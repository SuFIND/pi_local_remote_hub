export type LogLevel = "debug" | "info" | "warn" | "error";
export type LoggerMinLevel = LogLevel | "silent";

export type Logger = {
	debug(event: string, fields?: Record<string, unknown>): void;
	info(event: string, fields?: Record<string, unknown>): void;
	warn(event: string, fields?: Record<string, unknown>): void;
	error(event: string, fields?: Record<string, unknown>): void;
	setMinLevel(level: LoggerMinLevel): void;
};

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

/**
 * Structured JSON logger.
 *
 * Defaults to `"silent"` — emit nothing — because the extension's logs land in
 * the same terminal as the Pi prompt and a steady drip of connect/disconnect
 * lines is more noise than signal. `/remote start --logs` flips the level to
 * `info` for the active session.
 */
export function createLogger(namespace: string, minLevel: LoggerMinLevel = "silent"): Logger {
	let currentLevel: LoggerMinLevel = minLevel;

	function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
		if (currentLevel === "silent") return;
		if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
		const redacted = redact(fields);
		const line = JSON.stringify({ timestamp: new Date().toISOString(), namespace, level, event, ...redacted });
		const writer = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
		writer(line);
	}

	return {
		debug: (event, fields) => log("debug", event, fields),
		info: (event, fields) => log("info", event, fields),
		warn: (event, fields) => log("warn", event, fields),
		error: (event, fields) => log("error", event, fields),
		setMinLevel: (level) => {
			currentLevel = level;
		},
	};
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(fields)) {
		const lower = key.toLowerCase();
		if (lower.includes("token") || lower.includes("code") || lower.includes("secret") || lower.includes("authorization")) {
			output[key] = "[redacted]";
		} else {
			output[key] = value;
		}
	}
	return output;
}
