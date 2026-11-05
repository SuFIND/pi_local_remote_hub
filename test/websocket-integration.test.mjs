import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { DeviceTrust } = jiti("../extension/auth/DeviceTrust.ts");
const { DEFAULT_REMOTE_CONFIG } = jiti("../extension/config.ts");
const { createLogger } = jiti("../extension/logging/logger.ts");
const { QuestionBroker } = jiti("../extension/questions/QuestionBroker.ts");
const { RemoteServer } = jiti("../extension/server/RemoteServer.ts");
const { FileTrustStore } = jiti("../extension/auth/TrustStore.ts");
const { createHostIdentity } = jiti("../extension/identity/HostIdentity.ts");

const TEST_IDENTITY = createHostIdentity();
const TEST_CONFIG = { ...DEFAULT_REMOTE_CONFIG, host: "127.0.0.1", port: 0 };

/**
 * Mirrors the iOS client: dial `wss://…` with the `#fp=` fragment stripped,
 * skip CA validation, and pin the SHA-256 of the leaf certificate DER.
 */
function createClient(connectUrl) {
	const url = new URL(connectUrl);
	const expectedFingerprint = new URLSearchParams(url.hash.slice(1)).get("fp");
	url.hash = "";
	const ws = new WebSocket(url.toString(), { rejectUnauthorized: false });
	const queue = [];
	const waiters = [];
	const closed = new Promise((resolve) => ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })));
	let pinOk = false;
	ws.on("upgrade", (response) => {
		const der = response.socket.getPeerCertificate(false).raw;
		const actual = createHash("sha256").update(der).digest("base64url");
		pinOk = actual === expectedFingerprint;
		if (!pinOk) ws.terminate();
	});

	ws.on("message", (data) => {
		const message = JSON.parse(data.toString());
		const waiter = waiters.shift();
		if (waiter) waiter.resolve(message);
		else queue.push(message);
	});
	ws.on("error", (error) => {
		const waiter = waiters.shift();
		if (waiter) waiter.reject(error);
	});

	return {
		ws,
		closed,
		get pinOk() {
			return pinOk;
		},
		read(timeoutMs = 1_000) {
			if (queue.length > 0) return Promise.resolve(queue.shift());
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
				waiters.push({
					resolve: (value) => {
						clearTimeout(timer);
						resolve(value);
					},
					reject: (error) => {
						clearTimeout(timer);
						reject(error);
					},
				});
			});
		},
		expectNoMessage(timeoutMs = 100) {
			return this.read(timeoutMs).then(
				(message) => assert.fail(`expected no message, received ${JSON.stringify(message)}`),
				(error) => assert.equal(error.message, "timeout"),
			);
		},
		close() {
			ws.close();
		},
	};
}

function send(client, value) {
	client.ws.send(JSON.stringify({ protocolVersion: 1, ...value }));
}

async function withServer(testBody, options = {}) {
	const deviceTrust = options.deviceTrust ?? new DeviceTrust();
	const prompts = [];
	const adapter = {
		getState: () => ({ isIdle: true, cwd: "/tmp/pi-remote-test" }),
		prompt: async (message, delivery) => {
			prompts.push({ message, delivery });
		},
		abort: async () => {},
		compact: () => {},
		listSkills: () => ({
			skills: [{ name: "skill:diagnose", description: "Diagnose bugs" }],
		}),
	};
	let server;
	const questions = new QuestionBroker({
		onQuestion: (question) => server.broadcast("interaction.question", question),
		onResolved: (resolution) => server.broadcast("interaction.resolved", resolution),
	});
	server = new RemoteServer({
		config: DEFAULT_REMOTE_CONFIG,
		logger: createLogger("test", "silent"),
		adapter,
		deviceTrust,
		identity: options.identity ?? TEST_IDENTITY,
		questions,
		getState: () => adapter.getState(),
	});
	await server.start({ ...TEST_CONFIG, ...options.config });
	try {
		await testBody({ server, deviceTrust, adapter, prompts, questions });
	} finally {
		await server.stop();
	}
}

async function pairClient(server, deviceTrust) {
	const pairing = deviceTrust.startPairing();
	const client = createClient(server.getWebSocketUrl());
	const hello = await client.read();
	assert.equal(hello.type, "server.hello");
	assert.equal(client.pinOk, true);
	assert.equal(hello.payload.auth.pairingAvailable, true);
	assert.equal(hello.payload.capabilities.features.sequenceNumbers, true);
	assert.equal(hello.payload.capabilities.features.stableOkEnvelope, true);
	assert.equal(hello.payload.capabilities.commands.includes("session.listSkills"), true);
	assert.equal(hello.payload.capabilities.commands.includes("interaction.answer"), true);

	send(client, {
		id: "pair_1",
		type: "auth.pair.request",
		payload: { code: pairing.code, deviceName: "Test iPhone" },
	});
	const paired = await client.read();
	assert.equal(paired.type, "auth.pair.success");
	assert.equal(typeof paired.payload.token, "string");
	const snapshot = await client.read();
	assert.equal(snapshot.type, "state.snapshot");
	return { client, token: paired.payload.token };
}

test("WebSocket rejects authenticated commands before auth", async () => {
	await withServer(async ({ server }) => {
		const client = createClient(server.getWebSocketUrl());
		assert.equal((await client.read()).type, "server.hello");

		send(client, { id: "state_1", type: "session.getState", payload: {} });
		const response = await client.read();
		assert.equal(response.id, "state_1");
		assert.equal(response.type, "response.error");
		assert.equal(response.payload.code, "UNAUTHORIZED");
		client.close();
	});
});

test("WebSocket pairs, returns state, and reconnects with token", async () => {
	await withServer(async ({ server, deviceTrust }) => {
		const { client, token } = await pairClient(server, deviceTrust);

		send(client, { id: "state_1", type: "session.getState", payload: {} });
		const state = await client.read();
		assert.equal(state.type, "response.ok");
		assert.equal(state.id, "state_1");
		assert.equal(state.payload.ok, true);
		assert.equal(state.payload.command, "session.getState");
		assert.equal(state.payload.result.state.cwd, "/tmp/pi-remote-test");
		client.close();

		const reconnect = createClient(server.getWebSocketUrl());
		assert.equal((await reconnect.read()).type, "server.hello");
		send(reconnect, { id: "token_1", type: "auth.token", payload: { token } });
		const auth = await reconnect.read();
		assert.equal(auth.type, "auth.token.success");
		assert.equal(auth.id, "token_1");
		assert.equal((await reconnect.read()).type, "state.snapshot");
		reconnect.close();
	});
});

test("WebSocket returns the active Pi skills after auth", async () => {
	await withServer(async ({ server, deviceTrust }) => {
		const { client } = await pairClient(server, deviceTrust);

		send(client, { id: "skills_1", type: "session.listSkills", payload: {} });
		const response = await client.read();
		assert.equal(response.type, "response.ok");
		assert.equal(response.id, "skills_1");
		assert.equal(response.payload.command, "session.listSkills");
		assert.deepEqual(response.payload.result, {
			skills: [{ name: "skill:diagnose", description: "Diagnose bugs" }],
		});
		client.close();
	});
});

test("WebSocket session.prompt calls the Pi adapter only after auth", async () => {
	await withServer(async ({ server, deviceTrust, prompts }) => {
		const { client } = await pairClient(server, deviceTrust);

		send(client, { id: "prompt_1", type: "session.prompt", payload: { message: "Run tests", delivery: "followUp" } });
		const response = await client.read();
		assert.equal(response.type, "response.ok");
		assert.equal(response.payload.ok, true);
		assert.equal(response.payload.command, "session.prompt");
		assert.equal(response.payload.result.accepted, true);
		assert.deepEqual(prompts, [{ message: "Run tests", delivery: "followUp" }]);

		const changed = await client.read();
		assert.equal(changed.type, "state.changed");
		assert.equal(changed.payload.reason, "promptAccepted");
		assert.equal(changed.payload.state.cwd, "/tmp/pi-remote-test");
		client.close();
	});
});

test("WebSocket restores and answers a pending question after token reconnect", async () => {
	await withServer(async ({ server, deviceTrust, questions }) => {
		const { client, token } = await pairClient(server, deviceTrust);
		const answerPromise = questions.ask({
			toolCallId: "tool_question_1",
			question: "Which target?",
			options: [{ label: "Simulator" }, { label: "Device" }],
		});
		const question = await client.read();
		assert.equal(question.type, "interaction.question");
		assert.equal(question.payload.question, "Which target?");
		client.close();

		const reconnect = createClient(server.getWebSocketUrl());
		assert.equal((await reconnect.read()).type, "server.hello");
		send(reconnect, { id: "token_question", type: "auth.token", payload: { token } });
		assert.equal((await reconnect.read()).type, "auth.token.success");
		assert.equal((await reconnect.read()).type, "state.snapshot");
		const restored = await reconnect.read();
		assert.equal(restored.type, "interaction.question");
		assert.equal(restored.payload.requestId, question.payload.requestId);

		send(reconnect, {
			id: "answer_1",
			type: "interaction.answer",
			payload: { requestId: restored.payload.requestId, answer: "Simulator" },
		});
		const resolved = await reconnect.read();
		assert.equal(resolved.type, "interaction.resolved");
		assert.equal(resolved.payload.answer, "Simulator");
		const response = await reconnect.read();
		assert.equal(response.type, "response.ok");
		assert.equal(response.payload.command, "interaction.answer");
		assert.deepEqual(await answerPromise, { answer: "Simulator", wasCustom: false });
		reconnect.close();
	});
});

test("WebSocket broadcasts Pi events only to authenticated clients", async () => {
	await withServer(async ({ server, deviceTrust }) => {
		const unauthenticated = createClient(server.getWebSocketUrl());
		assert.equal((await unauthenticated.read()).type, "server.hello");

		const { client: authenticated } = await pairClient(server, deviceTrust);
		server.broadcast("pi.agent_start", { source: "pi", name: "agent_start", data: { turn: 1 } });

		const event = await authenticated.read();
		assert.equal(event.type, "pi.agent_start");
		assert.deepEqual(event.payload, { source: "pi", name: "agent_start", data: { turn: 1 } });
		await unauthenticated.expectNoMessage();

		unauthenticated.close();
		authenticated.close();
	});
});

test("WebSocket URL is wss:// and carries the certificate pin", async () => {
	await withServer(async ({ server }) => {
		const url = new URL(server.getWebSocketUrl());
		assert.equal(url.protocol, "wss:");
		assert.equal(url.hostname, "127.0.0.1");
		assert.equal(url.pathname, "/v1/ws");
		assert.equal(url.hash, `#fp=${TEST_IDENTITY.fingerprint}`);
		assert.equal(server.getDisplayWebSocketUrl(), `wss://127.0.0.1:${url.port}/v1/ws`);
		assert.match(server.getUrl(), /^https:\/\/127\.0\.0\.1:\d+$/);
	});
});

test("WebSocket refuses plaintext ws:// clients", async () => {
	await withServer(async ({ server }) => {
		const url = new URL(server.getWebSocketUrl());
		const ws = new WebSocket(`ws://127.0.0.1:${url.port}/v1/ws`);
		const outcome = await new Promise((resolve) => {
			ws.on("message", () => resolve("message"));
			ws.on("error", () => resolve("error"));
			ws.on("close", () => resolve("closed"));
		});
		assert.notEqual(outcome, "message");
		ws.terminate();
	});
});

test("A client pinning a different fingerprint rejects the server", async () => {
	await withServer(async ({ server }) => {
		const other = createHostIdentity();
		const url = new URL(server.getWebSocketUrl());
		url.hash = `fp=${other.fingerprint}`;
		const client = createClient(url.toString());
		await client.closed;
		assert.equal(client.pinOk, false);
	});
});

test("Revoking a device closes its live socket and rejects its token", async () => {
	await withServer(async ({ server, deviceTrust }) => {
		const { client, token } = await pairClient(server, deviceTrust);
		const [device] = deviceTrust.listTrustedDevices();
		const result = deviceTrust.revokeDevice(device.id.slice(0, 6));
		assert.equal(result.ok, true);
		assert.equal(server.disconnectDevice(device.id), 1);
		assert.equal((await client.closed).code, 4003);

		const reconnect = createClient(server.getWebSocketUrl());
		assert.equal((await reconnect.read()).type, "server.hello");
		send(reconnect, { id: "token_revoked", type: "auth.token", payload: { token } });
		const rejected = await reconnect.read();
		assert.equal(rejected.type, "response.error");
		assert.equal(rejected.payload.code, "UNAUTHORIZED");
		reconnect.close();
	});
});

test("Paired devices survive a restart with a file trust store, and revocation elsewhere drops the socket", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-remote-trust-"));
	const trustPath = join(dir, "trusted-devices.json");
	try {
		let token;
		await withServer(
			async ({ server, deviceTrust }) => {
				({ token } = await pairClient(server, deviceTrust).then(({ client, token }) => {
					client.close();
					return { token };
				}));
			},
			{ deviceTrust: new DeviceTrust({ store: new FileTrustStore(trustPath) }) },
		);

		// "Restart": a brand-new DeviceTrust + server reading the same files.
		await withServer(
			async ({ server, deviceTrust }) => {
				const client = createClient(server.getWebSocketUrl());
				assert.equal((await client.read()).type, "server.hello");
				send(client, { id: "token_after_restart", type: "auth.token", payload: { token } });
				assert.equal((await client.read()).type, "auth.token.success");
				assert.equal((await client.read()).type, "state.snapshot");

				// Another Pi process (its own DeviceTrust on the same file) revokes it;
				// this server notices on the next heartbeat.
				const elsewhere = new DeviceTrust({ store: new FileTrustStore(trustPath) });
				const [device] = deviceTrust.listTrustedDevices();
				assert.equal(elsewhere.revokeDevice(device.id).ok, true);
				assert.equal((await client.closed).code, 4003);
			},
			{
				deviceTrust: new DeviceTrust({ store: new FileTrustStore(trustPath) }),
				config: { heartbeatIntervalMs: 50 },
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
