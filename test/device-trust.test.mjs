import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { DeviceTrust } = jiti("../extension/auth/DeviceTrust.ts");
const { FileTrustStore } = jiti("../extension/auth/TrustStore.ts");
const { createPairingCode } = jiti("../extension/auth/crypto.ts");

function withTempDir(body) {
	const dir = mkdtempSync(join(tmpdir(), "pi-remote-device-trust-"));
	try {
		return body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function pair(trust, name = "iPhone") {
	const pairing = trust.startPairing();
	const paired = trust.pairDevice({ code: pairing.code, deviceName: name });
	assert.equal(paired.ok, true);
	return paired;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("DeviceTrust pairs once, returns a token, and disables the pairing code", () => {
	const trust = new DeviceTrust();
	const pairing = trust.startPairing();

	assert.equal(pairing.active, true);
	assert.match(pairing.code, /^\d{3}-\d{3}$/);

	const result = trust.pairDevice({ code: pairing.code, deviceName: "Example iPhone", remoteAddress: "127.0.0.1" });
	assert.equal(result.ok, true);
	assert.equal(result.device.name, "Example iPhone");
	assert.equal(typeof result.token, "string");
	assert.equal(trust.getStatus().pairing.active, false);

	const second = trust.pairDevice({ code: pairing.code, deviceName: "Other iPhone" });
	assert.equal(second.ok, false);
	assert.equal(second.code, "PAIRING_DISABLED");
});

test("DeviceTrust verifies token reconnects and revokeAllTrustedDevices invalidates tokens", () => {
	const trust = new DeviceTrust();
	const pairing = trust.startPairing();
	const paired = trust.pairDevice({ code: pairing.code, deviceName: "iPhone" });
	assert.equal(paired.ok, true);

	const device = trust.authenticateToken(paired.token);
	assert.equal(device?.id, paired.device.id);

	trust.revokeAllTrustedDevices();
	assert.equal(trust.authenticateToken(paired.token), undefined);
	assert.equal(trust.listTrustedDevices().length, 0);
});

test("DeviceTrust expires pairing codes", async () => {
	const trust = new DeviceTrust();
	const pairing = trust.startPairing({ ttlMs: 1 });
	await sleep(5);

	const result = trust.pairDevice({ code: pairing.code, deviceName: "Late iPhone" });
	assert.equal(result.ok, false);
	assert.equal(result.code, "PAIRING_EXPIRED");
});

test("DeviceTrust enforces max failed pairing attempts", () => {
	const trust = new DeviceTrust();
	trust.startPairing({ maxAttempts: 2 });

	const first = trust.pairDevice({ code: "000-000", deviceName: "Attacker" });
	assert.equal(first.ok, false);
	assert.equal(first.code, "UNAUTHORIZED");

	const second = trust.pairDevice({ code: "111-111", deviceName: "Attacker" });
	assert.equal(second.ok, false);
	assert.equal(second.code, "PAIRING_ATTEMPTS_EXCEEDED");
	assert.equal(trust.getStatus().pairing.active, false);
});

test("createPairingCode yields uniformly formatted six-digit codes", () => {
	const seen = new Set();
	for (let i = 0; i < 500; i += 1) {
		const code = createPairingCode();
		assert.match(code, /^[1-9]\d{2}-\d{3}$/);
		seen.add(code);
	}
	assert.ok(seen.size > 450, "codes should not repeat much");
});

test("FileTrustStore persists trust across DeviceTrust instances without storing tokens", () => {
	withTempDir((dir) => {
		const path = join(dir, "nested", "trusted-devices.json");
		const first = new DeviceTrust({ store: new FileTrustStore(path) });
		const paired = pair(first, "Persisted iPhone");

		const restarted = new DeviceTrust({ store: new FileTrustStore(path) });
		assert.equal(restarted.authenticateToken(paired.token)?.id, paired.device.id);
		assert.equal(restarted.listTrustedDevices()[0].name, "Persisted iPhone");

		const raw = readFileSync(path, "utf8");
		assert.equal(raw.includes(paired.token), false);
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.equal(JSON.parse(raw).devices[0].tokenHash.length > 20, true);
	});
});

test("revokeDevice removes one device by id prefix and reports ambiguity", () => {
	const trust = new DeviceTrust();
	const a = pair(trust, "A");
	const b = pair(trust, "B");

	assert.equal(trust.revokeDevice("").ok, false);
	assert.equal(trust.revokeDevice("zzzz-not-there").code, "NOT_FOUND");

	const removed = trust.revokeDevice(a.device.id.slice(0, 8));
	assert.equal(removed.ok, true);
	assert.equal(removed.device.id, a.device.id);
	assert.equal(trust.authenticateToken(a.token), undefined);
	assert.equal(trust.authenticateToken(b.token)?.id, b.device.id);
	assert.equal(trust.isTrustedDevice(a.device.id), false);
	assert.equal(trust.isTrustedDevice(b.device.id), true);
});

test("revokeDevice reports AMBIGUOUS for a prefix shared by several devices", () => {
	const trust = new DeviceTrust();
	const ids = [];
	// Ids are random base64url; pair until two share a first character.
	for (let i = 0; i < 200 && !ids.some((id, index) => ids.findIndex((other) => other[0] === id[0]) !== index); i += 1) {
		ids.push(pair(trust, `D${i}`).device.id);
	}
	const shared = ids.find((id, index) => ids.findIndex((other) => other[0] === id[0]) !== index);
	assert.ok(shared);
	const result = trust.revokeDevice(shared[0]);
	assert.equal(result.ok, false);
	assert.equal(result.code, "AMBIGUOUS");
});

test("revocation in one process is visible to another sharing the file", () => {
	withTempDir((dir) => {
		const path = join(dir, "trusted-devices.json");
		const windowA = new DeviceTrust({ store: new FileTrustStore(path) });
		const windowB = new DeviceTrust({ store: new FileTrustStore(path) });
		const paired = pair(windowA);
		assert.equal(windowB.authenticateToken(paired.token)?.id, paired.device.id);

		windowB.revokeAllTrustedDevices();
		assert.equal(windowA.authenticateToken(paired.token), undefined);
		assert.equal(windowA.isTrustedDevice(paired.device.id), false);
	});
});

test("a corrupt trust file fails closed and is set aside", () => {
	withTempDir((dir) => {
		const path = join(dir, "trusted-devices.json");
		writeFileSync(path, "{ not json");
		const trust = new DeviceTrust({ store: new FileTrustStore(path) });
		assert.deepEqual(trust.listTrustedDevices(), []);
		assert.ok(readdirSync(dir).some((name) => name.startsWith("trusted-devices.json.corrupt-")));
		assert.equal(existsSync(path), true);
		assert.equal(JSON.parse(readFileSync(path, "utf8")).devices.length, 0);
	});
});
