import type { IncomingMessage, ServerResponse } from "node:http";
import type { RemoteConfig } from "../config.js";
import type { RemoteStateSnapshot } from "../pi/stateSnapshot.js";

export type RouteContext = {
	config: RemoteConfig;
	connections: number;
	state: RemoteStateSnapshot;
};

export function handleHttpRoute(req: IncomingMessage, res: ServerResponse, context: RouteContext): boolean {
	const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

	if (req.method === "GET" && url.pathname === "/health") {
		sendJson(res, 200, { ok: true, connections: context.connections });
		return true;
	}

	if (req.method === "GET" && url.pathname === "/version") {
		sendJson(res, 200, {
			server: "pi-remote-control",
			protocolVersion: context.config.protocolVersion,
			webSocketPath: context.config.webSocketPath,
		});
		return true;
	}

	if (req.method === "GET" && url.pathname === "/") {
		sendText(res, 200, "Pi Remote is running. Native clients should connect to /v1/ws.\n");
		return true;
	}

	return false;
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}

function sendText(res: ServerResponse, status: number, value: string): void {
	res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
	res.end(value);
}
