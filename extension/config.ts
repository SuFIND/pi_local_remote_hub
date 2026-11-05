export const PROTOCOL_VERSION = 1 as const;

/**
 * `host: "auto"` (the default) means "bind the current private LAN IPv4 and
 * follow it when DHCP changes it" — resolved by `RemoteControlRuntime`, never
 * passed to `listen()`. An explicit `--host` pins the address.
 */
export const AUTO_HOST = "auto";

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
	/** Announce `_pi-remote._tcp` over Bonjour (macOS `dns-sd`). */
	advertise: boolean;
};

export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
	host: AUTO_HOST,
	port: 3769,
	protocolVersion: PROTOCOL_VERSION,
	webSocketPath: "/v1/ws",
	maxFrameBytes: 256 * 1024,
	heartbeatIntervalMs: 20_000,
	clientTimeoutMs: 60_000,
	authTimeoutMs: 10_000,
	debugRawEvents: false,
	advertise: true,
};

export function withRemoteConfig(overrides: Partial<Pick<RemoteConfig, "host" | "port" | "debugRawEvents" | "advertise">>): RemoteConfig {
	return {
		...DEFAULT_REMOTE_CONFIG,
		...(overrides.host !== undefined ? { host: overrides.host } : {}),
		...(overrides.port !== undefined ? { port: overrides.port } : {}),
		...(overrides.debugRawEvents !== undefined ? { debugRawEvents: overrides.debugRawEvents } : {}),
		...(overrides.advertise !== undefined ? { advertise: overrides.advertise } : {}),
	};
}

export function isLanExposure(host: string): boolean {
	return host === "0.0.0.0" || host === "::" || (!host.startsWith("127.") && host !== "localhost" && host !== "::1");
}
