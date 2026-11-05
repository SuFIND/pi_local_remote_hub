import { sanitizeForRemote } from "./sanitizer.js";

const EVENT_NAME_MAP: Record<string, string> = {
	session_start: "pi.session_start",
	session_shutdown: "pi.session_shutdown",
	agent_start: "pi.agent_start",
	agent_end: "pi.agent_end",
	agent_settled: "pi.agent_settled",
	turn_start: "pi.turn_start",
	turn_end: "pi.turn_end",
	message_start: "pi.message_start",
	message_update: "pi.message_delta",
	message_end: "pi.message_end",
	tool_execution_start: "pi.tool_start",
	tool_execution_update: "pi.tool_update",
	tool_execution_end: "pi.tool_end",
	tool_call: "pi.tool_call",
	tool_result: "pi.tool_result",
	model_select: "pi.model_changed",
	thinking_level_select: "pi.thinking_changed",
	session_compact: "pi.session_compact",
};

export type RemotePiEvent = {
	type: string;
	payload: {
		source: "pi";
		name: string;
		data: unknown;
	};
};

const MESSAGE_EVENTS = new Set(["message_start", "message_update", "message_end"]);

/**
 * Map a Pi event to its wire envelope, or `null` when it must not leave the
 * Mac. Pi ≥ 1.5 reports the system prompt as a `role: "system"` message and
 * attaches a full provider-context preview (`context`) to boundary events;
 * neither is transcript content and both can be tens of KB, so they are
 * dropped here rather than sanitized and shipped to the phone.
 */
export function mapPiEvent(eventName: string, event: unknown): RemotePiEvent | null {
	if (MESSAGE_EVENTS.has(eventName) && isSystemMessage(readField(event, "message"))) return null;
	return {
		type: EVENT_NAME_MAP[eventName] ?? `pi.${eventName}`,
		payload: {
			source: "pi",
			name: eventName,
			data: sanitizeForRemote(slimEvent(eventName, event)),
		},
	};
}

function slimEvent(eventName: string, event: unknown): unknown {
	if (typeof event !== "object" || event === null || Array.isArray(event)) return event;
	const record = event as Record<string, unknown>;
	let slim: Record<string, unknown> | undefined;
	if ("context" in record) {
		const { context: _context, ...rest } = record;
		slim = rest;
	}
	if (eventName === "agent_end" && Array.isArray(record.messages)) {
		slim = { ...(slim ?? record), messages: record.messages.filter((message) => !isSystemMessage(message)) };
	}
	return slim ?? event;
}

function readField(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

function isSystemMessage(message: unknown): boolean {
	return readField(message, "role") === "system";
}
