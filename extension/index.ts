import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DeviceTrust } from "./auth/DeviceTrust.js";
import { DEFAULT_REMOTE_CONFIG } from "./config.js";
import { registerRemoteCommand } from "./command.js";
import { RemoteEventStream } from "./events/RemoteEventStream.js";
import { createLogger } from "./logging/logger.js";
import { PiRemoteAdapter } from "./pi/PiRemoteAdapter.js";
import { RemoteControlRuntime } from "./runtime/RemoteControlRuntime.js";
import { RemoteServer } from "./server/RemoteServer.js";
import { CloudflareTunnel } from "./tunnel/CloudflareTunnel.js";

export default function piRemoteControl(pi: ExtensionAPI): void {
	const logger = createLogger("pi-remote-control");
	const adapter = new PiRemoteAdapter(pi);
	const deviceTrust = new DeviceTrust();
	const server = new RemoteServer({
		config: DEFAULT_REMOTE_CONFIG,
		logger,
		adapter,
		deviceTrust,
		getState: () => adapter.getState(),
	});
	const tunnel = new CloudflareTunnel(logger);
	const runtime = new RemoteControlRuntime(server, deviceTrust, tunnel, logger);

	registerRemoteCommand(pi, runtime, adapter, logger);
	new RemoteEventStream(server, adapter).bind(pi);

	pi.on("session_shutdown", async () => {
		await runtime.stop();
	});
}
