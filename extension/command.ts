import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TrustedDevice } from "./auth/DeviceTrust.js";
import type { ControlOp } from "./hubwire/frames.js";
import { buildPairingDeepLink, renderPairingQrCode } from "./runtime/pairingLink.js";

export const REMOTE_ACTIONS = ["pair", "status", "devices", "revoke", "rotate", "takeover"] as const;
export type RemoteAction = (typeof REMOTE_ACTIONS)[number];

export type HubControl = {
	control(op: ControlOp, args?: Record<string, unknown>): Promise<unknown>;
};

/** What the hub reports for `status` / `pair` (see `hub/HubService.ts`). */
export type HubStatusView = {
	running: boolean;
	/** The hub's package version (package.json). */
	version?: string;
	webSocketUrl?: string;
	displayWebSocketUrl?: string;
	fingerprintShort?: string;
	followsLanAddress: boolean;
	bonjour: { active: true; instanceName: string } | { active: false; reason: string };
	connections: number;
	roots: string[];
	agents: number;
	idleExitMinutes: number;
	deviceTrust: {
		pairing: { active: boolean; code?: string; expiresAt?: string; remainingAttempts?: number };
		trustedDevices: TrustedDevice[];
	};
	pairingCode?: string;
	pairingExpiresAt?: string;
	/** `pi-remote://pair?…` deep link for the open pairing window (QR content). */
	pairingLink?: string;
	lastError?: string;
};

export type RemoteCommandOptions = {
	/** One line telling the user how to start the hub when it is not running. */
	hubHint: string;
	captureContext?: (ctx: ExtensionContext) => void;
};

/**
 * `/remote` manages the Pi Remote Hub from any Pi window. The hub — not
 * this window — owns the LAN listener, so there is no start/stop here:
 * every interactive Pi registers with the hub automatically.
 */
export function registerRemoteCommand(pi: ExtensionAPI, hub: HubControl, options: RemoteCommandOptions): void {
	pi.registerCommand("remote", {
		description: "Pi Remote Hub: pair a phone, list or revoke devices, take a session back from the phone",
		getArgumentCompletions: (prefix) => REMOTE_ACTIONS.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			options.captureContext?.(ctx);
			const [action = "status", target] = args.trim().split(/\s+/).filter(Boolean);
			if (!isRemoteAction(action)) {
				ctx.ui.notify(`Usage: /remote ${REMOTE_ACTIONS.join("|")}`, "error");
				return;
			}
			if (action === "takeover") {
				await takeOver(ctx);
				return;
			}
			try {
				await runHubAction(hub, ctx, action, target);
			} catch (error) {
				ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}. ${options.hubHint}`, "error");
			}
		},
	});
}

function isRemoteAction(value: string): value is RemoteAction {
	return (REMOTE_ACTIONS as readonly string[]).includes(value);
}

async function runHubAction(hub: HubControl, ctx: ExtensionCommandContext, action: Exclude<RemoteAction, "takeover">, target?: string): Promise<void> {
	switch (action) {
		case "status":
			ctx.ui.notify(formatStatus((await hub.control("status")) as HubStatusView), "info");
			return;
		case "pair": {
			const status = (await hub.control("pair")) as HubStatusView;
			const qrBlock = await buildPairingQrBlock(status.webSocketUrl, status.pairingCode);
			ctx.ui.notify(`${formatStatus(status)}\n\nPairing code: ${status.pairingCode}\nExpires: ${status.pairingExpiresAt}${qrBlock}`, "info");
			return;
		}
		case "devices": {
			const result = (await hub.control("devices")) as { devices: TrustedDevice[] };
			ctx.ui.notify(formatDevices(result.devices), "info");
			return;
		}
		case "revoke": {
			if (!target) {
				ctx.ui.notify("Usage: /remote revoke <device-id>  (see /remote devices)", "error");
				return;
			}
			const device = (await hub.control("revoke", { id: target })) as TrustedDevice;
			ctx.ui.notify(`Revoked ${device.name} (${device.id}). It must pair again.`, "warning");
			return;
		}
		case "rotate": {
			const status = (await hub.control("rotate")) as HubStatusView;
			ctx.ui.notify(`All trusted devices revoked.\n${formatStatus(status)}`, "warning");
			return;
		}
	}
}

/**
 * Reload this window's session from disk after the phone worked on it
 * through the hub, so the terminal continues from the latest entry.
 */
async function takeOver(ctx: ExtensionCommandContext): Promise<void> {
	const file = ctx.sessionManager.getSessionFile();
	if (!file) {
		ctx.ui.notify("This Pi window has no session file to reload.", "error");
		return;
	}
	await ctx.waitForIdle();
	const result = await ctx.switchSession(file);
	if (result.cancelled) ctx.ui.notify("Takeover cancelled.", "warning");
}

async function buildPairingQrBlock(webSocketUrl?: string, pairingCode?: string): Promise<string> {
	if (!webSocketUrl || !pairingCode) return "";
	const link = buildPairingDeepLink(webSocketUrl, pairingCode);
	const qr = await renderPairingQrCode(link);
	return `\n\nScan to pair:\n${qr}\nDeep link: ${link}`;
}

export function formatStatus(status: HubStatusView): string {
	if (!status.running) return `Pi Remote Hub is not listening${status.lastError ? `: ${status.lastError}` : ""}`;
	const pairing = status.deviceTrust.pairing;
	const lines = [
		"Pi Remote Hub is running",
		...(status.version ? [`Version: ${status.version}`] : []),
		`WebSocket: ${status.webSocketUrl ?? "unknown"}`,
		`Fingerprint: ${status.fingerprintShort ?? "unknown"}`,
		`Address: ${status.followsLanAddress ? "follows this Mac's LAN IP" : "fixed"}`,
		status.bonjour.active ? `Bonjour: advertising "${status.bonjour.instanceName}"` : `Bonjour: off (${status.bonjour.reason})`,
		`Folders: ${status.roots.length > 0 ? status.roots.join(", ") : "none configured (hub/bin.mjs roots add <dir>)"}`,
		`Pi sessions online: ${status.agents} · phones connected: ${status.connections} · background Pi exits after ${status.idleExitMinutes} min idle`,
		`Trusted devices: ${status.deviceTrust.trustedDevices.length} (/remote devices)`,
		pairing.active
			? `Pairing: active, code ${pairing.code}, until ${pairing.expiresAt} (${pairing.remainingAttempts} attempts left)`
			: "Pairing: inactive; run /remote pair to create a fresh code",
	];
	return lines.join("\n");
}

export function formatDevices(devices: TrustedDevice[]): string {
	if (devices.length === 0) return "No trusted devices. Run /remote pair and pair from the iPhone.";
	const rows = devices.map(
		(device) => `${device.id}  ${device.name}  paired ${device.createdAt}  last seen ${device.lastSeenAt}${device.remoteAddress ? ` from ${device.remoteAddress}` : ""}`,
	);
	return `Trusted devices (${devices.length}):\n${rows.join("\n")}\n\nRevoke one with /remote revoke <id> (a unique prefix is enough); /remote rotate revokes all.`;
}
