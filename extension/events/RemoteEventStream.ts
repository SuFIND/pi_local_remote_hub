import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { extractEditPayload, synthesizeWriteDiff, type EditPayload } from "../pi/editPayload.js";
import { mapPiEvent } from "../pi/eventMapper.js";
import type { PiRemoteAdapter } from "../pi/PiRemoteAdapter.js";
import type { RemoteServer } from "../server/RemoteServer.js";

const PI_EVENT_NAMES = [
	"session_start",
	"session_shutdown",
	"agent_start",
	"agent_end",
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
	"session_compact",
] as const;

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
	) {}

	bind(pi: ExtensionAPI): void {
		for (const eventName of PI_EVENT_NAMES) {
			(pi.on as (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => void)(eventName, async (event, ctx) => {
				this.adapter.captureContext(ctx);
				if (!this.server.isRunning()) return;

				if (eventName === "tool_result") this.stashEditIfApplicable(event);
				const mapped = mapPiEvent(eventName, event);
				if (eventName === "tool_execution_end") this.attachEditPayload(event, mapped.payload);
				this.server.broadcast(mapped.type, mapped.payload);
			});
		}
	}

	private stashEditIfApplicable(event: unknown): void {
		const payload = extractEditPayload(event) ?? synthesizeWriteDiff(event);
		if (!payload) return;
		const id = readToolCallId(event);
		if (!id) return;
		this.pendingEdits.set(id, payload);
	}

	/**
	 * Attach the cached diff to the outgoing `pi.tool_end` payload, bypassing
	 * the sanitizer's 20K-char cap — users have explicitly asked to review
	 * whole diffs on mobile regardless of size, and `mapped.payload.data` has
	 * already been sanitized at this point so re-attaching the raw object
	 * leaves the rest of the event clipped per the usual rules.
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
