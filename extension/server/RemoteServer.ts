import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { DeviceTrust } from "../auth/DeviceTrust.js";
import type { RemoteConfig } from "../config.js";
import type { HostIdentity } from "../identity/HostIdentity.js";
import type { Logger } from "../logging/logger.js";
import { isAllowedPeerAddress, selectLanAddress } from "../net/lanAddress.js";
import { createServerEnvelope } from "../protocol/envelopes.js";
import { ConnectionRegistry } from "../connections/ConnectionRegistry.js";
import { RemoteConnection, type ConnectionSession } from "../connections/RemoteConnection.js";
import { handleHttpRoute } from "./routes.js";

export type SessionContext = {
	id: string;
	remoteAddress?: string;
	/** Send one envelope to this connection; sequence numbers are assigned here. */
	send: (type: string, payload?: unknown, requestId?: string) => void;
};

export type RemoteServerOptions = {
	config: RemoteConfig;
	logger: Logger;
	deviceTrust: DeviceTrust;
	/** TLS certificate + key; clients pin `identity.fingerprint`. */
	identity: HostIdentity | (() => HostIdentity);
	/** Protocol handler for one WebSocket connection. */
	createSession: (context: SessionContext) => ConnectionSession;
};

export class RemoteServer {
	private config: RemoteConfig;
	private readonly logger: Logger;
	private readonly deviceTrust: DeviceTrust;
	private readonly identitySource: HostIdentity | (() => HostIdentity);
	private identity?: HostIdentity;
	private readonly createSession: RemoteServerOptions["createSession"];
	private readonly registry = new ConnectionRegistry();
	private server?: https.Server;
	private wss?: WebSocketServer;
	private seq = 0;

	constructor(options: RemoteServerOptions) {
		this.config = options.config;
		this.logger = options.logger;
		this.deviceTrust = options.deviceTrust;
		this.identitySource = options.identity;
		this.createSession = options.createSession;
	}

	isRunning(): boolean {
		return Boolean(this.server?.listening);
	}

	connectionCount(): number {
		return this.registry.size;
	}

	getConfig(): RemoteConfig {
		return this.config;
	}

	/** Loaded on first use so Pi processes that never start the server never touch the key. */
	getIdentity(): HostIdentity {
		this.identity ??= typeof this.identitySource === "function" ? this.identitySource() : this.identitySource;
		return this.identity;
	}

	/** Host clients should dial: the bound address, or the LAN IP for a wildcard bind. */
	getAdvertisedHost(): string | undefined {
		if (!this.isRunning()) return undefined;
		const wildcard = this.config.host === "0.0.0.0" || this.config.host === "::";
		return wildcard ? selectLanAddress() ?? "localhost" : this.config.host;
	}

	getPort(): number | undefined {
		const address = this.server?.address();
		return address && typeof address !== "string" ? address.port : undefined;
	}

	getUrl(): string | undefined {
		const host = this.getAdvertisedHost();
		const port = this.getPort();
		if (!host || port === undefined) return undefined;
		return `https://${formatHost(host)}:${port}`;
	}

	/** `wss://…/v1/ws` without the pin — for display. */
	getDisplayWebSocketUrl(): string | undefined {
		const base = this.getUrl();
		return base ? `${base.replace(/^https:/, "wss:")}${this.config.webSocketPath}` : undefined;
	}

	/**
	 * The connect string handed to clients: `wss://host:port/v1/ws#fp=<pin>`.
	 * The fragment never goes on the wire; clients strip it and pin the
	 * certificate SHA-256 it names.
	 */
	getWebSocketUrl(): string | undefined {
		const base = this.getDisplayWebSocketUrl();
		return base ? `${base}#fp=${this.getIdentity().fingerprint}` : undefined;
	}

	/** Drop live sockets of a revoked device; returns how many were closed. */
	disconnectDevice(deviceId: string): number {
		return this.registry.closeDevice(deviceId);
	}

	disconnectAuthenticated(): void {
		this.registry.closeAuthenticated();
	}

	async start(config: RemoteConfig): Promise<void> {
		if (this.isRunning()) return;
		this.config = config;
		this.wss = new WebSocketServer({ noServer: true, maxPayload: this.config.maxFrameBytes });

		const identity = this.getIdentity();
		this.server = https.createServer({ key: identity.keyPem, cert: identity.certPem, minVersion: "TLSv1.2" }, (req, res) => {
			const handled = handleHttpRoute(req, res, {
				config: this.config,
				connections: this.registry.size,
			});
			if (!handled) {
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "Not found" }));
			}
		});

		this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
		// Defense in depth on top of the LAN-only bind: never complete a TLS
		// handshake with a peer outside loopback / private ranges.
		this.server.on("connection", (socket: Socket) => {
			if (!isAllowedPeerAddress(socket.remoteAddress)) {
				this.logger.warn("remote_peer_rejected", { remoteAddress: socket.remoteAddress });
				socket.destroy();
			}
		});
		this.server.on("tlsClientError", (error) => this.logger.debug("tls_client_error", { error: error.message }));

		try {
			await new Promise<void>((resolve, reject) => {
				const server = this.server!;
				server.once("error", reject);
				server.listen(this.config.port, this.config.host, () => {
					server.off("error", reject);
					resolve();
				});
			});
		} catch (error) {
			// Leave the instance restartable (e.g. EADDRINUSE → retry another port).
			this.server = undefined;
			this.wss?.close();
			this.wss = undefined;
			throw error;
		}

		this.logger.info("remote_server_started", { host: this.config.host, port: this.getPort(), wsPath: this.config.webSocketPath });
	}

	async stop(): Promise<void> {
		this.registry.closeAll();
		this.wss?.close();
		this.wss = undefined;

		const current = this.server;
		this.server = undefined;
		if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
		this.logger.info("remote_server_stopped");
	}

	broadcast(type: string, payload?: unknown): void {
		this.registry.broadcast(createServerEnvelope(this.nextSeq(), type, payload));
	}

	private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		if (url.pathname !== this.config.webSocketPath) {
			rejectUpgrade(socket, 404, "Not Found");
			return;
		}

		if (!this.isAllowedOrigin(req)) {
			this.logger.warn("websocket_origin_rejected", { origin: req.headers.origin });
			rejectUpgrade(socket, 403, "Forbidden");
			return;
		}

		this.wss?.handleUpgrade(req, socket, head, (ws) => {
			const connectionId = randomBytes(12).toString("base64url");
			let connection!: RemoteConnection;
			const session = this.createSession({
				id: connectionId,
				remoteAddress: req.socket.remoteAddress,
				send: (type, payload, requestId) => connection.send(createServerEnvelope(this.nextSeq(), type, payload, requestId)),
			});
			connection = new RemoteConnection({
				id: connectionId,
				remoteAddress: req.socket.remoteAddress,
				ws,
				config: this.config,
				logger: this.logger,
				session,
				isPairingAvailable: () => this.deviceTrust.isPairingAvailable(),
				isDeviceTrusted: (deviceId) => this.deviceTrust.isTrustedDevice(deviceId),
				send: (target, type, payload, requestId) => target.send(createServerEnvelope(this.nextSeq(), type, payload, requestId)),
				onClose: (target) => {
					this.registry.remove(target.id);
					this.logger.info("websocket_disconnected", { connectionId: target.id, ...target.closeInfo });
				},
			});
			this.registry.add(connection);
			this.logger.info("websocket_connected", { connectionId: connection.id, remoteAddress: connection.remoteAddress });
			connection.start();
		});
	}

	private isAllowedOrigin(req: IncomingMessage): boolean {
		const origin = req.headers.origin;
		if (!origin) return true;

		try {
			const originUrl = new URL(origin);
			const hostHeader = req.headers.host?.split(":")[0];
			return originUrl.hostname === hostHeader || originUrl.hostname === "localhost" || originUrl.hostname === "127.0.0.1" || originUrl.hostname === "::1";
		} catch {
			return false;
		}
	}

	private nextSeq(): number {
		this.seq += 1;
		return this.seq;
	}
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
	socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
	socket.destroy();
}

function formatHost(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
