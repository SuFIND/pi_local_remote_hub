import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
	FrameReader,
	writeFrame,
	type AgentFrame,
	type AgentMode,
	type AgentSessionInfo,
	type ControlOp,
	type ForwardedEnvelope,
	type HubNotice,
} from "../extension/hubwire/frames.js";
import type { Logger } from "../extension/logging/logger.js";
import { createErrorPayload } from "../extension/protocol/envelopes.js";
import { canonicalPath } from "./HubConfig.js";

/** A phone connection watching one session (implemented by `PhoneSession`). */
export type Viewer = {
	readonly id: string;
	deliver(type: string, payload?: unknown, requestId?: string): void;
	/** The session now lives in another Pi process (terminal /new, takeover). */
	agentReplaced(next: AgentRecord): void;
	/** The Pi process went away and nothing took its place. */
	agentGone(previous: AgentRecord, reason: "exited" | "idle"): void;
};

export type AgentRecord = {
	agentId: string;
	pid: number;
	mode: AgentMode;
	/** Present when the hub started this Pi (it may stop it again). */
	spawnToken?: string;
	session: AgentSessionInfo;
	state?: Record<string, unknown>;
	busy: boolean;
	connectedAt: number;
	lastActivityAt: number;
	/** Open `interaction.question`, replayed to phones that attach later. */
	pendingQuestion?: unknown;
	viewers: Set<Viewer>;
	socket: Socket;
	exitReason?: "idle" | "exited";
};

export type AgentHubOptions = {
	socketPath: string;
	logger: Logger;
	onControl: (op: ControlOp, args: Record<string, unknown> | undefined) => Promise<unknown>;
	onAgentRegistered?: (agent: AgentRecord) => void;
	onAgentGone?: (agent: AgentRecord) => void;
	/** A terminal took over a session a hub-started Pi was running; stop `from`. */
	onHandoff?: (from: AgentRecord, to: AgentRecord) => void;
	/** How long phones wait for a Pi window to re-register after switching session. */
	followGraceMs?: number;
};

type PendingRequest = { viewer: Viewer; requestId?: string; agentId: string; answered: boolean };

const ANSWERED_REPLY_TTL_MS = 10_000;

/** Events a watching terminal needs to draw another process's run. */
const MIRRORED_EVENTS = new Set(["pi.agent_start", "pi.agent_end", "pi.message_start", "pi.message_delta", "pi.message_end", "pi.tool_start", "pi.tool_end"]);

/**
 * The hub's local side: every Pi process registers here over the Unix
 * socket, and phone requests are routed to the process that owns the
 * session they are attached to.
 */
export class AgentHub {
	private server?: Server;
	private readonly agents = new Map<string, AgentRecord>();
	private readonly pending = new Map<string, PendingRequest>();
	/** pid → phones waiting for that Pi window's next session. */
	private readonly followers = new Map<number, { viewers: Set<Viewer>; previous: AgentRecord; timer: NodeJS.Timeout }>();
	/** hub-started owner → terminal waiting to take over once it is idle. */
	private readonly pendingHandoffs = new Map<string, string>();
	/** agentId → agents on the same session file that show its runs live. */
	private readonly watchers = new Map<string, Set<string>>();
	/** `pid:file` pairs already warned about a shared session (a reload re-registers). */
	private readonly warnedConflicts = new Set<string>();
	private seq = 0;

	constructor(private readonly options: AgentHubOptions) {}

	async start(): Promise<void> {
		const path = this.options.socketPath;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		if (existsSync(path)) {
			if (await isSocketAlive(path)) throw new Error(`Another Pi Remote Hub is already running (${path})`);
			unlinkSync(path);
		}
		const server = createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.off("error", reject);
				resolve();
			});
		});
		chmodSync(path, 0o600);
		this.server = server;
	}

	async stop(): Promise<void> {
		for (const agent of this.agents.values()) agent.socket.destroy();
		for (const follow of this.followers.values()) clearTimeout(follow.timer);
		this.followers.clear();
		const server = this.server;
		this.server = undefined;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			unlinkSync(this.options.socketPath);
		} catch {
			// already gone
		}
	}

	list(): AgentRecord[] {
		return [...this.agents.values()];
	}

	/** The process that owns `file`: a busy hub-started owner wins over a waiting terminal. */
	findBySession(file: string): AgentRecord | undefined {
		const target = canonicalPath(file);
		const matches = this.list().filter((agent) => agent.session.file && canonicalPath(agent.session.file) === target);
		return matches.find((agent) => this.pendingHandoffs.has(agent.agentId)) ?? matches.sort((a, b) => b.connectedAt - a.connectedAt)[0];
	}

	findBySpawnToken(token: string): AgentRecord | undefined {
		return this.list().find((agent) => agent.spawnToken === token);
	}

	attachedAgent(viewer: Viewer): AgentRecord | undefined {
		return this.list().find((agent) => agent.viewers.has(viewer));
	}

	attach(viewer: Viewer, agent: AgentRecord): void {
		this.detach(viewer);
		agent.viewers.add(viewer);
		this.sendViewers(agent);
		if (agent.pendingQuestion) viewer.deliver("interaction.question", agent.pendingQuestion);
	}

	detach(viewer: Viewer): void {
		for (const agent of this.agents.values()) {
			if (agent.viewers.delete(viewer)) this.sendViewers(agent);
		}
		for (const follow of this.followers.values()) follow.viewers.delete(viewer);
	}

	forward(viewer: Viewer, agent: AgentRecord, envelope: ForwardedEnvelope, requestId?: string): void {
		const rid = `r${++this.seq}`;
		this.pending.set(rid, { viewer, requestId, agentId: agent.agentId, answered: false });
		agent.lastActivityAt = Date.now();
		writeFrame(agent.socket, { t: "request", rid, envelope });
	}

	/** The hub is about to stop this Pi; tell its phones why when it disconnects. */
	markExiting(agent: AgentRecord, reason: "idle" | "exited"): void {
		agent.exitReason = reason;
	}

	notice(agent: AgentRecord, notice: HubNotice): void {
		writeFrame(agent.socket, { t: "notice", ...notice });
	}

	private accept(socket: Socket): void {
		let agent: AgentRecord | undefined;
		const reader = new FrameReader<AgentFrame>();
		writeFrame(socket, { t: "welcome", hubPid: process.pid });
		socket.on("data", (chunk) => {
			let frames: AgentFrame[];
			try {
				frames = reader.push(chunk);
			} catch {
				socket.destroy();
				return;
			}
			for (const frame of frames) {
				if (frame.t === "control") {
					this.handleControl(socket, frame);
				} else if (!agent) {
					if (frame.t === "hello") agent = this.register(frame, socket);
				} else {
					this.handleAgentFrame(agent, frame);
				}
			}
		});
		socket.on("error", () => {});
		socket.on("close", () => {
			if (agent) this.unregister(agent);
		});
	}

	private register(hello: Extract<AgentFrame, { t: "hello" }>, socket: Socket): AgentRecord {
		const now = Date.now();
		const record: AgentRecord = {
			agentId: hello.agentId,
			pid: hello.pid,
			mode: hello.mode,
			spawnToken: hello.spawnToken,
			session: hello.session,
			busy: false,
			connectedAt: now,
			lastActivityAt: now,
			viewers: new Set(),
			socket,
		};
		this.applyState(record, hello.state);
		this.agents.set(record.agentId, record);
		this.options.logger.info("hub_agent_registered", { agentId: record.agentId, pid: record.pid, mode: record.mode, file: record.session.file });

		const follow = this.followers.get(record.pid);
		if (follow) {
			clearTimeout(follow.timer);
			this.followers.delete(record.pid);
			this.moveViewers(follow.viewers, record);
		}
		this.checkConflicts(record);
		this.options.onAgentRegistered?.(record);
		return record;
	}

	private checkConflicts(record: AgentRecord): void {
		const file = record.session.file;
		if (!file) return;
		const target = canonicalPath(file);
		for (const other of this.agents.values()) {
			if (other === record || !other.session.file || canonicalPath(other.session.file) !== target) continue;
			if (other.spawnToken && !record.spawnToken) {
				if (!other.busy) {
					this.handoff(other, record);
				} else {
					this.pendingHandoffs.set(other.agentId, record.agentId);
					this.watch(record, other);
					this.notice(record, {
						level: "warning",
						message: "Pi Remote: the phone is running this session right now. It is shown live above the editor; this window takes over and reloads the latest messages as soon as that run finishes. Don't send prompts here until then.",
					});
				}
			} else if (!other.spawnToken && !record.spawnToken) {
				// Two terminals on one file: each shows the other's runs live and
				// reloads after them, so neither continues from a stale branch.
				this.watch(record, other);
				this.watch(other, record);
				const key = `${record.pid}:${target}`;
				if (!this.warnedConflicts.has(key)) {
					if (this.warnedConflicts.size > 1_000) this.warnedConflicts.clear();
					this.warnedConflicts.add(key);
					this.notice(record, {
						level: "warning",
						message: `Pi Remote: this session is also open in another Pi window (pid ${other.pid}). Its runs show here live and this window reloads after each one; send prompts from one window at a time.`,
					});
				}
			} else {
				this.notice(record, {
					level: "warning",
					message: `Pi Remote: this session is also open in another Pi process (pid ${other.pid}). Two Pi processes writing one session file can lose messages.`,
				});
			}
		}
	}

	/** `watcher` shows `watched`'s runs live until either goes away or the handoff completes. */
	private watch(watcher: AgentRecord, watched: AgentRecord): void {
		let set = this.watchers.get(watched.agentId);
		if (!set) {
			set = new Set();
			this.watchers.set(watched.agentId, set);
		}
		set.add(watcher.agentId);
		if (watched.busy) this.sendMirror(watcher, watched, "mirror.start");
	}

	private unwatch(watcher: AgentRecord, watched: AgentRecord): void {
		const set = this.watchers.get(watched.agentId);
		if (!set?.delete(watcher.agentId)) return;
		if (set.size === 0) this.watchers.delete(watched.agentId);
		this.sendMirror(watcher, watched, "mirror.stop");
	}

	private watchersOf(agent: AgentRecord): AgentRecord[] {
		const ids = this.watchers.get(agent.agentId);
		if (!ids) return [];
		return [...ids].map((id) => this.agents.get(id)).filter((watcher): watcher is AgentRecord => watcher !== undefined);
	}

	private sendMirror(watcher: AgentRecord, watched: AgentRecord, type: string, payload?: unknown): void {
		writeFrame(watcher.socket, { t: "mirror", from: { pid: watched.pid, background: Boolean(watched.spawnToken) }, type, payload });
	}

	private handoff(from: AgentRecord, to: AgentRecord): void {
		this.pendingHandoffs.delete(from.agentId);
		this.unwatch(to, from);
		const viewers = new Set(from.viewers);
		from.viewers.clear();
		this.sendViewers(from);
		this.moveViewers(viewers, to);
		this.options.onHandoff?.(from, to);
	}

	private moveViewers(viewers: Set<Viewer>, to: AgentRecord): void {
		if (viewers.size === 0) return;
		for (const viewer of viewers) to.viewers.add(viewer);
		this.sendViewers(to);
		for (const viewer of viewers) viewer.agentReplaced(to);
	}

	private handleAgentFrame(agent: AgentRecord, frame: AgentFrame): void {
		const wasBusy = agent.busy;
		if (frame.t === "event") {
			agent.lastActivityAt = Date.now();
			this.track(agent, frame.type, frame.payload);
			for (const viewer of agent.viewers) viewer.deliver(frame.type, frame.payload);
			if (MIRRORED_EVENTS.has(frame.type)) for (const watcher of this.watchersOf(agent)) this.sendMirror(watcher, agent, frame.type, frame.payload);
			this.maybeCompleteHandoff(agent);
			if (wasBusy && !agent.busy) this.runEnded(agent);
			return;
		}
		if (frame.t === "reply") {
			const pending = this.pending.get(frame.rid);
			if (!pending) return;
			if (frame.type === "state.changed") {
				this.track(agent, frame.type, frame.payload);
				this.maybeCompleteHandoff(agent);
				if (wasBusy && !agent.busy) this.runEnded(agent);
			}
			if (frame.type === "response.ok" || frame.type === "response.error") {
				if (pending.answered) return;
				pending.answered = true;
				pending.viewer.deliver(frame.type, frame.payload, pending.requestId);
				setTimeout(() => this.pending.delete(frame.rid), ANSWERED_REPLY_TTL_MS).unref();
			} else {
				pending.viewer.deliver(frame.type, frame.payload);
			}
		}
	}

	private track(agent: AgentRecord, type: string, payload: unknown): void {
		if (type === "state.changed" || type === "state.snapshot") {
			const state = (payload as { state?: unknown } | undefined)?.state;
			this.applyState(agent, state);
		} else if (type === "pi.agent_start") {
			agent.busy = true;
		} else if (type === "interaction.question") {
			agent.pendingQuestion = payload;
		} else if (type === "interaction.resolved") {
			agent.pendingQuestion = undefined;
		}
	}

	private applyState(agent: AgentRecord, state: unknown): void {
		if (!state || typeof state !== "object") return;
		const record = state as Record<string, unknown>;
		agent.state = record;
		agent.busy = record.isIdle === false || record.hasPendingMessages === true || record.phase === "needsInput" || record.phase === "compacting";
		if (typeof record.sessionFile === "string") agent.session.file = record.sessionFile;
		if (typeof record.sessionName === "string") agent.session.name = record.sessionName;
	}

	private maybeCompleteHandoff(agent: AgentRecord): void {
		if (agent.busy) return;
		const toId = this.pendingHandoffs.get(agent.agentId);
		if (!toId) return;
		const to = this.agents.get(toId);
		this.pendingHandoffs.delete(agent.agentId);
		if (!to) return;
		this.handoff(agent, to);
		this.notice(to, {
			level: "info",
			message: "Pi Remote: the phone's run finished; this window now owns the session and is loading the latest messages.",
			handoffReady: true,
		});
	}

	/** Terminals watching another terminal's run reload once it is over. */
	private runEnded(agent: AgentRecord): void {
		for (const watcher of this.watchersOf(agent)) {
			this.notice(watcher, { level: "info", message: "Pi Remote: the other Pi window finished a run on this session; reloading.", reload: true });
		}
	}

	private unregister(agent: AgentRecord): void {
		if (this.agents.get(agent.agentId) !== agent) return;
		this.agents.delete(agent.agentId);
		for (const watcher of this.watchersOf(agent)) this.sendMirror(watcher, agent, "mirror.stop");
		this.watchers.delete(agent.agentId);
		for (const [watchedId, set] of this.watchers) {
			set.delete(agent.agentId);
			if (set.size === 0) this.watchers.delete(watchedId);
		}
		this.options.logger.info("hub_agent_gone", { agentId: agent.agentId, pid: agent.pid, reason: agent.exitReason ?? "exited" });

		for (const [rid, pending] of this.pending) {
			if (pending.agentId !== agent.agentId) continue;
			this.pending.delete(rid);
			if (!pending.answered) {
				pending.viewer.deliver("response.error", createErrorPayload("SESSION_UNAVAILABLE", "Pi exited before answering"), pending.requestId);
			}
		}

		const waitingTerminal = this.pendingHandoffs.get(agent.agentId);
		this.pendingHandoffs.delete(agent.agentId);
		for (const [from, to] of this.pendingHandoffs) if (to === agent.agentId) this.pendingHandoffs.delete(from);
		const successor = waitingTerminal ? this.agents.get(waitingTerminal) : undefined;

		const viewers = new Set(agent.viewers);
		agent.viewers.clear();
		if (successor) {
			this.moveViewers(viewers, successor);
			// It ended without going idle (crash, stop); show what it wrote.
			this.notice(successor, {
				level: "info",
				message: "Pi Remote: the phone's Pi stopped; this window now owns the session and is loading the latest messages.",
				handoffReady: true,
			});
		} else if (viewers.size > 0) {
			if (agent.exitReason === "idle") {
				for (const viewer of viewers) viewer.agentGone(agent, "idle");
			} else {
				// A Pi window that switched session re-registers within moments.
				const timer = setTimeout(() => {
					this.followers.delete(agent.pid);
					for (const viewer of viewers) viewer.agentGone(agent, "exited");
				}, this.options.followGraceMs ?? 4_000);
				timer.unref();
				this.followers.set(agent.pid, { viewers, previous: agent, timer });
			}
		}
		this.options.onAgentGone?.(agent);
	}

	private handleControl(socket: Socket, frame: Extract<AgentFrame, { t: "control" }>): void {
		this.options.onControl(frame.op, frame.args).then(
			(result) => writeFrame(socket, { t: "controlResult", rid: frame.rid, ok: true, result }),
			(error) => writeFrame(socket, { t: "controlResult", rid: frame.rid, ok: false, error: error instanceof Error ? error.message : String(error) }),
		);
	}

	private sendViewers(agent: AgentRecord): void {
		writeFrame(agent.socket, { t: "viewers", count: agent.viewers.size });
	}
}

/** True when something is accepting connections on `path`. */
export function isSocketAlive(path: string, timeoutMs = 500): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		const timer = setTimeout(() => {
			socket.destroy();
			resolve(false);
		}, timeoutMs);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}
