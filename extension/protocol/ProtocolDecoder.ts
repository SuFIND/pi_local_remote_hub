import type WebSocket from "ws";
import { PROTOCOL_VERSION } from "../config.js";
import type { PromptDelivery } from "../pi/PiRemoteAdapter.js";
import type { ClientEnvelope } from "./envelopes.js";
import { ProtocolError } from "./errors.js";

export type ClientMessage =
	| { kind: "connection.ping"; id?: string }
	| { kind: "auth.pair.request"; id?: string; code: string; deviceName?: string }
	| { kind: "auth.token"; id?: string; token: string }
	| { kind: "session.getState"; id?: string }
	| { kind: "session.history"; id?: string; limit?: number }
	| { kind: "session.prompt"; id?: string; message: string; delivery: PromptDelivery }
	| { kind: "session.abort"; id?: string }
	| { kind: "session.compact"; id?: string }
	| { kind: "unknown"; id?: string; type: string };

export function decodeClientMessage(data: WebSocket.RawData): ClientMessage {
	const envelope = parseClientEnvelope(normalizeRawData(data));
	const { id, type, payload } = envelope;

	if (type === "connection.ping") return { kind: "connection.ping", id };
	if (type === "session.getState") return { kind: "session.getState", id };
	if (type === "session.abort") return { kind: "session.abort", id };
	if (type === "session.compact") return { kind: "session.compact", id };

	if (type === "auth.pair.request") {
		const body = requireRecord(payload, "Pairing payload must be an object");
		return {
			kind: "auth.pair.request",
			id,
			code: requireString(body.code, "Pairing code is required"),
			deviceName: optionalString(body.deviceName) ?? optionalString(body.clientName),
		};
	}

	if (type === "auth.token") {
		const body = requireRecord(payload, "Token payload must be an object");
		return { kind: "auth.token", id, token: requireString(body.token, "Token is required") };
	}

	if (type === "session.history") {
		const body = isRecord(payload) ? payload : {};
		const rawLimit = body.limit;
		let limit: number | undefined;
		if (typeof rawLimit === "number" && Number.isFinite(rawLimit)) {
			limit = Math.max(1, Math.min(1000, Math.floor(rawLimit)));
		}
		return { kind: "session.history", id, limit };
	}

	if (type === "session.prompt") {
		const body = requireRecord(payload, "Prompt payload must be an object");
		return {
			kind: "session.prompt",
			id,
			message: requireString(body.message, "Prompt message is required"),
			delivery: parseDelivery(body.delivery),
		};
	}

	return { kind: "unknown", id, type };
}

function parseClientEnvelope(data: Buffer | ArrayBuffer | Buffer[]): ClientEnvelope {
	const text = Buffer.isBuffer(data)
		? data.toString("utf8")
		: Array.isArray(data)
			? Buffer.concat(data).toString("utf8")
			: Buffer.from(data).toString("utf8");

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new ProtocolError("BAD_REQUEST", "Message must be valid JSON");
	}

	if (!isRecord(parsed)) throw new ProtocolError("BAD_REQUEST", "Message must be a JSON object");
	if (parsed.protocolVersion !== PROTOCOL_VERSION) {
		throw new ProtocolError("PROTOCOL_VERSION_UNSUPPORTED", `Only protocol version ${PROTOCOL_VERSION} is supported`);
	}
	if (typeof parsed.type !== "string" || parsed.type.length === 0 || parsed.type.length > 128) {
		throw new ProtocolError("BAD_REQUEST", "Message type must be a non-empty string");
	}
	if (parsed.id !== undefined && (typeof parsed.id !== "string" || parsed.id.length > 128)) {
		throw new ProtocolError("BAD_REQUEST", "Message id must be a string shorter than 129 characters");
	}

	return parsed as ClientEnvelope;
}

function normalizeRawData(data: WebSocket.RawData): Buffer | ArrayBuffer | Buffer[] {
	if (Buffer.isBuffer(data)) return data;
	if (data instanceof ArrayBuffer) return data;
	if (Array.isArray(data)) return data as Buffer[];
	return Buffer.from(data as ArrayBuffer);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
	if (!isRecord(value)) throw new ProtocolError("BAD_REQUEST", message);
	return value;
}

function requireString(value: unknown, message: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new ProtocolError("BAD_REQUEST", message);
	return value.trim();
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseDelivery(value: unknown): PromptDelivery {
	return value === "prompt" || value === "steer" || value === "followUp" || value === "auto" ? value : "auto";
}
