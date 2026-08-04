import { stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { RemoteSessionMonitor } from "../session/RemoteSessionMonitor.js";
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

export type RemoteSkillOption = {
	name: string;
	description?: string;
};

export type RemoteSkillList = {
	skills: RemoteSkillOption[];
};

export class PiRemoteAdapter {
	private latestContext?: ExtensionContext;
	private branch?: string;
	private branchLoadedCwd?: string;
	private branchRefresh?: Promise<void>;
	private readonly host = hostname();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly monitor = new RemoteSessionMonitor(),
	) {}

	captureContext(ctx: ExtensionContext): void {
		this.latestContext = ctx;
		if (this.branchLoadedCwd !== ctx.cwd) void this.refreshExecutionContext();
	}

	getState(): RemoteStateSnapshot {
		return createStateSnapshot(this.latestContext, {
			thinkingLevel: this.readThinkingLevel(),
			phase: this.monitor.phase,
			host: this.host,
			branch: this.branch,
			lastRun: this.monitor.lastRun,
		});
	}

	async refreshExecutionContext(force = false): Promise<void> {
		const cwd = this.latestContext?.cwd;
		if (!cwd || (!force && this.branchLoadedCwd === cwd)) return;
		if (this.branchRefresh) return this.branchRefresh;

		this.branchRefresh = this.loadBranch(cwd).finally(() => {
			this.branchRefresh = undefined;
		});
		return this.branchRefresh;
	}

	private async loadBranch(cwd: string): Promise<void> {
		try {
			const result = await this.pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 1_000 });
			let branch = result.code === 0 ? result.stdout.trim() : "";
			if (!branch && result.code === 0) {
				const revision = await this.pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 1_000 });
				if (revision.code === 0 && revision.stdout.trim()) branch = `detached @ ${revision.stdout.trim()}`;
			}
			if (this.latestContext?.cwd !== cwd) return;
			this.branch = branch || undefined;
			this.branchLoadedCwd = cwd;
		} catch {
			if (this.latestContext?.cwd !== cwd) return;
			this.branch = undefined;
			this.branchLoadedCwd = cwd;
		}
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
		const expanded = await this.expandSkillCommand(trimmed);

		const isIdle = this.latestContext?.isIdle() ?? true;
		if (isIdle) {
			this.pi.sendUserMessage(expanded);
			return;
		}

		if (delivery === "prompt") throw new Error("Agent is busy. Use steer or follow-up.");
		const deliverAs = delivery === "steer" ? "steer" : "followUp";
		this.pi.sendUserMessage(expanded, { deliverAs });
		if (deliverAs === "followUp") this.monitor.promptQueued();
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

	listSkills(): RemoteSkillList {
		const skills = this.pi
			.getCommands()
			.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
			.map((command) => {
				const name = command.name.slice(0, 128);
				const description = command.description?.trim().slice(0, 1024);
				return description ? { name, description } : { name };
			})
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, 200);
		return { skills };
	}

	private async expandSkillCommand(message: string): Promise<string> {
		if (!message.startsWith("/skill:")) return message;

		const spaceIndex = message.indexOf(" ");
		const commandName = spaceIndex === -1 ? message.slice(1) : message.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : message.slice(spaceIndex + 1).trim();
		const command = this.pi.getCommands().find((candidate) => candidate.source === "skill" && candidate.name === commandName);
		if (!command) throw new Error(`Unknown skill: ${commandName}`);

		const content = await readFile(command.sourceInfo.path, "utf8");
		const body = stripFrontmatter(content).trim();
		const skillName = commandName.slice("skill:".length);
		const baseDir = command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path);
		const block = `<skill name="${skillName}" location="${command.sourceInfo.path}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
		return args ? `${block}\n\n${args}` : block;
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
		this.monitor.compactionStarted();
	}

	setThinkingLevel(level: string): void {
		const api = this.pi as ExtensionAPI & { setThinkingLevel?: (level: string) => void };
		if (!api.setThinkingLevel) throw new Error("Thinking level control is not available in this Pi version");
		api.setThinkingLevel(level);
	}
}
