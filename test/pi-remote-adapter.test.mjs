import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url);
const { PiRemoteAdapter } = jiti("../extension/pi/PiRemoteAdapter.ts");
const { RemoteSessionMonitor } = jiti("../extension/session/RemoteSessionMonitor.ts");

test("PiRemoteAdapter lists only skill commands without exposing source paths", () => {
	const adapter = new PiRemoteAdapter({
		getCommands: () => [
			{
				name: "review",
				description: "Review changes",
				source: "extension",
				sourceInfo: { path: "/private/extensions/review.ts", source: "review", scope: "user" },
			},
			{
				name: "skill:zeta",
				description: "Run zeta",
				source: "skill",
				sourceInfo: { path: "/private/skills/zeta/SKILL.md", source: "zeta", scope: "user" },
			},
			{
				name: "skill:alpha",
				description: "Run alpha",
				source: "skill",
				sourceInfo: { path: "/private/skills/alpha/SKILL.md", source: "alpha", scope: "project" },
			},
		],
	});

	assert.deepEqual(adapter.listSkills(), {
		skills: [
			{ name: "skill:alpha", description: "Run alpha" },
			{ name: "skill:zeta", description: "Run zeta" },
		],
	});
});

test("PiRemoteAdapter expands an explicit skill before sending it to Pi", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-remote-skill-"));
	const skillPath = join(directory, "SKILL.md");
	writeFileSync(skillPath, "---\nname: diagnose\ndescription: Diagnose bugs\n---\n\n# Diagnose\n\nReproduce before fixing.\n");
	const sent = [];
	const adapter = new PiRemoteAdapter({
		getCommands: () => [{
			name: "skill:diagnose",
			description: "Diagnose bugs",
			source: "skill",
			sourceInfo: { path: skillPath, source: "diagnose", scope: "user", baseDir: directory },
		}],
		sendUserMessage: (message, options) => sent.push({ message, options }),
	});

	await adapter.prompt("/skill:diagnose inspect this crash", "auto");

	assert.deepEqual(sent, [{
		message: `<skill name="diagnose" location="${skillPath}">\nReferences are relative to ${directory}.\n\n# Diagnose\n\nReproduce before fixing.\n</skill>\n\ninspect this crash`,
		options: undefined,
	}]);
});

test("PiRemoteAdapter marks follow-up prompts queued but leaves steer running", async () => {
	const sent = [];
	const monitor = new RemoteSessionMonitor();
	monitor.agentStarted();
	const adapter = new PiRemoteAdapter({
		getCommands: () => [],
		sendUserMessage: (message, options) => sent.push({ message, options }),
		exec: async () => ({ stdout: "main\n", stderr: "", code: 0, killed: false }),
	}, monitor);
	adapter.captureContext({
		cwd: "/tmp/project",
		isIdle: () => false,
		hasPendingMessages: () => false,
		getContextUsage: () => ({ percent: 10 }),
		model: undefined,
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionName: () => undefined,
			getEntries: () => [],
			getLeafId: () => undefined,
		},
	});
	await adapter.refreshExecutionContext();

	await adapter.prompt("Run tests next", "followUp");
	assert.equal(monitor.phase, "queued");
	monitor.agentStarted();
	await adapter.prompt("Inspect the current failure first", "steer");
	assert.equal(monitor.phase, "running");
	assert.deepEqual(sent, [
		{ message: "Run tests next", options: { deliverAs: "followUp" } },
		{ message: "Inspect the current failure first", options: { deliverAs: "steer" } },
	]);
	assert.equal(adapter.getState().branch, "main");
	assert.equal(typeof adapter.getState().host, "string");
});
