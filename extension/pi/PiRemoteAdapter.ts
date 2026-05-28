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

export type RemoteModelOption = {
	provider: string;
	id: string;
	name: string;
	available: boolean;
	reasoning?: boolean;
	contextWindow?: number;
};

export type RemoteModelList = {
	models: RemoteModelOption[];
	current?: { provider: string; id: string };
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

	listModels(): RemoteModelList {
		const ctx = this.latestContext;
		if (!ctx) return { models: [] };

		const registry = ctx.modelRegistry;
		const availableKeys = new Set(registry.getAvailable().map((m) => `${m.provider}/${m.id}`));
		const models: RemoteModelOption[] = registry.getAll().map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.name,
			available: availableKeys.has(`${m.provider}/${m.id}`),
			reasoning: m.reasoning,
			contextWindow: m.contextWindow,
		}));
		const current = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
		return { models, current };
	}

	async setModel(provider: string, modelId: string): Promise<void> {
		const ctx = this.latestContext;
		if (!ctx) throw new Error("No active session");
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
		const accepted = await this.pi.setModel(model);
		if (!accepted) throw new Error(`Model ${provider}/${modelId} is not available (missing API key?)`);
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

	setThinkingLevel(level: string): void {
		const api = this.pi as ExtensionAPI & { setThinkingLevel?: (level: string) => void };
		if (!api.setThinkingLevel) throw new Error("Thinking level control is not available in this Pi version");
		api.setThinkingLevel(level);
	}
}
