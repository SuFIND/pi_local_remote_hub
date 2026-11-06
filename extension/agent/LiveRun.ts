import type { MirrorSource } from "../hubwire/frames.js";

/**
 * What a terminal shows while another Pi process runs its session (the
 * phone's hub-started Pi, or a second window): the prompt, the streaming
 * reply and the tools, built from mirrored `pi.*` events. Pure, so the
 * widget only maps it to terminal lines.
 */
export type LiveRunItem =
	| { kind: "user"; text: string }
	| { kind: "assistant"; text: string; thinking: boolean }
	| { kind: "tool"; id: string; title: string; status: "running" | "done" | "failed" };

export type LiveRunStyle = {
	header(text: string): string;
	dim(text: string): string;
	user(text: string): string;
	text(text: string): string;
	tool(text: string): string;
	ok(text: string): string;
	failed(text: string): string;
};

export type LiveRunWidth = {
	/** Visible terminal columns of `text`. */
	width(text: string): number;
	/** Cut to `columns` visible columns (with an ellipsis when cut). */
	truncate(text: string, columns: number): string;
	/** Wrap plain text to `columns`. */
	wrap(text: string, columns: number): string[];
};

/** Lines below the header; the widget never grows past this. */
export const LIVE_RUN_MAX_LINES = 10;
const MAX_ITEMS = 40;

export class LiveRun {
	private items: LiveRunItem[] = [];
	private source?: MirrorSource;
	private running = false;
	private finished = false;

	/** True while there is something to show. */
	get visible(): boolean {
		return this.source !== undefined;
	}

	/** Applies one mirrored event; returns true when the view changed. */
	apply(from: MirrorSource, type: string, payload: unknown): boolean {
		if (type === "mirror.stop") {
			const wasVisible = this.visible;
			this.reset();
			return wasVisible;
		}
		this.source = from;
		const data = eventData(payload);
		switch (type) {
			case "mirror.start":
				this.running = true;
				this.finished = false;
				return true;
			case "pi.agent_start":
				this.items = [];
				this.running = true;
				this.finished = false;
				return true;
			case "pi.agent_end":
				this.running = false;
				this.finished = true;
				return true;
			case "pi.message_start":
			case "pi.message_delta":
			case "pi.message_end":
				return this.applyMessage(type, readRecord(data, "message"));
			case "pi.tool_start":
				return this.applyToolStart(data);
			case "pi.tool_end":
				return this.applyToolEnd(data);
			default:
				return false;
		}
	}

	reset(): void {
		this.items = [];
		this.source = undefined;
		this.running = false;
		this.finished = false;
	}

	render(columns: number, style: LiveRunStyle, measure: LiveRunWidth): string[] {
		if (!this.source) return [];
		const width = Math.max(10, columns);
		const who = this.source.background ? "📱 iPhone" : `Pi window ${this.source.pid}`;
		const then = this.source.background ? "this window takes over when it finishes" : "this window reloads when it finishes";
		const state = this.finished ? "finished — loading the latest messages…" : this.running ? `running · ${then}` : "waiting";
		const lines = [measure.truncate(`${style.header(`${who} · live`)} ${style.dim(state)}`, width)];

		const body: string[] = [];
		for (let index = this.items.length - 1; index >= 0 && body.length < LIVE_RUN_MAX_LINES; index--) {
			const itemLines = this.renderItem(this.items[index], width, style, measure);
			body.unshift(...itemLines.slice(-(LIVE_RUN_MAX_LINES - body.length)));
		}
		return [...lines, ...body];
	}

	private renderItem(item: LiveRunItem, width: number, style: LiveRunStyle, measure: LiveRunWidth): string[] {
		const inner = width - 2;
		switch (item.kind) {
			case "user": {
				const first = item.text.split("\n").find((line) => line.trim()) ?? "";
				return [measure.truncate(`${style.user("› ")}${style.user(first.trim())}`, width)];
			}
			case "assistant": {
				if (!item.text.trim()) return item.thinking ? [`  ${style.dim("thinking…")}`] : [];
				const wrapped = item.text
					.trimEnd()
					.split("\n")
					.flatMap((line) => (line ? measure.wrap(line, inner) : [""]));
				return wrapped.map((line) => `  ${style.text(line)}`);
			}
			case "tool": {
				const mark = item.status === "running" ? style.dim("…") : item.status === "done" ? style.ok("✓") : style.failed("✗");
				const title = measure.truncate(item.title, Math.max(4, width - 6));
				return [`  ${style.tool("⏺")} ${style.tool(title)} ${mark}`];
			}
		}
	}

	private applyMessage(type: string, message: Record<string, unknown> | undefined): boolean {
		if (!message) return false;
		const role = message.role;
		if (role === "user") {
			if (type !== "pi.message_start" && type !== "pi.message_end") return false;
			const text = contentText(message.content);
			if (!text.trim()) return false;
			const last = this.items.at(-1);
			if (last?.kind === "user" && last.text === text) return false;
			this.push({ kind: "user", text });
			return true;
		}
		if (role !== "assistant") return false;
		const text = contentText(message.content);
		const thinking = hasThinking(message.content);
		const last = this.items.at(-1);
		if (type === "pi.message_start" || last?.kind !== "assistant") {
			this.push({ kind: "assistant", text, thinking });
		} else {
			last.text = text;
			last.thinking = thinking;
		}
		return true;
	}

	private applyToolStart(data: Record<string, unknown> | undefined): boolean {
		const id = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
		if (!id) return false;
		this.push({ kind: "tool", id, title: toolTitle(data?.toolName, data?.args), status: "running" });
		return true;
	}

	private applyToolEnd(data: Record<string, unknown> | undefined): boolean {
		const id = typeof data?.toolCallId === "string" ? data.toolCallId : undefined;
		const item = this.items.find((entry): entry is Extract<LiveRunItem, { kind: "tool" }> => entry.kind === "tool" && entry.id === id);
		const status = data?.isError === true ? "failed" : "done";
		if (item) {
			item.status = status;
		} else if (id) {
			// Started before this window began watching.
			this.push({ kind: "tool", id, title: toolTitle(data?.toolName, undefined), status });
		} else {
			return false;
		}
		return true;
	}

	private push(item: LiveRunItem): void {
		this.items.push(item);
		if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
	}
}

function eventData(payload: unknown): Record<string, unknown> | undefined {
	return readRecord(payload, "data");
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "object" && field !== null && !Array.isArray(field) ? (field as Record<string, unknown>) : undefined;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function hasThinking(content: unknown): boolean {
	return Array.isArray(content) && content.some((block) => typeof block === "object" && block !== null && block.type === "thinking");
}

function toolTitle(name: unknown, args: unknown): string {
	const tool = typeof name === "string" ? name : "tool";
	const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const firstLine = (value: unknown) => (typeof value === "string" ? (value.split("\n").find((line) => line.trim()) ?? "").trim() : "");
	if (tool === "bash" && record.command !== undefined) return `$ ${firstLine(record.command)}`;
	if (typeof record.path === "string") return `${tool} ${record.path}`;
	const summary = Object.values(record).map(firstLine).find(Boolean);
	return summary ? `${tool} ${summary}` : tool;
}
