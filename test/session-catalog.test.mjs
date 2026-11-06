import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { SessionCatalog } = jiti("../hub/SessionCatalog.ts");

const roots = ["/r/work", "/r/projects"];

function session(path, cwd, { name, firstMessage = "", prompts = "", minutesAgo = 0 } = {}) {
	const modified = new Date(Date.UTC(2026, 0, 1, 12, 0) - minutesAgo * 60_000);
	return { path, id: path, cwd, name, created: modified, modified, messageCount: 2, firstMessage, prompts: prompts || firstMessage };
}

function catalog(sessions) {
	return new SessionCatalog({ list: async () => sessions, cacheMs: 0 });
}

test("recent lists every running session first, then the newest stopped ones inside the roots", async () => {
	const sessions = [
		session("/s/1", "/r/work/code", { minutesAgo: 1 }),
		session("/s/2", "/r/work/code/dashboard", { minutesAgo: 2 }),
		session("/s/3", "/r/projects", { minutesAgo: 30 }),
		session("/s/4", "/elsewhere", { minutesAgo: 0 }),
		session("/s/5", "/r/work/code/storage/tmp/lab", { minutesAgo: 90 }),
	];
	const live = [
		{ file: "/s/3", cwd: "/r/projects", status: "terminal", busy: true },
		{ file: "/s/new", cwd: "/r/work/code", status: "background", busy: false },
	];
	const recent = await catalog(sessions).recent(roots, live, 2);
	assert.deepEqual(recent.map((s) => [s.path, s.status]), [
		["/s/new", "background"],
		["/s/3", "terminal"],
		["/s/1", "stopped"],
		["/s/2", "stopped"],
	]);
	assert.equal(recent[1].cwd, "/r/projects");
	assert.equal(recent[1].busy, true);
});

test("search needs every term, ranks by field and quotes the prompt it hit", async () => {
	const sessions = [
		session("/s/name", "/r/work/code", { name: "Login bug triage", minutesAgo: 50 }),
		session("/s/first", "/r/work/code", { firstMessage: "Fix the login flow, then the bug in signup", minutesAgo: 1 }),
		session("/s/prompt", "/r/work/code/dashboard", {
			firstMessage: "Start here",
			prompts: `Start here\n${"filler ".repeat(40)}now look at the LOGIN page bug please ${"tail ".repeat(40)}`,
			minutesAgo: 2,
		}),
		session("/s/folder", "/r/work/code/login-service", { firstMessage: "bug hunt", minutesAgo: 3 }),
		session("/s/half", "/r/work/code", { firstMessage: "login only", minutesAgo: 0 }),
		session("/s/outside", "/elsewhere", { name: "login bug", minutesAgo: 0 }),
	];
	const hits = await catalog(sessions).search(roots, [], "Login  BUG", 10);
	assert.deepEqual(hits.map((hit) => hit.path), ["/s/name", "/s/first", "/s/folder", "/s/prompt"]);
	assert.deepEqual(hits[0].match, { field: "name" });
	const mixed = await catalog(sessions).search(roots, [], "triage", 10);
	assert.deepEqual(mixed[0].match, { field: "name" }, "nothing to quote when only the name matched");
	const partly = await catalog([session("/s/p", "/r/work", { name: "SSO work", firstMessage: "Look at the 登录 flow" })]).search(roots, [], "sso 登录", 10);
	assert.deepEqual(partly[0].match, { field: "name", snippet: "Look at the 登录 flow" }, "the message term is quoted");
	assert.equal(hits[1].match.field, "firstMessage");
	assert.equal(hits[2].match.field, "folder");
	const quoted = hits[3].match;
	assert.equal(quoted.field, "prompt");
	assert.ok(quoted.snippet.includes("LOGIN page bug"), quoted.snippet);
	assert.ok(quoted.snippet.startsWith("…") && quoted.snippet.endsWith("…"));
	assert.ok(quoted.snippet.length <= 130);

	assert.deepEqual((await catalog(sessions).search(roots, [], "work/code/dashboard", 10)).map((hit) => hit.path), ["/s/prompt"]);
	assert.deepEqual(await catalog(sessions).search(roots, [], "   ", 10), []);
	assert.equal((await catalog(sessions).search(roots, [], "login", 2)).length, 2);
});

test("search finds a running session by name before it has a file on disk", async () => {
	const live = [{ file: "/s/fresh", cwd: "/r/projects", name: "Release notes", status: "background", busy: false }];
	const hits = await catalog([]).search(roots, live, "release", 10);
	assert.deepEqual(hits.map((hit) => [hit.path, hit.status, hit.match.field]), [["/s/fresh", "background", "name"]]);
});
