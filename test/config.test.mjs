import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { AUTO_HOST, DEFAULT_REMOTE_CONFIG, isLanExposure, withRemoteConfig } = jiti("../extension/config.ts");

test("withRemoteConfig defaults to following the LAN address with Bonjour on", () => {
	const config = withRemoteConfig({ host: undefined, port: undefined, debugRawEvents: undefined });
	assert.equal(config.host, AUTO_HOST);
	assert.equal(config.host, DEFAULT_REMOTE_CONFIG.host);
	assert.equal(config.port, DEFAULT_REMOTE_CONFIG.port);
	assert.equal(config.debugRawEvents, DEFAULT_REMOTE_CONFIG.debugRawEvents);
	assert.equal(config.advertise, true);
	assert.equal(withRemoteConfig({ advertise: false }).advertise, false);
});

test("withRemoteConfig applies defined overrides", () => {
	const config = withRemoteConfig({ host: "0.0.0.0", port: 1234, debugRawEvents: true });
	assert.equal(config.host, "0.0.0.0");
	assert.equal(config.port, 1234);
	assert.equal(config.debugRawEvents, true);
	assert.equal(isLanExposure(config.host), true);
});
