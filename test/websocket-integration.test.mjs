import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { DeviceTrust } = jiti("../extension/auth/DeviceTrust.ts");
const { DEFAULT_REMOTE_CONFIG } = jiti("../extension/config.ts");
const { createLogger } = jiti("../extension/logging/logger.ts");
const { RemoteServer } = jiti("../extension/server/RemoteServer.ts");

function createClient(url) {
	const ws = new WebSocket(url);
	const queue = [];
	const waiters = [];

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

async function withServer(testBody) {
	const deviceTrust = new DeviceTrust();
	const prompts = [];
	const adapter = {
		getState: () => ({ isIdle: true, cwd: "/tmp/pi-remote-test" }),
		prompt: async (message, delivery) => {
			prompts.push({ message, delivery });
		},
		abort: async () => {},
		compact: () => {},
	};
	const server = new RemoteServer({
		config: DEFAULT_REMOTE_CONFIG,
		logger: createLogger("test", "error"),
		adapter,
		deviceTrust,
		getState: () => adapter.getState(),
	});
	await server.start({ ...DEFAULT_REMOTE_CONFIG, port: 0 });
	try {
		await testBody({ server, deviceTrust, adapter, prompts });
	} finally {
		await server.stop();
	}
}

async function pairClient(server, deviceTrust) {
	const pairing = deviceTrust.startPairing();
	const client = createClient(server.getWebSocketUrl());
	const hello = await client.read();
	assert.equal(hello.type, "server.hello");
	assert.equal(hello.payload.auth.pairingAvailable, true);
	assert.equal(hello.payload.capabilities.features.sequenceNumbers, true);
	assert.equal(hello.payload.capabilities.features.stableOkEnvelope, true);

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
