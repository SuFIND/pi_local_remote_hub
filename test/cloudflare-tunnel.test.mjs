import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { CloudflareTunnel, CloudflareTunnelUnavailableError, CloudflareTunnelStartError, parsePublicUrl } = jiti(
	"../extension/tunnel/CloudflareTunnel.ts",
);

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeFakeBinary(script) {
	const dir = mkdtempSync(join(tmpdir(), "cloudflared-fake-"));
	const path = join(dir, "cloudflared");
	writeFileSync(path, `#!/bin/sh\n${script}\n`);
	chmodSync(path, 0o755);
	return path;
}

test("parsePublicUrl finds a trycloudflare.com URL in a noisy log line", () => {
	const line = "2026-05-12T18:34:57Z INF |  https://random-name.trycloudflare.com  |";
	assert.equal(parsePublicUrl(line), "https://random-name.trycloudflare.com");
});

test("parsePublicUrl returns null when no URL is present", () => {
	assert.equal(parsePublicUrl("INF Requesting new quick Tunnel on trycloudflare.com..."), null);
	assert.equal(parsePublicUrl(""), null);
});

test("parsePublicUrl is case-insensitive on the scheme prefix", () => {
	assert.equal(parsePublicUrl("HTTPS://Test-Host.trycloudflare.com"), "HTTPS://Test-Host.trycloudflare.com");
});

test("CloudflareTunnel.start resolves with public hostname when binary announces a URL", async () => {
	const binary = makeFakeBinary(`
		if [ "$1" = "--version" ]; then exit 0; fi
		echo "2026-05-12T18:34:56Z INF Starting tunnel" 1>&2
		echo "2026-05-12T18:34:57Z INF +-----+" 1>&2
		echo "https://happy-tunnel-1234.trycloudflare.com" 1>&2
		exec sleep 30
	`);
	const tunnel = new CloudflareTunnel(silentLogger, { binary, readyTimeoutMs: 5000 });
	const handle = await tunnel.start(3769, "/v1/ws");
	assert.equal(handle.publicHostname, "happy-tunnel-1234.trycloudflare.com");
	assert.equal(handle.publicWebSocketUrl, "wss://happy-tunnel-1234.trycloudflare.com/v1/ws");
	assert.equal(tunnel.isRunning(), true);
	await tunnel.stop();
	assert.equal(tunnel.isRunning(), false);
});

test("CloudflareTunnel.start rejects with CloudflareTunnelUnavailableError when binary is missing", async () => {
	const tunnel = new CloudflareTunnel(silentLogger, { binary: "/nonexistent/cloudflared", readyTimeoutMs: 5000 });
	await assert.rejects(() => tunnel.start(3769, "/v1/ws"), CloudflareTunnelUnavailableError);
});

test("CloudflareTunnel.start rejects with CloudflareTunnelStartError when the process exits before announcing a URL", async () => {
	// Print --version exit code 0 so probe passes, then exit immediately from `tunnel` invocation.
	const binary = makeFakeBinary(`
		if [ "$1" = "--version" ]; then exit 0; fi
		echo "starting up" 1>&2
		exit 1
	`);
	const tunnel = new CloudflareTunnel(silentLogger, { binary, readyTimeoutMs: 5000 });
	await assert.rejects(() => tunnel.start(3769, "/v1/ws"), CloudflareTunnelStartError);
});

test("CloudflareTunnel.start times out when the process never announces a URL", async () => {
	const binary = makeFakeBinary(`
		if [ "$1" = "--version" ]; then exit 0; fi
		# Sleep without ever printing the URL.
		sleep 30
	`);
	const tunnel = new CloudflareTunnel(silentLogger, { binary, readyTimeoutMs: 200 });
	await assert.rejects(() => tunnel.start(3769, "/v1/ws"), CloudflareTunnelStartError);
	assert.equal(tunnel.isRunning(), false);
});
