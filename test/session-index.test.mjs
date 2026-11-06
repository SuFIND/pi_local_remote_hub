import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jitiFactory from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = jitiFactory(import.meta.url);
const { SessionIndex } = jiti("../hub/SessionIndex.ts");

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function setup() {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-index-")));
	const sessions = join(base, "sessions");
	const cwd = join(base, "project");
	mkdirSync(cwd, { recursive: true });
	return { base, sessions, cwd, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function user(text, timestamp) {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text, timestamp) {
	// Real assistant messages carry fields after `timestamp`.
	return { role: "assistant", content: [{ type: "text", text }], api: "t", provider: "p", model: "m", usage, stopReason: "stop", timestamp, responseId: "r1", durationMs: 1234 };
}

function toolResult(timestamp) {
	return { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "x".repeat(50_000) }], isError: false, timestamp };
}

function comparable(info) {
	return { path: info.path, id: info.id, cwd: info.cwd, name: info.name, messageCount: info.messageCount, firstMessage: info.firstMessage, created: info.created.getTime(), modified: info.modified.getTime() };
}

async function assertMatchesPi(index, sessions) {
	const ours = (await index.list()).map(comparable);
	const pi = (await SessionManager.listAll(sessions)).map(comparable);
	assert.deepEqual(ours, pi);
}

test("the index matches Pi's own session list", async () => {
	const { sessions, cwd, cleanup } = setup();
	try {
		const a = SessionManager.create(cwd, sessions);
		a.appendMessage(user("first question", 1_000));
		a.appendMessage(assistant("answer", 2_000));
		a.appendMessage(toolResult(9_000));
		a.appendSessionInfo("Named session");
		const b = SessionManager.create(cwd, sessions);
		b.appendMessage({ role: "user", content: "plain string content", timestamp: 5_000 });
		b.appendMessage(assistant("ok", 6_000));
		b.appendSessionInfo("temp");
		b.appendSessionInfo("");
		const index = new SessionIndex({ sessionDir: sessions });
		await assertMatchesPi(index, sessions);
		const [latest] = await index.list();
		assert.equal(latest.firstMessage, "plain string content");
		assert.equal(latest.name, undefined);
	} finally {
		cleanup();
	}
});

test("every user prompt is kept for search, newest last and capped", async () => {
	const { sessions, cwd, cleanup } = setup();
	try {
		const { PROMPT_TEXT_MAX } = jiti("../hub/SessionIndex.ts");
		const manager = SessionManager.create(cwd, sessions);
		manager.appendMessage(user("first   question", 1_000));
		manager.appendMessage(assistant("assistant text is not indexed", 2_000));
		manager.appendMessage(toolResult(3_000));
		manager.appendMessage({ role: "user", content: "second\nquestion", timestamp: 4_000 });
		const index = new SessionIndex({ sessionDir: sessions });
		await assertMatchesPi(index, sessions);
		let [info] = await index.list();
		assert.equal(info.prompts, "first question\nsecond question");

		// Appended prompts are picked up incrementally; old text drops off the front.
		for (let i = 0; i < 12; i++) manager.appendMessage(user(`${i} ${"y".repeat(4_000)}`, 5_000 + i));
		[info] = await index.list();
		assert.equal(info.prompts.length, PROMPT_TEXT_MAX);
		assert.ok(info.prompts.startsWith("y") || info.prompts.startsWith("\n"));
		assert.ok(info.prompts.includes("11 yyy"));
		assert.ok(!info.prompts.includes("first question"));
		await assertMatchesPi(index, sessions);
	} finally {
		cleanup();
	}
});

test("appends are read incrementally and a half-written line waits", async () => {
	const { sessions, cwd, cleanup } = setup();
	try {
		const manager = SessionManager.create(cwd, sessions);
		manager.appendMessage(user("hello", 1_000));
		manager.appendMessage(assistant("hi", 2_000));
		const file = manager.getSessionFile();
		const index = new SessionIndex({ sessionDir: sessions });
		assert.equal((await index.list())[0].messageCount, 2);

		manager.appendMessage(user("more", 3_000));
		manager.appendMessage(assistant("sure", 4_000));
		let [info] = await index.list();
		assert.equal(info.messageCount, 4);
		assert.equal(info.modified.getTime(), 4_000);

		const line = JSON.stringify({ type: "message", id: "half", parentId: null, timestamp: new Date(5_000).toISOString(), message: user("partial", 5_000) });
		appendFileSync(file, line.slice(0, 40));
		[info] = await index.list();
		assert.equal(info.messageCount, 4);
		appendFileSync(file, `${line.slice(40)}\n`);
		[info] = await index.list();
		assert.equal(info.messageCount, 5);
		assert.equal(info.modified.getTime(), 5_000);
		await assertMatchesPi(index, sessions);
	} finally {
		cleanup();
	}
});

test("a rewritten or truncated file is parsed from scratch", async () => {
	const { sessions, cwd, cleanup } = setup();
	try {
		const manager = SessionManager.create(cwd, sessions);
		manager.appendMessage(user("original", 1_000));
		manager.appendMessage(assistant("one", 2_000));
		manager.appendMessage(assistant("two", 3_000));
		const file = manager.getSessionFile();
		const index = new SessionIndex({ sessionDir: sessions });
		assert.equal((await index.list())[0].messageCount, 3);

		// Same length or longer, but a different header (e.g. a migration).
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		const header = JSON.parse(lines[0]);
		header.id = header.id.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
		const replacement = [JSON.stringify(header), ...lines.slice(1), lines[1].replace("original", "rewritten")].join("\n");
		writeFileSync(file, `${replacement}\n`);
		let [info] = await index.list();
		assert.equal(info.id, header.id);
		await assertMatchesPi(index, sessions);

		writeFileSync(file, `${lines.slice(0, 2).join("\n")}\n`);
		[info] = await index.list();
		assert.equal(info.messageCount, 1);
		await assertMatchesPi(index, sessions);
	} finally {
		cleanup();
	}
});

test("files that are not Pi sessions are skipped and deleted files drop out", async () => {
	const { sessions, cwd, cleanup } = setup();
	try {
		mkdirSync(sessions, { recursive: true });
		writeFileSync(join(sessions, "notes.jsonl"), '{"hello":"world"}\n');
		const manager = SessionManager.create(cwd, sessions);
		manager.appendMessage(user("real", 1_000));
		manager.appendMessage(assistant("yes", 2_000));
		const index = new SessionIndex({ sessionDir: sessions });
		assert.equal((await index.list()).length, 1);
		rmSync(manager.getSessionFile());
		assert.equal((await index.list()).length, 0);
	} finally {
		cleanup();
	}
});
