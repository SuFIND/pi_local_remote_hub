import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Logger } from "../logging/logger.js";

/**
 * Advertises the listener as `_pi-remote._tcp` so the iPhone can find it on
 * the LAN (and re-find it after DHCP hands the Mac a new IP). On macOS this
 * shells out to the system `dns-sd` (mDNSResponder) — no npm dependency.
 *
 * The TXT record carries only what a client needs to connect and to match a
 * service to a paired host: the certificate fingerprint (public), address,
 * port, path, the project folder name for display, and a short hash of the
 * full cwd for reconnect matching. Never tokens or pairing codes.
 */

export const BONJOUR_SERVICE_TYPE = "_pi-remote._tcp";

export type BonjourAdvertisementInput = {
	fingerprint: string;
	host: string;
	port: number;
	webSocketPath: string;
	protocolVersion: number;
	cwd?: string;
};

export type BonjourAdvertisement = {
	instanceName: string;
	port: number;
	txt: Record<string, string>;
};

export type BonjourStatus = { active: true; instanceName: string } | { active: false; reason: string };

type SpawnFn = (command: string, args: readonly string[], options: { stdio: "ignore" }) => ChildProcess;

// Keeps dns-sd alive exactly as long as the Pi process: SIGTERM from `stop()`
// kills it immediately (`wait` is interruptible, `sleep` alone is not), and
// the loop reaps it if Pi dies without cleaning up.
const WATCHDOG_SCRIPT = [
	'dns-sd "$@" >/dev/null 2>&1 &',
	"child=$!",
	"parent=$PPID",
	"trap 'kill \"$child\" 2>/dev/null; exit 0' TERM INT HUP",
	'while kill -0 "$parent" 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 2 & wait $!; done',
	'kill "$child" 2>/dev/null',
].join("\n");

const MAX_INSTANCE_NAME_BYTES = 63;
const MAX_PROJECT_BYTES = 60;

export function buildBonjourAdvertisement(input: BonjourAdvertisementInput): BonjourAdvertisement {
	const project = input.cwd ? truncateUtf8(basename(input.cwd) || input.cwd, MAX_PROJECT_BYTES) : "";
	const txt: Record<string, string> = {
		v: String(input.protocolVersion),
		fp: input.fingerprint,
		host: input.host,
		port: String(input.port),
		path: input.webSocketPath,
	};
	if (project) txt.proj = project;
	if (input.cwd) txt.cwd = cwdTag(input.cwd);
	return {
		instanceName: truncateUtf8(project ? `Pi · ${project}` : "Pi", MAX_INSTANCE_NAME_BYTES),
		port: input.port,
		txt,
	};
}

/** Short, non-reversible tag for a working directory (iOS computes the same). */
export function cwdTag(cwd: string): string {
	return createHash("sha256").update(cwd, "utf8").digest("hex").slice(0, 16);
}

export function buildDnsSdArgs(advertisement: BonjourAdvertisement): string[] {
	return [
		"-R",
		advertisement.instanceName,
		BONJOUR_SERVICE_TYPE,
		"local",
		String(advertisement.port),
		...Object.entries(advertisement.txt).map(([key, value]) => `${key}=${value}`),
	];
}

export class BonjourAdvertiser {
	private child?: ChildProcess;
	private current: BonjourStatus = { active: false, reason: "not started" };
	private exitHookInstalled = false;

	constructor(
		private readonly logger: Logger,
		private readonly spawn: SpawnFn = nodeSpawn,
		private readonly platform: NodeJS.Platform = process.platform,
	) {}

	start(input: BonjourAdvertisementInput): BonjourStatus {
		this.stop();
		if (this.platform !== "darwin") {
			this.current = { active: false, reason: "Bonjour advertising uses macOS dns-sd; connect with the printed URL instead" };
			return this.current;
		}
		const advertisement = buildBonjourAdvertisement(input);
		let child: ChildProcess;
		try {
			child = this.spawn("/bin/sh", ["-c", WATCHDOG_SCRIPT, "pi-remote-bonjour", ...buildDnsSdArgs(advertisement)], {
				stdio: "ignore",
			});
		} catch (error) {
			this.current = { active: false, reason: `dns-sd failed to start: ${errorMessage(error)}` };
			return this.current;
		}
		this.child = child;
		this.current = { active: true, instanceName: advertisement.instanceName };
		child.on("error", (error) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.current = { active: false, reason: `dns-sd failed: ${errorMessage(error)}` };
			this.logger.warn("Bonjour advertisement failed", { error: errorMessage(error) });
		});
		child.on("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = undefined;
			this.current = { active: false, reason: `dns-sd exited (${signal ?? code ?? "unknown"})` };
		});
		child.unref();
		this.installExitHook();
		this.logger.info("Bonjour advertisement started", { name: advertisement.instanceName, port: advertisement.port });
		return this.current;
	}

	stop(reason = "stopped"): void {
		const child = this.child;
		this.child = undefined;
		if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		this.current = { active: false, reason };
	}

	status(): BonjourStatus {
		return this.current;
	}

	private installExitHook(): void {
		if (this.exitHookInstalled) return;
		this.exitHookInstalled = true;
		process.once("exit", () => this.stop());
	}
}

function truncateUtf8(value: string, maxBytes: number): string {
	let result = value;
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = Array.from(result).slice(0, -1).join("");
	return result;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
