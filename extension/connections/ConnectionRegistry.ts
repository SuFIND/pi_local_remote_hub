import { SERVER_CLOSE_CODES } from "../protocol/capabilities.js";
import type { ServerEnvelope } from "../protocol/envelopes.js";
import type { RemoteConnection } from "./RemoteConnection.js";

export class ConnectionRegistry {
	private readonly connections = new Map<string, RemoteConnection>();

	add(connection: RemoteConnection): void {
		this.connections.set(connection.id, connection);
	}

	remove(id: string): void {
		this.connections.delete(id);
	}

	get size(): number {
		return this.connections.size;
	}

	forEach(callback: (connection: RemoteConnection) => void): void {
		for (const connection of this.connections.values()) callback(connection);
	}

	broadcast(envelope: ServerEnvelope, options: { authenticatedOnly?: boolean } = { authenticatedOnly: true }): void {
		for (const connection of this.connections.values()) {
			if (options.authenticatedOnly !== false && !connection.isAuthenticated()) continue;
			connection.send(envelope);
		}
	}

	closeAll(code = SERVER_CLOSE_CODES.SERVER_SHUTDOWN.code, reason = SERVER_CLOSE_CODES.SERVER_SHUTDOWN.reason): void {
		for (const connection of this.connections.values()) connection.close(code, reason);
		this.connections.clear();
	}
}
