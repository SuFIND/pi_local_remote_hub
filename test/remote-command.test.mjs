import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { registerRemoteCommand } = jiti("../extension/command.ts");

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
			return {
				running: true,
				httpUrl: "http://192.168.1.10:3769",
				webSocketUrl: "ws://192.168.1.10:3769/v1/ws",
				connections: 0,
				config: { host: "0.0.0.0", port: 3769 },
				deviceTrust: { pairing: { active: false }, trustedDevices: [] },
				lanExposure: true,
			};
		},
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
