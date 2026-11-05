import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { BONJOUR_SERVICE_TYPE, BonjourAdvertiser, buildBonjourAdvertisement, buildDnsSdArgs, cwdTag } = jiti("../extension/net/BonjourAdvertiser.ts");
const { createLogger } = jiti("../extension/logging/logger.ts");

const input = {
	fingerprint: "A".repeat(43),
	host: "192.168.1.20",
	port: 3769,
	webSocketPath: "/v1/ws",
	protocolVersion: 1,
	cwd: "/Users/me/code/pi-remote-ios",
};

test("buildBonjourAdvertisement carries connect + pin data and no secrets", () => {
	const ad = buildBonjourAdvertisement(input);
	assert.equal(BONJOUR_SERVICE_TYPE, "_pi-remote._tcp");
	assert.equal(ad.instanceName, "Pi · pi-remote-ios");
	assert.deepEqual(ad.txt, {
		v: "1",
		fp: input.fingerprint,
		host: "192.168.1.20",
		port: "3769",
		path: "/v1/ws",
		proj: "pi-remote-ios",
		cwd: createHash("sha256").update(input.cwd).digest("hex").slice(0, 16),
	});
	assert.equal(cwdTag(input.cwd).length, 16);
	for (const [key, value] of Object.entries(ad.txt)) assert.ok(Buffer.byteLength(`${key}=${value}`) <= 255);
});

test("buildBonjourAdvertisement keeps names within DNS-SD limits", () => {
	const ad = buildBonjourAdvertisement({ ...input, cwd: `/tmp/${"项目".repeat(40)}` });
	assert.ok(Buffer.byteLength(ad.instanceName, "utf8") <= 63);
	assert.ok(Buffer.byteLength(ad.txt.proj, "utf8") <= 60);
	assert.equal(buildBonjourAdvertisement({ ...input, cwd: undefined }).instanceName, "Pi");
});

test("buildDnsSdArgs registers the service with TXT key=value pairs", () => {
	const args = buildDnsSdArgs(buildBonjourAdvertisement(input));
	assert.deepEqual(args.slice(0, 5), ["-R", "Pi · pi-remote-ios", "_pi-remote._tcp", "local", "3769"]);
	assert.ok(args.includes(`fp=${input.fingerprint}`));
	assert.ok(args.includes("host=192.168.1.20"));
});

function fakeSpawn() {
	const calls = [];
	const children = [];
	const spawn = (command, args, options) => {
		const child = new EventEmitter();
		child.exitCode = null;
		child.signalCode = null;
		child.killed = [];
		child.kill = (signal) => {
			child.killed.push(signal);
			child.signalCode = signal;
			child.emit("exit", null, signal);
			return true;
		};
		child.unref = () => {};
		calls.push({ command, args, options });
		children.push(child);
		return child;
	};
	return { spawn, calls, children };
}

test("BonjourAdvertiser runs dns-sd under a watchdog and stops it", () => {
	const { spawn, calls, children } = fakeSpawn();
	const advertiser = new BonjourAdvertiser(createLogger("test"), spawn, "darwin");

	const status = advertiser.start(input);
	assert.deepEqual(status, { active: true, instanceName: "Pi · pi-remote-ios" });
	assert.equal(calls[0].command, "/bin/sh");
	assert.match(calls[0].args[1], /dns-sd "\$@"/);
	assert.deepEqual(calls[0].args.slice(3, 8), ["-R", "Pi · pi-remote-ios", "_pi-remote._tcp", "local", "3769"]);

	// Restarting replaces the old registration.
	advertiser.start({ ...input, host: "192.168.1.30" });
	assert.deepEqual(children[0].killed, ["SIGTERM"]);
	assert.ok(calls[1].args.includes("host=192.168.1.30"));

	advertiser.stop();
	assert.deepEqual(children[1].killed, ["SIGTERM"]);
	assert.equal(advertiser.status().active, false);
});

test("BonjourAdvertiser reports an unexpected dns-sd exit and is a no-op off macOS", () => {
	const { spawn, children } = fakeSpawn();
	const advertiser = new BonjourAdvertiser(createLogger("test"), spawn, "darwin");
	advertiser.start(input);
	children[0].emit("exit", 1, null);
	assert.deepEqual(advertiser.status(), { active: false, reason: "dns-sd exited (1)" });

	const linux = fakeSpawn();
	const offMac = new BonjourAdvertiser(createLogger("test"), linux.spawn, "linux");
	assert.equal(offMac.start(input).active, false);
	assert.equal(linux.calls.length, 0);
});
