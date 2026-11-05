import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { formatDevices, formatStatus, parseRemoteArgs, registerRemoteCommand } = jiti("../extension/command.ts");

function runningStatus(overrides = {}) {
	return {
		running: true,
		httpUrl: "https://192.168.1.10:3769",
		webSocketUrl: "wss://192.168.1.10:3769/v1/ws#fp=PIN",
		displayWebSocketUrl: "wss://192.168.1.10:3769/v1/ws",
		fingerprint: "PIN",
		fingerprintShort: "AB12 CD34 EF56 7890",
		followsLanAddress: true,
		bonjour: { active: true, instanceName: "Pi · project" },
		connections: 0,
		config: { host: "192.168.1.10", port: 3769 },
		deviceTrust: { pairing: { active: true, code: "123-456", expiresAt: "2030-01-01T00:00:00.000Z", remainingAttempts: 5 }, trustedDevices: [] },
		lanExposure: true,
		pairingCode: "123-456",
		pairingExpiresAt: "2030-01-01T00:00:00.000Z",
		...overrides,
	};
}

test("remote start keeps public tunnels disabled", async () => {
	let command;
	let startOptions;
	const pi = {
		registerCommand: (name, definition) => {
			if (name === "remote") command = definition;
		},
	};
	const runtime = {
		start: async (options) => {
			startOptions = options;
			return runningStatus();
		},
		onStatusChange: () => {},
	};
	const logger = {
		setMinLevel: () => {},
		info: () => {},
	};
	const ctx = {
		ui: {
			notify: () => {},
			setStatus: () => {},
		},
	};

	registerRemoteCommand(pi, runtime, {
		captureContext: () => {},
		refreshExecutionContext: async () => {},
	}, logger);
	await command.handler("start", ctx);

	assert.equal(startOptions.useTunnel, false);
});

test("remote start prints the pinned wss URL, fingerprint and a deep link carrying the pin", async () => {
	let command;
	const notes = [];
	const statuses = [];
	const pi = { registerCommand: (name, definition) => name === "remote" && (command = definition) };
	const runtime = { start: async () => runningStatus(), onStatusChange: () => {} };
	const ctx = { ui: { notify: (message) => notes.push(message), setStatus: (_key, value) => statuses.push(value) } };
	registerRemoteCommand(pi, runtime, { captureContext: () => {}, refreshExecutionContext: async () => {} }, { setMinLevel: () => {}, info: () => {} });
	await command.handler("start", ctx);

	const text = notes.join("\n");
	assert.match(text, /^WebSocket: wss:\/\/192\.168\.1\.10:3769\/v1\/ws#fp=PIN$/m);
	assert.match(text, /^Fingerprint: AB12 CD34 EF56 7890$/m);
	assert.match(text, /^Pairing code: 123-456$/m);
	assert.match(text, /^Bonjour: advertising "Pi · project"$/m);
	const link = text.match(/^Deep link: (\S+)$/m)?.[1];
	assert.equal(new URL(link).searchParams.get("url"), "wss://192.168.1.10:3769/v1/ws#fp=PIN");
	assert.deepEqual(statuses, ["remote: wss://192.168.1.10:3769/v1/ws"]);
});

test("parseRemoteArgs understands device management and flags", () => {
	assert.equal(parseRemoteArgs("").action, "start");
	assert.equal(parseRemoteArgs("--host 127.0.0.1").host, "127.0.0.1");
	assert.equal(parseRemoteArgs("start --no-advertise").advertise, false);
	assert.equal(parseRemoteArgs("start").advertise, true);
	assert.deepEqual(parseRemoteArgs("revoke abc123"), { action: "revoke", target: "abc123" });
	assert.deepEqual(parseRemoteArgs("autostart on"), { action: "autostart", target: "on" });
	assert.equal(parseRemoteArgs("devices").action, "devices");
	assert.throws(() => parseRemoteArgs("autostart maybe"), /Usage/);
	assert.throws(() => parseRemoteArgs("start --port 99999"), /Port/);
});

test("remote revoke and devices report through the runtime", async () => {
	let command;
	const notes = [];
	const revoked = [];
	const pi = { registerCommand: (name, definition) => name === "remote" && (command = definition) };
	const device = { id: "dev123456", name: "iPhone", createdAt: "2026-01-01", lastSeenAt: "2026-01-02", remoteAddress: "192.168.1.5" };
	const runtime = {
		getStatus: () => runningStatus({ deviceTrust: { pairing: { active: false }, trustedDevices: [device] } }),
		revokeDevice: (id) => {
			revoked.push(id);
			return { ok: true, device };
		},
	};
	const ctx = { ui: { notify: (message, level) => notes.push({ message, level }), setStatus: () => {} } };
	registerRemoteCommand(pi, runtime, { captureContext: () => {}, refreshExecutionContext: async () => {} }, { setMinLevel: () => {}, info: () => {} });

	await command.handler("devices", ctx);
	assert.match(notes[0].message, /dev123456 {2}iPhone/);
	await command.handler("revoke dev12", ctx);
	assert.deepEqual(revoked, ["dev12"]);
	assert.match(notes[1].message, /Revoked iPhone \(dev123456\)/);
	await command.handler("revoke", ctx);
	assert.equal(notes[2].level, "error");

	assert.match(formatDevices([]), /No trusted devices/);
	assert.equal(formatStatus({ running: false }), "Pi Remote is stopped");
});
