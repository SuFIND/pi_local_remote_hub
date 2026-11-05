import type { PiRemoteAdapter } from "../pi/PiRemoteAdapter.js";
import type { QuestionBroker } from "../questions/QuestionBroker.js";
import { createErrorPayload } from "../protocol/envelopes.js";
import { ProtocolError, type ProtocolErrorCode } from "../protocol/errors.js";
import type { ClientMessage } from "../protocol/ProtocolDecoder.js";

/** Reply channel for one forwarded request; the hub restores the phone's request id. */
export type CommandReply = (type: string, payload?: unknown) => void;

export type SessionCommandAdapter = Pick<
	PiRemoteAdapter,
	"getState" | "getHistory" | "prompt" | "abort" | "compact" | "listModels" | "listSkills" | "setModel" | "setThinkingLevel"
>;

type StateChangedReason = "promptAccepted" | "abortRequested" | "compactRequested" | "modelChanged" | "thinkingChanged";

/**
 * Runs the session commands a phone sends, inside the Pi process that owns
 * the session. Authentication already happened at the hub; every message
 * that reaches this class comes from a trusted device.
 */
export class SessionCommands {
	constructor(
		private readonly adapter: SessionCommandAdapter,
		private readonly questions: QuestionBroker,
	) {}

	async handle(message: ClientMessage, reply: CommandReply): Promise<void> {
		try {
			await this.dispatch(message, reply);
		} catch (error) {
			if (error instanceof ProtocolError) {
				reply("response.error", createErrorPayload(error.code, error.message));
				return;
			}
			reply("response.error", createErrorPayload("COMMAND_FAILED", error instanceof Error ? error.message : String(error)));
		}
	}

	private async dispatch(message: ClientMessage, reply: CommandReply): Promise<void> {
		const ok = (result: unknown) => reply("response.ok", { ok: true, command: message.kind, result });
		switch (message.kind) {
			case "interaction.answer":
				this.questions.answer(message.requestId, message.answer);
				ok({ accepted: true, requestId: message.requestId });
				return;
			case "session.getState":
				ok({ state: this.adapter.getState() });
				return;
			case "session.history":
				ok(this.adapter.getHistory(message.limit));
				return;
			case "session.listModels":
				ok(this.adapter.listModels());
				return;
			case "session.listSkills":
				ok(this.adapter.listSkills());
				return;
			case "session.prompt":
				return this.run(reply, message.kind, "promptAccepted", () => this.adapter.prompt(message.message, message.delivery));
			case "session.abort":
				return this.run(reply, message.kind, "abortRequested", () => this.adapter.abort());
			case "session.compact":
				return this.run(reply, message.kind, "compactRequested", async () => this.adapter.compact());
			case "session.setModel":
				return this.run(reply, message.kind, "modelChanged", () => this.adapter.setModel(message.provider, message.modelId));
			case "session.setThinkingLevel":
				return this.run(reply, message.kind, "thinkingChanged", async () => this.adapter.setThinkingLevel(message.level));
			case "unknown":
				throw new ProtocolError("UNKNOWN_COMMAND", `Unknown command: ${message.type}`);
			default:
				throw new ProtocolError("UNKNOWN_COMMAND", `Unexpected command: ${message.kind}`);
		}
	}

	private async run(reply: CommandReply, command: string, reason: StateChangedReason, action: () => Promise<unknown>): Promise<void> {
		try {
			await action();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code: ProtocolErrorCode = /busy/i.test(message) ? "AGENT_BUSY" : "COMMAND_FAILED";
			reply("response.error", createErrorPayload(code, message));
			return;
		}
		const state = this.adapter.getState();
		reply("response.ok", { ok: true, command, result: { accepted: true, state } });
		reply("state.changed", { reason, state });
	}
}
