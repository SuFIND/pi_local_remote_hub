import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DeviceTrust } from "./auth/DeviceTrust.js";
import { DEFAULT_REMOTE_CONFIG } from "./config.js";
import { registerRemoteCommand } from "./command.js";
import { RemoteEventStream } from "./events/RemoteEventStream.js";
import { createLogger } from "./logging/logger.js";
import { PiRemoteAdapter } from "./pi/PiRemoteAdapter.js";
import { QuestionBroker } from "./questions/QuestionBroker.js";
import { registerRemoteQuestionTool } from "./questions/registerRemoteQuestionTool.js";
import { RemoteControlRuntime } from "./runtime/RemoteControlRuntime.js";
import { RemoteSessionMonitor } from "./session/RemoteSessionMonitor.js";
import { RunEvidenceCollector } from "./session/RunEvidenceCollector.js";
import { RemoteServer } from "./server/RemoteServer.js";
import { CloudflareTunnel } from "./tunnel/CloudflareTunnel.js";

export default function piRemoteControl(pi: ExtensionAPI): void {
	const logger = createLogger("pi-remote-control");
	const monitor = new RemoteSessionMonitor();
	const evidence = new RunEvidenceCollector();
	const adapter = new PiRemoteAdapter(pi, monitor);
	const deviceTrust = new DeviceTrust();
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
		questions,
		getState: () => adapter.getState(),
	});
	const tunnel = new CloudflareTunnel(logger);
	const runtime = new RemoteControlRuntime(server, deviceTrust, tunnel, logger, questions);

	registerRemoteCommand(pi, runtime, adapter, logger);
	registerRemoteQuestionTool(pi, questions, () => server.isRunning());
	new RemoteEventStream(server, adapter, monitor, evidence).bind(pi);

	pi.on("session_shutdown", async () => {
		await runtime.stop();
	});
}
