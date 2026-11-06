import { basename } from "node:path";
import type { DeviceTrust, TrustedDevice } from "../extension/auth/DeviceTrust.js";
import type { ConnectionSession } from "../extension/connections/RemoteConnection.js";
import type { ForwardedEnvelope } from "../extension/hubwire/frames.js";
import type { Logger } from "../extension/logging/logger.js";
import type { RemoteSessionHistory } from "../extension/pi/PiRemoteAdapter.js";
import { PROTOCOL_VERSION } from "../extension/config.js";
import { ProtocolError } from "../extension/protocol/errors.js";
import type { ClientMessage } from "../extension/protocol/ProtocolDecoder.js";
import type { SessionContext } from "../extension/server/RemoteServer.js";
import type { AgentRecord, Viewer } from "./AgentHub.js";
import type { ProjectSummary, SessionStatus, SessionSummary } from "./SessionCatalog.js";

/** What a phone connection needs from the hub (implemented by `HubService`). */
export type HubCore = {
	roots(): string[];
	isAllowedFolder(path: string): boolean;
	listProjects(): Promise<ProjectSummary[]>;
	listSessions(cwd: string): Promise<SessionSummary[]>;
	listFolders(path: string): string[];
	/** A saved or running session inside the roots, or undefined. */
	resolveSession(path: string): Promise<{ path: string; cwd: string } | undefined>;
	liveAgentFor(path: string): AgentRecord | undefined;
	/** Start Pi for a saved session (or a new one in `cwd`) and wait for it to register. */
	wake(target: { cwd: string; sessionPath?: string }): Promise<AgentRecord>;
	attach(viewer: Viewer, agent: AgentRecord): void;
	detach(viewer: Viewer): void;
	forward(viewer: Viewer, agent: AgentRecord, envelope: ForwardedEnvelope, requestId?: string): void;
	storedHistory(path: string, limit?: number): RemoteSessionHistory;
	storedState(path: string, cwd: string): Record<string, unknown>;
	phoneClosed(phone: PhoneSession): void;
};

export type AttachedSession = { path?: string; cwd: string; name?: string; status: SessionStatus };

/** Commands that can be answered from the session file without starting Pi. */
const STORED_COMMANDS = new Set(["session.history", "session.getState", "session.abort"]);

/**
 * One phone connection to the hub. After authentication the phone browses
 * folders and sessions, then attaches to one session: either a running Pi
 * (terminal window or hub-started) or a saved session that is "asleep".
 * Commands to a sleeping session start Pi for it on demand.
 */
/** One signed-in phone, as listed by the hub's `overview`. */
export type PhoneSummary = {
	connectionId: string;
	deviceId: string;
	deviceName: string;
	remoteAddress?: string;
	connectedAt: string;
	/** The running Pi it is attached to; absent while it looks at a stopped session or the browser. */
	agentId?: string;
	session?: { path?: string; cwd: string; name?: string };
};

export class PhoneSession implements ConnectionSession, Viewer {
	readonly id: string;
	private device?: TrustedDevice;
	private target?: { path?: string; cwd: string };
	private agent?: AgentRecord;
	/** True while this phone itself is starting Pi for its target. */
	private waking = false;
	private readonly connectedAt = new Date().toISOString();

	constructor(
		private readonly context: SessionContext,
		private readonly deviceTrust: DeviceTrust,
		private readonly logger: Logger,
		private readonly core: HubCore,
	) {
		this.id = context.id;
	}

	isAuthenticated(): boolean {
		return Boolean(this.device);
	}

	authenticatedDeviceId(): string | undefined {
		return this.device?.id;
	}

	/** What the Mac menu bar app shows for this phone; undefined until it signs in. */
	describe(): PhoneSummary | undefined {
		if (!this.device) return undefined;
		return {
			connectionId: this.id,
			deviceId: this.device.id,
			deviceName: this.device.name,
			remoteAddress: this.context.remoteAddress,
			connectedAt: this.connectedAt,
			agentId: this.agent?.agentId,
			session: this.target ? { path: this.target.path, cwd: this.target.cwd, name: this.agent?.session.name } : undefined,
		};
	}

	/** Saved session this phone is looking at while no Pi runs it. */
	wantsSession(path: string): boolean {
		return !this.agent && !this.waking && this.target?.path === path;
	}

	async handle(message: ClientMessage): Promise<void> {
		if (message.kind === "connection.ping") {
			this.context.send("connection.pong", { ok: true }, message.id);
			return;
		}
		if (!this.device) {
			this.authenticate(message);
			return;
		}
		switch (message.kind) {
			case "hub.listProjects":
				this.ok(message, { roots: this.core.roots(), projects: await this.core.listProjects() });
				return;
			case "hub.listSessions":
				this.requireFolder(message.cwd);
				this.ok(message, { cwd: message.cwd, sessions: await this.core.listSessions(message.cwd) });
				return;
			case "hub.listFolders":
				this.requireFolder(message.path);
				this.ok(message, { path: message.path, folders: this.core.listFolders(message.path).map((path) => ({ path, name: basename(path) })) });
				return;
			case "hub.openSession":
				await this.openSession(message);
				return;
			case "hub.newSession":
				await this.newSession(message);
				return;
			case "hub.detach":
				this.core.detach(this);
				this.agent = undefined;
				this.target = undefined;
				this.ok(message, { detached: true });
				return;
			default:
				await this.sessionCommand(message);
		}
	}

	deliver(type: string, payload?: unknown, requestId?: string): void {
		this.context.send(type, payload, requestId);
	}

	agentReplaced(next: AgentRecord): void {
		this.agent = next;
		this.target = { path: next.session.file, cwd: next.session.cwd };
		this.context.send("hub.attached", { reason: "replaced", session: this.describeAgent(next), state: next.state ?? null });
	}

	agentGone(previous: AgentRecord, reason: "exited" | "idle"): void {
		if (this.agent !== previous) return;
		this.agent = undefined;
		const path = previous.session.file;
		if (path) {
			// Keep watching the saved session; the next command wakes Pi again.
			this.target = { path, cwd: previous.session.cwd };
			this.context.send("hub.sessionStatus", { reason, session: { path, cwd: previous.session.cwd, name: previous.session.name, status: "stopped" } });
		} else {
			this.target = undefined;
			this.context.send("hub.detached", { reason });
		}
	}

	dispose(): void {
		this.core.detach(this);
		this.core.phoneClosed(this);
	}

	private authenticate(message: ClientMessage): void {
		if (message.kind === "auth.pair.request") {
			const result = this.deviceTrust.pairDevice({ code: message.code, deviceName: message.deviceName, remoteAddress: this.context.remoteAddress });
			if (!result.ok) throw new ProtocolError(result.code, result.message);
			this.device = result.device;
			this.logAuthenticated();
			this.context.send("auth.pair.success", { token: result.token, device: result.device, state: null, hub: this.hubInfo() }, message.id);
			return;
		}
		if (message.kind === "auth.token") {
			const device = this.deviceTrust.authenticateToken(message.token);
			if (!device) throw new ProtocolError("UNAUTHORIZED", "Invalid or expired device token");
			this.device = device;
			this.logAuthenticated();
			this.context.send("auth.token.success", { device, state: null, hub: this.hubInfo() }, message.id);
			return;
		}
		throw new ProtocolError("UNAUTHORIZED", "Authenticate before sending commands");
	}

	private async openSession(message: Extract<ClientMessage, { kind: "hub.openSession" }>): Promise<void> {
		const resolved = await this.core.resolveSession(message.sessionPath);
		if (!resolved) throw new ProtocolError("SESSION_UNAVAILABLE", "Session not found in the folders shared with this phone");
		const agent = this.core.liveAgentFor(resolved.path);
		if (agent) {
			this.attachTo(agent);
			this.ok(message, { session: this.describeAgent(agent), state: agent.state ?? null });
			return;
		}
		this.core.detach(this);
		this.agent = undefined;
		this.target = resolved;
		const state = this.core.storedState(resolved.path, resolved.cwd);
		this.ok(message, { session: { path: resolved.path, cwd: resolved.cwd, name: state.sessionName, status: "stopped" }, state });
	}

	private async newSession(message: Extract<ClientMessage, { kind: "hub.newSession" }>): Promise<void> {
		this.requireFolder(message.cwd);
		const agent = await this.core.wake({ cwd: message.cwd });
		this.attachTo(agent);
		this.ok(message, { session: this.describeAgent(agent), state: agent.state ?? null });
	}

	private async sessionCommand(message: ClientMessage): Promise<void> {
		if (message.kind === "unknown") throw new ProtocolError("UNKNOWN_COMMAND", `Unknown command: ${message.type}`);
		if (!message.kind.startsWith("session.") && message.kind !== "interaction.answer") {
			throw new ProtocolError("BAD_REQUEST", "Already authenticated");
		}
		if (!this.target && !this.agent) throw new ProtocolError("NO_SESSION", "Open a session first");
		if (!this.agent && this.target?.path && STORED_COMMANDS.has(message.kind)) {
			this.answerFromFile(message, this.target.path, this.target.cwd);
			return;
		}
		const agent = this.agent ?? (await this.wakeTarget());
		this.core.forward(this, agent, toForwardedEnvelope(message), message.id);
	}

	private answerFromFile(message: ClientMessage, path: string, cwd: string): void {
		if (message.kind === "session.history") {
			this.ok(message, this.core.storedHistory(path, message.limit));
			return;
		}
		const state = this.core.storedState(path, cwd);
		this.ok(message, message.kind === "session.abort" ? { accepted: true, state } : { state });
	}

	private async wakeTarget(): Promise<AgentRecord> {
		const target = this.target!;
		// Someone (a terminal, another phone) may have started it meanwhile.
		const running = target.path ? this.core.liveAgentFor(target.path) : undefined;
		let agent = running;
		if (!agent) {
			this.waking = true;
			try {
				agent = await this.core.wake({ cwd: target.cwd, sessionPath: target.path });
			} finally {
				this.waking = false;
			}
		}
		this.attachTo(agent);
		this.context.send("hub.sessionStatus", { reason: "started", session: this.describeAgent(agent) });
		return agent;
	}

	private attachTo(agent: AgentRecord): void {
		this.core.attach(this, agent);
		this.agent = agent;
		this.target = { path: agent.session.file, cwd: agent.session.cwd };
	}

	private describeAgent(agent: AgentRecord): AttachedSession {
		return { path: agent.session.file, cwd: agent.session.cwd, name: agent.session.name, status: agent.spawnToken ? "background" : "terminal" };
	}

	private requireFolder(path: string): void {
		if (!this.core.isAllowedFolder(path)) throw new ProtocolError("OUTSIDE_ROOTS", "That folder is not shared with this phone");
	}

	private hubInfo(): { roots: string[] } {
		return { roots: this.core.roots() };
	}

	private ok(message: ClientMessage, result: unknown): void {
		this.context.send("response.ok", { ok: true, command: message.kind, result }, message.id);
	}

	private logAuthenticated(): void {
		this.logger.info("remote_session_authenticated", { sessionId: this.id, deviceId: this.device?.id, deviceName: this.device?.name });
	}
}

/**
 * Re-encode a decoded command in its wire shape for the Pi process, which
 * decodes it again. Field names follow the wire format, not `ClientMessage`
 * (e.g. `session.setModel` carries `id`, decoded as `modelId`).
 */
export function toForwardedEnvelope(message: ClientMessage): ForwardedEnvelope {
	const envelope = (payload: Record<string, unknown> = {}): ForwardedEnvelope => ({ type: message.kind, protocolVersion: PROTOCOL_VERSION, payload });
	switch (message.kind) {
		case "interaction.answer":
			return envelope({ requestId: message.requestId, answer: message.answer });
		case "session.prompt":
			return envelope({ message: message.message, delivery: message.delivery });
		case "session.history":
			return envelope(message.limit === undefined ? {} : { limit: message.limit });
		case "session.setModel":
			return envelope({ provider: message.provider, id: message.modelId });
		case "session.setThinkingLevel":
			return envelope({ level: message.level });
		case "session.getState":
		case "session.abort":
		case "session.compact":
		case "session.listModels":
		case "session.listSkills":
			return envelope();
		default:
			throw new ProtocolError("UNKNOWN_COMMAND", `Cannot forward ${message.kind}`);
	}
}
