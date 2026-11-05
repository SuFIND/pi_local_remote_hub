import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { mapPiEvent } = jiti("../extension/pi/eventMapper.ts");

test("mapPiEvent wraps Pi events in a stable payload shape", () => {
	const mapped = mapPiEvent("agent_start", { prompt: "hello", token: "secret" });

	assert.equal(mapped.type, "pi.agent_start");
	assert.equal(mapped.payload.source, "pi");
	assert.equal(mapped.payload.name, "agent_start");
	assert.deepEqual(mapped.payload.data, { prompt: "hello", token: "[redacted]" });
});

test("mapPiEvent drops system-prompt messages and the provider context preview", () => {
	assert.equal(mapPiEvent("message_start", { type: "message_start", message: { role: "system", sections: ["huge"] } }), null);
	assert.equal(mapPiEvent("message_end", { type: "message_end", message: { role: "system" } }), null);
	assert.notEqual(mapPiEvent("message_end", { type: "message_end", message: { role: "assistant", content: [] } }), null);

	const turnEnd = mapPiEvent("turn_end", {
		type: "turn_end",
		turnIndex: 0,
		message: { role: "assistant", content: [] },
		toolResults: [],
		context: { messages: ["x".repeat(30_000)] },
		outcome: "completed",
	});
	assert.equal("context" in turnEnd.payload.data, false);
	assert.equal(turnEnd.payload.data.outcome, "completed");
	assert.deepEqual(turnEnd.payload.data.message, { role: "assistant", content: [] });

	const agentEnd = mapPiEvent("agent_end", {
		type: "agent_end",
		messages: [{ role: "system", sections: [] }, { role: "user", content: "hi" }],
	});
	assert.deepEqual(agentEnd.payload.data.messages, [{ role: "user", content: "hi" }]);
});
