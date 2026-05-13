import { sanitizeForRemote } from "./sanitizer.js";

const EVENT_NAME_MAP: Record<string, string> = {
	session_start: "pi.session_start",
	session_shutdown: "pi.session_shutdown",
	agent_start: "pi.agent_start",
	agent_end: "pi.agent_end",
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

export function mapPiEvent(eventName: string, event: unknown): RemotePiEvent {
	return {
		type: EVENT_NAME_MAP[eventName] ?? `pi.${eventName}`,
		payload: {
			source: "pi",
			name: eventName,
			data: sanitizeForRemote(event),
		},
	};
}
