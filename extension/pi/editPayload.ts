/**
 * Build the `edit` block attached to `pi.tool_end` events so iOS can render a
 * unified-diff review of file mutations without computing the diff itself.
 *
 * Pi already produces a unified diff for the `edit` tool — we just lift it
 * out of `tool_result.details.diff`. For `write` (new file or full overwrite)
 * Pi doesn't produce a diff, so we synthesize one against `/dev/null` so the
 * view layer sees a consistent payload.
 *
 * The `diff` field is intentionally exempt from the 20K-char sanitizer cap:
 * users explicitly want to review whole diffs on mobile no matter the size,
 * and the WebSocket frame cap (256 KB) is the only ceiling we keep.
 */

export type EditPayload = {
	filePath: string;
	diff: string;
	firstChangedLine?: number;
	stats: { added: number; removed: number };
};

/** Pull the diff out of a `tool_result` event when the tool is `edit`. */
export function extractEditPayload(event: unknown): EditPayload | null {
	if (!isObject(event)) return null;
	if (event.type !== "tool_result") return null;
	if (event.toolName !== "edit") return null;

	const input = isObject(event.input) ? event.input : null;
	const filePath = input && typeof input.path === "string" ? input.path : null;
	if (!filePath) return null;

	const details = isObject(event.details) ? event.details : null;
	const diff = details && typeof details.diff === "string" ? details.diff : null;
	if (!diff) return null;

	const firstChangedLine = details && typeof details.firstChangedLine === "number" ? details.firstChangedLine : undefined;

	// The diff is forwarded verbatim in Pi's own annotated format (per-line
	// line numbers, "…" separators, no @@ headers). The iOS app parses and
	// renders it natively — sidestepping the fragility of trying to convert
	// it into standard unified format.
	return {
		filePath,
		diff,
		firstChangedLine,
		stats: countDiffStats(diff),
	};
}

/**
 * Synthesize an all-added unified diff for a `write` tool call. Pi's write
 * tool only ships the new file content; we compose a `--- /dev/null` /
 * `+++ <path>` header so the same renderer handles new files.
 */
export function synthesizeWriteDiff(event: unknown): EditPayload | null {
	if (!isObject(event)) return null;
	if (event.type !== "tool_result") return null;
	if (event.toolName !== "write") return null;

	const input = isObject(event.input) ? event.input : null;
	const filePath = input && typeof input.path === "string" ? input.path : null;
	const content = input && typeof input.content === "string" ? input.content : null;
	if (!filePath || content == null) return null;

	const diff = buildAllAddedDiff(filePath, content);
	const stats = countDiffStats(diff);
	return { filePath, diff, firstChangedLine: 1, stats };
}

export function buildAllAddedDiff(filePath: string, content: string): string {
	// Split on \n; an empty trailing string after a final newline is dropped so
	// the hunk count reflects "real" lines rather than the file's trailing \n.
	const lines = content.split("\n");
	const trailing = lines.length > 0 && lines[lines.length - 1] === "" ? lines.pop() : undefined;
	const lineCount = lines.length;
	const header = `--- /dev/null\n+++ ${filePath}\n@@ -0,0 +1,${Math.max(lineCount, 1)} @@\n`;
	const body = lines.map((line) => `+${line}`).join("\n");
	// Preserve "missing newline at end of file" the way `git diff` does — if
	// the original content didn't end with `\n`, the last added line shouldn't
	// either.
	const trailingNewline = trailing === "" ? "\n" : "";
	return header + body + trailingNewline;
}

function countDiffStats(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		// Skip diff headers (`---`, `+++`) and hunk markers (`@@ … @@`).
		if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")) continue;
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { added, removed };
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
