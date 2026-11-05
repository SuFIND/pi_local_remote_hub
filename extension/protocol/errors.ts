export type ProtocolErrorCode =
	| "BAD_REQUEST"
	| "UNAUTHORIZED"
	| "PAIRING_DISABLED"
	| "PAIRING_EXPIRED"
	| "PAIRING_ATTEMPTS_EXCEEDED"
	| "PROTOCOL_VERSION_UNSUPPORTED"
	| "UNKNOWN_COMMAND"
	| "AGENT_BUSY"
	| "COMMAND_FAILED"
	| "PAYLOAD_TOO_LARGE"
	| "NO_SESSION"
	| "SESSION_UNAVAILABLE"
	| "OUTSIDE_ROOTS"
	| "INTERNAL_ERROR";

export type ProtocolErrorPayload = {
	code: ProtocolErrorCode;
	message: string;
};

export class ProtocolError extends Error {
	constructor(
		readonly code: ProtocolErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ProtocolError";
	}
}
