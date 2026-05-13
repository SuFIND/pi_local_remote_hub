const MAX_STRING_LENGTH = 20_000;
const MAX_ARRAY_LENGTH = 200;
const MAX_DEPTH = 8;

const REDACTED_KEYS = new Set(["authorization", "apiKey", "api_key", "token", "accessToken", "refreshToken", "secret", "password"]);

export function sanitizeForRemote(value: unknown): unknown {
	return sanitize(value, 0);
}

function sanitize(value: unknown, depth: number): unknown {
	if (depth > MAX_DEPTH) return "[Max depth reached]";
	if (value === null || value === undefined) return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function" || typeof value === "symbol") return undefined;
	if (typeof value === "string") return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value;
	if (typeof value !== "object") return value;

	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_LENGTH).map((item) => sanitize(item, depth + 1));
	}

	const output: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (REDACTED_KEYS.has(key) || REDACTED_KEYS.has(key.toLowerCase())) {
			output[key] = "[redacted]";
		} else {
			const sanitized = sanitize(child, depth + 1);
			if (sanitized !== undefined) output[key] = sanitized;
		}
	}
	return output;
}
