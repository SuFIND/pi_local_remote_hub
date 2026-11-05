import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir, writePrivateFile } from "../identity/HostIdentity.js";

/** Persistent `/remote` preferences (`<state dir>/settings.json`). */
export type RemoteSettings = {
	/** Start the LAN listener (no pairing window) when an interactive Pi session starts. */
	autoStart: boolean;
};

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = { autoStart: false };

export class RemoteSettingsStore {
	constructor(private readonly path: string) {}

	load(): RemoteSettings {
		if (!existsSync(this.path)) return { ...DEFAULT_REMOTE_SETTINGS };
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			const autoStart = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).autoStart : undefined;
			return { autoStart: autoStart === true };
		} catch {
			return { ...DEFAULT_REMOTE_SETTINGS };
		}
	}

	update(patch: Partial<RemoteSettings>): RemoteSettings {
		const next = { ...this.load(), ...patch };
		ensurePrivateDir(dirname(this.path));
		writePrivateFile(this.path, `${JSON.stringify(next, null, 2)}\n`);
		return next;
	}
}
