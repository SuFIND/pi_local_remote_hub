import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { DeviceTrust } = jiti("../extension/auth/DeviceTrust.ts");

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("DeviceTrust pairs once, returns a token, and disables the pairing code", () => {
	const trust = new DeviceTrust();
	const pairing = trust.startPairing();

	assert.equal(pairing.active, true);
	assert.match(pairing.code, /^\d{3}-\d{3}$/);

	const result = trust.pairDevice({ code: pairing.code, deviceName: "Tornike's iPhone", remoteAddress: "127.0.0.1" });
	assert.equal(result.ok, true);
	assert.equal(result.device.name, "Tornike's iPhone");
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
