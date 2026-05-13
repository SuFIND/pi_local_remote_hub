import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { extractEditPayload, synthesizeWriteDiff, buildAllAddedDiff } = jiti("../extension/pi/editPayload.ts");

test("extractEditPayload pulls diff out of an edit tool_result", () => {
	const event = {
		type: "tool_result",
		toolCallId: "tool_1",
		toolName: "edit",
		input: { path: "src/foo.swift", edits: [{ oldText: "let a", newText: "let b" }] },
		content: [{ type: "text", text: "edited" }],
		isError: false,
		details: {
			diff: "@@ -1,1 +1,1 @@\n-let a\n+let b\n",
			firstChangedLine: 1,
		},
	};
	const payload = extractEditPayload(event);
	assert.equal(payload.filePath, "src/foo.swift");
	assert.equal(payload.diff, "@@ -1,1 +1,1 @@\n-let a\n+let b\n");
	assert.equal(payload.firstChangedLine, 1);
	assert.equal(payload.stats.added, 1);
	assert.equal(payload.stats.removed, 1);
});

test("extractEditPayload returns null for non-edit tool results", () => {
	assert.equal(
		extractEditPayload({ type: "tool_result", toolName: "bash", input: {}, isError: false, content: [] }),
		null,
	);
	assert.equal(extractEditPayload({ type: "tool_call", toolName: "edit", input: { path: "x" } }), null);
});

test("extractEditPayload returns null when diff is missing", () => {
	const event = {
		type: "tool_result",
		toolName: "edit",
		input: { path: "src/foo.swift" },
		isError: false,
		content: [],
		details: undefined,
	};
	assert.equal(extractEditPayload(event), null);
});

test("synthesizeWriteDiff produces an all-added diff for a write tool_result", () => {
	const event = {
		type: "tool_result",
		toolCallId: "tool_2",
		toolName: "write",
		input: { path: "src/new.swift", content: "line one\nline two\nline three\n" },
		content: [],
		isError: false,
		details: undefined,
	};
	const payload = synthesizeWriteDiff(event);
	assert.equal(payload.filePath, "src/new.swift");
	assert.match(payload.diff, /^--- \/dev\/null\n\+\+\+ src\/new\.swift\n@@ -0,0 \+1,3 @@\n\+line one\n\+line two\n\+line three\n$/);
	assert.equal(payload.stats.added, 3);
	assert.equal(payload.stats.removed, 0);
});

test("synthesizeWriteDiff preserves missing trailing newline", () => {
	const payload = synthesizeWriteDiff({
		type: "tool_result",
		toolName: "write",
		input: { path: "x.txt", content: "one\ntwo" },
		isError: false,
		content: [],
		details: undefined,
	});
	assert.equal(payload.diff.endsWith("\n"), false);
	assert.equal(payload.stats.added, 2);
});

test("buildAllAddedDiff handles an empty file as a single added blank line", () => {
	const diff = buildAllAddedDiff("empty.txt", "");
	assert.match(diff, /@@ -0,0 \+1,1 @@/);
});

test("extractEditPayload forwards Pi's annotated diff verbatim", () => {
	const piDiff = "+ 15 const roster: Pet[] = [\n- 15 const pets: Pet[] = [";
	const event = {
		type: "tool_result",
		toolCallId: "tool_pi_1",
		toolName: "edit",
		input: { path: "test.ts", edits: [{ oldText: "const pets", newText: "const roster" }] },
		isError: false,
		content: [],
		details: { diff: piDiff, firstChangedLine: 15 },
	};
	const payload = extractEditPayload(event);
	assert.equal(payload.diff, piDiff);
	assert.equal(payload.stats.added, 1);
	assert.equal(payload.stats.removed, 1);
});
