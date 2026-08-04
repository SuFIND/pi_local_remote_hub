import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { QuestionBroker } = jiti("../extension/questions/QuestionBroker.ts");

test("QuestionBroker publishes a bounded question and resolves an option answer", async () => {
	const published = [];
	const resolved = [];
	const broker = new QuestionBroker({
		createID: () => "question_1",
		now: () => new Date("2026-08-04T10:00:00.000Z"),
		timeoutMs: 60_000,
		onQuestion: (question) => published.push(question),
		onResolved: (result) => resolved.push(result),
	});

	const resultPromise = broker.ask({
		toolCallId: "tool_1",
		question: "Which target should I test?",
		options: [
			{ label: "Simulator", description: "Run the simulator suite" },
			{ label: "Device", description: "Run the signed device build" },
		],
	});

	assert.deepEqual(published, [{
		requestId: "question_1",
		toolCallId: "tool_1",
		question: "Which target should I test?",
		options: [
			{ label: "Simulator", description: "Run the simulator suite" },
			{ label: "Device", description: "Run the signed device build" },
		],
		allowsCustomAnswer: true,
		createdAt: "2026-08-04T10:00:00.000Z",
		expiresAt: "2026-08-04T10:01:00.000Z",
	}]);
	assert.deepEqual(broker.current(), published[0]);

	broker.answer("question_1", "Simulator");
	assert.deepEqual(await resultPromise, { answer: "Simulator", wasCustom: false });
	assert.equal(broker.current(), undefined);
	assert.deepEqual(resolved, [{ requestId: "question_1", answer: "Simulator", reason: "answered" }]);
});

test("QuestionBroker accepts a custom answer and rejects stale or empty answers", async () => {
	const broker = new QuestionBroker({
		createID: () => "question_2",
		timeoutMs: 60_000,
	});
	const resultPromise = broker.ask({
		toolCallId: "tool_2",
		question: "What should I call the branch?",
		options: [],
	});

	assert.throws(() => broker.answer("stale", "feature/test"), /no longer pending/i);
	assert.throws(() => broker.answer("question_2", "   "), /answer is required/i);
	broker.answer("question_2", "feature/test");
	assert.deepEqual(await resultPromise, { answer: "feature/test", wasCustom: true });
});

test("QuestionBroker resolves cancellation when the agent aborts", async () => {
	const resolved = [];
	const broker = new QuestionBroker({
		createID: () => "question_3",
		timeoutMs: 60_000,
		onResolved: (result) => resolved.push(result),
	});
	const controller = new AbortController();
	const resultPromise = broker.ask({
		toolCallId: "tool_3",
		question: "Continue?",
		options: [{ label: "Yes" }],
	}, controller.signal);

	controller.abort();
	assert.deepEqual(await resultPromise, { answer: null, wasCustom: false });
	assert.deepEqual(resolved, [{ requestId: "question_3", answer: null, reason: "cancelled" }]);
});
