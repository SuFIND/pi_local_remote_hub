import assert from "node:assert/strict";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { registerRemoteQuestionTool } = jiti("../extension/questions/registerRemoteQuestionTool.ts");

function captureTool(broker, hasAuthenticatedClient) {
	let tool;
	registerRemoteQuestionTool({ registerTool: (definition) => { tool = definition; } }, broker, hasAuthenticatedClient);
	return tool;
}

test("remote question tool waits for the QuestionBroker", async () => {
	const calls = [];
	const broker = {
		ask: async (input, signal) => {
			calls.push({ input, signal });
			return { answer: "Simulator", wasCustom: false };
		},
	};
	const tool = captureTool(broker, () => true);
	const controller = new AbortController();
	const result = await tool.execute(
		"tool_1",
		{
			question: "Which target?",
			options: [{ label: "Simulator", description: "Fast feedback" }, { label: "Device" }],
		},
		controller.signal,
		undefined,
		{ hasUI: false, ui: {} },
	);

	assert.equal(tool.name, "remote_question");
	assert.equal(tool.executionMode, "sequential");
	assert.deepEqual(calls, [{
		input: {
			toolCallId: "tool_1",
			question: "Which target?",
			options: [{ label: "Simulator", description: "Fast feedback" }, { label: "Device" }],
		},
		signal: controller.signal,
	}]);
	assert.equal(result.content[0].text, "User selected: Simulator");
	assert.equal(result.details.channel, "remote");
});

test("question tool uses terminal input when no authenticated remote exists", async () => {
	const uiCalls = [];
	const tool = captureTool({ ask: () => assert.fail("remote broker should not be used") }, () => false);
	const result = await tool.execute(
		"tool_2",
		{ question: "Branch name?", options: [] },
		undefined,
		undefined,
		{
			hasUI: true,
			ui: {
				input: async (title, placeholder) => {
					uiCalls.push({ title, placeholder });
					return "feature/mobile";
				},
			},
		},
	);

	assert.deepEqual(uiCalls, [{ title: "Branch name?", placeholder: "Type your answer" }]);
	assert.equal(result.content[0].text, "User wrote: feature/mobile");
	assert.equal(result.details.channel, "terminal");
});
