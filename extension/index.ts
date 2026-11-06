import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HubLink } from "./agent/HubLink.js";
import { LiveRunWidget } from "./agent/LiveRunWidget.js";
import { SessionCommands } from "./agent/SessionCommands.js";
import { registerRemoteCommand } from "./command.js";
import { RemoteEventStream, type RemoteEventSink } from "./events/RemoteEventStream.js";
import { hubSocketPath, type AgentMode, type AgentSessionInfo } from "./hubwire/frames.js";
import { createLogger } from "./logging/logger.js";
import { PiRemoteAdapter } from "./pi/PiRemoteAdapter.js";
import { createErrorPayload } from "./protocol/envelopes.js";
import { ProtocolError } from "./protocol/errors.js";
import { decodeClientMessage } from "./protocol/ProtocolDecoder.js";
import { QuestionBroker } from "./questions/QuestionBroker.js";
import { registerRemoteQuestionTool } from "./questions/registerRemoteQuestionTool.js";
import { RemoteSessionMonitor } from "./session/RemoteSessionMonitor.js";
import { RunEvidenceCollector } from "./session/RunEvidenceCollector.js";
import { remoteStateDir } from "./storage.js";

const HUB_BIN = fileURLToPath(new URL("../hub/bin.mjs", import.meta.url));
const HUB_HINT = `Start the hub with: node ${HUB_BIN} run   (or "install" to keep it running at login)`;

/**
 * Pi Remote, Pi side. Every interactive (and hub-spawned) Pi process
 * registers its session with the Pi Remote Hub over a local socket; the
 * hub serves the phone on the LAN and forwards its commands here. Nothing
 * in this process listens on the network.
 */
export default function piRemoteControl(pi: ExtensionAPI): void {
	const logger = createLogger("pi-remote-control");
	const monitor = new RemoteSessionMonitor();
	const evidence = new RunEvidenceCollector();
	const adapter = new PiRemoteAdapter(pi, monitor);
	let link: HubLink | undefined;
	let liveRun: LiveRunWidget | undefined;

	const sink: RemoteEventSink = {
		isRunning: () => link?.isConnected() ?? false,
		broadcast: (type, payload) => link?.broadcast(type, payload),
		broadcastStateChanged: (reason) => link?.broadcast("state.changed", { reason, state: adapter.getState() }),
	};
	const questions = new QuestionBroker({
		onQuestion: (question) => {
			monitor.questionOpened();
			sink.broadcast("interaction.question", question);
			sink.broadcastStateChanged("questionOpened");
		},
		onResolved: (resolution) => {
			monitor.questionResolved();
			sink.broadcast("interaction.resolved", resolution);
			sink.broadcastStateChanged("questionResolved");
		},
	});
	const commands = new SessionCommands(adapter, questions);

	registerRemoteCommand(
		pi,
		{ control: (op, args) => (link ? link.control(op, args) : Promise.reject(new Error("Pi Remote Hub is not running"))) },
		{ hubHint: HUB_HINT, captureContext: (ctx) => adapter.captureContext(ctx) },
	);
	registerRemoteQuestionTool(pi, questions, () => (link?.viewerCount() ?? 0) > 0);
	new RemoteEventStream(sink, adapter, monitor, evidence).bind(pi);

	// Sockets are session-scoped: Pi builds a fresh extension instance for
	// every session it switches to (/new, /resume, /fork), so each instance
	// registers its own session and the hub moves attached phones along.
	pi.on("session_start", async (_event, ctx) => {
		adapter.captureContext(ctx);
		const mode = agentMode(ctx);
		if (!mode || link || process.env.PI_REMOTE_DISABLE === "1") return;
		liveRun = mode === "tui" && ctx.hasUI ? new LiveRunWidget(ctx.ui) : undefined;
		link = new HubLink({
			socketPath: hubSocketPath(remoteStateDir()),
			logger,
			mode,
			spawnToken: process.env.PI_REMOTE_SPAWN_TOKEN || undefined,
			describe: () => ({ session: describeSession(ctx), state: adapter.getState() }),
			onRequest: (envelope, reply) => {
				let message;
				try {
					message = decodeClientMessage(Buffer.from(JSON.stringify(envelope)));
				} catch (error) {
					const code = error instanceof ProtocolError ? error.code : "BAD_REQUEST";
					reply("response.error", createErrorPayload(code, error instanceof Error ? error.message : "Invalid message"));
					return;
				}
				void commands.handle(message, reply);
			},
			onViewers: (count) => {
				if (ctx.hasUI) ctx.ui.setStatus("pi-remote", count > 0 ? `📱 Pi Remote (${count})` : undefined);
			},
			onNotice: (notice) => {
				// A reload after every run of another window would be noise.
				if (ctx.hasUI && !notice.reload) ctx.ui.notify(notice.message, notice.level);
				// The phone's (or the other window's) run finished: reload this
				// window from the session file so it continues from the newest entry.
				if (notice.handoffReady || notice.reload) pi.sendUserMessage("/remote takeover", { expandPromptTemplates: true });
			},
			onMirror: (from, type, payload) => liveRun?.handle(from, type, payload),
			onConnectionChange: (connected) => {
				if (!connected) liveRun?.clear();
			},
		});
		link.start();
	});

	pi.on("session_shutdown", async () => {
		questions.cancelAll();
		liveRun?.clear();
		liveRun = undefined;
		link?.stop();
		link = undefined;
	});
}

/** One-shot `pi -p` / `--mode json` runs never register; there is nobody to steer them. */
function agentMode(ctx: ExtensionContext): AgentMode | undefined {
	if (ctx.mode === "tui") return "tui";
	if (ctx.mode === "rpc") return "rpc";
	return undefined;
}

function describeSession(ctx: ExtensionContext): AgentSessionInfo {
	const manager = ctx.sessionManager;
	return {
		file: manager.getSessionFile() ?? undefined,
		id: manager.getSessionId(),
		cwd: ctx.cwd,
		name: manager.getSessionName() ?? undefined,
	};
}
