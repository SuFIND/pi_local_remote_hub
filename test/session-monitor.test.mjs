import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { RemoteSessionMonitor } = jiti("../extension/session/RemoteSessionMonitor.ts");

test("RemoteSessionMonitor tracks running, queued, question, and completion phases", () => {
	const monitor = new RemoteSessionMonitor();
	assert.equal(monitor.phase, "idle");

	monitor.agentStarted();
	assert.equal(monitor.phase, "running");
	monitor.promptQueued();
	assert.equal(monitor.phase, "queued");
	monitor.questionOpened();
	assert.equal(monitor.phase, "needsInput");
	monitor.questionResolved();
	assert.equal(monitor.phase, "queued");
	monitor.agentSettled({ status: "completed" });
	assert.equal(monitor.phase, "completed");
});

test("RemoteSessionMonitor remembers prompts queued while a question is open", () => {
	const monitor = new RemoteSessionMonitor();
	monitor.agentStarted();
	monitor.questionOpened();
	monitor.promptQueued();
	assert.equal(monitor.phase, "needsInput");
	monitor.questionResolved();
	assert.equal(monitor.phase, "queued");
});

test("RemoteSessionMonitor restores its previous phase after compaction", () => {
	const monitor = new RemoteSessionMonitor();
	monitor.agentStarted();
	monitor.compactionStarted();
	assert.equal(monitor.phase, "compacting");
	monitor.compactionFinished();
	assert.equal(monitor.phase, "running");
});

test("RemoteSessionMonitor exposes the latest run and resets on a new session", () => {
	const monitor = new RemoteSessionMonitor();
	const summary = { runId: "run_1", status: "completed" };
	monitor.agentSettled(summary);
	assert.equal(monitor.phase, "completed");
	assert.equal(monitor.lastRun, summary);

	monitor.sessionStarted();
	assert.equal(monitor.phase, "idle");
	assert.equal(monitor.lastRun, undefined);
});
