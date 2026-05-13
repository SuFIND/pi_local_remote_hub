import {
	constantTimeEqualString,
	createPairingCode,
	createSecret,
	createToken,
	hashToken,
	normalizePairingCode,
} from "./crypto.js";

// MARK: - Public types

export type DeviceTrustStatus = {
	pairing: PairingStatus;
	trustedDevices: TrustedDevice[];
};

export type PairDeviceResult =
	| { ok: true; token: string; device: TrustedDevice }
	| { ok: false; code: "PAIRING_DISABLED" | "PAIRING_EXPIRED" | "PAIRING_ATTEMPTS_EXCEEDED" | "UNAUTHORIZED"; message: string };

export type PairingStatus = {
	active: boolean;
	code?: string;
	expiresAt?: string;
	remainingAttempts?: number;
};

export type PairingStartOptions = {
	ttlMs?: number;
	maxAttempts?: number;
};

export type TrustedDevice = {
	id: string;
	name: string;
	createdAt: string;
	lastSeenAt: string;
	remoteAddress?: string;
};

// MARK: - DeviceTrust

const DEFAULT_PAIRING_TTL_MS = 2 * 60_000;
const DEFAULT_MAX_PAIRING_ATTEMPTS = 5;
const MAX_TOKEN_LENGTH = 512;
const MAX_DEVICE_NAME_LENGTH = 80;

type TrustedDeviceRecord = TrustedDevice & { tokenHash: string };

type PairingValidation =
	| { ok: true }
	| { ok: false; code: "PAIRING_DISABLED" | "PAIRING_EXPIRED" | "PAIRING_ATTEMPTS_EXCEEDED" | "UNAUTHORIZED"; message: string };

/**
 * Device Trust — pairing window, code validation, token issue/verify, and
 * trusted-device list. The single deep module behind the auth domain.
 *
 * Internals (`#pairing`, `#tokens`) are not exported. They were once two
 * separate `PairingManager` and `TokenStore` classes; the fold matches the
 * file count to the domain count (one), so a reader chasing "how does
 * pairing work?" lands here and stops here.
 */
export class DeviceTrust {
	readonly #pairing = new PairingState();
	readonly #tokens = new TokenStoreState();

	startPairing(options: PairingStartOptions = {}): PairingStatus {
		return this.#pairing.start(options);
	}

	stopPairing(): void {
		this.#pairing.stop();
	}

	isPairingAvailable(): boolean {
		return this.#pairing.isAvailable();
	}

	pairDevice(input: { code: string; deviceName?: string; remoteAddress?: string }): PairDeviceResult {
		const validation = this.#pairing.validate(input.code);
		if (!validation.ok) return validation;
		return { ok: true, ...this.#tokens.issue({ name: input.deviceName, remoteAddress: input.remoteAddress }) };
	}

	authenticateToken(token: string): TrustedDevice | undefined {
		return this.#tokens.verify(token);
	}

	revokeAllTrustedDevices(): void {
		this.#tokens.revokeAll();
	}

	listTrustedDevices(): TrustedDevice[] {
		return this.#tokens.list();
	}

	getStatus(): DeviceTrustStatus {
		return {
			pairing: this.#pairing.status(),
			trustedDevices: this.listTrustedDevices(),
		};
	}
}

// MARK: - Internal: pairing window

class PairingState {
	private code?: string;
	private expiresAt = 0;
	private attempts = 0;
	private maxAttempts = DEFAULT_MAX_PAIRING_ATTEMPTS;

	start(options: PairingStartOptions): PairingStatus {
		this.code = createPairingCode();
		this.expiresAt = Date.now() + (options.ttlMs ?? DEFAULT_PAIRING_TTL_MS);
		this.attempts = 0;
		this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_PAIRING_ATTEMPTS;
		return this.status();
	}

	stop(): void {
		this.code = undefined;
		this.expiresAt = 0;
		this.attempts = 0;
	}

	status(): PairingStatus {
		if (!this.code || Date.now() >= this.expiresAt || this.attempts >= this.maxAttempts) {
			return { active: false };
		}
		return {
			active: true,
			code: this.code,
			expiresAt: new Date(this.expiresAt).toISOString(),
			remainingAttempts: Math.max(0, this.maxAttempts - this.attempts),
		};
	}

	isAvailable(): boolean {
		return this.status().active;
	}

	validate(candidate: string): PairingValidation {
		if (!this.code) {
			return { ok: false, code: "PAIRING_DISABLED", message: "Pairing is not enabled. Run /remote start again." };
		}
		if (Date.now() >= this.expiresAt) {
			this.stop();
			return { ok: false, code: "PAIRING_EXPIRED", message: "Pairing code expired. Run /remote start again." };
		}
		if (this.attempts >= this.maxAttempts) {
			this.stop();
			return { ok: false, code: "PAIRING_ATTEMPTS_EXCEEDED", message: "Pairing attempts exceeded. Run /remote start again." };
		}

		this.attempts += 1;
		if (!constantTimeEqualString(normalizePairingCode(candidate), this.code)) {
			if (this.attempts >= this.maxAttempts) {
				this.stop();
				return { ok: false, code: "PAIRING_ATTEMPTS_EXCEEDED", message: "Pairing attempts exceeded. Run /remote start again." };
			}
			return { ok: false, code: "UNAUTHORIZED", message: "Invalid pairing code" };
		}

		this.stop();
		return { ok: true };
	}
}

// MARK: - Internal: token store

class TokenStoreState {
	private readonly serverSecret = createSecret();
	private readonly devices = new Map<string, TrustedDeviceRecord>();

	issue(input: { name?: string; remoteAddress?: string }): { token: string; device: TrustedDevice } {
		const token = createToken();
		const now = new Date().toISOString();
		const id = createToken().slice(0, 16);
		const record: TrustedDeviceRecord = {
			id,
			name: sanitizeDeviceName(input.name) ?? "Unnamed device",
			createdAt: now,
			lastSeenAt: now,
			remoteAddress: input.remoteAddress,
			tokenHash: hashToken(token, this.serverSecret),
		};
		this.devices.set(id, record);
		return { token, device: publicDevice(record) };
	}

	verify(token: string): TrustedDevice | undefined {
		if (!token || token.length > MAX_TOKEN_LENGTH) return undefined;
		const candidate = hashToken(token, this.serverSecret);
		for (const record of this.devices.values()) {
			if (constantTimeEqualString(record.tokenHash, candidate)) {
				record.lastSeenAt = new Date().toISOString();
				return publicDevice(record);
			}
		}
		return undefined;
	}

	revokeAll(): void {
		this.devices.clear();
	}

	list(): TrustedDevice[] {
		return [...this.devices.values()].map(publicDevice);
	}
}

function sanitizeDeviceName(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	return trimmed.length > MAX_DEVICE_NAME_LENGTH ? trimmed.slice(0, MAX_DEVICE_NAME_LENGTH) : trimmed;
}

function publicDevice(record: TrustedDeviceRecord): TrustedDevice {
	return {
		id: record.id,
		name: record.name,
		createdAt: record.createdAt,
		lastSeenAt: record.lastSeenAt,
		remoteAddress: record.remoteAddress,
	};
}
