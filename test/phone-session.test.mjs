import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { toForwardedEnvelope } = jiti("../hub/PhoneSession.ts");
const { decodeClientMessage } = jiti("../extension/protocol/ProtocolDecoder.ts");

const decode = (value) => decodeClientMessage(Buffer.from(JSON.stringify(value)));

// What the iOS app sends for every command the hub forwards to a Pi process.
const WIRE_COMMANDS = [
	{ type: "interaction.answer", payload: { requestId: "q_1", answer: "Yes" } },
	{ type: "session.getState", payload: {} },
	{ type: "session.history", payload: { limit: 200 } },
	{ type: "session.history", payload: {} },
	{ type: "session.prompt", payload: { message: "hello", delivery: "followUp" } },
	{ type: "session.prompt", payload: { message: "steer it", delivery: "steer" } },
	{ type: "session.abort", payload: {} },
	{ type: "session.compact", payload: {} },
	{ type: "session.listModels", payload: {} },
	{ type: "session.listSkills", payload: {} },
	{ type: "session.setModel", payload: { provider: "anthropic", id: "claude-x" } },
	{ type: "session.setThinkingLevel", payload: { level: "high" } },
];

test("every forwarded command decodes to the same message inside Pi", () => {
	for (const command of WIRE_COMMANDS) {
		const atHub = decode({ id: "req_9", protocolVersion: 1, ...command });
		const forwarded = toForwardedEnvelope(atHub);
		const { id: _forwardedId, ...inPi } = decode(forwarded);
		const { id: _requestId, ...expected } = atHub;
		assert.deepEqual(inPi, expected, command.type);
	}
});

test("auth and hub commands are never forwarded", () => {
	for (const command of [
		{ type: "auth.token", payload: { token: "t" } },
		{ type: "hub.listProjects", payload: {} },
	]) {
		assert.throws(() => toForwardedEnvelope(decode({ protocolVersion: 1, ...command })), /Cannot forward/);
	}
});
