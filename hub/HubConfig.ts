import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export type HubConfig = {
	/** Folders the phone may use. Sessions and new sessions are limited to these trees. */
	roots: string[];
	/** Hub-started Pi processes exit after this long without a run. */
	idleExitMinutes: number;
	/** Preferred LAN port; any free port is used when it is taken. */
	port: number;
	/** Command used to start Pi for the phone. */
	piCommand: string;
	/** Extra arguments for hub-started Pi (e.g. `-e <extension>` while developing). */
	piArgs: string[];
};

export const DEFAULT_HUB_CONFIG: HubConfig = {
	roots: [],
	idleExitMinutes: 3,
	port: 3769,
	piCommand: "pi",
	piArgs: [],
};

export function hubConfigPath(stateDir: string): string {
	return join(stateDir, "hub.json");
}

export function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** Absolute, symlink-free form when the path exists (so a symlink cannot widen a root). */
export function canonicalPath(path: string): string {
	const absolute = resolve(expandHome(path));
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

export function loadHubConfig(path: string): HubConfig {
	if (!existsSync(path)) return { ...DEFAULT_HUB_CONFIG, roots: [] };
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Invalid hub config ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const roots = Array.isArray(raw.roots) ? raw.roots.filter((root): root is string => typeof root === "string" && root.trim() !== "") : [];
	const idle = typeof raw.idleExitMinutes === "number" && raw.idleExitMinutes > 0 && raw.idleExitMinutes <= 24 * 60 ? raw.idleExitMinutes : DEFAULT_HUB_CONFIG.idleExitMinutes;
	const port = typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port > 0 && raw.port < 65_536 ? raw.port : DEFAULT_HUB_CONFIG.port;
	const piCommand = typeof raw.piCommand === "string" && raw.piCommand.trim() ? raw.piCommand.trim() : DEFAULT_HUB_CONFIG.piCommand;
	const piArgs = Array.isArray(raw.piArgs) ? raw.piArgs.filter((arg): arg is string => typeof arg === "string").map(expandHome) : [];
	return { roots: dedupe(roots.map(canonicalPath)), idleExitMinutes: idle, port, piCommand, piArgs };
}

export function saveHubConfig(path: string, config: HubConfig): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(config, null, "\t")}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

/** True when `path` is a root or lies below one (both canonicalized). */
export function isInsideRoots(path: string, roots: readonly string[]): boolean {
	const target = canonicalPath(path);
	return roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

function dedupe(values: string[]): string[] {
	return [...new Set(values)];
}
