import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DeviceTrust } from "./auth/DeviceTrust.js";
import { FileTrustStore } from "./auth/TrustStore.js";
import { DEFAULT_REMOTE_CONFIG } from "./config.js";
import { registerRemoteCommand, statusBarText } from "./command.js";
import { RemoteEventStream } from "./events/RemoteEventStream.js";
import { loadOrCreateHostIdentity } from "./identity/HostIdentity.js";
import { createLogger } from "./logging/logger.js";
import { BonjourAdvertiser } from "./net/BonjourAdvertiser.js";
import { PiRemoteAdapter } from "./pi/PiRemoteAdapter.js";
import { QuestionBroker } from "./questions/QuestionBroker.js";
import { registerRemoteQuestionTool } from "./questions/registerRemoteQuestionTool.js";
import { RemoteControlRuntime } from "./runtime/RemoteControlRuntime.js";
import { RemoteSettingsStore } from "./runtime/RemoteSettings.js";
import { RemoteSessionMonitor } from "./session/RemoteSessionMonitor.js";
import { RunEvidenceCollector } from "./session/RunEvidenceCollector.js";
import { RemoteServer } from "./server/RemoteServer.js";
import { remoteStateDir } from "./storage.js";
import { CloudflareTunnel } from "./tunnel/CloudflareTunnel.js";

export default function piRemoteControl(pi: ExtensionAPI): void {
	const logger = createLogger("pi-remote-control");
	const monitor = new RemoteSessionMonitor();
	const evidence = new RunEvidenceCollector();
	const adapter = new PiRemoteAdapter(pi, monitor);
	const stateDir = remoteStateDir();
	// Trusted devices and the TLS identity live on disk so a paired phone
	// survives Pi restarts; both are touched only when the server is used.
	const deviceTrust = new DeviceTrust({ store: new FileTrustStore(join(stateDir, "trusted-devices.json")) });
	const settings = new RemoteSettingsStore(join(stateDir, "settings.json"));
	let server: RemoteServer;
	const questions = new QuestionBroker({
		onQuestion: (question) => {
			monitor.questionOpened();
			server.broadcast("interaction.question", question);
			server.broadcastStateChanged("questionOpened");
		},
		onResolved: (resolution) => {
			monitor.questionResolved();
			server.broadcast("interaction.resolved", resolution);
			server.broadcastStateChanged("questionResolved");
		},
	});
	server = new RemoteServer({
		config: DEFAULT_REMOTE_CONFIG,
		logger,
		adapter,
		deviceTrust,
		identity: () => loadOrCreateHostIdentity(stateDir),
		questions,
		getState: () => adapter.getState(),
	});
	const tunnel = new CloudflareTunnel(logger);
	const runtime = new RemoteControlRuntime(server, deviceTrust, tunnel, logger, questions, {
		advertiser: new BonjourAdvertiser(logger),
		getCwd: () => adapter.getState().cwd,
	});

	registerRemoteCommand(pi, runtime, adapter, logger, settings);
	registerRemoteQuestionTool(pi, questions, () => server.isRunning());
	new RemoteEventStream(server, adapter, monitor, evidence).bind(pi);

	// `/remote autostart on`: interactive Pi windows bring the listener up
	// for already-paired phones. No pairing window opens — pairing a new
	// device still takes an explicit `/remote start` at the Mac.
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || runtime.isRunning() || !settings.load().autoStart) return;
		adapter.captureContext(ctx);
		try {
			const status = await runtime.start({ pairing: false });
			ctx.ui.setStatus("pi-remote", statusBarText(status.displayWebSocketUrl));
		} catch (error) {
			ctx.ui.notify(`Pi Remote autostart failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		await runtime.stop();
	});
}
