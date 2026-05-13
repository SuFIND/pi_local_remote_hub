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
