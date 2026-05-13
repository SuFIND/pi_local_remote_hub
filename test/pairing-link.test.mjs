import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { buildPairingDeepLink, PAIRING_LINK_SCHEME } = jiti("../extension/runtime/pairingLink.ts");

test("buildPairingDeepLink encodes the ws url and code into a pi-remote:// uri", () => {
	const link = buildPairingDeepLink("ws://192.168.1.10:3769/v1/ws", "123-456");
	assert.equal(PAIRING_LINK_SCHEME, "pi-remote");
	const url = new URL(link);
	assert.equal(url.protocol, "pi-remote:");
	assert.equal(url.host, "pair");
	assert.equal(url.searchParams.get("url"), "ws://192.168.1.10:3769/v1/ws");
	assert.equal(url.searchParams.get("code"), "123-456");
});

test("buildPairingDeepLink percent-encodes special characters in the ws url", () => {
	const link = buildPairingDeepLink("ws://host:3769/v1/ws?token=a b&x=1", "000-000");
	assert.match(link, /url=ws%3A%2F%2Fhost%3A3769%2Fv1%2Fws%3Ftoken%3Da\+b%26x%3D1/);
});

test("buildPairingDeepLink throws on empty inputs", () => {
	assert.throws(() => buildPairingDeepLink("", "123-456"), /webSocketUrl/);
	assert.throws(() => buildPairingDeepLink("ws://h/", ""), /pairingCode/);
});
