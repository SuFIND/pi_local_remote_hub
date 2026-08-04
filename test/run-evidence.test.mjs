import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { RunEvidenceCollector } = jiti("../extension/session/RunEvidenceCollector.ts");

test("RunEvidenceCollector summarizes commands, failures, and changed files when Pi settles", () => {
	const times = [
		new Date("2026-08-04T10:00:00.000Z"),
		new Date("2026-08-04T10:01:00.000Z"),
	];
	const collector = new RunEvidenceCollector({
		createID: () => "run_1",
		now: () => times.shift() ?? new Date("2026-08-04T10:01:00.000Z"),
	});

	collector.handle("before_agent_start", {});
	collector.handle("tool_execution_start", {
		toolCallId: "bash_1",
		toolName: "bash",
		args: { command: "npm test" },
	});
	collector.handle("tool_result", {
		toolCallId: "bash_1",
		toolName: "bash",
		input: { command: "npm test" },
		isError: false,
	});
	collector.handle("tool_execution_start", {
		toolCallId: "edit_1",
		toolName: "edit",
		args: { path: "extension/index.ts" },
	});
	collector.handle("tool_result", {
		toolCallId: "edit_1",
		toolName: "edit",
		input: { path: "extension/index.ts" },
		isError: false,
	}, {
		filePath: "extension/index.ts",
		diff: "@@ -1 +1 @@\n-old\n+new\n",
		firstChangedLine: 1,
		stats: { added: 1, removed: 1 },
	});
	collector.handle("tool_execution_start", {
		toolCallId: "bash_2",
		toolName: "bash",
		args: { command: "npm run lint" },
	});
	collector.handle("tool_result", {
		toolCallId: "bash_2",
		toolName: "bash",
		input: { command: "npm run lint" },
		isError: true,
	});
	collector.handle("agent_end", {
		messages: [{ role: "assistant", stopReason: "stop" }],
	});
	const summary = collector.handle("agent_settled", {});

	assert.deepEqual(summary, {
		runId: "run_1",
		startedAt: "2026-08-04T10:00:00.000Z",
		completedAt: "2026-08-04T10:01:00.000Z",
		status: "completedWithErrors",
		toolCount: 3,
		failedToolCount: 1,
		commands: [
			{ toolCallId: "bash_1", command: "npm test", status: "succeeded" },
			{ toolCallId: "bash_2", command: "npm run lint", status: "failed" },
		],
		changedFiles: [{
			filePath: "extension/index.ts",
			added: 1,
			removed: 1,
			toolCallIds: ["edit_1"],
		}],
		truncated: false,
	});
	assert.deepEqual(collector.lastRun, summary);
});

test("RunEvidenceCollector keeps evidence across queued continuations until agent_settled", () => {
	let nextID = 0;
	const collector = new RunEvidenceCollector({ createID: () => `run_${++nextID}` });
	collector.handle("before_agent_start", {});
	collector.handle("tool_execution_start", { toolCallId: "bash_1", toolName: "bash", args: {} });
	collector.handle("tool_result", {
		toolCallId: "bash_1",
		toolName: "bash",
		input: { command: "npm test" },
		isError: false,
	});
	collector.handle("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
	collector.handle("before_agent_start", {});
	collector.handle("tool_execution_start", { toolCallId: "bash_2", toolName: "bash", args: {} });
	collector.handle("tool_result", {
		toolCallId: "bash_2",
		toolName: "bash",
		input: { command: "npm run typecheck" },
		isError: false,
	});

	const summary = collector.handle("agent_settled", {});
	assert.equal(summary.runId, "run_1");
	assert.equal(summary.toolCount, 2);
	assert.deepEqual(summary.commands.map((item) => item.command), ["npm test", "npm run typecheck"]);
});

test("RunEvidenceCollector reports an aborted run without treating it as a failure", () => {
	const collector = new RunEvidenceCollector({
		createID: () => "run_2",
		now: () => new Date("2026-08-04T10:00:00.000Z"),
	});
	collector.handle("before_agent_start", {});
	collector.handle("agent_end", {
		messages: [{ role: "assistant", stopReason: "aborted" }],
	});
	const summary = collector.handle("agent_settled", {});
	assert.equal(summary.status, "aborted");
});

test("RunEvidenceCollector merges repeated edits to the same file", () => {
	const collector = new RunEvidenceCollector({ createID: () => "run_3" });
	collector.handle("before_agent_start", {});
	for (const [toolCallId, added, removed] of [["edit_1", 2, 0], ["edit_2", 1, 3]]) {
		collector.handle("tool_execution_start", { toolCallId, toolName: "edit", args: {} });
		collector.handle("tool_result", { toolCallId, toolName: "edit", input: {}, isError: false }, {
			filePath: "Pi/App.swift",
			diff: "diff",
			stats: { added, removed },
		});
	}
	const summary = collector.handle("agent_settled", {});
	assert.deepEqual(summary.changedFiles, [{
		filePath: "Pi/App.swift",
		added: 3,
		removed: 3,
		toolCallIds: ["edit_1", "edit_2"],
	}]);
});
