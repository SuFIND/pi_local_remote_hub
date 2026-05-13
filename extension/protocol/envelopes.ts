import { PROTOCOL_VERSION } from "../config.js";
import type { ProtocolErrorPayload } from "./errors.js";
import type { SERVER_CAPABILITIES } from "./capabilities.js";

export type ClientEnvelope = {
	id?: string;
	type: string;
	protocolVersion: typeof PROTOCOL_VERSION;
	payload?: unknown;
};

export type ServerEnvelope = {
	id?: string;
	seq: number;
	type: string;
	protocolVersion: typeof PROTOCOL_VERSION;
	timestamp: string;
	payload?: unknown;
};

export type ServerHelloPayload = {
	server: "pi-remote-control";
	protocolVersion: typeof PROTOCOL_VERSION;
	auth: {
		required: true;
		pairingAvailable: boolean;
	};
	capabilities: typeof SERVER_CAPABILITIES;
};

export function createServerEnvelope(seq: number, type: string, payload?: unknown, id?: string): ServerEnvelope {
	return {
		id,
		seq,
		type,
		protocolVersion: PROTOCOL_VERSION,
		timestamp: new Date().toISOString(),
		payload,
	};
}

export function createErrorPayload(code: ProtocolErrorPayload["code"], message: string): ProtocolErrorPayload {
	return { code, message };
}
