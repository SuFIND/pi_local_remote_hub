# AGENTS.md — Project orientation

This file is the entry point for any agent working on `pi_local_remote_hub`, the computer side of Pi Local Remote. Read it first. The iOS app is the sibling repository `pi_local_remote_ios` (https://github.com/SuFIND/pi_local_remote_ios), normally checked out next to this one as `../pi_local_remote_ios`. Both started as a fork of [pi-remote-ios](https://github.com/tornikegomareli/pi-remote-ios) by Tornike Gomareli; keep his commits and the MIT copyright notice. For deeper specs see `Systems.md`, `PLAN.md`, and `docs/`. `CLAUDE.md` is a symlink to this file, so Claude Code and other agents read identical instructions — edit only `AGENTS.md`.

## What this project is

A system that lets a paired iOS app control the Pi (`@earendil-works/pi-coding-agent`) sessions on a Mac over the LAN:

1. **Pi Remote Hub** (`hub/`) — one resident Node process per Mac (run by the Pi Hub menu bar app, `node hub/bin.mjs run`, or a launchd agent via `install`). Owns the TLS WebSocket server, Bonjour, pairing and trusted devices; keeps a registry of every running Pi over a local Unix socket; lets the phone browse the shared folders (`hub.json` `roots`), open any saved session, and starts `pi --mode rpc --session …` for it on demand (exits again after `idleExitMinutes`, default 3).
2. **TypeScript Pi extension** (`extension/`) — loaded into every `pi` process. Registers its session with the hub (`HubLink`), runs forwarded commands against the live session, streams Pi events back, and provides `/remote pair|status|devices|revoke|rotate|takeover`. It never listens on the network.
3. **iOS app** — in `pi_local_remote_ios`, not here. Native SwiftUI app built on **The Composable Architecture (TCA)**. Pairs once with the hub, then picks a session and drives it: send prompts, abort, compact, observe streaming assistant output and tool calls. It implements the client side of `docs/PROTOCOL.md`.
4. **Pi Hub menu bar app** (`mac/PiHub`, SwiftPM, macOS 26+, Liquid Glass) — runs `node hub/bin.mjs run` as its child (restart with backoff 1/2/5/10/30 s; quitting stops it; an already-running hub is only observed) and shows the hub's `overview` polled every 2 s over `hub.sock`: the menu bar "P" opens a short panel (paired / in-use iPhone counts, Pair iPhone), and a settings window (`Window` scene: General, Shared Folders, iPhones, Pi Sessions) holds the rest. Built into `mac/build/Pi Hub.app` by `scripts/build-mac-app.mjs`.

User flow:

```
$ node hub/bin.mjs roots add ~/code    # share a folder with the phone
$ node hub/bin.mjs install             # hub at login (launchd); or `run` in the foreground
$ node hub/bin.mjs pair                # (or /remote pair in any Pi window) prints status,
                                       # 6-digit code and a QR deep link pi-remote://pair?url=…&code=…

iPhone: scan QR (or tap the Mac under Nearby) → pairs; the URL carries the certificate pin (#fp=…)
                                       # hub returns a one-time device token → iOS Keychain

iPhone: pick folder → session (terminal / background / stopped) or New session
iPhone: type prompt → Send             # phone → hub → owning Pi process → LLM → streaming back
```

Every `pi` window registers with the hub by itself (start order does not matter); `PI_REMOTE_DISABLE=1` opts a process out. One writer per session: a terminal opening a session that a hub-started Pi holds takes it over (at once if idle, else after the run, then reloads via `/remote takeover`). While it waits, the hub mirrors the busy Pi's events (`mirror` frames) to the terminal, which shows them in a live widget above the editor; two terminals on one session file mirror each other, and the idle one reloads when the other's run ends.

## Repository layout

```
pi_local_remote_hub/
├── hub/                    Pi Remote Hub (resident LAN server)
│   ├── bin.mjs, main.ts    CLI: run | install | uninstall | status | pair | devices | revoke | roots | idle
│   ├── HubService.ts       composition: TLS server + Bonjour + trust + AgentHub + spawner + idle exit
│   ├── AgentHub.ts         Unix-socket registry of Pi processes, request routing, follow/handoff
│   ├── PhoneSession.ts     one phone: auth, hub.* browsing, attach, wake stopped sessions
│   ├── AgentSpawner.ts     `pi --mode rpc` child processes (dialogs auto-cancelled)
│   ├── SessionCatalog.ts, SessionIndex.ts  folders/sessions under the roots; incremental JSONL index
│   ├── HubConfig.ts        hub.json (roots, idleExitMinutes, port, piCommand, piArgs)
│   └── launchd.ts, controlClient.ts
├── mac/PiHub/              Pi Hub menu bar app (SwiftPM; `swift test --package-path mac/PiHub`)
│   ├── Sources/PiHubCore/  HubOverview (overview JSON), HubControlClient (hub.sock), HubLaunchConfig, HubFormatting
│   └── Sources/PiHub/      PiHubApp (MenuBarExtra + settings Window), HubModel, HubSupervisor (child hub), MenuView (panel), SettingsView, PairingPanel, Components (shared views, MenuBarIcon), MenuSnapshot (DEBUG)
├── extension/              TypeScript Pi extension (runs in every Pi process)
│   ├── index.ts            entry point: HubLink per session, event stream, remote_question
│   ├── command.ts          /remote command (talks to the hub's control ops)
│   ├── agent/              HubLink (Unix socket to the hub) + SessionCommands (forwarded commands) + LiveRun/LiveRunWidget (mirrored run)
│   ├── hubwire/            NDJSON frames between hub and Pi processes
│   ├── config.ts           defaults + env overrides
│   ├── runtime/            RemoteControlRuntime (listen/stop/status/rotate, LAN follow, Bonjour) — used by the hub
│   ├── server/             HTTP + WebSocket upgrade lifecycle — used by the hub
│   ├── connections/        RemoteConnection (socket lifecycle; protocol via a ConnectionSession)
│   ├── auth/               DeviceTrust + PairingManager + TokenStore + TrustStore (shared trust file) + crypto
│   ├── identity/           self-signed TLS host certificate + fingerprint (HostIdentity, certificate)
│   ├── net/                LAN address selection/peer filter + Bonjour advertiser (dns-sd)
│   ├── storage.ts          ~/.pi/agent/pi-remote state dir (PI_REMOTE_STATE_DIR)
│   ├── protocol/           wire envelopes + ProtocolDecoder + capabilities + error codes
│   ├── pi/                 PiRemoteAdapter (seam around ExtensionAPI) + sanitizer + editPayload (unified-diff extraction/synthesis) + history (4 MiB budget)
│   ├── events/             RemoteEventStream (Pi event subscription + broadcast)
│   ├── questions/          remote_question tool + reconnect-safe QuestionBroker
│   ├── session/            structured phase monitor + run evidence collector
│   └── logging/            structured logger
│
├── test/                   Node test suite (decoder/auth/session index/hub integration)
│
├── docs/
│   ├── PROTOCOL.md         full wire protocol spec
│   ├── SECURITY.md         threat model + security invariants
│   ├── RELEASE_CHECKLIST.md
│   └── API.md              short index
│
├── AGENTS.md               this file — project orientation, rules, conventions
├── CLAUDE.md               symlink → AGENTS.md (do not edit directly)
├── Systems.md              expanded system prompt for agents
├── PLAN.md                 architecture plan + phase status
├── CONTEXT.md              domain glossary
└── README.md
```

Planned: a Windows tray app next to `mac/` (e.g. `windows/PiHub`) that runs the same hub.

Recommended local checkout:

```
pi_local_remote/
├── pi_local_remote_hub/    this repository
└── pi_local_remote_ios/    iOS app (its scripts/run-e2e.mjs uses ../pi_local_remote_hub)
```

## TypeScript extension

### Module map

| Module | Owns |
|---|---|
| `HubService` | The hub: composes `RemoteServer` + `RemoteControlRuntime` + `DeviceTrust` + `AgentHub` + `AgentSpawner` + `SessionCatalog`; control ops (`status`, `pair` (+ `pairingLink`), `devices`, `revoke`, `rotate`, and for the menu bar app `overview`, `addRoot`, `removeRoot`, `setIdle`, `stopAgent` — hub-started Pi only; root and idle changes are saved to `hub.json`); idle exit of hub-started Pi; LAN listen retry. |
| `HubSupervisor` (Swift) | The menu bar app's child hub: `node <checkout>/hub/bin.mjs run` with the PATH recorded at build time, log appended to `hub.log`, restart with backoff when it exits on its own, SIGTERM then SIGKILL on quit. Leaves a hub that answers on `hub.sock` alone (external). |
| `HubModel` (Swift) | Polls `overview` every 2 s, keeps the supervisor reconciled, runs the menu's and settings window's control requests, tracks the open pairing window and settings pane, Open at Login (`SMAppService.mainApp`). The settings window switches the app to a regular (Dock) app while open. |
| `AgentHub` | Unix socket (`hub.sock`, 0600). Registers Pi processes (`hello`), routes phone requests (`request`/`reply` with per-request ids), fans events out to attached phones, replays an open question on attach, follows a Pi window across session switches (same pid re-registers), and enforces one writer per session (idle handoff at once, busy handoff after the run). Mirrors a busy writer's `pi.*` events to watching terminals (`mirror.start`/`mirror.stop` around them). |
| `PhoneSession` | One phone connection: auth, `hub.listProjects/listSessions/recentSessions/searchSessions/listFolders/openSession/newSession/detach`, roots checks, answers stopped sessions from disk, wakes Pi on demand. |
| `AgentSpawner` | Starts `pi [piArgs] --mode rpc [--session f]` with `PI_REMOTE_SPAWN_TOKEN`, cancels RPC dialog requests, stops via stdin EOF → SIGTERM → SIGKILL. |
| `SessionIndex` | Incremental, read-only index of Pi's session JSONL files (per-file size/mtime/offset; parses appended bytes only). Results match `SessionManager.listAll`, plus each session's user prompts (newest 32 KiB) for search. |
| `SessionCatalog` | The index filtered to the roots and merged with live Pi: projects, a folder's sessions, recent (running + newest stopped), and ranked search (name > first message > folder > prompts, every term required, quoted snippet). |
| `HubProjectTree` (Swift) | Nests `hub.listProjects` into the folder tree the phone shows: nodes hang under their nearest listed ancestor, so folders without sessions fold into their child's label. |
| `HubLink` | Extension side of the hub socket: hello with session + state, reconnect every 3 s, control requests, viewer count, notices (`handoffReady` and `reload` trigger `/remote takeover`), `mirror` frames for the live widget. |
| `LiveRun` / `LiveRunWidget` | Pure model of a mirrored run (last 10 lines, 40 items) and its pi-tui widget (`pi-remote-live`) above a terminal's editor while another Pi writes the session. |
| `selectHistory` | Newest `session.history` entries within the 4 MiB budget, used for live and stopped sessions alike. |
| `SessionCommands` | Executes forwarded `session.*` / `interaction.answer` against `PiRemoteAdapter` + `QuestionBroker` inside the owning Pi process. |
| `RemoteControlRuntime` | `start`/`stop`/`getStatus`/`rotateTrust`/`revokeDevice` for the hub's listener. Follows LAN address changes and keeps Bonjour in sync. |
| `DeviceTrust` | Pairing window, code validation, token issue/verify, trusted device list, revocation. Wraps internal `PairingManager` + `TokenStore` over a `TrustStore`. |
| `TrustStore` | `FileTrustStore` persists `{secret, devices[tokenHash…]}` to the shared, re-read-on-every-call `trusted-devices.json` (0600; corrupt → moved aside, fail closed). `MemoryTrustStore` for tests. |
| `HostIdentity` | Loads or creates the shared self-signed ECDSA P-256 TLS identity and computes its pin (`certificateFingerprint`). |
| `lanAddress` | Picks the private LAN IPv4 to bind (`--host auto`) and filters peers to private/loopback ranges. |
| `BonjourAdvertiser` | Registers `_pi-remote._tcp` via a watchdogged `dns-sd -R` child (macOS only) with TXT `v, fp, host, port, path, proj, cwd`. |
| `ProtocolDecoder` | Decodes raw WebSocket frames into typed `ClientMessage`. Validates protocolVersion, type, payload shape. |
| `RemoteConnection` | One client's WebSocket lifecycle only — hello, frame receive, heartbeat, auth timeout, close cleanup. Delegates protocol to a `ConnectionSession` (the hub's `PhoneSession`). |
| `RemoteServer` | HTTPS (TLS ≥ 1.2) + WebSocket upgrade server, peer-address filter, connection registry, sequence numbers, per-device disconnect. Sessions come from a `createSession` factory. |
| `PiRemoteAdapter` | Seam around Pi's active session operations. Owns state/history, prompt delivery, model/thinking changes, abort, compact, and execution context. Registration modules use only Pi's command, tool, or event registration surfaces. |
| `RemoteEventStream` | Subscribes to Pi events (`message_*`, `tool_execution_*`, `agent_*`, …), maps to stable `pi.*` types, broadcasts only to authenticated clients, drives structured phase changes, and emits run completion evidence after `agent_settled`. Also attaches edit/write diffs to matching `pi.tool_end` events. |
| `editPayload` | Pure helper: `extractEditPayload(toolResultEvent)` lifts Pi's own diff for `edit`, `synthesizeWriteDiff(toolResultEvent)` builds an all-added `/dev/null` diff for `write`. Both bypass the sanitizer's 20K-char cap on the `diff` field so the iOS app can render whole diffs; diffs over 4 MiB are dropped (the run still reports the edit). |
| `QuestionBroker` | Owns one bounded pending `remote_question`, restores it after token reconnect, and resolves answer, abort, timeout, or server stop. |
| `RemoteSessionMonitor` | Tracks `idle`, `running`, `queued`, `compacting`, `needsInput`, `completed`, and `failed` phases. |
| `RunEvidenceCollector` | Accumulates bounded command outcomes, tool failures, and changed-file statistics until `agent_settled`. |

### Wire protocol (summary; full spec in `docs/PROTOCOL.md`)

- WebSocket at `/v1/ws`, JSON envelopes, `protocolVersion: 1`.
- Server envelope: `{ id?, seq, type, protocolVersion, timestamp, payload }`.
- Client envelope: `{ id?, type, protocolVersion, payload }`.
- Connection state machine: connect → `server.hello` → `auth.pair.request` (with code) **or** `auth.token` → `auth.*.success` (`state: null`, `hub.roots`) → `hub.*` browsing → `hub.openSession` / `hub.newSession` → live `session.*` commands/events for that session; `hub.attached` / `hub.sessionStatus` when it moves or stops.
- Stable `response.ok` shape: `{ ok, command, result }`.
- State-changing commands emit `state.changed` after `response.ok`.
- Pi events come through as `pi.<name>` with payload `{ source: "pi", name, data }`.
- iOS requires `pi.agent_settled` in server capabilities and rejects stale loaded extensions with `/reload` guidance.
- Close codes: `1001` server shutdown, `4000` heartbeat timeout, `4001` auth timeout, `4003` device revoked.
- Transport is `wss://`; URLs carry the certificate pin as `#fp=<base64url sha256(cert DER)>`.

### Security invariants

- The hub binds only the private LAN address, serves TLS, and drops peers outside private/loopback ranges. Pi processes never listen on the network.
- The TLS identity, trusted devices, `hub.json` and `hub.sock` live in `~/.pi/agent/pi-remote/` (dir 0700, secrets and socket 0600).
- The phone can only browse, open and create sessions inside `roots` (symlink-resolved); the hub never writes session files and only stops Pi processes it started (never mid-run).
- Unauthenticated clients can only receive `server.hello`, send `connection.ping`, or auth.
- Pi event broadcasts go only to authenticated connections.
- Pairing code expires after 2 minutes; 5 failed attempts disable the code; successful pair disables the code.
- Tokens are high-entropy and returned once. Server stores only `sha256(token + serverSecret)`.
- The iOS app stores its issued token and pinned URL in Keychain, pins the leaf certificate (TOFU when the URL has no `#fp=`), and refuses `ws://` to non-loopback hosts.
- The hub never opens a pairing window by itself; `pair` is explicit.
- Sanitizer caps payloads at 20K-char strings, 200-item arrays, depth 8; redacts known secret keys.

### Running

```
npm install
npm run typecheck     # tsc --noEmit
npm test              # node --test test/*.test.mjs

node hub/bin.mjs run  # hub in the foreground (JSON logs on stderr); PI_REMOTE_STATE_DIR isolates state
node hub/bin.mjs roots add <dir> | pair | status | devices | revoke <id> | idle <min>

node scripts/build-mac-app.mjs [--install]   # Pi Hub.app (menu bar); --install replaces ~/Applications/Pi Hub.app and opens it
swift test --package-path mac/PiHub          # menu bar app core tests; PI_HUB_LIVE_SOCKET=…/hub.sock also decodes a live overview

pi                    # from repo root, loads extension via .pi/settings.json; registers with the hub
> /remote pair | status | devices | revoke <id> | rotate | takeover
```

## Conventions

### Swift code style

- **Indent**: 2 spaces. Tab width 2. Apply consistently.
- **Type naming**: no project prefix on generic primitives (`Card`, `PrimaryButton`, not `PiCard`/`PiCTA`).
- Keep Pi Hub logic that can be tested without AppKit in `PiHubCore` (formatting, overview decoding, launch config) and cover it in `PiHubCoreTests`.

### TypeScript extension

- One concept per module file. `PhoneSession` does not touch sockets; `AgentHub` does not interpret session commands; `RemoteConnection` does not interpret protocol; `PiRemoteAdapter` is the only place that executes active Pi session operations. Registration modules may call `registerCommand`, `registerTool`, or `on`.
- No legacy `extensions/` directory — source is in `extension/`.
- Wire-format changes require parallel updates to the iOS `Pi/Pi/Core/Protocol/` types in `pi_local_remote_ios`; keep `protocolVersion` and the server capabilities honest so an older app fails clearly.
- Run `npm run typecheck` after any change. Run `npm test` for protocol/auth/runtime/event-stream changes.

### Documentation discipline

When making important changes:

1. Update `AGENTS.md` (this file; `CLAUDE.md` is a symlink to it).
2. Update `PLAN.md` if phase/architecture changes.
3. Update `docs/PROTOCOL.md` if wire messages change.
4. Update `docs/SECURITY.md` if security assumptions change.
5. Update `docs/SWIFT_CLIENT_NOTES.md` in `pi_local_remote_ios` if iOS expectations change.
6. Update tests for protocol guarantees.
7. Note user-visible changes in `CHANGELOG.md`.

### Versioning

This repository has one version: `package.json` (+ `package-lock.json`), which the hub reports (`extension/version.ts` → `status.version`, `GET /version`) and `scripts/build-mac-app.mjs` stamps into Pi Hub (a future Windows app takes the same). Bump it with a `CHANGELOG.md` section and tag `vX.Y.Z` on `main`. The iOS app is versioned in its own repository; both released 0.1.0 together. Compatibility between them is `protocolVersion` plus the server capabilities, not the version numbers.

## Useful entry points

| To work on … | Start here |
|---|---|
| Wire-protocol change | `extension/protocol/ProtocolDecoder.ts` + `docs/PROTOCOL.md` (+ `Pi/Pi/Core/Protocol/` in `pi_local_remote_ios`) |
| Hub op / phone browsing | `hub/PhoneSession.ts` + `hub/SessionCatalog.ts` |
| Pi Hub menu bar app | `mac/PiHub/Sources/PiHub/HubModel.swift` → `MenuView.swift` / `SettingsView.swift` |
| Pi event mapping | `extension/events/RemoteEventStream.ts` + `extension/pi/eventMapper.ts` |
| Auth/security | `extension/auth/DeviceTrust.ts` + `docs/SECURITY.md` |
| Adapter to Pi | `extension/pi/PiRemoteAdapter.ts` (the one place Pi APIs are touched) |

## Working Agreement

### 1. Change Isolation

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless explicitly asked.

The test: every changed line must trace directly to the user's request.

### 2. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Your job is to turn vague tasks into concrete, verifiable goals.

Given a request:
- "Add validation" → "Write tests for invalid inputs, then make them pass."
- "Fix the bug" → "Write a test that reproduces it, then make it pass."
- "Refactor X" → "Ensure tests pass before and after the change."

For multi-step tasks, first state a brief plan in this form:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Then execute the plan, updating it if reality disagrees with assumptions.

### 3. Default Mode: Constructive Skeptic

Your default stance is critical thinking, not agreement.

- Never agree by default. First, stress-test the idea, strategy, or opinion.
- For any proposal, ask: what's the weakest point? What could break? What's missing?
- Don't echo my framing. If I say "I think X is the move," you don't start with "X is definitely the move" or "That makes a lot of sense." You start from: what am I not seeing?

No glazing:
- Don't say something is "great," "brilliant," or "really smart" unless you can point to specific, concrete reasons.
- Even then, lead with what's wrong, risky, or unclear before acknowledging strengths.
- Compliments without substance are treated as noise.

Agreement must be earned:
- Only agree after you've genuinely pressure-tested the idea.
- When you do agree, say why in a way that adds new information or perspective, not just a rephrase of what I already said.
- Be direct and concise. Skip warm-up sentences.

Filler is forbidden:
- Don't pad responses with generic affirmations.
- If the answer is "no" or "this won't work," say that in the first sentence and then explain.

Actively hunt for flaws:
- Call out bad logic, weak assumptions, and blind spots immediately — especially when I sound confident or excited.
- The more certain I sound, the more you should look for counter-arguments and failure modes.

If you catch yourself about to start a response with "That's a great point" or "You're absolutely right," stop and rewrite. Start instead with the most useful critical observation, question, or refinement you can offer.

### 4. PRs and Commits

For pull requests and commits, write like a human explaining work to another human.

No "official" sections, no templated bullets like "Summary", "Motivation", or "Change log" unless the repo explicitly requires it. Don't generate robotic, over-structured PR descriptions.

In PR descriptions:
- Explain what changed, how it works now, and why we're doing it — in plain language.
- Prefer a few clear paragraphs over bullet dumps.
- Mention any tradeoffs, risks, or follow-up work directly in the text instead of hiding them behind headings.

In commit messages:
- Keep them short, specific, and readable.
- Describe the real intention of the change, not generic noise like "fix issues" or "update code".
- If a commit fixes a bug, say what was broken and how this commit fixes it.
