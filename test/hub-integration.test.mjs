import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import jitiFactory from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const jiti = jitiFactory(import.meta.url);
const { HubService } = jiti("../hub/HubService.ts");
const { SessionCatalog } = jiti("../hub/SessionCatalog.ts");
const { DEFAULT_HUB_CONFIG } = jiti("../hub/HubConfig.ts");
const { HubLink } = jiti("../extension/agent/HubLink.ts");
const { SessionCommands } = jiti("../extension/agent/SessionCommands.ts");
const { QuestionBroker } = jiti("../extension/questions/QuestionBroker.ts");
const { decodeClientMessage } = jiti("../extension/protocol/ProtocolDecoder.ts");
const { hubSocketPath } = jiti("../extension/hubwire/frames.ts");
const { createHostIdentity } = jiti("../extension/identity/HostIdentity.ts");
const { createLogger } = jiti("../extension/logging/logger.ts");

const logger = createLogger("hub-test", "silent");
let nextPid = 50_000;

// MARK: phone client (mirrors the iOS app: pinned wss, fragment stripped)

function createPhone(connectUrl) {
	const url = new URL(connectUrl);
	const expected = new URLSearchParams(url.hash.slice(1)).get("fp");
	url.hash = "";
	const ws = new WebSocket(url.toString(), { rejectUnauthorized: false });
	const inbox = [];
	const waiters = [];
	let pinOk = false;
	let seq = 0;
	const closed = new Promise((resolve) => ws.on("close", (code) => resolve({ code })));
	ws.on("upgrade", (response) => {
		const der = response.socket.getPeerCertificate(false).raw;
		pinOk = createHash("sha256").update(der).digest("base64url") === expected;
		if (!pinOk) ws.terminate();
	});
	ws.on("message", (data) => {
		inbox.push(JSON.parse(data.toString()));
		for (const waiter of [...waiters]) waiter();
	});
	ws.on("error", () => {});
	const phone = {
		closed,
		get pinOk() {
			return pinOk;
		},
		/** First not-yet-consumed message matching `match` (type string or predicate). */
		next(match, timeoutMs = 2_000) {
			const predicate = typeof match === "string" ? (message) => message.type === match : match;
			return new Promise((resolve, reject) => {
				const check = () => {
					const index = inbox.findIndex(predicate);
					if (index < 0) return false;
					const [message] = inbox.splice(index, 1);
					waiters.splice(waiters.indexOf(check), 1);
					clearTimeout(timer);
					resolve(message);
					return true;
				};
				const timer = setTimeout(() => {
					waiters.splice(waiters.indexOf(check), 1);
					reject(new Error(`timed out waiting for ${typeof match === "string" ? match : "message"}; inbox: ${JSON.stringify(inbox.map((m) => m.type))}`));
				}, timeoutMs);
				waiters.push(check);
				check();
			});
		},
		has(type) {
			return inbox.some((message) => message.type === type);
		},
		send(type, payload = {}) {
			const id = `req_${++seq}`;
			ws.send(JSON.stringify({ protocolVersion: 1, id, type, payload }));
			return id;
		},
		/** Send a command and wait for its response.ok / response.error. */
		async request(type, payload, timeoutMs) {
			const id = phone.send(type, payload);
			return phone.next((message) => message.id === id && message.type.startsWith("response."), timeoutMs);
		},
		close() {
			ws.close();
		},
	};
	return phone;
}

async function pairPhone(hub) {
	const pairing = await hub.control("pair");
	const phone = createPhone(hub.status().webSocketUrl);
	const hello = await phone.next("server.hello");
	assert.equal(phone.pinOk, true);
	assert.equal(hello.payload.auth.pairingAvailable, true);
	phone.send("auth.pair.request", { code: pairing.pairingCode, deviceName: "Test iPhone" });
	const paired = await phone.next("auth.pair.success");
	return { phone, token: paired.payload.token, paired };
}

async function tokenPhone(hub, token) {
	const phone = createPhone(hub.status().webSocketUrl);
	await phone.next("server.hello");
	phone.send("auth.token", { token });
	await phone.next("auth.token.success");
	return phone;
}

// MARK: in-process Pi agents (the real HubLink + SessionCommands)

function startAgent(socketPath, { file, cwd, name, mode = "tui", pid = nextPid++, spawnToken, prompt } = {}) {
	const state = { isIdle: true, cwd, sessionFile: file, sessionName: name, phase: "idle" };
	const prompts = [];
	const notices = [];
	const mirrors = [];
	const viewerCounts = [];
	const adapter = {
		getState: () => ({ ...state }),
		getHistory: () => ({ entries: [{ id: "live-entry" }], totalEntries: 1, truncated: false }),
		prompt: prompt ?? (async (message, delivery) => prompts.push({ message, delivery })),
		abort: async () => {},
		compact: () => {},
		listModels: () => ({ models: [] }),
		listSkills: () => ({ skills: [] }),
		setModel: async () => {},
		setThinkingLevel: () => {},
	};
	let link;
	const questions = new QuestionBroker({
		onQuestion: (question) => link.broadcast("interaction.question", question),
		onResolved: (resolution) => link.broadcast("interaction.resolved", resolution),
	});
	const commands = new SessionCommands(adapter, questions);
	link = new HubLink({
		socketPath,
		logger,
		mode,
		pid,
		spawnToken,
		retryMs: 50,
		describe: () => ({ session: { file, cwd, name }, state: adapter.getState() }),
		onRequest: (envelope, reply) => void commands.handle(decodeClientMessage(Buffer.from(JSON.stringify(envelope))), reply),
		onViewers: (count) => viewerCounts.push(count),
		onNotice: (notice) => notices.push(notice),
		onMirror: (from, type, payload) => mirrors.push({ from, type, payload }),
	});
	link.start();
	return {
		link,
		file,
		pid,
		prompts,
		notices,
		mirrors,
		emit: (type, payload) => link.broadcast(type, payload),
		viewerCounts,
		questions,
		setBusy(busy) {
			state.isIdle = !busy;
			state.phase = busy ? "running" : "idle";
			link.broadcast(busy ? "pi.agent_start" : "pi.agent_settled", {});
			link.broadcast("state.changed", { reason: busy ? "agent_start" : "agent_settled", state: adapter.getState() });
		},
		stop: () => link.stop(),
	};
}

/** Stands in for `pi --mode rpc`: each "process" is an in-process agent. */
function fakeSpawner(socketPath, sessionsDir) {
	const children = new Map();
	const started = [];
	const stopped = [];
	let counter = 0;
	return {
		started,
		stopped,
		children,
		start(target) {
			const token = `tok${++counter}`;
			const file = target.sessionPath ?? join(sessionsDir, `new-${counter}.jsonl`);
			const agent = startAgent(socketPath, { file, cwd: target.cwd, mode: "rpc", spawnToken: token });
			let exit;
			const exited = new Promise((resolve) => (exit = resolve));
			const spawned = { token, target, agent, stderrTail: () => "", exited };
			spawned.exit = (code) => {
				agent.stop();
				children.delete(token);
				exit(code);
			};
			children.set(token, spawned);
			started.push(spawned);
			return spawned;
		},
		get: (token) => children.get(token),
		async stop(token) {
			const spawned = children.get(token);
			if (!spawned) return;
			stopped.push(token);
			spawned.exit(0);
		},
		async stopAll() {
			for (const token of [...children.keys()]) await this.stop(token);
		},
	};
}

function writeSession(sessionsDir, cwd, text) {
	const manager = SessionManager.create(cwd, sessionsDir);
	manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
	manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: `re: ${text}` }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	});
	return manager.getSessionFile();
}

async function eventually(check, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value) return value;
		if (Date.now() > deadline) assert.fail("condition not reached in time");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withHub(body, { idleExitMinutes = 3, idleCheckMs = 60_000, followGraceMs = 150 } = {}) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "pi-hub-")));
	const stateDir = join(base, "state");
	const sessionsDir = join(base, "sessions");
	const root = join(base, "code");
	const app = join(root, "app");
	const lib = join(root, "lib");
	const outside = join(base, "outside");
	for (const dir of [stateDir, sessionsDir, app, lib, outside]) mkdirSync(dir, { recursive: true });
	const socketPath = hubSocketPath(stateDir);
	const configPath = join(stateDir, "hub.json");
	const spawner = fakeSpawner(socketPath, sessionsDir);
	const hub = new HubService({
		stateDir,
		configPath,
		config: { ...DEFAULT_HUB_CONFIG, roots: [root], idleExitMinutes, port: 0 },
		logger,
		catalog: new SessionCatalog({ sessionDir: sessionsDir, cacheMs: 0 }),
		spawner,
		selectHost: () => "127.0.0.1",
		advertise: false,
		idleCheckMs,
		followGraceMs,
		registerTimeoutMs: 3_000,
	});
	await hub.start();
	const agents = [];
	const phones = [];
	const ctx = {
		hub,
		configPath,
		root,
		app,
		lib,
		outside,
		sessionsDir,
		spawner,
		agent: (options) => {
			const agent = startAgent(socketPath, options);
			agents.push(agent);
			return agent;
		},
		registered: (agent) => eventually(() => hub.agents.list().find((record) => record.agentId === agent.link.agentId)),
		pair: async () => {
			const result = await pairPhone(hub);
			phones.push(result.phone);
			return result;
		},
		reconnect: async (token) => {
			const phone = await tokenPhone(hub, token);
			phones.push(phone);
			return phone;
		},
	};
	try {
		await body(ctx);
	} finally {
		for (const phone of phones) phone.close();
		for (const agent of agents) agent.stop();
		await hub.stop();
		rmSync(base, { recursive: true, force: true });
	}
}

// MARK: transport and pairing

test("the hub serves pinned wss and refuses plaintext or a wrong pin", async () => {
	await withHub(async ({ hub }) => {
		const url = new URL(hub.status().webSocketUrl);
		assert.equal(url.protocol, "wss:");
		assert.equal(url.pathname, "/v1/ws");
		assert.match(url.hash, /^#fp=/);

		const plain = new WebSocket(`ws://127.0.0.1:${url.port}/v1/ws`);
		const outcome = await new Promise((resolve) => {
			plain.on("message", () => resolve("message"));
			plain.on("error", () => resolve("error"));
			plain.on("close", () => resolve("closed"));
		});
		assert.notEqual(outcome, "message");
		plain.terminate();

		url.hash = `fp=${createHostIdentity().fingerprint}`;
		const wrong = createPhone(url.toString());
		await wrong.closed;
		assert.equal(wrong.pinOk, false);
	});
});

test("a phone pairs once with the hub and reconnects with its token", async () => {
	await withHub(async ({ hub, root, pair, reconnect }) => {
		const early = createPhone(hub.status().webSocketUrl);
		await early.next("server.hello");
		const rejected = await early.request("hub.listProjects", {});
		assert.equal(rejected.type, "response.error");
		assert.equal(rejected.payload.code, "UNAUTHORIZED");
		early.close();

		const { phone, token, paired } = await pair();
		assert.deepEqual(paired.payload.hub, { roots: [root] });
		assert.equal(paired.payload.state, null);
		assert.equal(phone.has("state.snapshot"), false);
		phone.close();

		const again = await reconnect(token);
		assert.equal((await again.request("hub.listProjects", {})).type, "response.ok");
	});
});

test("revoking a device through the hub closes its socket", async () => {
	await withHub(async ({ hub, pair }) => {
		const { phone } = await pair();
		const { devices } = await hub.control("devices");
		assert.equal(devices.length, 1);
		await hub.control("revoke", { id: devices[0].id });
		assert.equal((await phone.closed).code, 4003);
	});
});

// MARK: browsing

test("the phone only browses folders and sessions inside the shared roots", async () => {
	await withHub(async ({ root, app, lib, outside, sessionsDir, pair }) => {
		const file = writeSession(sessionsDir, app, "hello hub");
		const foreign = writeSession(sessionsDir, outside, "secret");
		const { phone } = await pair();

		const projects = (await phone.request("hub.listProjects", {})).payload.result;
		assert.deepEqual(projects.roots, [root]);
		const byPath = new Map(projects.projects.map((project) => [project.path, project]));
		assert.equal(byPath.get(app).sessionCount, 1);
		assert.equal(byPath.get(lib).sessionCount, 0);
		assert.equal(byPath.has(outside), false);

		const sessions = (await phone.request("hub.listSessions", { cwd: app })).payload.result.sessions;
		assert.equal(sessions.length, 1);
		assert.equal(sessions[0].path, file);
		assert.equal(sessions[0].status, "stopped");
		assert.equal(sessions[0].firstMessage, "hello hub");

		const folders = (await phone.request("hub.listFolders", { path: root })).payload.result.folders;
		assert.deepEqual(folders.map((folder) => folder.name), ["app", "lib"]);

		for (const [type, payload] of [
			["hub.listSessions", { cwd: outside }],
			["hub.listFolders", { path: outside }],
			["hub.newSession", { cwd: outside }],
		]) {
			const response = await phone.request(type, payload);
			assert.equal(response.payload.code, "OUTSIDE_ROOTS", type);
		}
		assert.equal((await phone.request("hub.openSession", { sessionPath: foreign })).payload.code, "SESSION_UNAVAILABLE");

		const recent = (await phone.request("hub.recentSessions", { limit: 5 })).payload.result.sessions;
		assert.deepEqual(recent.map((session) => [session.path, session.cwd]), [[file, app]]);
		const found = (await phone.request("hub.searchSessions", { query: "HELLO" })).payload.result;
		assert.equal(found.query, "HELLO");
		assert.deepEqual(found.sessions.map((session) => [session.path, session.match.field]), [[file, "firstMessage"]]);
		assert.deepEqual((await phone.request("hub.searchSessions", { query: "secret" })).payload.result.sessions, []);
		assert.equal((await phone.request("session.prompt", { message: "hi" })).payload.code, "NO_SESSION");
	});
});

// MARK: live terminal sessions

test("a terminal session: commands reach its Pi and its events reach the phone", async () => {
	await withHub(async ({ app, sessionsDir, agent, registered, pair }) => {
		const file = writeSession(sessionsDir, app, "terminal work");
		const terminal = agent({ file, cwd: app, name: "Terminal" });
		await registered(terminal);
		const { phone } = await pair();

		const listed = (await phone.request("hub.listSessions", { cwd: app })).payload.result.sessions;
		assert.equal(listed[0].status, "terminal");

		const opened = (await phone.request("hub.openSession", { sessionPath: file })).payload.result;
		assert.equal(opened.session.status, "terminal");
		assert.equal(opened.state.sessionFile, file);
		await eventually(() => terminal.viewerCounts.at(-1) === 1);

		const history = await phone.request("session.history", { limit: 10 });
		assert.deepEqual(history.payload.result.entries, [{ id: "live-entry" }]);

		const prompt = await phone.request("session.prompt", { message: "from the phone", delivery: "followUp" });
		assert.equal(prompt.type, "response.ok");
		assert.deepEqual(terminal.prompts, [{ message: "from the phone", delivery: "followUp" }]);
		assert.equal((await phone.next("state.changed")).payload.reason, "promptAccepted");

		terminal.link.broadcast("pi.message_update", { text: "streaming" });
		assert.deepEqual((await phone.next("pi.message_update")).payload, { text: "streaming" });

		assert.equal((await phone.request("hub.detach", {})).type, "response.ok");
		await eventually(() => terminal.viewerCounts.at(-1) === 0);
	});
});

test("an open question is replayed to a phone that attaches later and can be answered", async () => {
	await withHub(async ({ app, sessionsDir, agent, registered, pair, reconnect }) => {
		const file = writeSession(sessionsDir, app, "needs input");
		const terminal = agent({ file, cwd: app });
		await registered(terminal);
		const answer = terminal.questions.ask({ toolCallId: "tool_1", question: "Deploy?", options: [{ label: "Yes" }, { label: "No" }] });

		const { phone, token } = await pair();
		await phone.request("hub.openSession", { sessionPath: file });
		const question = await phone.next("interaction.question");
		assert.equal(question.payload.question, "Deploy?");

		const second = await reconnect(token);
		await second.request("hub.openSession", { sessionPath: file });
		await second.next("interaction.question");

		const answered = await second.request("interaction.answer", { requestId: question.payload.requestId, answer: "Yes" });
		assert.equal(answered.type, "response.ok");
		assert.equal((await answer).answer, "Yes");
		assert.equal((await phone.next("interaction.resolved")).payload.reason, "answered");
	});
});

test("a Pi exiting mid-request answers SESSION_UNAVAILABLE", async () => {
	await withHub(async ({ app, sessionsDir, agent, registered, pair }) => {
		const file = writeSession(sessionsDir, app, "slow");
		const terminal = agent({ file, cwd: app, prompt: () => new Promise(() => {}) });
		await registered(terminal);
		const { phone } = await pair();
		await phone.request("hub.openSession", { sessionPath: file });
		const id = phone.send("session.prompt", { message: "never answered" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		terminal.stop();
		const response = await phone.next((message) => message.id === id);
		assert.equal(response.type, "response.error");
		assert.equal(response.payload.code, "SESSION_UNAVAILABLE");
	});
});

test("phones follow a Pi window that switches session, and learn when it closes", async () => {
	await withHub(async ({ app, sessionsDir, agent, registered, pair }) => {
		const first = writeSession(sessionsDir, app, "first");
		const second = writeSession(sessionsDir, app, "second");
		const before = agent({ file: first, cwd: app, pid: 4242 });
		await registered(before);
		const { phone } = await pair();
		await phone.request("hub.openSession", { sessionPath: first });

		before.stop();
		const after = agent({ file: second, cwd: app, pid: 4242 });
		const attached = await phone.next("hub.attached");
		assert.equal(attached.payload.reason, "replaced");
		assert.equal(attached.payload.session.path, second);
		assert.equal(attached.payload.session.status, "terminal");
		await phone.request("session.prompt", { message: "on the new session" });
		assert.equal(after.prompts.length, 1);

		after.stop();
		const status = await phone.next("hub.sessionStatus");
		assert.equal(status.payload.reason, "exited");
		assert.equal(status.payload.session.status, "stopped");
		assert.equal(status.payload.session.path, second);
	});
});

// MARK: sleeping sessions and hub-started Pi

test("a stopped session answers from disk, and a prompt starts Pi for it", async () => {
	await withHub(async ({ app, sessionsDir, spawner, pair }) => {
		const file = writeSession(sessionsDir, app, "resume me");
		const { phone } = await pair();

		const opened = (await phone.request("hub.openSession", { sessionPath: file })).payload.result;
		assert.equal(opened.session.status, "stopped");
		assert.equal(opened.state.isIdle, true);
		assert.equal(opened.state.sessionFile, file);
		assert.equal(opened.state.model, undefined);

		const history = (await phone.request("session.history", {})).payload.result;
		assert.equal(history.totalEntries, 2);
		assert.equal(history.entries[0].message.content[0].text, "resume me");
		assert.equal(spawner.started.length, 0);

		const prompt = await phone.request("session.prompt", { message: "continue" });
		assert.equal(prompt.type, "response.ok");
		assert.equal(spawner.started.length, 1);
		assert.deepEqual(spawner.started[0].target, { cwd: app, sessionPath: file });
		assert.equal(spawner.started[0].agent.prompts[0].message, "continue");
		const started = await phone.next("hub.sessionStatus");
		assert.equal(started.payload.reason, "started");
		assert.equal(started.payload.session.status, "background");

		const listed = (await phone.request("hub.listSessions", { cwd: app })).payload.result.sessions;
		assert.equal(listed[0].status, "background");
	});
});

test("an idle hub-started Pi exits; the phone stays on the session and wakes it again", async () => {
	await withHub(
		async ({ app, sessionsDir, spawner, pair }) => {
			const file = writeSession(sessionsDir, app, "idle test");
			const { phone } = await pair();
			await phone.request("hub.openSession", { sessionPath: file });
			await phone.request("session.prompt", { message: "one" });
			await phone.next((message) => message.type === "hub.sessionStatus" && message.payload.reason === "started");

			const idle = await phone.next((message) => message.type === "hub.sessionStatus" && message.payload.reason === "idle", 3_000);
			assert.equal(idle.payload.session.status, "stopped");
			assert.equal(idle.payload.session.path, file);
			assert.deepEqual(spawner.stopped, ["tok1"]);

			await phone.request("session.prompt", { message: "two" });
			assert.equal(spawner.started.length, 2);
			assert.equal(spawner.started[1].agent.prompts[0].message, "two");
		},
		{ idleExitMinutes: 0.003, idleCheckMs: 30 },
	);
});

test("a busy hub-started Pi is never stopped for being idle", async () => {
	await withHub(
		async ({ app, sessionsDir, spawner, pair }) => {
			const file = writeSession(sessionsDir, app, "long task");
			const { phone } = await pair();
			await phone.request("hub.openSession", { sessionPath: file });
			await phone.request("session.prompt", { message: "work" });
			spawner.started[0].agent.setBusy(true);
			await new Promise((resolve) => setTimeout(resolve, 600));
			assert.deepEqual(spawner.stopped, []);
			spawner.started[0].agent.setBusy(false);
			await eventually(() => spawner.stopped.length === 1, 3_000);
		},
		{ idleExitMinutes: 0.003, idleCheckMs: 30 },
	);
});

test("a new session starts Pi in the chosen folder", async () => {
	await withHub(async ({ lib, spawner, pair }) => {
		const { phone } = await pair();
		const created = (await phone.request("hub.newSession", { cwd: lib })).payload.result;
		assert.equal(created.session.status, "background");
		assert.equal(created.session.cwd, lib);
		assert.deepEqual(spawner.started[0].target, { cwd: lib });
		await phone.request("session.prompt", { message: "first message" });
		assert.equal(spawner.started[0].agent.prompts[0].message, "first message");

		const listed = (await phone.request("hub.listSessions", { cwd: lib })).payload.result.sessions;
		assert.equal(listed.length, 1);
		assert.equal(listed[0].path, created.session.path);
	});
});

// MARK: one writer per session

test("opening a session in a terminal takes it over from an idle hub-started Pi", async () => {
	await withHub(async ({ app, sessionsDir, spawner, agent, pair }) => {
		const file = writeSession(sessionsDir, app, "handoff");
		const { phone } = await pair();
		await phone.request("hub.openSession", { sessionPath: file });
		await phone.request("session.prompt", { message: "from phone" });
		await phone.next("hub.sessionStatus");

		const terminal = agent({ file, cwd: app });
		const attached = await phone.next("hub.attached");
		assert.equal(attached.payload.session.status, "terminal");
		await eventually(() => spawner.stopped.length === 1);
		assert.deepEqual(terminal.notices, []);

		await phone.request("session.prompt", { message: "now in the terminal" });
		assert.equal(terminal.prompts[0].message, "now in the terminal");
	});
});

test("a terminal waits for a busy hub-started Pi, then takes over and reloads", async () => {
	await withHub(async ({ app, sessionsDir, spawner, agent, pair }) => {
		const file = writeSession(sessionsDir, app, "busy handoff");
		const { phone } = await pair();
		await phone.request("hub.openSession", { sessionPath: file });
		await phone.request("session.prompt", { message: "long run" });
		await phone.next("hub.sessionStatus");
		const background = spawner.started[0].agent;
		background.setBusy(true);
		await new Promise((resolve) => setTimeout(resolve, 50));

		const terminal = agent({ file, cwd: app });
		await eventually(() => terminal.notices.length === 1);
		assert.equal(terminal.notices[0].level, "warning");
		assert.equal(terminal.notices[0].handoffReady, undefined);
		assert.equal(spawner.stopped.length, 0);
		assert.equal(phone.has("hub.attached"), false);

		// Meanwhile the terminal shows the phone's run live.
		await eventually(() => terminal.mirrors.length === 1);
		assert.equal(terminal.mirrors[0].type, "mirror.start");
		assert.deepEqual(terminal.mirrors[0].from, { pid: background.pid, background: true });
		const delta = { source: "pi", name: "message_update", data: { message: { role: "assistant", content: [{ type: "text", text: "half" }] } } };
		background.emit("pi.message_delta", delta);
		await eventually(() => terminal.mirrors.length === 2);
		assert.deepEqual(terminal.mirrors[1].payload, delta);

		background.setBusy(false);
		const attached = await phone.next("hub.attached");
		assert.equal(attached.payload.session.status, "terminal");
		await eventually(() => terminal.notices.length === 2);
		assert.equal(terminal.notices[1].handoffReady, true);
		assert.equal(terminal.mirrors.at(-1).type, "mirror.stop");
		await eventually(() => spawner.stopped.length === 1);
	});
});

test("two terminals on one session file show each other's runs and reload after them", async () => {
	await withHub(async ({ app, sessionsDir, agent, registered }) => {
		const file = writeSession(sessionsDir, app, "shared");
		const first = agent({ file, cwd: app });
		await registered(first);
		const second = agent({ file, cwd: app });
		await eventually(() => second.notices.length === 1);
		assert.match(second.notices[0].message, /also open in another Pi window/);
		assert.deepEqual(first.notices, []);

		first.setBusy(true);
		first.emit("pi.tool_start", { source: "pi", name: "tool_execution_start", data: { toolCallId: "t1", toolName: "bash", args: { command: "ls" } } });
		await eventually(() => second.mirrors.length === 2);
		assert.deepEqual(second.mirrors.map((m) => m.type), ["pi.agent_start", "pi.tool_start"]);
		assert.deepEqual(second.mirrors[0].from, { pid: first.pid, background: false });
		assert.deepEqual(first.mirrors, []);

		first.setBusy(false);
		await eventually(() => second.notices.length === 2);
		assert.equal(second.notices[1].reload, true);
		assert.deepEqual(first.notices, []);

		// And the other way round.
		second.setBusy(true);
		await eventually(() => first.mirrors.length === 1);
		second.setBusy(false);
		await eventually(() => first.notices.length === 1);
		assert.equal(first.notices[0].reload, true);

		second.stop();
		await eventually(() => first.mirrors.at(-1).type === "mirror.stop");
	});
});

test("a sleeping session's phone follows a terminal that opens it", async () => {
	await withHub(async ({ app, sessionsDir, agent, pair }) => {
		const file = writeSession(sessionsDir, app, "wake by terminal");
		const { phone } = await pair();
		await phone.request("hub.openSession", { sessionPath: file });
		const terminal = agent({ file, cwd: app });
		const attached = await phone.next("hub.attached");
		assert.equal(attached.payload.session.status, "terminal");
		await phone.request("session.prompt", { message: "hello terminal" });
		assert.equal(terminal.prompts[0].message, "hello terminal");
	});
});

test("pi-remote control ops: status reports roots, agents and the pinned URL", async () => {
	await withHub(async ({ hub, root, app, sessionsDir, agent, registered }) => {
		await registered(agent({ file: writeSession(sessionsDir, app, "x"), cwd: app }));
		const status = await hub.control("status");
		assert.equal(status.running, true);
		assert.equal(status.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
		assert.deepEqual(status.roots, [root]);
		assert.equal(status.agents, 1);
		assert.equal(status.idleExitMinutes, 3);
		assert.match(status.webSocketUrl, /^wss:\/\/127\.0\.0\.1:\d+\/v1\/ws#fp=/);
	});
});

// MARK: menu bar app

test("overview lists each Pi, the phones watching it, devices and roots", async () => {
	await withHub(async ({ hub, root, app, outside, sessionsDir, agent, registered, pair }) => {
		const file = writeSession(sessionsDir, app, "menu");
		await registered(agent({ file, cwd: app, name: "Menu work" }));
		await registered(agent({ cwd: outside }));
		const { phone } = await pair();
		await phone.request("hub.openSession", { sessionPath: file });

		const overview = await hub.control("overview");
		assert.equal(overview.pid, process.pid);
		assert.deepEqual(overview.roots, [root]);
		assert.equal(overview.status.running, true);
		const shared = overview.agents.find((entry) => entry.cwd === app);
		assert.equal(shared.origin, "terminal");
		assert.equal(shared.sessionName, "Menu work");
		assert.equal(shared.sessionFile, file);
		assert.equal(shared.shared, true);
		assert.deepEqual(shared.viewers, ["Test iPhone"]);
		const hidden = overview.agents.find((entry) => entry.cwd === outside);
		assert.equal(hidden.shared, false);
		assert.deepEqual(hidden.viewers, []);
		assert.equal(overview.phones.length, 1);
		assert.equal(overview.phones[0].deviceName, "Test iPhone");
		assert.equal(overview.phones[0].agentId, shared.agentId);
		assert.equal(overview.phones[0].session.path, file);
		assert.deepEqual(overview.devices.map((device) => device.name), ["Test iPhone"]);

		const pairing = await hub.control("pair");
		assert.match(pairing.pairingLink, /^pi-remote:\/\/pair\?/);
		assert.ok(pairing.pairingLink.includes(`code=${pairing.pairingCode}`));
	});
});

test("menu bar ops save roots and idle time, and stop only hub-started Pi", async () => {
	await withHub(async ({ hub, configPath, root, app, lib, outside, sessionsDir, agent, registered, pair, spawner }) => {
		const saved = () => JSON.parse(readFileSync(configPath, "utf8"));
		assert.deepEqual((await hub.control("addRoot", { path: outside })).roots, [root, outside]);
		assert.deepEqual(saved().roots, [root, outside]);
		await assert.rejects(hub.control("addRoot", { path: join(outside, "missing") }), /Not a folder/);
		assert.deepEqual((await hub.control("removeRoot", { path: outside })).roots, [root]);
		assert.deepEqual(saved().roots, [root]);
		assert.equal((await hub.control("setIdle", { minutes: 7 })).idleExitMinutes, 7);
		assert.equal(saved().idleExitMinutes, 7);
		await assert.rejects(hub.control("setIdle", { minutes: 0 }), /between/);

		const terminal = await registered(agent({ file: writeSession(sessionsDir, app, "t"), cwd: app }));
		await assert.rejects(hub.control("stopAgent", { agentId: terminal.agentId }), /terminal/);
		await assert.rejects(hub.control("stopAgent", { agentId: "nope" }), /no longer running/);

		const { phone } = await pair();
		await phone.request("hub.newSession", { cwd: lib });
		const background = (await hub.control("overview")).agents.find((entry) => entry.origin === "background");
		assert.ok(background);
		await hub.control("stopAgent", { agentId: background.agentId });
		assert.deepEqual(spawner.stopped, ["tok1"]);
		const status = await phone.next((message) => message.type === "hub.sessionStatus" && message.payload.reason === "exited");
		assert.equal(status.payload.session.status, "stopped");
	});
});
