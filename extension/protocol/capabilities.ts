export const SERVER_CAPABILITIES = {
	authMethods: ["pairingCode", "deviceToken"],
	commands: [
		"session.getState",
		"session.history",
		"session.prompt",
		"session.abort",
		"session.compact",
		"session.listModels",
		"session.setModel",
		"session.setThinkingLevel",
	],
	events: [
		"state.snapshot",
		"state.changed",
		"pi.session_start",
		"pi.session_shutdown",
		"pi.agent_start",
		"pi.agent_end",
		"pi.turn_start",
		"pi.turn_end",
		"pi.message_start",
		"pi.message_delta",
		"pi.message_end",
		"pi.tool_start",
		"pi.tool_update",
		"pi.tool_end",
		"pi.model_changed",
		"pi.thinking_changed",
	],
	features: {
		sequenceNumbers: true,
		stableOkEnvelope: true,
		stateChangedEvents: true,
		authenticatedPiEventsOnly: true,
	},
} as const;

export const SERVER_CLOSE_CODES = {
	HEARTBEAT_TIMEOUT: { code: 4000, reason: "Heartbeat timeout" },
	AUTHENTICATION_TIMEOUT: { code: 4001, reason: "Authentication timeout" },
	SERVER_SHUTDOWN: { code: 1001, reason: "Server shutting down" },
} as const;
