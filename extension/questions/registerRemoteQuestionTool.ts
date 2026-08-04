import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { QuestionBroker, RemoteQuestionAnswer, RemoteQuestionOption } from "./QuestionBroker.js";

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: 500, description: "Display label for this answer" }),
	description: Type.Optional(Type.String({ maxLength: 1_000, description: "Short consequence or explanation" })),
});

const QuestionSchema = Type.Object({
	question: Type.String({ minLength: 1, maxLength: 2_000, description: "The blocking question to ask" }),
	options: Type.Optional(Type.Array(OptionSchema, { maxItems: 12, description: "Suggested answers; omit for free text" })),
});

type QuestionToolDetails = {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom: boolean;
	channel: "remote" | "terminal" | "unavailable";
};

export function registerRemoteQuestionTool(
	pi: ExtensionAPI,
	broker: QuestionBroker,
	shouldAskRemotely: () => boolean,
): void {
	pi.registerTool({
		name: "remote_question",
		label: "Remote question",
		description: "Ask the user one blocking question. Use this only when work cannot continue safely without a user decision.",
		promptSnippet: "Ask the user a blocking question with suggested answers.",
		promptGuidelines: [
			"Use question only when a missing user decision blocks progress; continue independently when the answer can be inferred safely.",
			"Keep suggested answers concrete and explain consequences in their descriptions.",
		],
		parameters: QuestionSchema,
		executionMode: "sequential",

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const options = params.options ?? [];
			const channel = shouldAskRemotely() ? "remote" : ctx.hasUI ? "terminal" : "unavailable";
			let result: RemoteQuestionAnswer;
			if (channel === "remote") {
				if (ctx.hasUI) ctx.ui.notify("Waiting for an answer in Pi Remote", "info");
				result = await broker.ask({ toolCallId, question: params.question, options }, signal);
			} else if (channel === "terminal") {
				result = await askInTerminal(ctx, params.question, options);
			} else {
				result = { answer: null, wasCustom: false };
			}

			const details: QuestionToolDetails = {
				question: params.question,
				options: options.map((option) => option.label),
				answer: result.answer,
				wasCustom: result.wasCustom,
				channel,
			};
			if (!result.answer) {
				return {
					content: [{ type: "text", text: channel === "unavailable" ? "No interactive user is available." : "The user did not answer." }],
					details,
				};
			}
			return {
				content: [{ type: "text", text: result.wasCustom ? `User wrote: ${result.answer}` : `User selected: ${result.answer}` }],
				details,
			};
		},
	});
}

async function askInTerminal(
	ctx: ExtensionContext,
	question: string,
	options: RemoteQuestionOption[],
): Promise<RemoteQuestionAnswer> {
	if (options.length === 0) {
		const answer = (await ctx.ui.input(question, "Type your answer"))?.trim() || null;
		return { answer, wasCustom: answer !== null };
	}

	const customLabel = "Write another answer…";
	const selected = await ctx.ui.select(question, [...options.map((option) => option.label), customLabel]);
	if (!selected) return { answer: null, wasCustom: false };
	if (selected !== customLabel) return { answer: selected, wasCustom: false };
	const answer = (await ctx.ui.input(question, "Type your answer"))?.trim() || null;
	return { answer, wasCustom: answer !== null };
}
