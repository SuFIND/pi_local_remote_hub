import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";

export const LAUNCH_AGENT_LABEL = "com.pi-remote.hub";

export function launchAgentPath(): string {
	return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

/**
 * launchd starts agents with a bare PATH. Keep the directories that hold
 * `node`, `pi` and Homebrew tools so the hub can start Pi like a terminal.
 */
export function launchPath(piCommand: string): string {
	const dirs = [dirname(process.execPath)];
	const pi = which(piCommand);
	if (pi) dirs.push(dirname(pi));
	dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
	return [...new Set(dirs)].join(delimiter);
}

export function buildLaunchAgentPlist(input: { nodePath: string; binPath: string; logPath: string; path: string; stateDir?: string }): string {
	const env: Record<string, string> = { PATH: input.path };
	if (input.stateDir) env.PI_REMOTE_STATE_DIR = input.stateDir;
	const envXml = Object.entries(env)
		.map(([key, value]) => `\t\t<key>${xml(key)}</key>\n\t\t<string>${xml(value)}</string>`)
		.join("\n");
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>${LAUNCH_AGENT_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${xml(input.nodePath)}</string>
		<string>${xml(input.binPath)}</string>
		<string>run</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
${envXml}
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardOutPath</key>
	<string>${xml(input.logPath)}</string>
	<key>StandardErrorPath</key>
	<string>${xml(input.logPath)}</string>
</dict>
</plist>
`;
}

export function installLaunchAgent(plist: string): void {
	const path = launchAgentPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, plist, { mode: 0o644 });
	const domain = `gui/${userInfo().uid}`;
	try {
		execFileSync("launchctl", ["bootout", `${domain}/${LAUNCH_AGENT_LABEL}`], { stdio: "ignore" });
	} catch {
		// not loaded yet
	}
	execFileSync("launchctl", ["bootstrap", domain, path], { stdio: "inherit" });
}

export function uninstallLaunchAgent(): boolean {
	const path = launchAgentPath();
	try {
		execFileSync("launchctl", ["bootout", `gui/${userInfo().uid}/${LAUNCH_AGENT_LABEL}`], { stdio: "ignore" });
	} catch {
		// not loaded
	}
	if (!existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

function which(command: string): string | undefined {
	if (command.includes("/")) return command;
	try {
		return execFileSync("/usr/bin/which", [command], { encoding: "utf8" }).trim() || undefined;
	} catch {
		return undefined;
	}
}

function xml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
