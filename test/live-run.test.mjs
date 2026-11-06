import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { LiveRun, LIVE_RUN_MAX_LINES } = jiti("../extension/agent/LiveRun.ts");

const plain = { header: (t) => t, dim: (t) => t, user: (t) => t, text: (t) => t, tool: (t) => t, ok: (t) => t, failed: (t) => t };
const measure = {
	width: (t) => t.length,
	truncate: (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t),
	wrap: (t, n) => (t.match(new RegExp(`.{1,${n}}`, "g")) ?? [""]),
};
const phone = { pid: 7, background: true };
const ev = (name, data) => ({ source: "pi", name, data });
const assistant = (text) => ({ message: { role: "assistant", content: [{ type: "text", text }] } });

test("a live run shows the prompt, the streaming reply and tools", () => {
	const run = new LiveRun();
	assert.equal(run.visible, false);
	run.apply(phone, "pi.agent_start", ev("agent_start", {}));
	run.apply(phone, "pi.message_start", ev("message_start", { message: { role: "user", content: [{ type: "text", text: "fix the tests\nplease" }] } }));
	run.apply(phone, "pi.message_start", ev("message_start", assistant("")));
	run.apply(phone, "pi.message_delta", ev("message_update", assistant("Looking")));
	run.apply(phone, "pi.message_delta", ev("message_update", assistant("Looking at it")));
	run.apply(phone, "pi.message_end", ev("message_end", assistant("Looking at it.")));
	run.apply(phone, "pi.tool_start", ev("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "npm test\n--watch" } }));
	run.apply(phone, "pi.tool_start", ev("tool_execution_start", { toolCallId: "b", toolName: "read", args: { path: "src/app.ts" } }));
	run.apply(phone, "pi.tool_end", ev("tool_execution_end", { toolCallId: "a", toolName: "bash", isError: true }));
	run.apply(phone, "pi.tool_end", ev("tool_execution_end", { toolCallId: "b", toolName: "read", isError: false }));
	assert.deepEqual(run.render(80, plain, measure), [
		"📱 iPhone · live running · this window takes over when it finishes",
		"› fix the tests",
		"  Looking at it.",
		"  ⏺ $ npm test ✗",
		"  ⏺ read src/app.ts ✓",
	]);
	run.apply(phone, "pi.agent_end", ev("agent_end", {}));
	assert.match(run.render(80, plain, measure)[0], /finished — loading the latest messages/);
	assert.equal(run.apply(phone, "mirror.stop"), true);
	assert.equal(run.visible, false);
	assert.deepEqual(run.render(80, plain, measure), []);
});

test("a live run keeps only the newest lines and fits the width", () => {
	const run = new LiveRun();
	run.apply({ pid: 42, background: false }, "mirror.start");
	run.apply({ pid: 42, background: false }, "pi.message_start", ev("message_start", assistant(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"))));
	const lines = run.render(20, plain, measure);
	assert.equal(lines.length, 1 + LIVE_RUN_MAX_LINES);
	assert.match(lines[0], /^Pi window 42/);
	assert.equal(lines.at(-1), "  line 29");
	assert.ok(lines.every((line) => line.length <= 20));
});

test("a tool that started before watching still shows when it ends", () => {
	const run = new LiveRun();
	run.apply(phone, "pi.tool_end", ev("tool_execution_end", { toolCallId: "z", toolName: "edit" }));
	assert.deepEqual(run.render(40, plain, measure).slice(1), ["  ⏺ edit ✓"]);
});
