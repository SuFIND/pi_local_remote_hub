import { randomUUID } from "node:crypto";
import { ProtocolError } from "../protocol/errors.js";

const MAX_QUESTION_LENGTH = 2_000;
const MAX_OPTIONS = 12;
const MAX_OPTION_LABEL_LENGTH = 500;
const MAX_OPTION_DESCRIPTION_LENGTH = 1_000;
const MAX_ANSWER_LENGTH = 8_000;

export type RemoteQuestionOption = {
	label: string;
	description?: string;
};

export type RemoteQuestion = {
	requestId: string;
	toolCallId: string;
	question: string;
	options: RemoteQuestionOption[];
	allowsCustomAnswer: true;
	createdAt: string;
	expiresAt: string;
};

export type RemoteQuestionAnswer = {
	answer: string | null;
	wasCustom: boolean;
};

export type RemoteQuestionResolution = {
	requestId: string;
	answer: string | null;
	reason: "answered" | "cancelled" | "timeout" | "remoteStopped";
};

type AskInput = {
	toolCallId: string;
	question: string;
	options: RemoteQuestionOption[];
};

type BrokerOptions = {
	createID?: () => string;
	now?: () => Date;
	timeoutMs?: number;
	onQuestion?: (question: RemoteQuestion) => void;
	onResolved?: (resolution: RemoteQuestionResolution) => void;
};

type PendingQuestion = {
	question: RemoteQuestion;
	resolve: (answer: RemoteQuestionAnswer) => void;
	timer: NodeJS.Timeout;
	abortSignal?: AbortSignal;
	abortHandler?: () => void;
};

/** Owns the one blocking remote question allowed by sequential tool execution. */
export class QuestionBroker {
	private readonly createID: () => string;
	private readonly now: () => Date;
	private readonly timeoutMs: number;
	private readonly onQuestion?: BrokerOptions["onQuestion"];
	private readonly onResolved?: BrokerOptions["onResolved"];
	private pending?: PendingQuestion;

	constructor(options: BrokerOptions = {}) {
		this.createID = options.createID ?? (() => `question_${randomUUID()}`);
		this.now = options.now ?? (() => new Date());
		this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
		this.onQuestion = options.onQuestion;
		this.onResolved = options.onResolved;
	}

	current(): RemoteQuestion | undefined {
		return this.pending?.question;
	}

	ask(input: AskInput, signal?: AbortSignal): Promise<RemoteQuestionAnswer> {
		if (this.pending) throw new Error("Another question is already pending");
		const createdAt = this.now();
		const question = normalizeQuestion(input, this.createID(), createdAt, this.timeoutMs);

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.settle({ answer: null, wasCustom: false }, "timeout");
			}, this.timeoutMs);
			timer.unref?.();

			const abortHandler = () => {
				this.settle({ answer: null, wasCustom: false }, "cancelled");
			};
			this.pending = { question, resolve, timer, abortSignal: signal, abortHandler };
			if (signal?.aborted) abortHandler();
			else signal?.addEventListener("abort", abortHandler, { once: true });
			if (this.pending) this.onQuestion?.(question);
		});
	}

	answer(requestId: string, rawAnswer: string): void {
		const pending = this.pending;
		if (!pending || pending.question.requestId !== requestId) {
			throw new ProtocolError("BAD_REQUEST", "Question is no longer pending");
		}
		const answer = rawAnswer.trim();
		if (!answer) throw new ProtocolError("BAD_REQUEST", "Answer is required");
		if (answer.length > MAX_ANSWER_LENGTH) {
			throw new ProtocolError("BAD_REQUEST", `Answer must be ${MAX_ANSWER_LENGTH} characters or fewer`);
		}
		const wasCustom = !pending.question.options.some((option) => option.label === answer);
		this.settle({ answer, wasCustom }, "answered");
	}

	cancelAll(reason: "remoteStopped" = "remoteStopped"): void {
		if (!this.pending) return;
		this.settle({ answer: null, wasCustom: false }, reason);
	}

	private settle(answer: RemoteQuestionAnswer, reason: RemoteQuestionResolution["reason"]): void {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		clearTimeout(pending.timer);
		if (pending.abortHandler) pending.abortSignal?.removeEventListener("abort", pending.abortHandler);
		this.onResolved?.({ requestId: pending.question.requestId, answer: answer.answer, reason });
		pending.resolve(answer);
	}
}

function normalizeQuestion(input: AskInput, requestId: string, createdAt: Date, timeoutMs: number): RemoteQuestion {
	const question = input.question.trim().slice(0, MAX_QUESTION_LENGTH);
	if (!question) throw new Error("Question is required");
	const options = input.options.slice(0, MAX_OPTIONS).flatMap((option) => {
		const label = option.label.trim().slice(0, MAX_OPTION_LABEL_LENGTH);
		if (!label) return [];
		const description = option.description?.trim().slice(0, MAX_OPTION_DESCRIPTION_LENGTH);
		return [{ label, ...(description ? { description } : {}) }];
	});
	return {
		requestId,
		toolCallId: input.toolCallId,
		question,
		options,
		allowsCustomAnswer: true,
		createdAt: createdAt.toISOString(),
		expiresAt: new Date(createdAt.getTime() + timeoutMs).toISOString(),
	};
}
