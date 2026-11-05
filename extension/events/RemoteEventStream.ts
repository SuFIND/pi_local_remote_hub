import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractEditPayload, synthesizeWriteDiff, type EditPayload } from "../pi/editPayload.js";
import { mapPiEvent } from "../pi/eventMapper.js";
import type { PiRemoteAdapter } from "../pi/PiRemoteAdapter.js";
import type { RemoteSessionMonitor } from "../session/RemoteSessionMonitor.js";
import type { RunEvidenceCollector } from "../session/RunEvidenceCollector.js";
import type { RemoteServer } from "../server/RemoteServer.js";

const PI_EVENT_NAMES = [
	"session_start",
	"session_shutdown",
	"before_agent_start",
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"tool_call",
	"tool_result",
	"model_select",
	"thinking_level_select",
	"session_before_compact",
	"session_compact",
] as const;

const INTERNAL_ONLY_EVENTS = new Set<string>(["before_agent_start", "session_before_compact"]);
const STATE_CHANGE_EVENTS = new Set<string>([
	"session_start",
	"before_agent_start",
	"agent_start",
	"agent_settled",
	"session_before_compact",
	"session_compact",
]);

export class RemoteEventStream {
	/**
	 * Per-toolCallId stash of the unified diff lifted from `tool_result` so we
	 * can attach it to the matching `tool_execution_end` event. iOS only
	 * watches `pi.tool_end`; consolidating here removes the need for the
	 * client to correlate two event streams by id.
	 */
	private readonly pendingEdits = new Map<string, EditPayload>();

	constructor(
		private readonly server: RemoteServer,
		private readonly adapter: PiRemoteAdapter,
		private readonly monitor: RemoteSessionMonitor,
		private readonly evidence: RunEvidenceCollector,
	) {}

	bind(pi: ExtensionAPI): void {
		for (const eventName of PI_EVENT_NAMES) {
			(pi.on as (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => void)(eventName, async (event, ctx) => {
				this.adapter.captureContext(ctx);
				const edit = eventName === "tool_result" ? this.stashEditIfApplicable(event) : undefined;
				const summary = this.evidence.handle(eventName, event, edit);
				this.updateMonitor(eventName, summary);

				if (eventName === "session_start" || eventName === "agent_settled") {
					await this.adapter.refreshExecutionContext(eventName === "agent_settled");
				}
				if (!this.server.isRunning()) return;

				if (!INTERNAL_ONLY_EVENTS.has(eventName)) {
					const mapped = mapPiEvent(eventName, event);
					if (mapped) {
						if (eventName === "tool_execution_end") this.attachEditPayload(event, mapped.payload);
						this.server.broadcast(mapped.type, mapped.payload);
					}
				}
				if (summary) this.server.broadcast("session.run.completed", summary);
				if (STATE_CHANGE_EVENTS.has(eventName)) this.server.broadcastStateChanged(eventName);
			});
		}
	}

	private updateMonitor(eventName: string, summary: ReturnType<RunEvidenceCollector["handle"]>): void {
		switch (eventName) {
			case "session_start":
				this.monitor.sessionStarted();
				break;
			case "before_agent_start":
			case "agent_start":
				this.monitor.agentStarted();
				break;
			case "session_before_compact":
				this.monitor.compactionStarted();
				break;
			case "session_compact":
				this.monitor.compactionFinished();
				break;
			case "agent_settled":
				if (summary) this.monitor.agentSettled(summary);
				break;
			default:
				break;
		}
	}

	private stashEditIfApplicable(event: unknown): EditPayload | undefined {
		const payload = extractEditPayload(event) ?? synthesizeWriteDiff(event);
		if (!payload) return undefined;
		const id = readToolCallId(event);
		if (!id) return undefined;
		this.pendingEdits.set(id, payload);
		return payload;
	}

	/**
	 * Attach the cached diff to the outgoing `pi.tool_end` payload, bypassing
	 * the sanitizer's 20K-char cap. The rest of the event stays bounded.
	 */
	private attachEditPayload(event: unknown, mappedPayload: { data: unknown }): void {
		const id = readToolCallId(event);
		if (!id) return;
		const payload = this.pendingEdits.get(id);
		if (!payload) return;
		this.pendingEdits.delete(id);
		if (typeof mappedPayload.data === "object" && mappedPayload.data !== null) {
			(mappedPayload.data as Record<string, unknown>).edit = payload;
		}
	}
}

function readToolCallId(event: unknown): string | null {
	if (typeof event !== "object" || event === null) return null;
	const candidate = (event as Record<string, unknown>).toolCallId;
	return typeof candidate === "string" ? candidate : null;
}
