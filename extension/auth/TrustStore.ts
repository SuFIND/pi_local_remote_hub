import { existsSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir, writePrivateFile } from "../identity/HostIdentity.js";

/**
 * Persistence seam behind `DeviceTrust`. Only token *hashes* (keyed by a
 * per-install secret) are stored — never the bearer tokens themselves.
 */
export type TrustedDeviceRecord = {
	id: string;
	name: string;
	createdAt: string;
	lastSeenAt: string;
	remoteAddress?: string;
	tokenHash: string;
};

export type TrustFile = {
	version: 1;
	secret: string;
	devices: TrustedDeviceRecord[];
};

export interface TrustStore {
	load(): TrustFile | undefined;
	save(file: TrustFile): void;
}

/** Process-local store: trust dies with the process (tests, ephemeral use). */
export class MemoryTrustStore implements TrustStore {
	private file?: TrustFile;

	load(): TrustFile | undefined {
		return this.file ? structuredClone(this.file) : undefined;
	}

	save(file: TrustFile): void {
		this.file = structuredClone(file);
	}
}

/**
 * JSON file (0600, atomic rename) shared by every Pi process using the same
 * agent directory. Each `DeviceTrust` operation re-reads it, so a device
 * paired or revoked in one Pi window is honoured by the others.
 */
export class FileTrustStore implements TrustStore {
	constructor(private readonly path: string) {}

	load(): TrustFile | undefined {
		if (!existsSync(this.path)) return undefined;
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
			const file = parseTrustFile(parsed);
			if (file) return file;
		} catch {
			// Fall through.
		}
		// Unreadable trust state fails closed: set it aside (for inspection)
		// and start over with no trusted devices.
		try {
			renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
		} catch {
			// Ignore — the next save overwrites it.
		}
		return undefined;
	}

	save(file: TrustFile): void {
		ensurePrivateDir(dirname(this.path));
		writePrivateFile(this.path, `${JSON.stringify(file, null, 2)}\n`);
	}
}

function parseTrustFile(value: unknown): TrustFile | undefined {
	if (!isRecord(value) || value.version !== 1 || typeof value.secret !== "string" || value.secret.length < 16) return undefined;
	if (!Array.isArray(value.devices)) return undefined;
	const devices: TrustedDeviceRecord[] = [];
	for (const entry of value.devices) {
		if (!isRecord(entry)) return undefined;
		const { id, name, createdAt, lastSeenAt, remoteAddress, tokenHash } = entry;
		if (typeof id !== "string" || typeof name !== "string" || typeof tokenHash !== "string") return undefined;
		if (typeof createdAt !== "string" || typeof lastSeenAt !== "string") return undefined;
		devices.push({
			id,
			name,
			createdAt,
			lastSeenAt,
			...(typeof remoteAddress === "string" ? { remoteAddress } : {}),
			tokenHash,
		});
	}
	return { version: 1, secret: value.secret, devices };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
