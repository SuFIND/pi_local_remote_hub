import type { DeviceTrust } from "../auth/DeviceTrust.js";
import type { TrustedDevice } from "../auth/DeviceTrust.js";
import type { Logger } from "../logging/logger.js";
import type { PiRemoteAdapter } from "../pi/PiRemoteAdapter.js";
import { createErrorPayload } from "../protocol/envelopes.js";
import { ProtocolError, type ProtocolErrorCode } from "../protocol/errors.js";
import type { ClientMessage } from "../protocol/ProtocolDecoder.js";

export type RemoteSessionOptions = {
	id: string;
	remoteAddress?: string;
	adapter: PiRemoteAdapter;
	deviceTrust: DeviceTrust;
	logger: Logger;
	send: (type: string, payload?: unknown, requestId?: string) => void;
};

type OkPayload = {
	ok: true;
	command: string;
	result: unknown;
};

type StateChangedReason = "promptAccepted" | "abortRequested" | "compactRequested" | "modelChanged" | "thinkingChanged";

export class RemoteSession {
	private authenticatedDevice?: TrustedDevice;

	constructor(private readonly options: RemoteSessionOptions) {}

	isAuthenticated(): boolean {
		return Boolean(this.authenticatedDevice);
	}

	async handle(message: ClientMessage): Promise<void> {
		if (message.kind === "connection.ping") {
			this.options.send("connection.pong", { ok: true }, message.id);
			return;
		}

		if (!this.isAuthenticated()) {
			this.handleAuthMessage(message);
			return;
		}

		await this.handleAuthenticatedMessage(message);
	}

	private handleAuthMessage(message: ClientMessage): void {
		if (message.kind === "auth.pair.request") {
			const result = this.options.deviceTrust.pairDevice({
				code: message.code,
				deviceName: message.deviceName,
				remoteAddress: this.options.remoteAddress,
			});
			if (!result.ok) throw new ProtocolError(result.code, result.message);

			this.authenticate(result.device);
			this.options.send("auth.pair.success", { token: result.token, device: result.device, state: this.options.adapter.getState() }, message.id);
			this.sendStateSnapshot();
			return;
		}

		if (message.kind === "auth.token") {
			const device = this.options.deviceTrust.authenticateToken(message.token);
			if (!device) throw new ProtocolError("UNAUTHORIZED", "Invalid or expired device token");

			this.authenticate(device);
			this.options.send("auth.token.success", { device, state: this.options.adapter.getState() }, message.id);
			this.sendStateSnapshot();
			return;
		}

		throw new ProtocolError("UNAUTHORIZED", "Authenticate before sending commands");
	}

	private async handleAuthenticatedMessage(message: ClientMessage): Promise<void> {
		if (message.kind === "session.getState") {
			this.sendOk(message.id, message.kind, { state: this.options.adapter.getState() });
			return;
		}

		if (message.kind === "session.history") {
			const history = this.options.adapter.getHistory(message.limit);
			this.sendOk(message.id, message.kind, history);
			return;
		}

		if (message.kind === "session.prompt") {
			await this.runCommand(message.id, message.kind, async () => {
				await this.options.adapter.prompt(message.message, message.delivery);
				const state = this.options.adapter.getState();
				return { result: { accepted: true, state }, stateChanged: { reason: "promptAccepted" as const, state } };
			});
			return;
		}

		if (message.kind === "session.abort") {
			await this.runCommand(message.id, message.kind, async () => {
				await this.options.adapter.abort();
				const state = this.options.adapter.getState();
				return { result: { accepted: true, state }, stateChanged: { reason: "abortRequested" as const, state } };
			});
			return;
		}

		if (message.kind === "session.compact") {
			await this.runCommand(message.id, message.kind, async () => {
				this.options.adapter.compact();
				const state = this.options.adapter.getState();
				return { result: { accepted: true, state }, stateChanged: { reason: "compactRequested" as const, state } };
			});
			return;
		}

		if (message.kind === "session.listModels") {
			this.sendOk(message.id, message.kind, this.options.adapter.listModels());
			return;
		}

		if (message.kind === "session.setModel") {
			await this.runCommand(message.id, message.kind, async () => {
				await this.options.adapter.setModel(message.provider, message.modelId);
				const state = this.options.adapter.getState();
				return { result: { accepted: true, state }, stateChanged: { reason: "modelChanged" as const, state } };
			});
			return;
		}

		if (message.kind === "session.setThinkingLevel") {
			await this.runCommand(message.id, message.kind, async () => {
				this.options.adapter.setThinkingLevel(message.level);
				const state = this.options.adapter.getState();
				return { result: { accepted: true, state }, stateChanged: { reason: "thinkingChanged" as const, state } };
			});
			return;
		}

		if (message.kind === "unknown") throw new ProtocolError("UNKNOWN_COMMAND", `Unknown command: ${message.type}`);
		throw new ProtocolError("UNKNOWN_COMMAND", `Unexpected command: ${message.kind}`);
	}

	private async runCommand(
		requestId: string | undefined,
		command: string,
		action: () => Promise<{ result: unknown; stateChanged?: { reason: StateChangedReason; state: unknown } }>,
	): Promise<void> {
		try {
			const outcome = await action();
			this.sendOk(requestId, command, outcome.result);
			if (outcome.stateChanged) this.sendStateChanged(outcome.stateChanged.reason, outcome.stateChanged.state);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const code: ProtocolErrorCode = message.includes("busy") || message.includes("Busy") ? "AGENT_BUSY" : "COMMAND_FAILED";
			this.options.send("response.error", createErrorPayload(code, message), requestId);
		}
	}

	private sendOk(requestId: string | undefined, command: string, result: unknown): void {
		const payload: OkPayload = { ok: true, command, result };
		this.options.send("response.ok", payload, requestId);
	}

	private sendStateSnapshot(): void {
		this.options.send("state.snapshot", { state: this.options.adapter.getState() });
	}

	private sendStateChanged(reason: StateChangedReason, state: unknown): void {
		this.options.send("state.changed", { reason, state });
	}

	private authenticate(device: TrustedDevice): void {
		this.authenticatedDevice = device;
		this.options.logger.info("remote_session_authenticated", { sessionId: this.options.id, deviceId: device.id, deviceName: device.name });
	}
}
