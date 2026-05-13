import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { decodeClientMessage } = jiti("../extension/protocol/ProtocolDecoder.ts");
const { ProtocolError } = jiti("../extension/protocol/errors.ts");

function frame(value) {
	return Buffer.from(JSON.stringify(value), "utf8");
}

test("ProtocolDecoder decodes auth.pair.request", () => {
	const message = decodeClientMessage(frame({
		id: "pair_1",
		type: "auth.pair.request",
		protocolVersion: 1,
		payload: { code: "123456", deviceName: "iPhone" },
	}));

	assert.deepEqual(message, {
		kind: "auth.pair.request",
		id: "pair_1",
		code: "123456",
		deviceName: "iPhone",
	});
});

test("ProtocolDecoder decodes session.prompt with default delivery", () => {
	const message = decodeClientMessage(frame({
		id: "prompt_1",
		type: "session.prompt",
		protocolVersion: 1,
		payload: { message: "Run tests" },
	}));

	assert.deepEqual(message, {
		kind: "session.prompt",
		id: "prompt_1",
		message: "Run tests",
		delivery: "auto",
	});
});

test("ProtocolDecoder rejects malformed JSON", () => {
	assert.throws(() => decodeClientMessage(Buffer.from("{")), (error) => {
		assert.equal(error instanceof ProtocolError, true);
		assert.equal(error.code, "BAD_REQUEST");
		return true;
	});
});

test("ProtocolDecoder rejects unsupported protocol versions", () => {
	assert.throws(() => decodeClientMessage(frame({ type: "connection.ping", protocolVersion: 999 })), (error) => {
		assert.equal(error instanceof ProtocolError, true);
		assert.equal(error.code, "PROTOCOL_VERSION_UNSUPPORTED");
		return true;
	});
});

test("ProtocolDecoder decodes session.history with limit", () => {
	const message = decodeClientMessage(frame({
		id: "hist_1",
		type: "session.history",
		protocolVersion: 1,
		payload: { limit: 50 },
	}));

	assert.deepEqual(message, { kind: "session.history", id: "hist_1", limit: 50 });
});

test("ProtocolDecoder decodes session.history without limit", () => {
	const message = decodeClientMessage(frame({
		id: "hist_2",
		type: "session.history",
		protocolVersion: 1,
		payload: {},
	}));

	assert.deepEqual(message, { kind: "session.history", id: "hist_2", limit: undefined });
});

test("ProtocolDecoder clamps session.history limit", () => {
	const message = decodeClientMessage(frame({
		type: "session.history",
		protocolVersion: 1,
		payload: { limit: 99999 },
	}));

	assert.equal(message.kind, "session.history");
	assert.equal(message.limit, 1000);
});

test("ProtocolDecoder rejects malformed command payloads", () => {
	assert.throws(() => decodeClientMessage(frame({
		id: "prompt_1",
		type: "session.prompt",
		protocolVersion: 1,
		payload: { message: "" },
	})), (error) => {
		assert.equal(error instanceof ProtocolError, true);
		assert.equal(error.code, "BAD_REQUEST");
		return true;
	});
});
