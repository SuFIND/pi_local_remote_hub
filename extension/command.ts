import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_REMOTE_CONFIG } from "./config.js";
import type { Logger } from "./logging/logger.js";
import type { PiRemoteAdapter } from "./pi/PiRemoteAdapter.js";
import { buildPairingDeepLink, renderPairingQrCode } from "./runtime/pairingLink.js";
import type { RemoteControlRuntime, RemoteRuntimeStatus } from "./runtime/RemoteControlRuntime.js";

export function registerRemoteCommand(pi: ExtensionAPI, runtime: RemoteControlRuntime, adapter: PiRemoteAdapter, logger: Logger): void {
	pi.registerCommand("remote", {
		description: "Start or stop the Pi Remote WebSocket server",
		getArgumentCompletions: (prefix) => ["start", "stop", "status", "rotate"].filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			adapter.captureContext(ctx);
			await adapter.refreshExecutionContext();
			const parsed = parseRemoteArgs(args);

			if (parsed.action === "stop") {
				await runtime.stop();
				ctx.ui.setStatus("pi-remote", undefined);
				ctx.ui.notify("Pi Remote stopped", "info");
				return;
			}

			if (parsed.action === "status") {
				ctx.ui.notify(formatStatus(runtime.getStatus()), "info");
				return;
			}

			if (parsed.action === "rotate") {
				const status = runtime.rotateTrust();
				ctx.ui.notify(`Trusted devices revoked.\n${formatStatus(status)}`, "warning");
				return;
			}

			// Logging level is per-session — re-running `/remote start` without `--logs`
			// after a previous `--logs` session returns to silent.
			logger.setMinLevel(parsed.showLogs ? "info" : "silent");

			let result;
			try {
				result = await runtime.start({
					host: parsed.host,
					port: parsed.port,
					debugRawEvents: parsed.debugRawEvents,
					useTunnel: parsed.useTunnel,
				});
			} catch (err) {
				const message = (err as Error).message;
				ctx.ui.notify(`Pi Remote failed to start: ${message}`, "error");
				return;
			}

			if (result.lanExposure) {
				ctx.ui.notify("Pi Remote is binding to a non-localhost address. Only use this on trusted networks.", "warning");
			}
			if (result.publicWebSocketUrl) {
				ctx.ui.notify(
					`Cloudflare Quick Tunnel is exposing this Pi to the public internet at ${result.tunnelHostname}. Anyone with the pairing code can pair during the 2-minute window.`,
					"warning",
				);
			}

			const advertisedUrl = result.publicWebSocketUrl ?? result.webSocketUrl;
			ctx.ui.setStatus("pi-remote", advertisedUrl ? `remote: ${advertisedUrl}` : "remote: running");
			const qrBlock = await buildPairingQrBlock({ webSocketUrl: advertisedUrl, pairingCode: result.pairingCode });
			ctx.ui.notify(
				`${formatStatus(result)}\n\nPairing code: ${result.pairingCode}\nExpires: ${result.pairingExpiresAt}${qrBlock}`,
				"info",
			);
			logger.info("remote_command_started", {
				host: result.config.host,
				port: result.config.port,
				tunnel: Boolean(result.publicWebSocketUrl),
			});
		},
	});
}

type ParsedRemoteArgs = {
	action: "start" | "stop" | "status" | "rotate";
	host?: string;
	port?: number;
	debugRawEvents?: boolean;
	useTunnel?: boolean;
	showLogs?: boolean;
};

function parseRemoteArgs(args: string): ParsedRemoteArgs {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const action = parts[0] === "stop" || parts[0] === "status" || parts[0] === "rotate" ? parts[0] : "start";
	let host: string | undefined;
	let port: number | undefined;
	let debugRawEvents = DEFAULT_REMOTE_CONFIG.debugRawEvents;
	// Pi Remote ships as a same-network tool. Tunnel support stays disabled.
	let useTunnel = false;
	// Default to silent so the Pi prompt isn't drowned by connect/disconnect
	// chatter; `--logs` flips structured logging on for this session.
	let showLogs = false;

	for (let i = action === "start" && parts[0] === "start" ? 1 : 0; i < parts.length; i += 1) {
		const part = parts[i];
		if (part === "--host" && parts[i + 1]) host = parts[++i];
		else if (part.startsWith("--host=")) host = part.slice("--host=".length);
		else if (part === "--port" && parts[i + 1]) port = Number(parts[++i]);
		else if (part.startsWith("--port=")) port = Number(part.slice("--port=".length));
		else if (part === "--debug-raw-events") debugRawEvents = true;
		else if (part === "--local" || part === "--no-tunnel") useTunnel = false;
		else if (part === "--logs" || part === "--verbose") showLogs = true;
	}

	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
		throw new Error("Port must be an integer between 1 and 65535");
	}

	return { action, host, port, debugRawEvents, useTunnel, showLogs };
}

async function buildPairingQrBlock(result: { webSocketUrl?: string; pairingCode?: string }): Promise<string> {
	if (!result.webSocketUrl || !result.pairingCode) return "";
	const link = buildPairingDeepLink(result.webSocketUrl, result.pairingCode);
	const qr = await renderPairingQrCode(link);
	return `\n\nScan to pair:\n${qr}\nDeep link: ${link}`;
}

function formatStatus(status: RemoteRuntimeStatus): string {
	if (!status.running) return "Pi Remote is stopped";
	const pairing = status.deviceTrust.pairing;
	const lines = [
		"Pi Remote is running",
		`HTTP: ${status.httpUrl ?? "unknown"}`,
		`WebSocket: ${status.webSocketUrl ?? "unknown"}`,
	];
	if (status.publicWebSocketUrl) {
		lines.push(`Public (Cloudflare Tunnel): ${status.publicWebSocketUrl}`);
	}
	lines.push(
		pairing.active
			? `Pairing: active, code ${pairing.code}, until ${pairing.expiresAt} (${pairing.remainingAttempts} attempts left)`
			: "Pairing: inactive; run /remote start to create a fresh code",
	);
	return lines.join("\n");
}
