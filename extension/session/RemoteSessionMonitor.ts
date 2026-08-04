import type { RemoteRunEvidence } from "./RunEvidenceCollector.js";

export type RemoteSessionPhase = "idle" | "running" | "queued" | "compacting" | "needsInput" | "completed" | "failed";

/**
 * Small state machine for the session-level status shown by remote clients.
 * Pi events remain authoritative; command handlers only mark queued input.
 */
export class RemoteSessionMonitor {
	private currentPhase: RemoteSessionPhase = "idle";
	private phaseBeforeInterruption: RemoteSessionPhase = "running";
	private latestRun?: RemoteRunEvidence;

	get phase(): RemoteSessionPhase {
		return this.currentPhase;
	}

	get lastRun(): RemoteRunEvidence | undefined {
		return this.latestRun;
	}

	sessionStarted(): void {
		this.currentPhase = "idle";
		this.phaseBeforeInterruption = "running";
		this.latestRun = undefined;
	}

	agentStarted(): void {
		this.currentPhase = "running";
	}

	promptQueued(): void {
		if (this.currentPhase === "needsInput" || this.currentPhase === "compacting") {
			this.phaseBeforeInterruption = "queued";
			return;
		}
		if (this.currentPhase === "running" || this.currentPhase === "queued") {
			this.currentPhase = "queued";
		}
	}

	questionOpened(): void {
		if (this.currentPhase !== "needsInput") this.phaseBeforeInterruption = this.currentPhase;
		this.currentPhase = "needsInput";
	}

	questionResolved(): void {
		if (this.currentPhase !== "needsInput") return;
		this.currentPhase = this.phaseBeforeInterruption === "idle" || this.phaseBeforeInterruption === "completed"
			? "running"
			: this.phaseBeforeInterruption;
	}

	compactionStarted(): void {
		if (this.currentPhase !== "compacting") this.phaseBeforeInterruption = this.currentPhase;
		this.currentPhase = "compacting";
	}

	compactionFinished(): void {
		if (this.currentPhase !== "compacting") return;
		this.currentPhase = this.phaseBeforeInterruption === "idle" ? "running" : this.phaseBeforeInterruption;
	}

	agentSettled(summary: RemoteRunEvidence): void {
		this.latestRun = summary;
		this.currentPhase = summary.status === "failed" ? "failed" : "completed";
	}
}
