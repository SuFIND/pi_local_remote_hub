export const PROTOCOL_VERSION = 1 as const;

export type RemoteConfig = {
	host: string;
	port: number;
	protocolVersion: typeof PROTOCOL_VERSION;
	webSocketPath: string;
	maxFrameBytes: number;
	heartbeatIntervalMs: number;
	clientTimeoutMs: number;
	authTimeoutMs: number;
	debugRawEvents: boolean;
};

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
	host: "0.0.0.0",
	port: 3769,
	protocolVersion: PROTOCOL_VERSION,
	webSocketPath: "/v1/ws",
	maxFrameBytes: 256 * 1024,
	heartbeatIntervalMs: 20_000,
	clientTimeoutMs: 60_000,
	authTimeoutMs: 10_000,
	debugRawEvents: false,
};

export function withRemoteConfig(overrides: Partial<Pick<RemoteConfig, "host" | "port" | "debugRawEvents">>): RemoteConfig {
	return {
		...DEFAULT_REMOTE_CONFIG,
		...(overrides.host !== undefined ? { host: overrides.host } : {}),
		...(overrides.port !== undefined ? { port: overrides.port } : {}),
		...(overrides.debugRawEvents !== undefined ? { debugRawEvents: overrides.debugRawEvents } : {}),
	};
}

export function isLanExposure(host: string): boolean {
	return host === "0.0.0.0" || host === "::" || (!host.startsWith("127.") && host !== "localhost" && host !== "::1");
}
