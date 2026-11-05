import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TrustedDevice } from "./auth/DeviceTrust.js";
import { DEFAULT_REMOTE_CONFIG } from "./config.js";
import type { Logger } from "./logging/logger.js";
import type { PiRemoteAdapter } from "./pi/PiRemoteAdapter.js";
import { buildPairingDeepLink, renderPairingQrCode } from "./runtime/pairingLink.js";
import type { RemoteControlRuntime, RemoteRuntimeStatus } from "./runtime/RemoteControlRuntime.js";
import type { RemoteSettingsStore } from "./runtime/RemoteSettings.js";

const ACTIONS = ["start", "stop", "status", "devices", "revoke", "rotate", "autostart"] as const;
type RemoteAction = (typeof ACTIONS)[number];

export function registerRemoteCommand(
	pi: ExtensionAPI,
	runtime: RemoteControlRuntime,
	adapter: PiRemoteAdapter,
	logger: Logger,
	settings?: RemoteSettingsStore,
): void {
	pi.registerCommand("remote", {
		description: "Pi Remote: start/stop the LAN server, pair, list or revoke devices",
		getArgumentCompletions: (prefix) => ACTIONS.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			adapter.captureContext(ctx);
			await adapter.refreshExecutionContext();
			let parsed: ParsedRemoteArgs;
			try {
				parsed = parseRemoteArgs(args);
			} catch (err) {
				ctx.ui.notify((err as Error).message, "error");
				return;
			}

			switch (parsed.action) {
				case "stop":
					await runtime.stop();
					ctx.ui.setStatus("pi-remote", undefined);
					ctx.ui.notify("Pi Remote stopped", "info");
					return;
				case "status":
					ctx.ui.notify(formatStatus(runtime.getStatus()), "info");
					return;
				case "devices":
					ctx.ui.notify(formatDevices(runtime.getStatus().deviceTrust.trustedDevices), "info");
					return;
				case "revoke": {
					if (!parsed.target) {
						ctx.ui.notify("Usage: /remote revoke <device-id>  (see /remote devices)", "error");
						return;
					}
					const result = runtime.revokeDevice(parsed.target);
					ctx.ui.notify(
						result.ok ? `Revoked ${result.device.name} (${result.device.id}). It must pair again.` : result.message,
						result.ok ? "warning" : "error",
					);
					return;
				}
				case "rotate": {
					const status = runtime.rotateTrust();
					ctx.ui.notify(`All trusted devices revoked.\n${formatStatus(status)}`, "warning");
					return;
				}
				case "autostart": {
					if (!settings) {
						ctx.ui.notify("Autostart is unavailable", "error");
						return;
					}
					const next = parsed.target === "on" ? settings.update({ autoStart: true }) : parsed.target === "off" ? settings.update({ autoStart: false }) : settings.load();
					ctx.ui.notify(
						next.autoStart
							? "Autostart: on — interactive Pi sessions serve already-paired devices on the LAN. Run /remote start to pair a new one."
							: "Autostart: off — run /remote start to serve the phone.",
						"info",
					);
					return;
				}
				case "start":
					await startRemote(runtime, ctx, logger, parsed);
					return;
			}
		},
	});
}

async function startRemote(runtime: RemoteControlRuntime, ctx: ExtensionContext, logger: Logger, parsed: ParsedRemoteArgs): Promise<void> {
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
			advertise: parsed.advertise,
		});
	} catch (err) {
		ctx.ui.notify(`Pi Remote failed to start: ${(err as Error).message}`, "error");
		return;
	}

	if (result.lanExposure) {
		ctx.ui.notify(
			`Pi Remote is listening on your local network (${result.config.host}), TLS-encrypted. Only pair on networks you trust.`,
			"warning",
		);
	}
	if (result.publicWebSocketUrl) {
		ctx.ui.notify(
			`Cloudflare Quick Tunnel is exposing this Pi to the public internet at ${result.tunnelHostname}. Anyone with the pairing code can pair during the 2-minute window.`,
			"warning",
		);
	}

	const connectUrl = result.publicWebSocketUrl ?? result.webSocketUrl;
	ctx.ui.setStatus("pi-remote", statusBarText(result.displayWebSocketUrl));
	runtime.onStatusChange((status) => {
		ctx.ui.setStatus("pi-remote", statusBarText(status.displayWebSocketUrl));
		ctx.ui.notify(`Pi Remote moved to ${status.displayWebSocketUrl} (LAN address changed). Paired phones reconnect via Bonjour.`, "info");
	});
	const qrBlock = await buildPairingQrBlock({ webSocketUrl: connectUrl, pairingCode: result.pairingCode });
	ctx.ui.notify(
		`${formatStatus(result)}\n\nPairing code: ${result.pairingCode}\nExpires: ${result.pairingExpiresAt}${qrBlock}`,
		"info",
	);
	logger.info("remote_command_started", {
		host: result.config.host,
		port: result.config.port,
		tunnel: Boolean(result.publicWebSocketUrl),
	});
}

export function statusBarText(displayWebSocketUrl: string | undefined): string {
	return displayWebSocketUrl ? `remote: ${displayWebSocketUrl}` : "remote: running";
}

type ParsedRemoteArgs = {
	action: RemoteAction;
	/** `revoke <id>` / `autostart on|off`. */
	target?: string;
	host?: string;
	port?: number;
	debugRawEvents?: boolean;
	useTunnel?: boolean;
	advertise?: boolean;
	showLogs?: boolean;
};

export function parseRemoteArgs(args: string): ParsedRemoteArgs {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const explicitAction = (ACTIONS as readonly string[]).includes(parts[0] ?? "") ? (parts[0] as RemoteAction) : undefined;
	const action = explicitAction ?? "start";
	if (action === "revoke" || action === "autostart") {
		const target = parts[1];
		if (action === "autostart" && target !== undefined && target !== "on" && target !== "off") {
			throw new Error("Usage: /remote autostart [on|off]");
		}
		return { action, target };
	}

	let host: string | undefined;
	let port: number | undefined;
	let debugRawEvents = DEFAULT_REMOTE_CONFIG.debugRawEvents;
	// Pi Remote ships as a same-network tool. Tunnel support stays disabled.
	let useTunnel = false;
	let advertise = DEFAULT_REMOTE_CONFIG.advertise;
	// Default to silent so the Pi prompt isn't drowned by connect/disconnect
	// chatter; `--logs` flips structured logging on for this session.
	let showLogs = false;

	for (let i = explicitAction ? 1 : 0; i < parts.length; i += 1) {
		const part = parts[i];
		if (part === "--host" && parts[i + 1]) host = parts[++i];
		else if (part.startsWith("--host=")) host = part.slice("--host=".length);
		else if (part === "--port" && parts[i + 1]) port = Number(parts[++i]);
		else if (part.startsWith("--port=")) port = Number(part.slice("--port=".length));
		else if (part === "--debug-raw-events") debugRawEvents = true;
		else if (part === "--local" || part === "--no-tunnel") useTunnel = false;
		else if (part === "--no-advertise" || part === "--no-bonjour") advertise = false;
		else if (part === "--logs" || part === "--verbose") showLogs = true;
	}

	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
		throw new Error("Port must be an integer between 1 and 65535");
	}

	return { action, host, port, debugRawEvents, useTunnel, advertise, showLogs };
}

async function buildPairingQrBlock(result: { webSocketUrl?: string; pairingCode?: string }): Promise<string> {
	if (!result.webSocketUrl || !result.pairingCode) return "";
	const link = buildPairingDeepLink(result.webSocketUrl, result.pairingCode);
	const qr = await renderPairingQrCode(link);
	return `\n\nScan to pair:\n${qr}\nDeep link: ${link}`;
}

export function formatStatus(status: RemoteRuntimeStatus): string {
	if (!status.running) return "Pi Remote is stopped";
	const pairing = status.deviceTrust.pairing;
	const lines = [
		"Pi Remote is running",
		`HTTPS: ${status.httpUrl ?? "unknown"}`,
		`WebSocket: ${status.webSocketUrl ?? "unknown"}`,
		`Fingerprint: ${status.fingerprintShort ?? "unknown"}`,
		`Address: ${status.followsLanAddress ? "follows this Mac's LAN IP" : "fixed (--host)"}`,
		status.bonjour.active ? `Bonjour: advertising "${status.bonjour.instanceName}"` : `Bonjour: off (${status.bonjour.reason})`,
	];
	if (status.publicWebSocketUrl) {
		lines.push(`Public (Cloudflare Tunnel): ${status.publicWebSocketUrl}`);
	}
	lines.push(
		`Trusted devices: ${status.deviceTrust.trustedDevices.length} (/remote devices)`,
		pairing.active
			? `Pairing: active, code ${pairing.code}, until ${pairing.expiresAt} (${pairing.remainingAttempts} attempts left)`
			: "Pairing: inactive; run /remote start to create a fresh code",
	);
	return lines.join("\n");
}

export function formatDevices(devices: TrustedDevice[]): string {
	if (devices.length === 0) return "No trusted devices. Run /remote start and pair from the iPhone.";
	const rows = devices.map(
		(device) => `${device.id}  ${device.name}  paired ${device.createdAt}  last seen ${device.lastSeenAt}${device.remoteAddress ? ` from ${device.remoteAddress}` : ""}`,
	);
	return `Trusted devices (${devices.length}):\n${rows.join("\n")}\n\nRevoke one with /remote revoke <id> (a unique prefix is enough); /remote rotate revokes all.`;
}
