import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { RemoteEventStream } = jiti("../extension/events/RemoteEventStream.ts");
const { RemoteSessionMonitor } = jiti("../extension/session/RemoteSessionMonitor.ts");
const { RunEvidenceCollector } = jiti("../extension/session/RunEvidenceCollector.ts");

test("RemoteEventStream emits structured phase changes and completion evidence", async () => {
	const handlers = new Map();
	const broadcasts = [];
	const stateChanges = [];
	const server = {
		isRunning: () => true,
		broadcast: (type, payload) => broadcasts.push({ type, payload }),
		broadcastStateChanged: (reason) => stateChanges.push(reason),
	};
	const adapter = {
		captureContext: () => {},
		refreshExecutionContext: async () => {},
	};
	const monitor = new RemoteSessionMonitor();
	const evidence = new RunEvidenceCollector({
		createID: () => "run_1",
		now: () => new Date("2026-08-04T10:00:00.000Z"),
	});
	new RemoteEventStream(server, adapter, monitor, evidence).bind({
		on: (name, handler) => handlers.set(name, handler),
	});
	const context = {};

	await handlers.get("before_agent_start")({ type: "before_agent_start", prompt: "test", systemPrompt: "private" }, context);
	assert.equal(monitor.phase, "running");
	assert.equal(broadcasts.some((item) => item.type === "pi.before_agent_start"), false);

	await handlers.get("agent_start")({ type: "agent_start" }, context);
	await handlers.get("tool_execution_start")({
		type: "tool_execution_start",
		toolCallId: "bash_1",
		toolName: "bash",
		args: { command: "npm test" },
	}, context);
	await handlers.get("tool_result")({
		type: "tool_result",
		toolCallId: "bash_1",
		toolName: "bash",
		input: { command: "npm test" },
		content: [{ type: "text", text: "ok" }],
		isError: false,
	}, context);
	await handlers.get("agent_end")({
		type: "agent_end",
		messages: [{ role: "assistant", stopReason: "stop" }],
	}, context);
	await handlers.get("agent_settled")({ type: "agent_settled" }, context);

	assert.equal(monitor.phase, "completed");
	assert.deepEqual(stateChanges, ["before_agent_start", "agent_start", "agent_settled"]);
	const completion = broadcasts.find((item) => item.type === "session.run.completed");
	assert.equal(completion.payload.status, "completed");
	assert.deepEqual(completion.payload.commands, [{
		toolCallId: "bash_1",
		command: "npm test",
		status: "succeeded",
	}]);
	assert.equal(broadcasts.some((item) => item.type === "pi.agent_settled"), true);
});

test("RemoteEventStream never broadcasts session_before_compact contents", async () => {
	const handlers = new Map();
	const broadcasts = [];
	const server = {
		isRunning: () => true,
		broadcast: (type, payload) => broadcasts.push({ type, payload }),
		broadcastStateChanged: () => {},
	};
	const monitor = new RemoteSessionMonitor();
	new RemoteEventStream(
		server,
		{ captureContext: () => {}, refreshExecutionContext: async () => {} },
		monitor,
		new RunEvidenceCollector(),
	).bind({ on: (name, handler) => handlers.set(name, handler) });

	await handlers.get("session_before_compact")({
		type: "session_before_compact",
		branchEntries: [{ secret: "must not leave the Mac" }],
	}, {});

	assert.equal(monitor.phase, "compacting");
	assert.deepEqual(broadcasts, []);
});
