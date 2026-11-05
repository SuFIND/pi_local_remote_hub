import type WebSocket from "ws";
import type { RemoteConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import { SERVER_CAPABILITIES, SERVER_CLOSE_CODES } from "../protocol/capabilities.js";
import { createErrorPayload, type ServerEnvelope } from "../protocol/envelopes.js";
import { ProtocolError } from "../protocol/errors.js";
import { decodeClientMessage } from "../protocol/ProtocolDecoder.js";
import type { RemoteSession } from "./RemoteSession.js";

export type RemoteConnectionOptions = {
	id: string;
	remoteAddress?: string;
	ws: WebSocket;
	config: RemoteConfig;
	logger: Logger;
	session: RemoteSession;
	isPairingAvailable: () => boolean;
	/** Re-checked on every heartbeat so a revoked device is dropped. */
	isDeviceTrusted: (deviceId: string) => boolean;
	send: (connection: RemoteConnection, type: string, payload?: unknown, requestId?: string) => void;
	onClose: (connection: RemoteConnection) => void;
};

export class RemoteConnection {
	readonly id: string;
	readonly remoteAddress?: string;
	private readonly ws: WebSocket;
	private readonly config: RemoteConfig;
	private readonly logger: Logger;
	private readonly session: RemoteSession;
	private readonly isPairingAvailable: () => boolean;
	private readonly isDeviceTrusted: (deviceId: string) => boolean;
	private readonly sendFromServer: RemoteConnectionOptions["send"];
	private readonly onClose: RemoteConnectionOptions["onClose"];
	private authTimeout?: NodeJS.Timeout;
	private heartbeat?: NodeJS.Timeout;
	private lastSeenAt = Date.now();

	constructor(options: RemoteConnectionOptions) {
		this.id = options.id;
		this.remoteAddress = options.remoteAddress;
		this.ws = options.ws;
		this.config = options.config;
		this.logger = options.logger;
		this.session = options.session;
		this.isPairingAvailable = options.isPairingAvailable;
		this.isDeviceTrusted = options.isDeviceTrusted;
		this.sendFromServer = options.send;
		this.onClose = options.onClose;
	}

	start(): void {
		this.ws.on("message", (data) => {
			void this.handleMessage(data);
		});
		this.ws.on("pong", () => this.markSeen());
		this.ws.on("close", () => this.cleanup());
		this.ws.on("error", (error) => {
			this.logger.warn("websocket_error", { connectionId: this.id, error: error.message });
		});

		this.sendFromServer(this, "server.hello", {
			server: "pi-remote-control",
			protocolVersion: this.config.protocolVersion,
			auth: {
				required: true,
				pairingAvailable: this.isPairingAvailable(),
			},
			capabilities: SERVER_CAPABILITIES,
		});

		this.authTimeout = setTimeout(() => {
			if (!this.session.isAuthenticated()) this.close(SERVER_CLOSE_CODES.AUTHENTICATION_TIMEOUT.code, SERVER_CLOSE_CODES.AUTHENTICATION_TIMEOUT.reason);
		}, this.config.authTimeoutMs);

		this.heartbeat = setInterval(() => this.checkHeartbeat(), this.config.heartbeatIntervalMs);
	}

	isAuthenticated(): boolean {
		return this.session.isAuthenticated();
	}

	deviceId(): string | undefined {
		return this.session.authenticatedDeviceId();
	}

	send(envelope: ServerEnvelope): void {
		if (this.ws.readyState !== this.ws.OPEN) return;
		this.ws.send(JSON.stringify(envelope));
	}

	close(code?: number, reason?: string): void {
		if (this.ws.readyState === this.ws.CLOSED || this.ws.readyState === this.ws.CLOSING) return;
		this.ws.close(code, reason);
	}

	private async handleMessage(data: WebSocket.RawData): Promise<void> {
		this.markSeen();
		let requestId: string | undefined;

		try {
			const message = decodeClientMessage(data);
			requestId = message.id;
			await this.session.handle(message);
			if (this.session.isAuthenticated() && this.authTimeout) {
				clearTimeout(this.authTimeout);
				this.authTimeout = undefined;
			}
		} catch (error) {
			if (error instanceof ProtocolError) {
				this.sendFromServer(this, "response.error", createErrorPayload(error.code, error.message), requestId);
			} else {
				this.logger.warn("websocket_bad_message", { connectionId: this.id, error: error instanceof Error ? error.message : String(error) });
				this.sendFromServer(this, "response.error", createErrorPayload("BAD_REQUEST", "Invalid message"), requestId);
			}
		}
	}

	private markSeen(): void {
		this.lastSeenAt = Date.now();
	}

	private checkHeartbeat(): void {
		if (Date.now() - this.lastSeenAt > this.config.clientTimeoutMs) {
			this.close(SERVER_CLOSE_CODES.HEARTBEAT_TIMEOUT.code, SERVER_CLOSE_CODES.HEARTBEAT_TIMEOUT.reason);
			return;
		}

		const deviceId = this.deviceId();
		if (deviceId && !this.isDeviceTrusted(deviceId)) {
			this.close(SERVER_CLOSE_CODES.DEVICE_REVOKED.code, SERVER_CLOSE_CODES.DEVICE_REVOKED.reason);
			return;
		}

		if (this.ws.readyState === this.ws.OPEN) this.ws.ping();
	}

	private cleanup(): void {
		if (this.authTimeout) clearTimeout(this.authTimeout);
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.onClose(this);
	}
}
