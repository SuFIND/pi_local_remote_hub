import type { DeviceTrust, DeviceTrustStatus, RevokeDeviceResult } from "../auth/DeviceTrust.js";
import { AUTO_HOST, isLanExposure, withRemoteConfig, type RemoteConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { BonjourAdvertiser, BonjourStatus } from "../net/BonjourAdvertiser.js";
import { isLoopbackHost, selectLanAddress } from "../net/lanAddress.js";
import type { QuestionBroker } from "../questions/QuestionBroker.js";
import type { RemoteServer } from "../server/RemoteServer.js";

export type RemoteStartOptions = {
	host?: string;
	port?: number;
	debugRawEvents?: boolean;
	/** Bonjour advertisement; defaults to on. */
	advertise?: boolean;
	/** Open a fresh pairing window (default). `false` = serve already-paired devices only (autostart). */
	pairing?: boolean;
};

export type RemoteRuntimeStatus = {
	running: boolean;
	httpUrl?: string;
	/** Connect string with the certificate pin: `wss://…/v1/ws#fp=…`. */
	webSocketUrl?: string;
	/** Same URL without the pin, for compact display. */
	displayWebSocketUrl?: string;
	fingerprint?: string;
	fingerprintShort?: string;
	/** True when the bind address follows the LAN IP (no explicit `--host`). */
	followsLanAddress: boolean;
	bonjour: BonjourStatus;
	connections: number;
	config: RemoteConfig;
	deviceTrust: DeviceTrustStatus;
};

export type RemoteStartResult = RemoteRuntimeStatus & {
	pairingCode?: string;
	pairingExpiresAt?: string;
	lanExposure: boolean;
};

export type RemoteRuntimeOptions = {
	advertiser?: BonjourAdvertiser;
	/** Current private LAN address; injectable for tests. */
	selectHost?: () => string | undefined;
	/** Project directory shown in the Bonjour name. */
	getCwd?: () => string | undefined;
	/** Explicit Bonjour display name (wins over the cwd basename). */
	getAdvertisementName?: () => string | undefined;
	addressPollMs?: number;
};

const DEFAULT_ADDRESS_POLL_MS = 5_000;

export class RemoteControlRuntime {
	private readonly advertiser?: BonjourAdvertiser;
	private readonly selectHost: () => string | undefined;
	private readonly getCwd: () => string | undefined;
	private readonly getAdvertisementName: () => string | undefined;
	private readonly addressPollMs: number;
	private followsLanAddress = false;
	private addressWatch?: NodeJS.Timeout;
	private rebinding = false;
	private statusListener?: (status: RemoteRuntimeStatus) => void;

	constructor(
		private readonly server: RemoteServer,
		private readonly deviceTrust: DeviceTrust,
		private readonly logger: Logger,
		private readonly questions?: QuestionBroker,
		options: RemoteRuntimeOptions = {},
	) {
		this.advertiser = options.advertiser;
		this.selectHost = options.selectHost ?? (() => selectLanAddress());
		this.getCwd = options.getCwd ?? (() => undefined);
		this.getAdvertisementName = options.getAdvertisementName ?? (() => undefined);
		this.addressPollMs = options.addressPollMs ?? DEFAULT_ADDRESS_POLL_MS;
	}

	isRunning(): boolean {
		return this.server.isRunning();
	}

	/** Called after the listener moves to a new LAN address (status bar refresh). */
	onStatusChange(listener: ((status: RemoteRuntimeStatus) => void) | undefined): void {
		this.statusListener = listener;
	}

	async start(options: RemoteStartOptions): Promise<RemoteStartResult> {
		const followsLanAddress = options.host === undefined || options.host === AUTO_HOST;
		const host = followsLanAddress ? this.selectHost() : options.host;
		if (!host) {
			throw new Error("No private LAN IPv4 address found. Join Wi-Fi or Ethernet, or pass --host <address>.");
		}
		const config = withRemoteConfig({ host, port: options.port, debugRawEvents: options.debugRawEvents, advertise: options.advertise });
		const current = this.server.getConfig();
		if (
			this.server.isRunning() &&
			(current.host !== config.host || (options.port !== undefined && this.server.getPort() !== options.port))
		) {
			this.questions?.cancelAll();
			await this.server.stop();
		}

		const pairing = options.pairing === false ? undefined : this.deviceTrust.startPairing();
		if (this.server.isRunning()) {
			// Same address: keep serving; refresh settings that don't need a rebind.
			Object.assign(this.server.getConfig(), { debugRawEvents: config.debugRawEvents, advertise: config.advertise });
		} else {
			await this.listen(config, options.port !== undefined);
		}
		this.followsLanAddress = followsLanAddress;
		this.logger.info("remote_runtime_started", { host: config.host, port: this.server.getPort() });

		this.refreshAdvertisement();
		this.watchAddress();

		return {
			...this.getStatus(),
			pairingCode: pairing?.code,
			pairingExpiresAt: pairing?.expiresAt,
			lanExposure: isLanExposure(config.host),
		};
	}

	async stop(): Promise<void> {
		this.stopWatchingAddress();
		this.advertiser?.stop();
		this.questions?.cancelAll();
		this.deviceTrust.stopPairing();
		await this.server.stop();
	}

	/** Revoke every device (and rotate the hashing secret), drop their sockets, open pairing. */
	rotateTrust(): RemoteRuntimeStatus {
		this.deviceTrust.revokeAllTrustedDevices();
		this.server.disconnectAuthenticated();
		this.deviceTrust.startPairing();
		return this.getStatus();
	}

	revokeDevice(idOrPrefix: string): RevokeDeviceResult {
		const result = this.deviceTrust.revokeDevice(idOrPrefix);
		if (result.ok) this.server.disconnectDevice(result.device.id);
		return result;
	}

	getStatus(): RemoteRuntimeStatus {
		const running = this.server.isRunning();
		const identity = running ? this.server.getIdentity() : undefined;
		return {
			running,
			httpUrl: this.server.getUrl(),
			webSocketUrl: this.server.getWebSocketUrl(),
			displayWebSocketUrl: this.server.getDisplayWebSocketUrl(),
			fingerprint: identity?.fingerprint,
			fingerprintShort: identity?.fingerprintShort,
			followsLanAddress: running && this.followsLanAddress,
			bonjour: this.advertiser?.status() ?? { active: false, reason: "unavailable" },
			connections: this.server.connectionCount(),
			config: this.server.getConfig(),
			deviceTrust: this.deviceTrust.getStatus(),
		};
	}

	/** Re-check the LAN address now (the poll timer calls this). Exposed for tests. */
	async checkLanAddress(): Promise<boolean> {
		if (!this.followsLanAddress || !this.server.isRunning() || this.rebinding) return false;
		const next = this.selectHost();
		const config = this.server.getConfig();
		if (!next || next === config.host) return false;

		this.rebinding = true;
		const previousHost = config.host;
		const port = this.server.getPort() ?? config.port;
		try {
			// Pending questions survive: the phone reconnects (via Bonjour) and
			// `auth.token` re-delivers them.
			await this.server.stop();
			await this.listen({ ...config, host: next, port }, false);
			this.refreshAdvertisement();
			this.logger.info("remote_address_changed", { from: previousHost, to: next, port: this.server.getPort() });
			this.statusListener?.(this.getStatus());
			return true;
		} catch (error) {
			this.logger.warn("remote_address_rebind_failed", { to: next, error: error instanceof Error ? error.message : String(error) });
			return false;
		} finally {
			this.rebinding = false;
		}
	}

	private async listen(config: RemoteConfig, portIsExplicit: boolean): Promise<void> {
		try {
			await this.server.start(config);
		} catch (error) {
			// If the default port is taken, take any free port — Bonjour tells
			// the phone where it went.
			if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || portIsExplicit) throw error;
			await this.server.start({ ...config, port: 0 });
		}
	}

	private refreshAdvertisement(): void {
		if (!this.advertiser) return;
		const config = this.server.getConfig();
		const host = this.server.getAdvertisedHost();
		const port = this.server.getPort();
		if (!config.advertise || !host || port === undefined) {
			this.advertiser.stop(config.advertise ? "stopped" : "disabled (--no-bonjour)");
			return;
		}
		// An explicit loopback bind (`--host 127.0.0.1`) is unreachable from the
		// LAN; advertising it would point other devices at themselves.
		if (!this.followsLanAddress && isLoopbackHost(host)) {
			this.advertiser.stop("loopback-only server");
			return;
		}
		const name = this.getAdvertisementName();
		this.advertiser.start({
			...(name ? { name } : {}),
			fingerprint: this.server.getIdentity().fingerprint,
			host,
			port,
			webSocketPath: config.webSocketPath,
			protocolVersion: config.protocolVersion,
			cwd: this.getCwd(),
		});
	}

	private watchAddress(): void {
		this.stopWatchingAddress();
		if (!this.followsLanAddress) return;
		this.addressWatch = setInterval(() => void this.checkLanAddress(), this.addressPollMs);
		this.addressWatch.unref();
	}

	private stopWatchingAddress(): void {
		if (this.addressWatch) clearInterval(this.addressWatch);
		this.addressWatch = undefined;
	}
}
