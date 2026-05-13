import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeForRemote } from "./sanitizer.js";

export type RemoteStateSnapshot = {
	cwd?: string;
	sessionFile?: string;
	isIdle: boolean;
	hasPendingMessages?: boolean;
	entryCount?: number;
	leafId?: string;
	model?: {
		provider?: string;
		id?: string;
		name?: string;
	};
	contextUsage?: unknown;
};

export function createStateSnapshot(ctx: ExtensionContext | undefined): RemoteStateSnapshot {
	if (!ctx) return { isIdle: true };

	return {
		cwd: ctx.cwd,
		sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
		isIdle: ctx.isIdle(),
		hasPendingMessages: ctx.hasPendingMessages(),
		entryCount: ctx.sessionManager.getEntries().length,
		leafId: ctx.sessionManager.getLeafId() ?? undefined,
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
		contextUsage: sanitizeForRemote(ctx.getContextUsage()),
	};
}
