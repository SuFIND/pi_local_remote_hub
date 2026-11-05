import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { formatDevices, formatStatus, registerRemoteCommand } = jiti("../extension/command.ts");

function hubStatus(overrides = {}) {
	return {
		running: true,
		webSocketUrl: "wss://192.168.1.10:3769/v1/ws#fp=PIN",
		displayWebSocketUrl: "wss://192.168.1.10:3769/v1/ws",
		fingerprintShort: "AB12 CD34 EF56 7890",
		followsLanAddress: true,
		bonjour: { active: true, instanceName: "Hub · Mac" },
		connections: 1,
		roots: ["/Users/me/code"],
		agents: 2,
		idleExitMinutes: 3,
		deviceTrust: { pairing: { active: false }, trustedDevices: [] },
		...overrides,
	};
}

function harness(control) {
	let command;
	const calls = [];
	const notices = [];
	const pi = { registerCommand: (name, spec) => (command = { name, ...spec }) };
	const hub = {
		control: async (op, args) => {
			calls.push({ op, args });
			return control(op, args);
		},
	};
	registerRemoteCommand(pi, hub, { hubHint: "Start it with: node hub/bin.mjs run" });
	const ctx = {
		ui: { notify: (message, level) => notices.push({ message, level }) },
		sessionManager: { getSessionFile: () => "/tmp/s.jsonl" },
		waitForIdle: async () => calls.push({ op: "waitForIdle" }),
		switchSession: async (file) => {
			calls.push({ op: "switchSession", file });
			return { cancelled: false };
		},
	};
	return { command, calls, notices, run: (args) => command.handler(args, ctx) };
}

test("/remote completes the hub actions and defaults to status", async () => {
	const { command, calls, notices, run } = harness(() => hubStatus());
	assert.equal(command.name, "remote");
	assert.deepEqual(
		command.getArgumentCompletions("r").map((item) => item.value),
		["revoke", "rotate"],
	);
	await run("");
	assert.deepEqual(calls, [{ op: "status", args: undefined }]);
	assert.match(notices[0].message, /Pi Remote Hub is running/);
	assert.match(notices[0].message, /Folders: \/Users\/me\/code/);
	assert.match(notices[0].message, /Pi sessions online: 2 · phones connected: 1 · background Pi exits after 3 min idle/);
});

test("/remote pair prints the code, a QR code and a pinned deep link", async () => {
	const { notices, run } = harness(() =>
		hubStatus({ pairingCode: "123-456", pairingExpiresAt: "2030-01-01T00:00:00.000Z", deviceTrust: { pairing: { active: true, code: "123-456", expiresAt: "2030-01-01T00:00:00.000Z", remainingAttempts: 5 }, trustedDevices: [] } }),
	);
	await run("pair");
	const message = notices[0].message;
	assert.match(message, /Pairing code: 123-456/);
	assert.match(message, /Scan to pair:/);
	assert.match(message, /Deep link: pi-remote:\/\/pair\?url=wss%3A%2F%2F192\.168\.1\.10%3A3769%2Fv1%2Fws%23fp%3DPIN&code=123-456/);
});

test("/remote revoke needs an id and reports the revoked device", async () => {
	const { calls, notices, run } = harness((op) => (op === "revoke" ? { id: "dev-1", name: "iPhone" } : hubStatus()));
	await run("revoke");
	assert.equal(notices[0].level, "error");
	assert.equal(calls.length, 0);
	await run("revoke dev-1");
	assert.deepEqual(calls, [{ op: "revoke", args: { id: "dev-1" } }]);
	assert.match(notices[1].message, /Revoked iPhone \(dev-1\)/);
});

test("/remote explains how to start the hub when it is unreachable", async () => {
	const { notices, run } = harness(() => {
		throw new Error("Pi Remote Hub is not running");
	});
	await run("status");
	assert.equal(notices[0].level, "error");
	assert.equal(notices[0].message, "Pi Remote Hub is not running. Start it with: node hub/bin.mjs run");
});

test("/remote takeover reloads this window's session after it is idle", async () => {
	const { calls, run } = harness(() => hubStatus());
	await run("takeover");
	assert.deepEqual(calls, [{ op: "waitForIdle" }, { op: "switchSession", file: "/tmp/s.jsonl" }]);
});

test("unknown /remote actions show usage", async () => {
	const { notices, run } = harness(() => hubStatus());
	await run("start");
	assert.match(notices[0].message, /^Usage: \/remote pair\|status\|devices\|revoke\|rotate\|takeover/);
});

test("formatStatus reports a hub that cannot reach the LAN", () => {
	assert.equal(formatStatus(hubStatus({ running: false, lastError: "No private LAN IPv4 address found" })), "Pi Remote Hub is not listening: No private LAN IPv4 address found");
	assert.match(formatStatus(hubStatus({ roots: [] })), /Folders: none configured/);
});

test("formatDevices lists trusted devices and explains revocation", () => {
	assert.match(formatDevices([]), /No trusted devices/);
	const text = formatDevices([{ id: "dev-1", name: "iPhone", createdAt: "a", lastSeenAt: "b", remoteAddress: "192.168.1.20" }]);
	assert.match(text, /dev-1 {2}iPhone {2}paired a {2}last seen b from 192\.168\.1\.20/);
	assert.match(text, /\/remote revoke <id>/);
});
