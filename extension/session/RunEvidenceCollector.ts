import { randomUUID } from "node:crypto";
import type { EditPayload } from "../pi/editPayload.js";

const MAX_COMMANDS = 20;
const MAX_COMMAND_LENGTH = 2_000;
const MAX_CHANGED_FILES = 50;
const MAX_TOOL_CALLS_PER_FILE = 20;
const MAX_FILE_PATH_LENGTH = 2_000;

export type RemoteRunStatus = "completed" | "completedWithErrors" | "aborted" | "failed";

export type RemoteRunCommand = {
	toolCallId: string;
	command: string;
	status: "succeeded" | "failed";
};

export type RemoteChangedFile = {
	filePath: string;
	added: number;
	removed: number;
	toolCallIds: string[];
};

export type RemoteRunEvidence = {
	runId: string;
	startedAt: string;
	completedAt: string;
	status: RemoteRunStatus;
	toolCount: number;
	failedToolCount: number;
	commands: RemoteRunCommand[];
	changedFiles: RemoteChangedFile[];
	truncated: boolean;
};

type CollectorOptions = {
	createID?: () => string;
	now?: () => Date;
};

type ActiveRun = {
	runId: string;
	startedAt: string;
	toolCount: number;
	failedToolCount: number;
	commands: RemoteRunCommand[];
	changedFiles: RemoteChangedFile[];
	recordedResults: Set<string>;
	outcome?: "aborted" | "failed";
	truncated: boolean;
};

/** Collects structured, bounded evidence for one Pi agent run. */
export class RunEvidenceCollector {
	private readonly createID: () => string;
	private readonly now: () => Date;
	private active?: ActiveRun;
	lastRun?: RemoteRunEvidence;

	constructor(options: CollectorOptions = {}) {
		this.createID = options.createID ?? (() => `run_${randomUUID()}`);
		this.now = options.now ?? (() => new Date());
	}

	handle(eventName: string, event: unknown, edit?: EditPayload): RemoteRunEvidence | undefined {
		switch (eventName) {
			case "session_start":
				this.active = undefined;
				this.lastRun = undefined;
				return undefined;
			case "before_agent_start":
				if (!this.active) this.start();
				return undefined;
			case "agent_start":
				if (!this.active) this.start();
				return undefined;
			case "tool_execution_start":
				this.ensureActive().toolCount += 1;
				return undefined;
			case "tool_result":
				this.recordResult(event, edit);
				return undefined;
			case "agent_end":
				this.recordAgentOutcome(event);
				return undefined;
			case "agent_settled":
				return this.finish();
			default:
				return undefined;
		}
	}

	private start(): void {
		this.active = {
			runId: this.createID(),
			startedAt: this.now().toISOString(),
			toolCount: 0,
			failedToolCount: 0,
			commands: [],
			changedFiles: [],
			recordedResults: new Set(),
			truncated: false,
		};
	}

	private ensureActive(): ActiveRun {
		if (!this.active) this.start();
		return this.active!;
	}

	private recordResult(event: unknown, edit?: EditPayload): void {
		const obj = readRecord(event);
		if (!obj) return;
		const toolCallId = readString(obj.toolCallId);
		if (!toolCallId) return;
		const run = this.ensureActive();
		if (run.recordedResults.has(toolCallId)) return;
		run.recordedResults.add(toolCallId);

		const isError = obj.isError === true;
		if (isError) run.failedToolCount += 1;
		if (obj.toolName === "bash") this.recordCommand(run, toolCallId, obj.input, isError);
		if (edit) this.recordChangedFile(run, toolCallId, edit);
	}

	private recordCommand(run: ActiveRun, toolCallId: string, input: unknown, isError: boolean): void {
		const command = readString(readRecord(input)?.command)?.trim();
		if (!command) return;
		if (run.commands.length >= MAX_COMMANDS) {
			run.truncated = true;
			return;
		}
		const bounded = command.slice(0, MAX_COMMAND_LENGTH);
		if (bounded.length !== command.length) run.truncated = true;
		run.commands.push({ toolCallId, command: bounded, status: isError ? "failed" : "succeeded" });
	}

	private recordChangedFile(run: ActiveRun, toolCallId: string, edit: EditPayload): void {
		const filePath = edit.filePath.slice(0, MAX_FILE_PATH_LENGTH);
		if (filePath.length !== edit.filePath.length) run.truncated = true;
		const existing = run.changedFiles.find((file) => file.filePath === filePath);
		if (existing) {
			existing.added += edit.stats.added;
			existing.removed += edit.stats.removed;
			if (existing.toolCallIds.length < MAX_TOOL_CALLS_PER_FILE) existing.toolCallIds.push(toolCallId);
			else run.truncated = true;
			return;
		}
		if (run.changedFiles.length >= MAX_CHANGED_FILES) {
			run.truncated = true;
			return;
		}
		run.changedFiles.push({
			filePath,
			added: edit.stats.added,
			removed: edit.stats.removed,
			toolCallIds: [toolCallId],
		});
	}

	private recordAgentOutcome(event: unknown): void {
		const messages = readRecord(event)?.messages;
		if (!Array.isArray(messages)) return;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = readRecord(messages[index]);
			if (message?.role !== "assistant") continue;
			const run = this.ensureActive();
			if (message.stopReason === "aborted") run.outcome = "aborted";
			else if (message.stopReason === "error" || readString(message.errorMessage)) run.outcome = "failed";
			else run.outcome = undefined;
			return;
		}
	}

	private finish(): RemoteRunEvidence {
		const run = this.ensureActive();
		const status: RemoteRunStatus = run.outcome
			?? (run.failedToolCount > 0 ? "completedWithErrors" : "completed");
		const summary: RemoteRunEvidence = {
			runId: run.runId,
			startedAt: run.startedAt,
			completedAt: this.now().toISOString(),
			status,
			toolCount: run.toolCount,
			failedToolCount: run.failedToolCount,
			commands: run.commands,
			changedFiles: run.changedFiles,
			truncated: run.truncated,
		};
		this.active = undefined;
		this.lastRun = summary;
		return summary;
	}
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}
