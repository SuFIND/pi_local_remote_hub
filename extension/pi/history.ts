import { sanitizeForRemote } from "./sanitizer.js";

/**
 * Upper bound for one `session.history` answer. It travels as a single
 * hub frame (16 MiB limit) and a single WebSocket message (the iOS app
 * accepts 16 MiB), and a phone has to parse it in one go.
 */
export const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

export type RemoteSessionHistory = {
	entries: unknown[];
	leafId?: string;
	totalEntries: number;
	truncated: boolean;
};

/**
 * The newest `limit` entries of a branch, oldest first and sanitized,
 * trimmed further from the oldest end so the entries stay within
 * `maxBytes` of JSON. The newest entry is always included.
 */
export function selectHistory(
	branch: readonly { timestamp: string }[],
	leafId: string | undefined,
	limit?: number,
	maxBytes = HISTORY_MAX_BYTES,
): RemoteSessionHistory {
	const sorted = branch.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp));
	const total = sorted.length;
	const oldest = limit !== undefined && limit < total ? total - limit : 0;
	const entries: unknown[] = [];
	let bytes = 0;
	for (let index = total - 1; index >= oldest; index--) {
		const entry = sanitizeForRemote(sorted[index]);
		const size = Buffer.byteLength(JSON.stringify(entry) ?? "", "utf8") + 1;
		if (entries.length > 0 && bytes + size > maxBytes) break;
		entries.push(entry);
		bytes += size;
	}
	entries.reverse();
	return { entries, leafId, totalEntries: total, truncated: entries.length < total };
}
