import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import WebSocket from "ws";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { DeviceTrust } = jiti("../extension/auth/DeviceTrust.ts");
const { DEFAULT_REMOTE_CONFIG } = jiti("../extension/config.ts");
const { createHostIdentity } = jiti("../extension/identity/HostIdentity.ts");
const { createLogger } = jiti("../extension/logging/logger.ts");
const { QuestionBroker } = jiti("../extension/questions/QuestionBroker.ts");
const { RemoteControlRuntime } = jiti("../extension/runtime/RemoteControlRuntime.ts");
const { RemoteServer } = jiti("../extension/server/RemoteServer.ts");

const identity = createHostIdentity();

function fakeAdvertiser() {
	const starts = [];
	let stops = 0;
	let current = { active: false, reason: "not started" };
	return {
		starts,
		get stops() {
			return stops;
		},
		start(input) {
			starts.push(input);
			current = { active: true, instanceName: "Pi · test" };
			return current;
		},
		stop(reason = "stopped") {
			stops += 1;
			current = { active: false, reason };
		},
		status: () => current,
	};
}

function setup({ host = "127.0.0.1" } = {}) {
	// `host: null` = no LAN address (a default parameter would swallow `undefined`).
	const deviceTrust = new DeviceTrust();
	const questions = new QuestionBroker();
	const server = new RemoteServer({
		config: DEFAULT_REMOTE_CONFIG,
		logger: createLogger("test"),
		deviceTrust,
		identity,
		createSession: () => ({ handle: async () => {}, isAuthenticated: () => false, authenticatedDeviceId: () => undefined }),
	});
	const advertiser = fakeAdvertiser();
	const lan = { host };
	const runtime = new RemoteControlRuntime(server, deviceTrust, createLogger("test"), questions, {
		advertiser,
		selectHost: () => lan.host ?? undefined,
		getCwd: () => "/tmp/project-x",
		addressPollMs: 60_000,
	});
	return { runtime, server, deviceTrust, questions, advertiser, lan };
}

function helloOver(url) {
	const target = new URL(url);
	target.hash = "";
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(target.toString(), { rejectUnauthorized: false });
		ws.once("message", (data) => {
			ws.close();
			resolve(JSON.parse(data.toString()).type);
		});
		ws.once("error", reject);
	});
}

test("start binds the selected LAN address, opens pairing, and advertises the pin", async () => {
	const { runtime, advertiser } = setup();
	try {
		const result = await runtime.start({ port: 0 });
		assert.equal(result.running, true);
		assert.equal(result.config.host, "127.0.0.1");
		assert.equal(result.followsLanAddress, true);
		assert.match(result.pairingCode, /^\d{3}-\d{3}$/);
		assert.equal(result.fingerprint, identity.fingerprint);
		assert.equal(result.fingerprintShort, identity.fingerprintShort);
		assert.equal(result.webSocketUrl, `${result.displayWebSocketUrl}#fp=${identity.fingerprint}`);
		assert.deepEqual(result.bonjour, { active: true, instanceName: "Pi · test" });
		assert.equal(advertiser.starts.length, 1);
		assert.deepEqual(
			{ ...advertiser.starts[0], port: undefined },
			{ fingerprint: identity.fingerprint, host: "127.0.0.1", port: undefined, webSocketPath: "/v1/ws", protocolVersion: 1, cwd: "/tmp/project-x" },
		);
		assert.equal(await helloOver(result.webSocketUrl), "server.hello");
	} finally {
		await runtime.stop();
	}
	assert.equal(advertiser.status().active, false);
});

test("start without a LAN address fails with guidance", async () => {
	const { runtime } = setup({ host: null });
	try {
		await assert.rejects(runtime.start({}), /No private LAN IPv4 address found/);
		assert.equal(runtime.isRunning(), false);
	} finally {
		await runtime.stop();
	}
});

test("pairing:false serves paired devices without opening a pairing window", async () => {
	const { runtime } = setup();
	try {
		const result = await runtime.start({ port: 0, pairing: false });
		assert.equal(result.running, true);
		assert.equal(result.pairingCode, undefined);
		assert.equal(result.deviceTrust.pairing.active, false);
	} finally {
		await runtime.stop();
	}
});

test("the listener follows a LAN address change on the same port and keeps pending questions", async () => {
	const { runtime, server, advertiser, lan, questions } = setup();
	const changes = [];
	runtime.onStatusChange((status) => changes.push(status));
	try {
		const first = await runtime.start({ port: 0 });
		const port = server.getPort();
		const pending = questions.ask({ toolCallId: "q1", question: "Still there?", options: [{ label: "Yes" }] });

		assert.equal(await runtime.checkLanAddress(), false, "unchanged address is a no-op");

		lan.host = "::1";
		assert.equal(await runtime.checkLanAddress(), true);
		assert.equal(server.getConfig().host, "::1");
		assert.equal(server.getPort(), port);
		assert.equal(changes.length, 1);
		assert.equal(changes[0].displayWebSocketUrl, `wss://[::1]:${port}/v1/ws`);
		assert.equal(advertiser.starts.at(-1).host, "::1");
		assert.notEqual(changes[0].webSocketUrl, first.webSocketUrl);
		assert.equal(await helloOver(changes[0].webSocketUrl), "server.hello");
		assert.equal(questions.current()?.question, "Still there?");

		lan.host = undefined;
		assert.equal(await runtime.checkLanAddress(), false, "losing the address keeps the old bind");
		questions.cancelAll();
		await pending;
	} finally {
		await runtime.stop();
	}
});

test("an explicit --host is pinned and never rebinds", async () => {
	const { runtime, lan, advertiser } = setup({ host: "::1" });
	try {
		const result = await runtime.start({ host: "127.0.0.1", port: 0 });
		assert.equal(result.followsLanAddress, false);
		assert.deepEqual(result.bonjour, { active: false, reason: "loopback-only server" }, "loopback binds are not advertised");
		assert.equal(advertiser.starts.length, 0);
		lan.host = "::1";
		assert.equal(await runtime.checkLanAddress(), false);
		assert.equal(runtime.getStatus().config.host, "127.0.0.1");
	} finally {
		await runtime.stop();
	}
});

test("a busy default port falls back to a free one; a busy explicit port is an error", async () => {
	const blocker = net.createServer();
	const blocked = await new Promise((resolve) => {
		blocker.once("error", () => resolve(false));
		blocker.listen(DEFAULT_REMOTE_CONFIG.port, "127.0.0.1", () => resolve(true));
	});
	const { runtime } = setup();
	try {
		const result = await runtime.start({});
		assert.equal(result.running, true);
		assert.notEqual(new URL(result.webSocketUrl).port, String(DEFAULT_REMOTE_CONFIG.port));
		await runtime.stop();

		await assert.rejects(runtime.start({ port: DEFAULT_REMOTE_CONFIG.port }), /EADDRINUSE/);
	} finally {
		await runtime.stop();
		if (blocked) await new Promise((resolve) => blocker.close(resolve));
	}
});

test("start --no-advertise withdraws the Bonjour record", async () => {
	const { runtime, advertiser } = setup();
	try {
		await runtime.start({ port: 0 });
		const stopsBefore = advertiser.stops;
		const result = await runtime.start({ advertise: false });
		assert.equal(result.bonjour.active, false);
		assert.ok(advertiser.stops > stopsBefore);
	} finally {
		await runtime.stop();
	}
});
