import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parseSessionEntries, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";
import { selectHistory, type RemoteSessionHistory } from "../extension/pi/history.js";
import { canonicalPath, expandHome, isInsideRoots } from "./HubConfig.js";
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
	/** The folder Pi runs the session in. */
	cwd: string;
	id?: string;
	name?: string;
	firstMessage: string;
	modified?: string;
	messageCount: number;
	status: SessionStatus;
	busy: boolean;
};

/** Where a search hit its first term, with the text around it. */
export type SessionMatch = { field: "name" | "firstMessage" | "prompt" | "folder"; snippet?: string };

export type SessionSearchHit = SessionSummary & { match?: SessionMatch };

export type CatalogOptions = {
	/**
	 * Pi's session directory. Defaults like Pi: `PI_CODING_AGENT_SESSION_DIR`
	 * (one flat folder), else one folder per cwd under `~/.pi/agent/sessions`.
	 */
	sessionDir?: string;
	cacheMs?: number;
	list?: () => Promise<IndexedSession[]>;
};

/** Pi's `PI_CODING_AGENT_SESSION_DIR`; the hub and the Pi it starts share it. */
function envSessionDir(): string | undefined {
	const value = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
	return value ? expandHome(value) : undefined;
}

const IGNORED_FOLDERS = new Set(["node_modules", "Library", "Applications"]);
const FIRST_MESSAGE_CHARS = 240;
const SNIPPET_CHARS = 120;
const MAX_QUERY_TERMS = 8;
/** Field weights: a hit in the name says more than one somewhere in the prompts. */
const FIELD_WEIGHT = { name: 8, firstMessage: 4, folder: 2, prompt: 1 } as const;

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
		const index = new SessionIndex({ sessionDir: options.sessionDir ?? envSessionDir() });
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
		const entries = await this.entries(live, (path) => path === folder);
		return entries.map((entry) => entry.summary).sort(byStatusThenRecent);
	}

	/**
	 * Every running session inside the roots, then the `limit` most recently
	 * active stopped ones.
	 */
	async recent(roots: readonly string[], live: readonly LiveSession[], limit: number): Promise<SessionSummary[]> {
		const summaries = (await this.entries(live, (path) => isInsideRoots(path, roots))).map((entry) => entry.summary).sort(byStatusThenRecent);
		const running = summaries.filter((summary) => summary.status !== "stopped");
		const stopped = summaries.filter((summary) => summary.status === "stopped").slice(0, limit);
		return [...running, ...stopped];
	}

	/**
	 * Sessions inside the roots whose name, first message, prompts or folder
	 * (relative to its root) contain every whitespace-separated term of
	 * `query`, case-insensitively. Best field first, then running, then recent.
	 */
	async search(roots: readonly string[], live: readonly LiveSession[], query: string, limit: number): Promise<SessionSearchHit[]> {
		const terms = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, MAX_QUERY_TERMS);
		if (terms.length === 0) return [];
		const hits: { hit: SessionSearchHit; score: number }[] = [];
		for (const { summary, prompts } of await this.entries(live, (path) => isInsideRoots(path, roots))) {
			const root = roots.find((candidate) => isInsideRoots(summary.cwd, [candidate]));
			const fields = {
				name: summary.name ?? "",
				firstMessage: summary.firstMessage,
				folder: root ? `${basename(root)}/${relative(root, canonicalPath(summary.cwd))}` : summary.cwd,
				prompt: prompts,
			};
			const lower = { name: fields.name.toLowerCase(), firstMessage: fields.firstMessage.toLowerCase(), folder: fields.folder.toLowerCase(), prompt: fields.prompt.toLowerCase() };
			let score = 0;
			let first: SessionMatch["field"] | undefined;
			let quoted: { field: "firstMessage" | "prompt"; term: string } | undefined;
			for (const term of terms) {
				const field = (Object.keys(FIELD_WEIGHT) as SessionMatch["field"][]).find((key) => lower[key].includes(term));
				if (!field) {
					score = 0;
					break;
				}
				score += FIELD_WEIGHT[field];
				first ??= field;
				if (!quoted && (field === "firstMessage" || field === "prompt")) quoted = { field, term };
			}
			if (score === 0 || !first) continue;
			const match: SessionMatch = { field: first };
			// The row shows the title and folder already; quote the message
			// text that a term was found in, so the hit explains itself.
			if (quoted) match.snippet = snippet(fields[quoted.field], lower[quoted.field], quoted.term);
			hits.push({ hit: { ...summary, match }, score });
		}
		return hits
			.sort((a, b) => b.score - a.score || byStatusThenRecent(a.hit, b.hit))
			.slice(0, limit)
			.map((entry) => entry.hit);
	}

	/** Saved and brand-new running sessions whose canonical cwd passes `include`. */
	private async entries(live: readonly LiveSession[], include: (cwd: string) => boolean): Promise<{ summary: SessionSummary; prompts: string }[]> {
		const liveByFile = new Map(live.filter((agent) => agent.file).map((agent) => [canonicalPath(agent.file!), agent]));
		const entries: { summary: SessionSummary; prompts: string }[] = [];
		const seen = new Set<string>();
		for (const session of await this.allSessions()) {
			if (!session.cwd || !include(canonicalPath(session.cwd))) continue;
			const path = canonicalPath(session.path);
			const agent = liveByFile.get(path);
			seen.add(path);
			entries.push({
				summary: {
					path: session.path,
					cwd: session.cwd,
					id: session.id,
					name: session.name ?? agent?.name,
					firstMessage: truncate(session.firstMessage, FIRST_MESSAGE_CHARS),
					modified: session.modified.toISOString(),
					messageCount: session.messageCount,
					status: agent?.status ?? "stopped",
					busy: agent?.busy ?? false,
				},
				prompts: session.prompts ?? "",
			});
		}
		// A brand-new session has no file on disk until its first message.
		for (const agent of live) {
			if (!agent.file || !include(canonicalPath(agent.cwd)) || seen.has(canonicalPath(agent.file))) continue;
			entries.push({
				summary: {
					path: agent.file,
					cwd: agent.cwd,
					name: agent.name,
					firstMessage: "",
					modified: new Date().toISOString(),
					messageCount: 0,
					status: agent.status,
					busy: agent.busy,
				},
				prompts: "",
			});
		}
		return entries;
	}
}

function byStatusThenRecent(a: SessionSummary, b: SessionSummary): number {
	return rank(b.status) - rank(a.status) || (b.modified ?? "").localeCompare(a.modified ?? "");
}

/** About `SNIPPET_CHARS` of `text` around the first `term`, on word-ish edges. */
function snippet(text: string, lower: string, term: string): string {
	const at = Math.max(0, lower.indexOf(term));
	const lead = Math.floor((SNIPPET_CHARS - term.length) / 3);
	let start = Math.max(0, at - lead);
	let end = Math.min(text.length, start + SNIPPET_CHARS);
	start = Math.max(0, end - SNIPPET_CHARS);
	if (start > 0) {
		const space = text.lastIndexOf(" ", at);
		if (space > start && space - start < 20) start = space + 1;
	}
	if (end < text.length) {
		const space = text.indexOf(" ", end - 20);
		if (space !== -1 && space < end) end = space;
	}
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
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
	return selectHistory(manager.getBranch(), manager.getLeafId() ?? undefined, limit);
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
