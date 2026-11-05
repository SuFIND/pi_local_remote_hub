import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { Logger } from "../logging/logger.js";
import {
	FrameReader,
	writeFrame,
	type AgentFrame,
	type AgentMode,
	type AgentSessionInfo,
	type ControlOp,
	type ForwardedEnvelope,
	type HubFrame,
	type HubNotice,
} from "../hubwire/frames.js";

export type HubLinkOptions = {
	socketPath: string;
	logger: Logger;
	mode: AgentMode;
	spawnToken?: string;
	/** Defaults to this process; tests run several agents in one process. */
	pid?: number;
	/** Current session identity and state snapshot, read on every (re)connect. */
	describe: () => { session: AgentSessionInfo; state: unknown };
	onRequest: (envelope: ForwardedEnvelope, reply: (type: string, payload?: unknown) => void) => void;
	onViewers?: (count: number) => void;
	onNotice?: (notice: HubNotice) => void;
	onConnectionChange?: (connected: boolean) => void;
	retryMs?: number;
	connectSocket?: (path: string) => Socket;
};

const CONTROL_TIMEOUT_MS = 8_000;

/**
 * The extension's connection to the Pi Remote Hub. Phones never talk to a
 * Pi process directly any more: the hub owns the LAN listener, pairing and
 * routing, and this link carries forwarded commands in and events out.
 *
 * The hub may start later or restart; the link keeps retrying quietly so a
 * terminal Pi window becomes reachable as soon as the hub is up.
 */
export class HubLink {
	readonly agentId = randomBytes(9).toString("base64url");
	private socket?: Socket;
	private connected = false;
	private stopped = true;
	private retryTimer?: NodeJS.Timeout;
	private viewers = 0;
	private controlSeq = 0;
	private readonly pendingControl = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

	constructor(private readonly options: HubLinkOptions) {}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.dial();
	}

	stop(): void {
		this.stopped = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = undefined;
		this.socket?.destroy();
		this.socket = undefined;
		this.setConnected(false);
	}

	isConnected(): boolean {
		return this.connected;
	}

	/** Phones currently attached to this session through the hub. */
	viewerCount(): number {
		return this.connected ? this.viewers : 0;
	}

	broadcast(type: string, payload?: unknown): void {
		this.send({ t: "event", type, payload });
	}

	/** Ask the hub to do something on the user's behalf (`/remote pair`, …). */
	control(op: ControlOp, args?: Record<string, unknown>): Promise<unknown> {
		if (!this.connected || !this.socket) {
			return Promise.reject(new Error("Pi Remote Hub is not running"));
		}
		const rid = `ctl${++this.controlSeq}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingControl.delete(rid);
				reject(new Error("Pi Remote Hub did not answer"));
			}, CONTROL_TIMEOUT_MS);
			this.pendingControl.set(rid, { resolve, reject, timer });
			this.send({ t: "control", rid, op, args });
		});
	}

	private dial(): void {
		if (this.stopped) return;
		const socket = (this.options.connectSocket ?? ((path) => connect(path)))(this.options.socketPath);
		this.socket = socket;
		const reader = new FrameReader<HubFrame>();
		socket.on("connect", () => {
			const { session, state } = this.options.describe();
			writeFrame(socket, {
				t: "hello",
				agentId: this.agentId,
				pid: this.options.pid ?? process.pid,
				mode: this.options.mode,
				spawnToken: this.options.spawnToken,
				session,
				state,
			});
			this.setConnected(true);
			this.options.logger.debug("hub_link_connected", { socketPath: this.options.socketPath });
		});
		socket.on("data", (chunk) => {
			let frames: HubFrame[];
			try {
				frames = reader.push(chunk);
			} catch {
				socket.destroy();
				return;
			}
			for (const frame of frames) this.handle(frame);
		});
		socket.on("error", () => {
			// ENOENT / ECONNREFUSED while the hub is not running: retry below.
		});
		socket.on("close", () => {
			if (this.socket === socket) this.socket = undefined;
			this.setConnected(false);
			this.failPendingControl();
			if (this.stopped) return;
			this.retryTimer = setTimeout(() => this.dial(), this.options.retryMs ?? 3_000);
			this.retryTimer.unref();
		});
	}

	private handle(frame: HubFrame): void {
		switch (frame.t) {
			case "request":
				this.options.onRequest(frame.envelope, (type, payload) => this.send({ t: "reply", rid: frame.rid, type, payload }));
				return;
			case "viewers":
				this.viewers = frame.count;
				this.options.onViewers?.(frame.count);
				return;
			case "controlResult": {
				const pending = this.pendingControl.get(frame.rid);
				if (!pending) return;
				this.pendingControl.delete(frame.rid);
				clearTimeout(pending.timer);
				if (frame.ok) pending.resolve(frame.result);
				else pending.reject(new Error(frame.error ?? "Pi Remote Hub refused the request"));
				return;
			}
			case "notice":
				this.options.onNotice?.({ level: frame.level, message: frame.message, handoffReady: frame.handoffReady });
				return;
			default:
				return;
		}
	}

	private send(frame: AgentFrame): void {
		if (this.socket && this.connected) writeFrame(this.socket, frame);
	}

	private setConnected(connected: boolean): void {
		if (this.connected === connected) return;
		this.connected = connected;
		if (!connected) this.viewers = 0;
		this.options.onConnectionChange?.(connected);
	}

	private failPendingControl(): void {
		for (const [rid, pending] of this.pendingControl) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Pi Remote Hub disconnected"));
			this.pendingControl.delete(rid);
		}
	}
}
