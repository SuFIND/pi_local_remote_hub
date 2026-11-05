import type { Socket } from "node:net";
import { join } from "node:path";

/**
 * Wire format between a Pi process (the extension, "agent") and the Pi
 * Remote Hub on the same Mac: newline-delimited JSON over a Unix socket in
 * the state directory. The socket file is created 0600 inside a 0700
 * directory, so only the logged-in user can register agents or ask the hub
 * to open pairing. Nothing here crosses the network.
 */
export const HUB_SOCKET_NAME = "hub.sock";

export function hubSocketPath(stateDir: string): string {
	return join(stateDir, HUB_SOCKET_NAME);
}

export type AgentMode = "tui" | "rpc" | "other";

export type AgentSessionInfo = {
	/** Absolute `.jsonl` path; absent for `--no-session` processes. */
	file?: string;
	id?: string;
	cwd: string;
	name?: string;
};

export type ControlOp = "status" | "pair" | "devices" | "revoke" | "rotate";

/** Client envelope the hub forwards unchanged (the phone's request id is kept hub-side). */
export type ForwardedEnvelope = { type: string; protocolVersion: number; payload?: unknown };

export type AgentFrame =
	| {
			t: "hello";
			agentId: string;
			pid: number;
			mode: AgentMode;
			/** Set by the hub when it spawned this process (`PI_REMOTE_SPAWN_TOKEN`). */
			spawnToken?: string;
			session: AgentSessionInfo;
			state: unknown;
	  }
	| { t: "event"; type: string; payload?: unknown }
	| { t: "reply"; rid: string; type: string; payload?: unknown }
	| { t: "control"; rid: string; op: ControlOp; args?: Record<string, unknown> };

export type HubNotice = {
	level: "info" | "warning";
	message: string;
	/** The phone-side run that blocked a terminal takeover has finished. */
	handoffReady?: boolean;
};

export type HubFrame =
	| { t: "welcome"; hubPid: number }
	| { t: "request"; rid: string; envelope: ForwardedEnvelope }
	| { t: "viewers"; count: number }
	| { t: "controlResult"; rid: string; ok: boolean; result?: unknown; error?: string }
	| ({ t: "notice" } & HubNotice);

/** Generous: tool results and diffs are already capped by the sanitizer. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Splits a byte stream into JSON frames; throws on an oversized line. */
export class FrameReader<T> {
	private buffer = "";

	push(chunk: Buffer | string): T[] {
		this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		const frames: T[] = [];
		let newline: number;
		while ((newline = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (!line.trim()) continue;
			try {
				frames.push(JSON.parse(line) as T);
			} catch {
				// A malformed line is dropped; the stream stays usable.
			}
		}
		if (this.buffer.length > MAX_FRAME_BYTES) {
			this.buffer = "";
			throw new Error("hub frame too large");
		}
		return frames;
	}
}

export function writeFrame(socket: Socket, frame: AgentFrame | HubFrame): boolean {
	if (socket.destroyed || !socket.writable) return false;
	return socket.write(`${JSON.stringify(frame)}\n`);
}
