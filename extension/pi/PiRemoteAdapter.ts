import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeForRemote } from "./sanitizer.js";
import { createStateSnapshot, type RemoteStateSnapshot } from "./stateSnapshot.js";

export type PromptDelivery = "auto" | "prompt" | "steer" | "followUp";

export type RemoteSessionHistory = {
	entries: unknown[];
	leafId?: string;
	totalEntries: number;
	truncated: boolean;
};

export class PiRemoteAdapter {
	private latestContext?: ExtensionContext;

	constructor(private readonly pi: ExtensionAPI) {}

	captureContext(ctx: ExtensionContext): void {
		this.latestContext = ctx;
	}

	getState(): RemoteStateSnapshot {
		return createStateSnapshot(this.latestContext, { thinkingLevel: this.readThinkingLevel() });
	}

	private readThinkingLevel(): string | undefined {
		const api = this.pi as ExtensionAPI & { getThinkingLevel?: () => string };
		try {
			return api.getThinkingLevel?.();
		} catch {
			return undefined;
		}
	}

	getHistory(limit?: number): RemoteSessionHistory {
		const ctx = this.latestContext;
		if (!ctx) return { entries: [], totalEntries: 0, truncated: false };

		const branch = ctx.sessionManager.getBranch().slice();
		branch.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
		const total = branch.length;

		let selected = branch;
		let truncated = false;
		if (limit !== undefined && limit < total) {
			selected = branch.slice(total - limit);
			truncated = true;
		}

		return {
			entries: selected.map((entry) => sanitizeForRemote(entry)),
			leafId: ctx.sessionManager.getLeafId() ?? undefined,
			totalEntries: total,
			truncated,
		};
	}

	async prompt(message: string, delivery: PromptDelivery): Promise<void> {
		const trimmed = message.trim();
		if (!trimmed) throw new Error("Message is required");

		const isIdle = this.latestContext?.isIdle() ?? true;
		if (isIdle) {
			this.pi.sendUserMessage(trimmed);
			return;
		}

		if (delivery === "prompt") throw new Error("Agent is busy. Use steer or follow-up.");
		this.pi.sendUserMessage(trimmed, { deliverAs: delivery === "steer" ? "steer" : "followUp" });
	}

	async abort(): Promise<void> {
		const ctx = this.latestContext as (ExtensionContext & { abort?: () => Promise<void> | void }) | undefined;
		if (!ctx?.abort) throw new Error("Abort is not available in this Pi version/context");
		await ctx.abort();
	}

	compact(): void {
		const ctx = this.latestContext as (ExtensionContext & { compact?: (options?: unknown) => void }) | undefined;
		if (!ctx?.compact) throw new Error("Compact is not available in this Pi version/context");
		ctx.compact();
	}
}
