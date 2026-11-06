import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DeviceTrust, type TrustedDevice } from "../extension/auth/DeviceTrust.js";
import { FileTrustStore } from "../extension/auth/TrustStore.js";
import type { HubStatusView } from "../extension/command.js";
import { DEFAULT_REMOTE_CONFIG } from "../extension/config.js";
import { hubSocketPath, type ControlOp, type ForwardedEnvelope } from "../extension/hubwire/frames.js";
import { loadOrCreateHostIdentity } from "../extension/identity/HostIdentity.js";
import type { Logger } from "../extension/logging/logger.js";
import { BonjourAdvertiser } from "../extension/net/BonjourAdvertiser.js";
import { buildPairingDeepLink } from "../extension/runtime/pairingLink.js";
import { RemoteControlRuntime } from "../extension/runtime/RemoteControlRuntime.js";
import { RemoteServer } from "../extension/server/RemoteServer.js";
import { AgentHub, type AgentRecord, type Viewer } from "./AgentHub.js";
import { AgentSpawner, type AgentSpawnerOptions } from "./AgentSpawner.js";
import { canonicalPath, isInsideRoots, saveHubConfig, type HubConfig } from "./HubConfig.js";
import { PhoneSession, type HubCore, type PhoneSummary } from "./PhoneSession.js";
import { listFolders, readStoredHistory, readStoredState, SessionCatalog, type LiveSession } from "./SessionCatalog.js";

export type HubServiceOptions = {
	stateDir: string;
	config: HubConfig;
	logger: Logger;
	catalog?: SessionCatalog;
	spawner?: AgentSpawner;
	spawn?: AgentSpawnerOptions["spawn"];
	/** LAN address source; tests bind loopback. */
	selectHost?: () => string | undefined;
	advertise?: boolean;
	registerTimeoutMs?: number;
	idleCheckMs?: number;
	listenRetryMs?: number;
	followGraceMs?: number;
	/** `hub.json`; lets local tools change roots and idle time through the hub. */
	configPath?: string;
	logPath?: string;
};

/** One running Pi, as listed by `overview`. */
export type AgentSummary = {
	agentId: string;
	pid: number;
	mode: AgentRecord["mode"];
	/** `terminal`: a Pi window the user opened; `background`: started by the hub for a phone. */
	origin: "terminal" | "background";
	cwd: string;
	sessionFile?: string;
	sessionName?: string;
	model?: string;
	busy: boolean;
	/** Whether the phone can see it (its folder is inside a shared root). */
	shared: boolean;
	connectedAt: string;
	lastActivityAt: string;
	/** Names of the phones attached to it. */
	viewers: string[];
};

/** Everything the Pi Hub menu bar app shows, in one control request. */
export type HubOverview = {
	pid: number;
	startedAt: string;
	status: HubStatusView;
	roots: string[];
	idleExitMinutes: number;
	agents: AgentSummary[];
	phones: PhoneSummary[];
	devices: TrustedDevice[];
	configPath?: string;
	logPath?: string;
};

/**
 * The Pi Remote Hub: one long-lived process per Mac. It owns the TLS
 * listener, Bonjour, pairing and the trusted-device list, keeps a registry
 * of every running Pi (over the local socket), starts Pi for sessions the
 * phone opens, and stops those again after `idleExitMinutes` without work.
 */
export class HubService implements HubCore {
	readonly deviceTrust: DeviceTrust;
	readonly server: RemoteServer;
	readonly runtime: RemoteControlRuntime;
	readonly agents: AgentHub;
	private readonly catalog: SessionCatalog;
	private readonly spawner: AgentSpawner;
	private readonly phones = new Set<PhoneSession>();
	private readonly startedAt = new Date().toISOString();
	private readonly waking = new Map<string, Promise<AgentRecord>>();
	private readonly spawnWaiters = new Map<string, (agent: AgentRecord) => void>();
	private readonly host = hostname();
	private config: HubConfig;
	private idleTimer?: NodeJS.Timeout;
	private listenTimer?: NodeJS.Timeout;
	private lastError?: string;
	private stopped = false;

	constructor(private readonly options: HubServiceOptions) {
		this.config = options.config;
		this.deviceTrust = new DeviceTrust({ store: new FileTrustStore(join(options.stateDir, "trusted-devices.json")) });
		this.server = new RemoteServer({
			config: { ...DEFAULT_REMOTE_CONFIG, port: options.config.port },
			logger: options.logger,
			deviceTrust: this.deviceTrust,
			identity: () => loadOrCreateHostIdentity(options.stateDir),
			createSession: (context) => {
				const phone = new PhoneSession(context, this.deviceTrust, options.logger, this);
				this.phones.add(phone);
				return phone;
			},
		});
		this.runtime = new RemoteControlRuntime(this.server, this.deviceTrust, options.logger, undefined, {
			advertiser: options.advertise === false ? undefined : new BonjourAdvertiser(options.logger),
			selectHost: options.selectHost,
			getAdvertisementName: () => macName().replace(/[“”"]/g, ""),
		});
		this.agents = new AgentHub({
			socketPath: hubSocketPath(options.stateDir),
			logger: options.logger,
			onControl: (op, args) => this.control(op, args),
			onAgentRegistered: (agent) => this.onAgentRegistered(agent),
			onAgentGone: () => this.catalog.invalidate(),
			onHandoff: (from) => void this.stopAgent(from, "exited"),
			followGraceMs: options.followGraceMs,
		});
		this.catalog = options.catalog ?? new SessionCatalog();
		this.spawner = options.spawner ?? new AgentSpawner({ piCommand: options.config.piCommand, piArgs: options.config.piArgs, logger: options.logger, spawn: options.spawn });
	}

	async start(): Promise<void> {
		await this.agents.start();
		// First scan of Pi's session files; later scans only read appended bytes.
		void this.catalog.allSessions().catch(() => undefined);
		await this.ensureListening();
		this.idleTimer = setInterval(() => this.stopIdleAgents(), this.options.idleCheckMs ?? 15_000);
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.idleTimer) clearInterval(this.idleTimer);
		if (this.listenTimer) clearTimeout(this.listenTimer);
		await this.spawner.stopAll();
		await this.runtime.stop();
		await this.agents.stop();
	}

	updateConfig(config: HubConfig): void {
		this.config = config;
		this.catalog.invalidate();
	}

	status(): HubStatusView {
		const runtime = this.runtime.getStatus();
		return {
			...runtime,
			roots: this.config.roots,
			agents: this.agents.list().length,
			idleExitMinutes: this.config.idleExitMinutes,
			lastError: runtime.running ? undefined : this.lastError,
		};
	}

	async control(op: ControlOp, args: Record<string, unknown> | undefined): Promise<unknown> {
		switch (op) {
			case "status":
				return this.status();
			case "pair": {
				if (!this.server.isRunning()) throw new Error(`The hub is not listening on the LAN${this.lastError ? `: ${this.lastError}` : ""}`);
				const pairing = this.deviceTrust.startPairing();
				const status = this.status();
				const pairingLink = status.webSocketUrl && pairing.code ? buildPairingDeepLink(status.webSocketUrl, pairing.code) : undefined;
				return { ...status, pairingCode: pairing.code, pairingExpiresAt: pairing.expiresAt, pairingLink };
			}
			case "devices":
				return { devices: this.deviceTrust.listTrustedDevices() };
			case "revoke": {
				const result = this.runtime.revokeDevice(String(args?.id ?? ""));
				if (!result.ok) throw new Error(result.message);
				return result.device;
			}
			case "rotate":
				this.runtime.rotateTrust();
				return this.status();
			case "overview":
				return this.overview();
			case "addRoot":
			case "removeRoot": {
				const path = canonicalPath(String(args?.path ?? ""));
				if (op === "addRoot" && !(existsSync(path) && statSync(path).isDirectory())) throw new Error(`Not a folder: ${path}`);
				const roots = op === "addRoot" ? [...new Set([...this.config.roots, path])] : this.config.roots.filter((root) => root !== path);
				this.saveConfig({ ...this.config, roots });
				return this.overview();
			}
			case "setIdle": {
				const minutes = Number(args?.minutes);
				if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new Error("Idle minutes must be between 0 and 1440");
				this.saveConfig({ ...this.config, idleExitMinutes: minutes });
				return this.overview();
			}
			case "stopAgent": {
				const agent = this.agents.list().find((record) => record.agentId === args?.agentId);
				if (!agent) throw new Error("That Pi is no longer running");
				if (!agent.spawnToken) throw new Error("This Pi runs in a terminal window; quit it there");
				await this.stopAgent(agent, "exited");
				return this.overview();
			}
		}
	}

	overview(): HubOverview {
		const phones = [...this.phones].map((phone) => phone.describe()).filter((phone): phone is PhoneSummary => Boolean(phone));
		const agents = this.agents.list().map((agent): AgentSummary => {
			const model = agent.state?.model as { name?: unknown; id?: unknown } | undefined;
			return {
				agentId: agent.agentId,
				pid: agent.pid,
				mode: agent.mode,
				origin: agent.spawnToken ? "background" : "terminal",
				cwd: agent.session.cwd,
				sessionFile: agent.session.file,
				sessionName: agent.session.name,
				model: typeof model?.name === "string" ? model.name : typeof model?.id === "string" ? model.id : undefined,
				busy: agent.busy,
				shared: isInsideRoots(agent.session.cwd, this.config.roots),
				connectedAt: new Date(agent.connectedAt).toISOString(),
				lastActivityAt: new Date(agent.lastActivityAt).toISOString(),
				viewers: phones.filter((phone) => phone.agentId === agent.agentId).map((phone) => phone.deviceName),
			};
		});
		return {
			pid: process.pid,
			startedAt: this.startedAt,
			status: this.status(),
			roots: this.config.roots,
			idleExitMinutes: this.config.idleExitMinutes,
			agents,
			phones,
			devices: this.deviceTrust.listTrustedDevices(),
			configPath: this.options.configPath,
			logPath: this.options.logPath,
		};
	}

	private saveConfig(config: HubConfig): void {
		if (!this.options.configPath) throw new Error("This hub runs without a config file");
		saveHubConfig(this.options.configPath, config);
		this.updateConfig(config);
	}

	// MARK: HubCore

	roots(): string[] {
		return this.config.roots;
	}

	isAllowedFolder(path: string): boolean {
		if (!isInsideRoots(path, this.config.roots)) return false;
		try {
			return statSync(path).isDirectory();
		} catch {
			return false;
		}
	}

	listProjects() {
		return this.catalog.projects(this.config.roots, this.liveSessions());
	}

	listSessions(cwd: string) {
		return this.catalog.sessions(cwd, this.liveSessions());
	}

	recentSessions(limit: number) {
		return this.catalog.recent(this.config.roots, this.liveSessions(), limit);
	}

	searchSessions(query: string, limit: number) {
		return this.catalog.search(this.config.roots, this.liveSessions(), query, limit);
	}

	listFolders(path: string): string[] {
		return listFolders(path);
	}

	async resolveSession(path: string): Promise<{ path: string; cwd: string } | undefined> {
		const live = this.agents.findBySession(path);
		if (live?.session.file && isInsideRoots(live.session.cwd, this.config.roots)) return { path: live.session.file, cwd: live.session.cwd };
		const info = await this.catalog.findSession(path, this.config.roots);
		return info ? { path: info.path, cwd: info.cwd } : undefined;
	}

	liveAgentFor(path: string): AgentRecord | undefined {
		return this.agents.findBySession(path);
	}

	wake(target: { cwd: string; sessionPath?: string }): Promise<AgentRecord> {
		const key = target.sessionPath ? canonicalPath(target.sessionPath) : undefined;
		const existing = key ? this.waking.get(key) : undefined;
		if (existing) return existing;
		const promise = this.spawnAndWait(target).finally(() => {
			if (key) this.waking.delete(key);
		});
		if (key) this.waking.set(key, promise);
		return promise;
	}

	attach(viewer: Viewer, agent: AgentRecord): void {
		this.agents.attach(viewer, agent);
	}

	detach(viewer: Viewer): void {
		this.agents.detach(viewer);
	}

	forward(viewer: Viewer, agent: AgentRecord, envelope: ForwardedEnvelope, requestId?: string): void {
		this.agents.forward(viewer, agent, envelope, requestId);
	}

	storedHistory(path: string, limit?: number) {
		return readStoredHistory(path, limit);
	}

	storedState(path: string, cwd: string) {
		return readStoredState(path, cwd, this.host);
	}

	phoneClosed(phone: PhoneSession): void {
		this.phones.delete(phone);
	}

	// MARK: internals

	private liveSessions(): LiveSession[] {
		return this.agents.list().map((agent) => ({
			file: agent.session.file,
			cwd: agent.session.cwd,
			name: agent.session.name,
			status: agent.spawnToken ? "background" : "terminal",
			busy: agent.busy,
		}));
	}

	private async spawnAndWait(target: { cwd: string; sessionPath?: string }): Promise<AgentRecord> {
		if (!existsSync(target.cwd)) throw new Error(`Folder no longer exists: ${target.cwd}`);
		const spawned = this.spawner.start(target);
		const timeoutMs = this.options.registerTimeoutMs ?? 30_000;
		try {
			return await new Promise<AgentRecord>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error("Pi started but never registered with the hub. Is the Pi Remote extension installed in Pi's settings?"));
				}, timeoutMs);
				this.spawnWaiters.set(spawned.token, (agent) => {
					clearTimeout(timer);
					resolve(agent);
				});
				void spawned.exited.then((code) => {
					clearTimeout(timer);
					const tail = spawned.stderrTail().split("\n").slice(-3).join(" ").trim();
					reject(new Error(`Pi exited (code ${code ?? "?"}) before it was ready${tail ? `: ${tail}` : ""}`));
				});
			});
		} catch (error) {
			void this.spawner.stop(spawned.token);
			throw error;
		} finally {
			this.spawnWaiters.delete(spawned.token);
		}
	}

	private onAgentRegistered(agent: AgentRecord): void {
		this.catalog.invalidate();
		if (agent.spawnToken) {
			this.spawnWaiters.get(agent.spawnToken)?.(agent);
			if (!this.spawner.get(agent.spawnToken)) {
				// Claims a token from an older hub run: treat it as a terminal-less
				// Pi we did not start, never stop it.
				agent.spawnToken = undefined;
			}
		}
		// Phones looking at this saved session follow it into the live process.
		const file = agent.session.file;
		if (!file) return;
		for (const phone of this.phones) {
			if (phone.wantsSession(file)) {
				this.agents.attach(phone, agent);
				phone.agentReplaced(agent);
			}
		}
	}

	private stopIdleAgents(): void {
		const idleMs = this.config.idleExitMinutes * 60_000;
		const now = Date.now();
		for (const agent of this.agents.list()) {
			if (!agent.spawnToken || agent.busy || now - agent.lastActivityAt < idleMs) continue;
			void this.stopAgent(agent, "idle");
		}
	}

	private async stopAgent(agent: AgentRecord, reason: "idle" | "exited"): Promise<void> {
		if (!agent.spawnToken) return;
		this.agents.markExiting(agent, reason);
		await this.spawner.stop(agent.spawnToken);
	}

	/** Keep trying to bind the LAN address (Wi-Fi may come up after login). */
	private async ensureListening(): Promise<void> {
		if (this.stopped) return;
		try {
			// The default port is passed as "unset" so a busy 3769 falls back to a
			// free port (Bonjour tells the phone); an explicit custom port is strict.
			const port = this.config.port === DEFAULT_REMOTE_CONFIG.port ? undefined : this.config.port;
			await this.runtime.start({ port, pairing: false });
			this.lastError = undefined;
		} catch (error) {
			this.lastError = error instanceof Error ? error.message : String(error);
			this.options.logger.warn("hub_listen_failed", { error: this.lastError });
			this.listenTimer = setTimeout(() => void this.ensureListening(), this.options.listenRetryMs ?? 10_000);
		}
	}
}

function macName(): string {
	try {
		const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2_000 }).trim();
		if (name) return name;
	} catch {
		// not macOS, or scutil unavailable
	}
	return hostname().replace(/\.local$/, "");
}
