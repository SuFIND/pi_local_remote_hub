import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseSessionEntries, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { sanitizeForRemote } from "../extension/pi/sanitizer.js";
import type { RemoteSessionHistory } from "../extension/pi/PiRemoteAdapter.js";
import { canonicalPath, isInsideRoots } from "./HubConfig.js";
import { SessionIndex, type IndexedSession } from "./SessionIndex.js";

export type SessionStatus = "terminal" | "background" | "stopped";

/** A live Pi process as far as the catalog cares. */
export type LiveSession = {
	file?: string;
	cwd: string;
	name?: string;
	status: Exclude<SessionStatus, "stopped">;
	busy: boolean;
};

export type ProjectSummary = {
	path: string;
	name: string;
	root: string;
	sessionCount: number;
	running: number;
	lastActivity?: string;
};

export type SessionSummary = {
	path: string;
	id?: string;
	name?: string;
	firstMessage: string;
	modified?: string;
	messageCount: number;
	status: SessionStatus;
	busy: boolean;
};

export type CatalogOptions = {
	/** Pi's session directory; defaults to Pi's own default. */
	sessionDir?: string;
	cacheMs?: number;
	list?: () => Promise<IndexedSession[]>;
};

const IGNORED_FOLDERS = new Set(["node_modules", "Library", "Applications"]);
const FIRST_MESSAGE_CHARS = 240;

/**
 * Everything the phone can browse: Pi's saved sessions (an incremental
 * `SessionIndex` over Pi's session files) filtered to the configured roots,
 * merged with the sessions that are running now.
 */
export class SessionCatalog {
	private cache?: { at: number; sessions: IndexedSession[] };
	private readonly cacheMs: number;
	private readonly list: () => Promise<IndexedSession[]>;

	constructor(options: CatalogOptions = {}) {
		this.cacheMs = options.cacheMs ?? 1_000;
		const index = new SessionIndex({ sessionDir: options.sessionDir });
		this.list = options.list ?? (() => index.list());
	}

	invalidate(): void {
		this.cache = undefined;
	}

	async allSessions(): Promise<IndexedSession[]> {
		if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.sessions;
		const sessions = await this.list();
		this.cache = { at: Date.now(), sessions };
		return sessions;
	}

	async findSession(path: string, roots: readonly string[]): Promise<IndexedSession | undefined> {
		const canonical = canonicalPath(path);
		const sessions = await this.allSessions();
		const info = sessions.find((session) => canonicalPath(session.path) === canonical);
		return info && info.cwd && isInsideRoots(info.cwd, roots) ? info : undefined;
	}

	/** Each root, its direct subfolders, and any deeper folder that has sessions. */
	async projects(roots: readonly string[], live: readonly LiveSession[]): Promise<ProjectSummary[]> {
		const sessions = await this.allSessions();
		const byPath = new Map<string, ProjectSummary>();
		const ensure = (path: string, root: string): ProjectSummary => {
			let project = byPath.get(path);
			if (!project) {
				project = { path, name: basename(path) || path, root, sessionCount: 0, running: 0 };
				byPath.set(path, project);
			}
			return project;
		};
		for (const root of roots) {
			ensure(root, root);
			for (const folder of listFolders(root)) ensure(folder, root);
		}
		for (const session of sessions) {
			if (!session.cwd) continue;
			const cwd = canonicalPath(session.cwd);
			const root = roots.find((candidate) => isInsideRoots(cwd, [candidate]));
			if (!root) continue;
			const project = ensure(cwd, root);
			project.sessionCount += 1;
			const modified = session.modified.toISOString();
			if (!project.lastActivity || modified > project.lastActivity) project.lastActivity = modified;
		}
		for (const agent of live) {
			const cwd = canonicalPath(agent.cwd);
			const root = roots.find((candidate) => isInsideRoots(cwd, [candidate]));
			if (!root) continue;
			const project = ensure(cwd, root);
			project.running += 1;
			const now = new Date().toISOString();
			if (!project.lastActivity || now > project.lastActivity) project.lastActivity = now;
		}
		return [...byPath.values()].sort(
			(a, b) => b.running - a.running || (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "") || a.name.localeCompare(b.name),
		);
	}

	async sessions(cwd: string, live: readonly LiveSession[]): Promise<SessionSummary[]> {
		const folder = canonicalPath(cwd);
		const liveByFile = new Map(live.filter((agent) => agent.file).map((agent) => [canonicalPath(agent.file!), agent]));
		const summaries: SessionSummary[] = [];
		const seen = new Set<string>();
		for (const session of await this.allSessions()) {
			if (!session.cwd || canonicalPath(session.cwd) !== folder) continue;
			const path = canonicalPath(session.path);
			const agent = liveByFile.get(path);
			seen.add(path);
			summaries.push({
				path: session.path,
				id: session.id,
				name: session.name ?? agent?.name,
				firstMessage: truncate(session.firstMessage, FIRST_MESSAGE_CHARS),
				modified: session.modified.toISOString(),
				messageCount: session.messageCount,
				status: agent?.status ?? "stopped",
				busy: agent?.busy ?? false,
			});
		}
		// A brand-new session has no file on disk until its first message.
		for (const agent of live) {
			if (!agent.file || canonicalPath(agent.cwd) !== folder || seen.has(canonicalPath(agent.file))) continue;
			summaries.push({
				path: agent.file,
				name: agent.name,
				firstMessage: "",
				modified: new Date().toISOString(),
				messageCount: 0,
				status: agent.status,
				busy: agent.busy,
			});
		}
		return summaries.sort(
			(a, b) => rank(b.status) - rank(a.status) || (b.modified ?? "").localeCompare(a.modified ?? ""),
		);
	}
}

/** Visible child directories, sorted by name. Never lists files. */
export function listFolders(path: string): string[] {
	let names: string[];
	try {
		names = readdirSync(path);
	} catch {
		return [];
	}
	return names
		.filter((name) => !name.startsWith(".") && !IGNORED_FOLDERS.has(name))
		.map((name) => join(path, name))
		.filter((child) => {
			try {
				return statSync(child).isDirectory();
			} catch {
				return false;
			}
		})
		.sort((a, b) => basename(a).localeCompare(basename(b)));
}

/** History of a session that is not running, read straight from its file. */
export function readStoredHistory(path: string, limit?: number): RemoteSessionHistory {
	const manager = openReadOnly(path);
	const branch = manager.getBranch().slice();
	branch.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	const total = branch.length;
	const selected = limit !== undefined && limit < total ? branch.slice(total - limit) : branch;
	return {
		entries: selected.map((entry) => sanitizeForRemote(entry)),
		leafId: manager.getLeafId() ?? undefined,
		totalEntries: total,
		truncated: selected.length < total,
	};
}

/** Best-effort state for a stopped session: idle, with its last model and thinking level. */
export function readStoredState(path: string, cwd: string, host: string): Record<string, unknown> {
	const manager = openReadOnly(path, cwd);
	let model: { provider?: string; id?: string } | undefined;
	let thinkingLevel: string | undefined;
	for (const entry of manager.getBranch()) {
		const record = entry as unknown as Record<string, unknown>;
		if (record.type === "model_change") model = { provider: record.provider as string, id: record.modelId as string };
		if (record.type === "thinking_level_change") thinkingLevel = record.thinkingLevel as string;
	}
	return {
		cwd,
		sessionFile: path,
		sessionName: manager.getSessionName() ?? undefined,
		isIdle: true,
		entryCount: manager.getEntries().length,
		leafId: manager.getLeafId() ?? undefined,
		model,
		thinkingLevel,
		phase: "idle",
		host,
	};
}

/**
 * Load a session without ever writing it. `SessionManager.open` may rewrite
 * the file (header for empty files, format migration) while a terminal Pi
 * appends to it; an in-memory manager over the parsed entries never does.
 */
function openReadOnly(path: string, cwd?: string): SessionManager {
	const entries = parseSessionEntries(readFileSync(path, "utf8")) as FileEntry[];
	const header = entries.find((entry) => entry.type === "session") as { cwd?: string } | undefined;
	return SessionManager.inMemory(cwd ?? header?.cwd ?? process.cwd(), undefined, entries);
}

function rank(status: SessionStatus): number {
	return status === "stopped" ? 0 : 1;
}

function truncate(text: string, max: number): string {
	const single = text.replace(/\s+/g, " ").trim();
	return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
