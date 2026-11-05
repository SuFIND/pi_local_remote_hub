import type WebSocket from "ws";
import { PROTOCOL_VERSION } from "../config.js";
import type { PromptDelivery } from "../pi/PiRemoteAdapter.js";
import type { ClientEnvelope } from "./envelopes.js";
import { ProtocolError } from "./errors.js";

export type ClientMessage =
	| { kind: "connection.ping"; id?: string }
	| { kind: "auth.pair.request"; id?: string; code: string; deviceName?: string }
	| { kind: "auth.token"; id?: string; token: string }
	| { kind: "interaction.answer"; id?: string; requestId: string; answer: string }
	| { kind: "session.getState"; id?: string }
	| { kind: "session.history"; id?: string; limit?: number }
	| { kind: "session.prompt"; id?: string; message: string; delivery: PromptDelivery }
	| { kind: "session.abort"; id?: string }
	| { kind: "session.compact"; id?: string }
	| { kind: "session.listModels"; id?: string }
	| { kind: "session.listSkills"; id?: string }
	| { kind: "session.setModel"; id?: string; provider: string; modelId: string }
	| { kind: "session.setThinkingLevel"; id?: string; level: string }
	| { kind: "hub.listProjects"; id?: string }
	| { kind: "hub.listSessions"; id?: string; cwd: string }
	| { kind: "hub.listFolders"; id?: string; path: string }
	| { kind: "hub.openSession"; id?: string; sessionPath: string }
	| { kind: "hub.newSession"; id?: string; cwd: string }
	| { kind: "hub.detach"; id?: string }
	| { kind: "unknown"; id?: string; type: string };

const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export function decodeClientMessage(data: WebSocket.RawData): ClientMessage {
	const envelope = parseClientEnvelope(normalizeRawData(data));
	const { id, type, payload } = envelope;

	if (type === "connection.ping") return { kind: "connection.ping", id };
	if (type === "session.getState") return { kind: "session.getState", id };
	if (type === "session.abort") return { kind: "session.abort", id };
	if (type === "session.compact") return { kind: "session.compact", id };
	if (type === "session.listModels") return { kind: "session.listModels", id };
	if (type === "session.listSkills") return { kind: "session.listSkills", id };

	if (type === "session.setModel") {
		const body = requireRecord(payload, "setModel payload must be an object");
		return {
			kind: "session.setModel",
			id,
			provider: requireString(body.provider, "Model provider is required"),
			modelId: requireString(body.id, "Model id is required"),
		};
	}

	if (type === "session.setThinkingLevel") {
		const body = requireRecord(payload, "setThinkingLevel payload must be an object");
		const level = requireString(body.level, "Thinking level is required");
		if (!THINKING_LEVELS.includes(level as (typeof THINKING_LEVELS)[number])) {
			throw new ProtocolError("BAD_REQUEST", `Thinking level must be one of: ${THINKING_LEVELS.join(", ")}`);
		}
		return { kind: "session.setThinkingLevel", id, level };
	}

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

	if (type === "interaction.answer") {
		const body = requireRecord(payload, "Answer payload must be an object");
		return {
			kind: "interaction.answer",
			id,
			requestId: requireBoundedString(body.requestId, "Question request id is required", 128),
			answer: requireBoundedString(body.answer, "Answer is required", 8_000),
		};
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

	if (type === "hub.listProjects") return { kind: "hub.listProjects", id };
	if (type === "hub.detach") return { kind: "hub.detach", id };
	if (type === "hub.listSessions" || type === "hub.newSession") {
		const body = requireRecord(payload, "Payload is required");
		return { kind: type, id, cwd: requireAbsolutePath(body.cwd, "cwd must be an absolute path") };
	}
	if (type === "hub.listFolders") {
		const body = requireRecord(payload, "Payload is required");
		return { kind: "hub.listFolders", id, path: requireAbsolutePath(body.path, "path must be an absolute path") };
	}
	if (type === "hub.openSession") {
		const body = requireRecord(payload, "Payload is required");
		return { kind: "hub.openSession", id, sessionPath: requireAbsolutePath(body.sessionPath, "sessionPath must be an absolute path") };
	}

	return { kind: "unknown", id, type };
}

function requireAbsolutePath(value: unknown, message: string): string {
	const path = requireBoundedString(value, message, 4096);
	if (!path.startsWith("/") || path.includes("\0")) throw new ProtocolError("BAD_REQUEST", message);
	return path;
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

function requireBoundedString(value: unknown, message: string, maximumLength: number): string {
	const result = requireString(value, message);
	if (result.length > maximumLength) throw new ProtocolError("BAD_REQUEST", `${message} Maximum length is ${maximumLength} characters`);
	return result;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseDelivery(value: unknown): PromptDelivery {
	return value === "prompt" || value === "steer" || value === "followUp" || value === "auto" ? value : "auto";
}
