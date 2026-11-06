import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type TUI } from "@earendil-works/pi-tui";
import type { MirrorSource } from "../hubwire/frames.js";
import { LiveRun, type LiveRunStyle, type LiveRunWidth } from "./LiveRun.js";

const WIDGET_KEY = "pi-remote-live";

const MEASURE: LiveRunWidth = {
	width: visibleWidth,
	truncate: (text, columns) => truncateToWidth(text, columns),
	wrap: (text, columns) => wrapTextWithAnsi(text, columns),
};

/**
 * The widget above the editor that shows another Pi process's run on this
 * session (see `LiveRun`). Mounted on the first mirrored event, re-rendered
 * through the TUI on every change, removed on `mirror.stop` or `clear()`.
 */
export class LiveRunWidget {
	private readonly run = new LiveRun();
	private tui?: TUI;
	private mounted = false;

	constructor(private readonly ui: Pick<ExtensionUIContext, "setWidget">) {}

	handle(from: MirrorSource, type: string, payload: unknown): void {
		if (!this.run.apply(from, type, payload)) return;
		if (!this.run.visible) {
			this.unmount();
		} else if (!this.mounted) {
			this.mount();
		} else {
			this.tui?.requestRender();
		}
	}

	clear(): void {
		this.run.reset();
		this.unmount();
	}

	private mount(): void {
		this.mounted = true;
		this.ui.setWidget(WIDGET_KEY, (tui: TUI, theme: Theme) => {
			this.tui = tui;
			const style = styleFor(theme);
			return { render: (width: number) => this.run.render(width, style, MEASURE), invalidate: () => {} };
		});
	}

	private unmount(): void {
		if (!this.mounted) return;
		this.mounted = false;
		this.tui = undefined;
		this.ui.setWidget(WIDGET_KEY, undefined);
	}
}

function styleFor(theme: Theme): LiveRunStyle {
	return {
		header: (text) => theme.fg("accent", theme.bold(text)),
		dim: (text) => theme.fg("dim", text),
		user: (text) => theme.fg("muted", text),
		text: (text) => theme.fg("text", text),
		tool: (text) => theme.fg("toolTitle", text),
		ok: (text) => theme.fg("success", text),
		failed: (text) => theme.fg("error", text),
	};
}
