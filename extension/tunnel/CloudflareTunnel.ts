import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import type { Logger } from "../logging/logger.js";

/**
 * Manages a `cloudflared tunnel --url http://127.0.0.1:<port>` subprocess,
 * a.k.a. a Cloudflare Quick Tunnel. Exposes the laptop's localhost-bound
 * WebSocket server at `https://<random>.trycloudflare.com` so the paired iOS
 * app can reach it from anywhere with internet — no account required.
 *
 * Lifecycle: `start()` blocks until cloudflared announces a public URL (or
 * times out / fails to spawn). `stop()` sends SIGTERM and escalates to
 * SIGKILL after 3s. The process auto-clears state on its own `exit` event.
 *
 * Pairing-code + device-token auth still gate everything on the wire; this
 * module only makes the server reachable.
 */
export class CloudflareTunnelUnavailableError extends Error {
	constructor() {
		super(
			"cloudflared is not installed. Install it with `brew install cloudflared` (macOS) or follow https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
		);
		this.name = "CloudflareTunnelUnavailableError";
	}
}

export class CloudflareTunnelStartError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CloudflareTunnelStartError";
	}
}

export type CloudflareTunnelHandle = {
	publicHostname: string;
	publicWebSocketUrl: string;
};

export type CloudflareTunnelOptions = {
	binary?: string;
	readyTimeoutMs?: number;
};

const TRYCLOUDFLARE_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export class CloudflareTunnel {
	private proc: ChildProcess | null = null;
	private handle: CloudflareTunnelHandle | null = null;
	private readonly binary: string;
	private readonly readyTimeoutMs: number;

	constructor(private readonly logger: Logger, options: CloudflareTunnelOptions = {}) {
		this.binary = options.binary ?? "cloudflared";
		this.readyTimeoutMs = options.readyTimeoutMs ?? 30_000;
	}

	isRunning(): boolean {
		return this.proc !== null;
	}

	getHandle(): CloudflareTunnelHandle | null {
		return this.handle;
	}

	async start(localPort: number, wsPath: string): Promise<CloudflareTunnelHandle> {
		if (this.proc) throw new Error("Tunnel already running");

		await this.assertAvailable();

		const proc = spawn(
			this.binary,
			["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${localPort}`],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		this.proc = proc;
		proc.once("exit", (code, signal) => {
			this.logger.warn("tunnel_process_exited", { code, signal });
			if (this.proc === proc) {
				this.proc = null;
				this.handle = null;
			}
		});

		let url: string;
		try {
			url = await this.awaitPublicUrl(proc);
		} catch (err) {
			this.proc = null;
			proc.kill("SIGKILL");
			proc.stdout?.destroy();
			proc.stderr?.destroy();
			throw err;
		}

		const hostname = url.replace(/^https?:\/\//, "");
		this.handle = {
			publicHostname: hostname,
			publicWebSocketUrl: `wss://${hostname}${wsPath}`,
		};
		this.logger.info("tunnel_started", { hostname });
		return this.handle;
	}

	async stop(): Promise<void> {
		const proc = this.proc;
		if (!proc) return;
		this.proc = null;
		this.handle = null;

		await new Promise<void>((resolve) => {
			let exited = false;
			const onExit = () => {
				exited = true;
				clearTimeout(timer);
				// Force-close the stdio pipes so Node's event loop doesn't wait on lingering
				// readable streams (the readline interfaces from `awaitPublicUrl` attach
				// listeners that count as open handles until the underlying stream is destroyed).
				proc.stdout?.destroy();
				proc.stderr?.destroy();
				resolve();
			};
			proc.once("exit", onExit);
			proc.kill("SIGTERM");
			// `proc.killed` flips to true after any `kill()` call regardless of whether the
			// process actually died, so we can't condition on it. Always escalate to SIGKILL
			// if SIGTERM hasn't taken effect within 3s — `kill("SIGKILL")` on an already-dead
			// process is a no-op.
			const timer = setTimeout(() => {
				if (exited) return;
				proc.kill("SIGKILL");
			}, 3000);
		});
		this.logger.info("tunnel_stopped");
	}

	private awaitPublicUrl(proc: ChildProcess): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			const settle = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};

			const onLine = (line: string) => {
				const found = parsePublicUrl(line);
				if (found) settle(() => resolve(found));
			};
			if (proc.stdout) readline.createInterface({ input: proc.stdout }).on("line", onLine);
			if (proc.stderr) readline.createInterface({ input: proc.stderr }).on("line", onLine);

			proc.once("error", (err) => settle(() => reject(new CloudflareTunnelStartError(`cloudflared failed to start: ${err.message}`))));
			proc.once("exit", (code) =>
				settle(() => reject(new CloudflareTunnelStartError(`cloudflared exited (code ${code}) before announcing a public URL`))),
			);

			const timer = setTimeout(
				() => settle(() => reject(new CloudflareTunnelStartError(`cloudflared did not announce a public URL within ${this.readyTimeoutMs}ms`))),
				this.readyTimeoutMs,
			);
		});
	}

	private assertAvailable(): Promise<void> {
		return new Promise((resolve, reject) => {
			const probe = spawn(this.binary, ["--version"], { stdio: "ignore" });
			probe.once("error", () => reject(new CloudflareTunnelUnavailableError()));
			probe.once("exit", (code) => (code === 0 ? resolve() : reject(new CloudflareTunnelUnavailableError())));
		});
	}
}

/**
 * Extracts a `https://*.trycloudflare.com` URL from a cloudflared log line.
 * Exported for unit-testing.
 */
export function parsePublicUrl(line: string): string | null {
	const match = line.match(TRYCLOUDFLARE_REGEX);
	return match ? match[0] : null;
}
