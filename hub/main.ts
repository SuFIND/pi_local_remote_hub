import { existsSync, mkdirSync, statSync, truncateSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatDevices, formatStatus, type HubStatusView } from "../extension/command.js";
import type { TrustedDevice } from "../extension/auth/DeviceTrust.js";
import { hubSocketPath } from "../extension/hubwire/frames.js";
import { createLogger } from "../extension/logging/logger.js";
import { buildPairingDeepLink, renderPairingQrCode } from "../extension/runtime/pairingLink.js";
import { remoteStateDir } from "../extension/storage.js";
import { controlRequest } from "./controlClient.js";
import { canonicalPath, hubConfigPath, loadHubConfig, saveHubConfig } from "./HubConfig.js";
import { HubService } from "./HubService.js";
import { buildLaunchAgentPlist, installLaunchAgent, launchAgentPath, launchPath, uninstallLaunchAgent } from "./launchd.js";

const USAGE = `Pi Remote Hub — serve your Mac's Pi sessions to the Pi Remote iPhone app.

Usage: node hub/bin.mjs <command>

  run                  Run the hub in the foreground
  install              Run the hub at login (launchd agent) and start it now
  uninstall            Remove the login item and stop the hub
  status               Show the hub's address, folders and devices
  pair                 Open a 2-minute pairing window (prints code + QR)
  devices              List trusted phones
  revoke <id>          Revoke one phone
  roots                List the folders shared with the phone
  roots add <dir>      Share a folder (its sessions and subfolders)
  roots remove <dir>   Stop sharing a folder
  idle <minutes>       Minutes before a hub-started Pi exits when idle
`;

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export async function main(argv: string[]): Promise<number> {
	const [command = "help", ...rest] = argv;
	const stateDir = remoteStateDir();
	const configPath = hubConfigPath(stateDir);
	const socketPath = hubSocketPath(stateDir);
	try {
		switch (command) {
			case "run":
				return await run(stateDir, configPath);
			case "status":
				console.log(formatStatus((await controlRequest(socketPath, "status")) as HubStatusView));
				return 0;
			case "pair": {
				const status = (await controlRequest(socketPath, "pair")) as HubStatusView;
				console.log(formatStatus(status));
				if (status.webSocketUrl && status.pairingCode) {
					const link = buildPairingDeepLink(status.webSocketUrl, status.pairingCode);
					console.log(`\nPairing code: ${status.pairingCode}\nExpires: ${status.pairingExpiresAt}\n\n${await renderPairingQrCode(link)}\nDeep link: ${link}`);
				}
				return 0;
			}
			case "devices": {
				const result = (await controlRequest(socketPath, "devices")) as { devices: TrustedDevice[] };
				console.log(formatDevices(result.devices).replaceAll("/remote ", "hub/bin.mjs "));
				return 0;
			}
			case "revoke": {
				if (!rest[0]) throw new Error("Usage: revoke <device-id>");
				const device = (await controlRequest(socketPath, "revoke", { id: rest[0] })) as TrustedDevice;
				console.log(`Revoked ${device.name} (${device.id}).`);
				return 0;
			}
			case "roots":
				return roots(configPath, rest);
			case "idle": {
				const minutes = Number(rest[0]);
				if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("Usage: idle <minutes>");
				saveHubConfig(configPath, { ...loadHubConfig(configPath), idleExitMinutes: minutes });
				console.log(`Hub-started Pi exits after ${minutes} min idle.`);
				return 0;
			}
			case "install":
				return install(stateDir, configPath);
			case "uninstall":
				console.log(uninstallLaunchAgent() ? "Removed the Pi Remote Hub login item." : "No login item was installed.");
				return 0;
			default:
				console.log(USAGE);
				return command === "help" || command === "--help" ? 0 : 1;
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function run(stateDir: string, configPath: string): Promise<number> {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const logPath = join(stateDir, "hub.log");
	if (existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) truncateSync(logPath, 0);
	const logger = createLogger("pi-remote-hub", "info");
	const config = loadHubConfig(configPath);
	if (!existsSync(configPath)) saveHubConfig(configPath, config);
	const hub = new HubService({ stateDir, config, logger });
	await hub.start();
	const status = hub.status();
	logger.info("hub_started", { url: status.displayWebSocketUrl, roots: config.roots, pid: process.pid });
	if (config.roots.length === 0) logger.warn("hub_no_roots", { hint: "node hub/bin.mjs roots add <dir>" });

	watchFile(configPath, { interval: 2_000 }, () => {
		try {
			hub.updateConfig(loadHubConfig(configPath));
			logger.info("hub_config_reloaded", {});
		} catch (error) {
			logger.warn("hub_config_invalid", { error: error instanceof Error ? error.message : String(error) });
		}
	});

	await new Promise<void>((resolve) => {
		const shutdown = () => resolve();
		process.once("SIGINT", shutdown);
		process.once("SIGTERM", shutdown);
	});
	unwatchFile(configPath);
	await hub.stop();
	return 0;
}

function roots(configPath: string, args: string[]): number {
	const config = loadHubConfig(configPath);
	const [action, dir] = args;
	if (action === "add" || action === "remove") {
		if (!dir) throw new Error(`Usage: roots ${action} <dir>`);
		const path = canonicalPath(dir);
		if (action === "add" && !(existsSync(path) && statSync(path).isDirectory())) throw new Error(`Not a folder: ${path}`);
		const next = action === "add" ? [...new Set([...config.roots, path])] : config.roots.filter((root) => root !== path);
		saveHubConfig(configPath, { ...config, roots: next });
		config.roots = next;
	}
	console.log(config.roots.length > 0 ? `Shared folders:\n${config.roots.map((root) => `  ${root}`).join("\n")}` : "No shared folders. Add one: roots add <dir>");
	return 0;
}

function install(stateDir: string, configPath: string): number {
	mkdirSync(stateDir, { recursive: true, mode: 0o700 });
	const config = loadHubConfig(configPath);
	if (!existsSync(configPath)) saveHubConfig(configPath, config);
	const binPath = fileURLToPath(new URL("./bin.mjs", import.meta.url));
	const plist = buildLaunchAgentPlist({
		nodePath: process.execPath,
		binPath,
		logPath: join(stateDir, "hub.log"),
		path: launchPath(config.piCommand),
		stateDir: process.env.PI_REMOTE_STATE_DIR?.trim() || undefined,
	});
	installLaunchAgent(plist);
	console.log(`Installed ${launchAgentPath()}; the hub now runs at login. Logs: ${join(stateDir, "hub.log")}`);
	if (config.roots.length === 0) console.log("Next: share a folder with `node hub/bin.mjs roots add <dir>`, then pair with `node hub/bin.mjs pair`.");
	return 0;
}
