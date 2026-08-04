import { randomBytes } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { DeviceTrust } from "../auth/DeviceTrust.js";
import type { RemoteConfig } from "../config.js";
import type { Logger } from "../logging/logger.js";
import type { PiRemoteAdapter } from "../pi/PiRemoteAdapter.js";
import type { RemoteStateSnapshot } from "../pi/stateSnapshot.js";
import { QuestionBroker } from "../questions/QuestionBroker.js";
import { createServerEnvelope } from "../protocol/envelopes.js";
import { ConnectionRegistry } from "../connections/ConnectionRegistry.js";
import { RemoteConnection } from "../connections/RemoteConnection.js";
import { RemoteSession } from "../connections/RemoteSession.js";
import { handleHttpRoute } from "./routes.js";

export type RemoteServerOptions = {
	config: RemoteConfig;
	logger: Logger;
	adapter: PiRemoteAdapter;
	deviceTrust: DeviceTrust;
	getState: () => RemoteStateSnapshot;
	questions?: QuestionBroker;
};

export class RemoteServer {
	private config: RemoteConfig;
	private readonly logger: Logger;
	private readonly adapter: PiRemoteAdapter;
	private readonly deviceTrust: DeviceTrust;
	private readonly getState: () => RemoteStateSnapshot;
	private readonly questions: QuestionBroker;
	private readonly registry = new ConnectionRegistry();
	private server?: http.Server;
	private wss?: WebSocketServer;
	private seq = 0;

	constructor(options: RemoteServerOptions) {
		this.config = options.config;
		this.logger = options.logger;
		this.adapter = options.adapter;
		this.deviceTrust = options.deviceTrust;
		this.getState = options.getState;
		this.questions = options.questions ?? new QuestionBroker();
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

	getUrl(): string | undefined {
		const address = this.server?.address();
		if (!address || typeof address === "string") return undefined;
		const displayHost = this.config.host === "0.0.0.0" ? getLanAddress() ?? "localhost" : this.config.host;
		return `http://${displayHost}:${address.port}`;
	}

	getWebSocketUrl(): string | undefined {
		const base = this.getUrl();
		if (!base) return undefined;
		return `${base.replace(/^http:/, "ws:")}${this.config.webSocketPath}`;
	}

	async start(config: RemoteConfig): Promise<void> {
		if (this.isRunning()) return;
		this.config = config;
		this.wss = new WebSocketServer({ noServer: true, maxPayload: this.config.maxFrameBytes });

		this.server = http.createServer((req, res) => {
			const handled = handleHttpRoute(req, res, {
				config: this.config,
				connections: this.registry.size,
				state: this.getState(),
			});
			if (!handled) {
				res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
				res.end(JSON.stringify({ error: "Not found" }));
			}
		});

		this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));

		await new Promise<void>((resolve, reject) => {
			const server = this.server!;
			server.once("error", reject);
			server.listen(this.config.port, this.config.host, () => {
				server.off("error", reject);
				resolve();
			});
		});

		this.logger.info("remote_server_started", { host: this.config.host, port: this.config.port, wsPath: this.config.webSocketPath });
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

	broadcastStateChanged(reason: string): void {
		this.broadcast("state.changed", { reason, state: this.getState() });
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
			const session = new RemoteSession({
				id: connectionId,
				remoteAddress: req.socket.remoteAddress,
				adapter: this.adapter,
				deviceTrust: this.deviceTrust,
				logger: this.logger,
				questions: this.questions,
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
				send: (target, type, payload, requestId) => target.send(createServerEnvelope(this.nextSeq(), type, payload, requestId)),
				onClose: (target) => {
					this.registry.remove(target.id);
					this.logger.info("websocket_disconnected", { connectionId: target.id });
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

function getLanAddress(): string | undefined {
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal) return entry.address;
		}
	}
	return undefined;
}
