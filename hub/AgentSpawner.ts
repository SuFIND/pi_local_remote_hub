import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { Logger } from "../extension/logging/logger.js";

export type SpawnTarget = {
	cwd: string;
	/** Existing session file; omitted for a new session. */
	sessionPath?: string;
};

export type SpawnedPi = {
	token: string;
	target: SpawnTarget;
	child: ChildProcess;
	/** Last bytes of stderr, for "Pi failed to start" messages. */
	stderrTail(): string;
	exited: Promise<number | null>;
};

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export type AgentSpawnerOptions = {
	piCommand: string;
	piArgs?: readonly string[];
	logger: Logger;
	env?: NodeJS.ProcessEnv;
	spawn?: SpawnFn;
	/** Grace between closing stdin and SIGTERM / SIGKILL. */
	stopGraceMs?: number;
};

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);
const STDERR_TAIL_BYTES = 4_096;

/**
 * Starts Pi in RPC mode for the phone. The Pi Remote extension inside it
 * registers with the hub (it finds the hub through `PI_REMOTE_SPAWN_TOKEN`
 * and the shared state directory), so this class only manages the process.
 */
export class AgentSpawner {
	private readonly children = new Map<string, SpawnedPi>();
	private readonly spawnFn: SpawnFn;

	constructor(private readonly options: AgentSpawnerOptions) {
		this.spawnFn = options.spawn ?? nodeSpawn;
	}

	start(target: SpawnTarget): SpawnedPi {
		const token = randomBytes(18).toString("base64url");
		const args = [...(this.options.piArgs ?? []), "--mode", "rpc", ...(target.sessionPath ? ["--session", target.sessionPath] : [])];
		const child = this.spawnFn(this.options.piCommand, args, {
			cwd: target.cwd,
			env: { ...(this.options.env ?? process.env), PI_REMOTE_SPAWN_TOKEN: token },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
		});
		this.answerDialogs(child);
		const exited = new Promise<number | null>((resolve) => {
			child.once("exit", (code) => resolve(code));
			child.once("error", (error) => {
				stderr += `\n${error.message}`;
				resolve(null);
			});
		});
		const spawned: SpawnedPi = { token, target, child, stderrTail: () => stderr.trim(), exited };
		this.children.set(token, spawned);
		void exited.then((code) => {
			this.children.delete(token);
			this.options.logger.info("hub_pi_exited", { cwd: target.cwd, session: target.sessionPath, code });
		});
		this.options.logger.info("hub_pi_started", { pid: child.pid, cwd: target.cwd, session: target.sessionPath });
		return spawned;
	}

	get(token: string): SpawnedPi | undefined {
		return this.children.get(token);
	}

	/** Close stdin (Pi's RPC mode exits on EOF), then escalate. */
	async stop(token: string): Promise<void> {
		const spawned = this.children.get(token);
		if (!spawned) return;
		const grace = this.options.stopGraceMs ?? 4_000;
		spawned.child.stdin?.end();
		const term = setTimeout(() => spawned.child.kill("SIGTERM"), grace);
		const kill = setTimeout(() => spawned.child.kill("SIGKILL"), grace * 2);
		await spawned.exited;
		clearTimeout(term);
		clearTimeout(kill);
	}

	async stopAll(): Promise<void> {
		await Promise.all([...this.children.keys()].map((token) => this.stop(token)));
	}

	/**
	 * RPC mode turns extension dialogs into `extension_ui_request` lines on
	 * stdout and waits for an answer. Nobody sits at this "terminal", so
	 * every dialog is cancelled at once instead of hanging the agent; phone
	 * questions go through the `remote_question` tool instead.
	 */
	private answerDialogs(child: ChildProcess): void {
		let buffer = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.includes("extension_ui_request")) continue;
				try {
					const message = JSON.parse(line) as { type?: string; id?: string; method?: string };
					if (message.type === "extension_ui_request" && message.id && DIALOG_METHODS.has(message.method ?? "")) {
						child.stdin?.write(`${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`);
					}
				} catch {
					// not JSON; ignore
				}
			}
			if (buffer.length > 1_000_000) buffer = "";
		});
	}
}
