import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeForRemote } from "./sanitizer.js";

export type RemoteStateSnapshot = {
	cwd?: string;
	sessionFile?: string;
	sessionName?: string;
	isIdle: boolean;
	hasPendingMessages?: boolean;
	entryCount?: number;
	leafId?: string;
	model?: {
		provider?: string;
		id?: string;
		name?: string;
	};
	thinkingLevel?: string;
	contextUsage?: unknown;
};

export type StateSnapshotExtras = {
	/** Current thinking level, read from the ExtensionAPI rather than the
	 * context (it lives on `pi.getThinkingLevel()`, not `ctx`). */
	thinkingLevel?: string;
};

export function createStateSnapshot(ctx: ExtensionContext | undefined, extras: StateSnapshotExtras = {}): RemoteStateSnapshot {
	if (!ctx) return { isIdle: true, thinkingLevel: extras.thinkingLevel };

	return {
		cwd: ctx.cwd,
		sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
		sessionName: ctx.sessionManager.getSessionName() ?? undefined,
		isIdle: ctx.isIdle(),
		hasPendingMessages: ctx.hasPendingMessages(),
		entryCount: ctx.sessionManager.getEntries().length,
		leafId: ctx.sessionManager.getLeafId() ?? undefined,
		model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id, name: ctx.model.name } : undefined,
		thinkingLevel: extras.thinkingLevel,
		contextUsage: sanitizeForRemote(ctx.getContextUsage()),
	};
}
