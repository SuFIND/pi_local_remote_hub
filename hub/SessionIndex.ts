import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** What the phone's session list needs; mirrors Pi's `SessionInfo`. */
export type IndexedSession = {
	path: string;
	id: string;
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
};

type FileState = {
	size: number;
	mtimeMs: number;
	/** Bytes consumed so far (always just after a newline). */
	offset: number;
	headerLine?: string;
	header?: { id: string; cwd: string; timestamp: string; parentSession?: string };
	invalid: boolean;
	name?: string;
	messageCount: number;
	firstMessage: string;
	lastActivity?: number;
};

export type SessionIndexOptions = {
	/** A flat session directory (tests, `--session-dir`); defaults to Pi's per-project tree. */
	sessionDir?: string;
	concurrency?: number;
};

const HEAD_BYTES = 256;
const TAIL_BYTES = 640;
/** `"timestamp":<ms>` as a message field, not inside an escaped string. */
const MESSAGE_TIME = /(?<!\\)"timestamp":(\d+)/g;
const HEADER_PROBE_BYTES = 4_096;

/**
 * Pi's own `SessionManager.listAll()` parses every session file in full on
 * every call — seconds for a few hundred sessions with long tool output.
 * Session files are append-only JSONL, so this index remembers each file's
 * size and parse offset and only reads what was appended since, and it
 * avoids `JSON.parse` on large lines by peeking at their first and last
 * bytes. Results match `SessionInfo` (count, first user message, name,
 * last user/assistant activity).
 */
export class SessionIndex {
	private readonly files = new Map<string, FileState>();
	private scanning?: Promise<IndexedSession[]>;

	constructor(private readonly options: SessionIndexOptions = {}) {}

	/** Every session, newest first. Concurrent callers share one scan. */
	list(): Promise<IndexedSession[]> {
		this.scanning ??= this.scan().finally(() => {
			this.scanning = undefined;
		});
		return this.scanning;
	}

	private async scan(): Promise<IndexedSession[]> {
		const paths = await this.discover();
		const present = new Set(paths);
		for (const path of this.files.keys()) if (!present.has(path)) this.files.delete(path);
		const results = await mapLimit(paths, this.options.concurrency ?? 8, (path) => this.refresh(path));
		return results.filter((info): info is IndexedSession => info !== undefined).sort((a, b) => b.modified.getTime() - a.modified.getTime());
	}

	private async discover(): Promise<string[]> {
		if (this.options.sessionDir) return jsonlFiles(this.options.sessionDir);
		const root = join(getAgentDir(), "sessions");
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			return [];
		}
		const dirs = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => join(root, entry.name));
		return (await Promise.all(dirs.map(jsonlFiles))).flat();
	}

	private async refresh(path: string): Promise<IndexedSession | undefined> {
		let stats;
		try {
			stats = await stat(path);
		} catch {
			this.files.delete(path);
			return undefined;
		}
		let state = this.files.get(path);
		if (state && state.size === stats.size && state.mtimeMs === stats.mtimeMs) return toInfo(path, state, stats.mtime);
		if (!state || stats.size < state.offset || !(await this.sameHeader(path, state))) state = emptyState();
		try {
			await parseFrom(path, state);
		} catch {
			this.files.delete(path);
			return undefined;
		}
		state.size = stats.size;
		state.mtimeMs = stats.mtimeMs;
		this.files.set(path, state);
		return toInfo(path, state, stats.mtime);
	}

	/** A rewritten file (migration, fork) gets a new header; then parse from scratch. */
	private async sameHeader(path: string, state: FileState): Promise<boolean> {
		if (!state.headerLine) return state.offset === 0;
		const handle = await open(path, "r");
		try {
			const buffer = Buffer.alloc(Math.min(HEADER_PROBE_BYTES, Buffer.byteLength(state.headerLine) + 1));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			return buffer.subarray(0, bytesRead).toString("utf8") === `${state.headerLine}\n`.slice(0, bytesRead);
		} finally {
			await handle.close();
		}
	}
}

function emptyState(): FileState {
	return { size: 0, mtimeMs: 0, offset: 0, invalid: false, messageCount: 0, firstMessage: "" };
}

function toInfo(path: string, state: FileState, mtime: Date): IndexedSession | undefined {
	const header = state.header;
	if (state.invalid || !header) return undefined;
	const headerTime = new Date(header.timestamp).getTime();
	const modified = state.lastActivity && state.lastActivity > 0 ? new Date(state.lastActivity) : Number.isNaN(headerTime) ? mtime : new Date(headerTime);
	return {
		path,
		id: header.id,
		cwd: header.cwd,
		name: state.name,
		parentSessionPath: header.parentSession,
		created: new Date(header.timestamp),
		modified,
		messageCount: state.messageCount,
		firstMessage: state.firstMessage || "(no messages)",
	};
}

async function parseFrom(path: string, state: FileState): Promise<void> {
	const stream = createReadStream(path, { start: state.offset });
	let carry: Buffer | undefined;
	let consumed = state.offset;
	for await (const chunk of stream as AsyncIterable<Buffer>) {
		const buffer = carry ? Buffer.concat([carry, chunk]) : chunk;
		let start = 0;
		let newline: number;
		while ((newline = buffer.indexOf(10, start)) !== -1) {
			if (!state.invalid) consumeLine(state, buffer, start, newline);
			consumed += newline - start + 1;
			start = newline + 1;
		}
		carry = start < buffer.length ? Buffer.from(buffer.subarray(start)) : undefined;
	}
	// A trailing line without "\n" is still being written; read it next time.
	state.offset = consumed;
}

function consumeLine(state: FileState, buffer: Buffer, start: number, end: number): void {
	if (end <= start) return;
	if (!state.header) {
		const text = buffer.toString("utf8", start, end);
		const entry = parse(text);
		if (!entry) return;
		if (entry.type !== "session") {
			state.invalid = true;
			return;
		}
		state.headerLine = text;
		state.header = {
			id: String(entry.id),
			cwd: typeof entry.cwd === "string" ? entry.cwd : "",
			timestamp: String(entry.timestamp),
			parentSession: typeof entry.parentSession === "string" ? entry.parentSession : undefined,
		};
		return;
	}
	const head = buffer.toString("utf8", start, Math.min(end, start + HEAD_BYTES));
	const type = /^\{"type":"([A-Za-z_]+)"/.exec(head)?.[1];
	if (type === undefined) {
		// Not Pi's usual key order: fall back to a full parse.
		const entry = parse(buffer.toString("utf8", start, end));
		if (entry) applyEntry(state, entry);
		return;
	}
	if (type === "session_info") {
		const entry = parse(buffer.toString("utf8", start, end));
		if (entry) state.name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
		return;
	}
	if (type !== "message") return;
	const role = /"message":\{"role":"([A-Za-z]+)"/.exec(head)?.[1];
	if (role === undefined || (role === "user" && !state.firstMessage)) {
		const entry = parse(buffer.toString("utf8", start, end));
		if (entry) applyEntry(state, entry);
		return;
	}
	if (role !== "user" && role !== "assistant") {
		state.messageCount += 1;
		return;
	}
	// The message's own timestamp sits near the end (assistant messages add
	// responseId, durationMs, … after it). Without it, parse the line.
	const tail = buffer.toString("utf8", Math.max(start, end - TAIL_BYTES), end);
	const messageTime = [...tail.matchAll(MESSAGE_TIME)].at(-1)?.[1];
	if (!messageTime) {
		const entry = parse(buffer.toString("utf8", start, end));
		if (entry) applyEntry(state, entry);
		return;
	}
	state.messageCount += 1;
	state.lastActivity = Math.max(state.lastActivity ?? 0, Number(messageTime));
}

/** Same rules as Pi's `buildSessionInfo` for one parsed entry. */
function applyEntry(state: FileState, entry: Record<string, unknown>): void {
	if (entry.type === "session_info") {
		state.name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
		return;
	}
	if (entry.type !== "message") return;
	state.messageCount += 1;
	const message = entry.message as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
	if (!message || typeof message.role !== "string" || !("content" in message)) return;
	if (message.role !== "user" && message.role !== "assistant") return;
	const time = typeof message.timestamp === "number" ? message.timestamp : new Date(String(entry.timestamp)).getTime();
	if (!Number.isNaN(time)) state.lastActivity = Math.max(state.lastActivity ?? 0, time);
	if (state.firstMessage || message.role !== "user") return;
	const text = extractText(message.content);
	if (text) state.firstMessage = text;
}

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}

function parse(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) return undefined;
	try {
		const value = JSON.parse(text) as unknown;
		return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

async function jsonlFiles(dir: string): Promise<string[]> {
	try {
		return (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name));
	} catch {
		return [];
	}
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]);
		}
	});
	await Promise.all(workers);
	return results;
}
