import { DeviceTrust, type DeviceTrustStatus } from "../auth/DeviceTrust.js";
import { isLanExposure, withRemoteConfig, type RemoteConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { RemoteServer } from "../server/RemoteServer.js";
import type { CloudflareTunnel, CloudflareTunnelHandle } from "../tunnel/CloudflareTunnel.js";

export type RemoteStartOptions = {
	host?: string;
	port?: number;
	debugRawEvents?: boolean;
	useTunnel?: boolean;
};

export type RemoteRuntimeStatus = {
	running: boolean;
	httpUrl?: string;
	webSocketUrl?: string;
	publicWebSocketUrl?: string;
	tunnelHostname?: string;
	connections: number;
	config: RemoteConfig;
	deviceTrust: DeviceTrustStatus;
};

export type RemoteStartResult = RemoteRuntimeStatus & {
	pairingCode?: string;
	pairingExpiresAt?: string;
	lanExposure: boolean;
};

export class RemoteControlRuntime {
	constructor(
		private readonly server: RemoteServer,
		private readonly deviceTrust: DeviceTrust,
		private readonly tunnel: CloudflareTunnel,
		private readonly logger: Logger,
	) {}

	async start(options: RemoteStartOptions): Promise<RemoteStartResult> {
		const config = withRemoteConfig(options);
		const currentConfig = this.server.getConfig();
		if (this.server.isRunning() && (currentConfig.host !== config.host || currentConfig.port !== config.port)) {
			await this.server.stop();
		}

		const pairing = this.deviceTrust.startPairing();
		await this.server.start(config);
		this.logger.info("remote_runtime_started", { host: config.host, port: config.port });

		let tunnelHandle: CloudflareTunnelHandle | null = null;
		if (options.useTunnel) {
			try {
				tunnelHandle = await this.tunnel.start(config.port, config.webSocketPath);
			} catch (err) {
				// Tunnel was requested but failed — tear down so the user isn't left with a
				// half-running server pointing at the wrong URL.
				this.deviceTrust.stopPairing();
				await this.server.stop();
				throw err;
			}
		}

		return {
			...this.getStatus(),
			pairingCode: pairing.code,
			pairingExpiresAt: pairing.expiresAt,
			lanExposure: isLanExposure(config.host),
			publicWebSocketUrl: tunnelHandle?.publicWebSocketUrl,
			tunnelHostname: tunnelHandle?.publicHostname,
		};
	}

	async stop(): Promise<void> {
		this.deviceTrust.stopPairing();
		await this.tunnel.stop();
		await this.server.stop();
	}

	rotateTrust(): RemoteRuntimeStatus {
		this.deviceTrust.revokeAllTrustedDevices();
		this.deviceTrust.startPairing();
		return this.getStatus();
	}

	getStatus(): RemoteRuntimeStatus {
		const tunnelHandle = this.tunnel.getHandle();
		return {
			running: this.server.isRunning(),
			httpUrl: this.server.getUrl(),
			webSocketUrl: this.server.getWebSocketUrl(),
			publicWebSocketUrl: tunnelHandle?.publicWebSocketUrl,
			tunnelHostname: tunnelHandle?.publicHostname,
			connections: this.server.connectionCount(),
			config: this.server.getConfig(),
			deviceTrust: this.deviceTrust.getStatus(),
		};
	}
}
