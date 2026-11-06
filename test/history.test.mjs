import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { selectHistory } = jiti("../extension/pi/history.ts");

function entry(index, textBytes = 10) {
	return {
		type: "message",
		id: `e${index}`,
		parentId: index > 0 ? `e${index - 1}` : null,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
		message: { role: "user", content: [{ type: "text", text: "x".repeat(textBytes) }] },
	};
}

test("history keeps the newest entries, oldest first", () => {
	const branch = [entry(2), entry(0), entry(1), entry(3)];
	const history = selectHistory(branch, "e3", 3);
	assert.deepEqual(history.entries.map((e) => e.id), ["e1", "e2", "e3"]);
	assert.equal(history.totalEntries, 4);
	assert.equal(history.truncated, true);
	assert.equal(history.leafId, "e3");
	assert.equal(selectHistory(branch, "e3").truncated, false);
});

test("history stays within the byte budget, dropping the oldest entries", () => {
	const branch = Array.from({ length: 10 }, (_, index) => entry(index, 1_000));
	const one = Buffer.byteLength(JSON.stringify(branch[0])) + 1;
	const history = selectHistory(branch, "e9", 200, one * 3 + 10);
	assert.deepEqual(history.entries.map((e) => e.id), ["e7", "e8", "e9"]);
	assert.equal(history.truncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(history.entries)) <= one * 3 + 10);
});

test("history always includes the newest entry even when it alone is over budget", () => {
	const history = selectHistory([entry(0), entry(1, 5_000)], "e1", 200, 100);
	assert.deepEqual(history.entries.map((e) => e.id), ["e1"]);
	assert.equal(history.truncated, true);
});
