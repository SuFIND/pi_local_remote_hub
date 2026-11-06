# Pi Remote Protocol

Protocol version: `1`.

Transport: WebSocket over TLS (`wss://`) at `/v1/ws`. The host certificate is self-signed; clients pin it (see [Host identity and discovery](#host-identity-and-discovery)). Plain `ws://` is only for loopback test servers.

The server is the **Pi Remote Hub**, one process per Mac (`node hub/bin.mjs run`, or a launchd agent after `install`). `node hub/bin.mjs pair` or `/remote pair` in any Pi window opens a short-lived pairing code. After authentication the phone browses the shared folders and attaches to one session at a time ([Hub commands](#hub-commands)); every `session.*` command and Pi event then refers to that session.

## Server envelope

All server messages use this envelope:

```json
{
  "id": "req_1",
  "seq": 1,
  "type": "response.ok",
  "protocolVersion": 1,
  "timestamp": "2026-05-09T00:00:00.000Z",
  "payload": {}
}
```

Fields:

- `id`: present when replying to a client request.
- `seq`: monotonic sequence number for reconnect-gap detection.
- `type`: server event or response type.
- `protocolVersion`: currently `1`.
- `timestamp`: ISO-8601 server timestamp.
- `payload`: type-specific payload.

## Client envelope

```json
{
  "id": "req_1",
  "type": "connection.ping",
  "protocolVersion": 1,
  "payload": {}
}
```

## Connection flow

### 1. Connect

Client opens:

```txt
wss://host:3769/v1/ws
```

The printed and QR URL is `wss://host:3769/v1/ws#fp=<pin>`. Strip the fragment before dialing and verify the presented certificate against `<pin>`.

Server sends `server.hello`:

```json
{
  "type": "server.hello",
  "payload": {
    "server": "pi-remote-control",
    "protocolVersion": 1,
    "auth": {
      "required": true,
      "pairingAvailable": true
    },
    "capabilities": {
      "authMethods": ["pairingCode", "deviceToken"],
      "commands": ["hub.listProjects", "hub.listSessions", "hub.listFolders", "hub.openSession", "hub.newSession", "hub.detach", "interaction.answer", "session.getState", "session.history", "session.prompt", "session.abort", "session.compact", "session.listModels", "session.listSkills", "session.setModel", "session.setThinkingLevel"],
      "features": {
        "sequenceNumbers": true,
        "stableOkEnvelope": true,
        "stateChangedEvents": true,
        "authenticatedPiEventsOnly": true,
        "hub": true
      }
    }
  }
}
```

### 2A. Pair new device

Client sends:

```json
{
  "id": "pair_1",
  "type": "auth.pair.request",
  "protocolVersion": 1,
  "payload": {
    "code": "123-456",
    "deviceName": "Example iPhone"
  }
}
```

Server replies:

```json
{
  "id": "pair_1",
  "type": "auth.pair.success",
  "payload": {
    "token": "device-token-returned-once",
    "device": {
      "id": "...",
      "name": "Example iPhone",
      "createdAt": "...",
      "lastSeenAt": "..."
    },
    "state": null,
    "hub": { "roots": ["/Users/me/code"] }
  }
}
```

Store `token` in iOS Keychain. The hub stores only a token hash, in `~/.pi/agent/pi-remote/trusted-devices.json`, so the token survives hub and Mac restarts. `/remote revoke` or `/remote rotate` invalidates it.

`state` is `null` because no session is attached yet; there is no `state.snapshot` after auth. Open a session with `hub.openSession` or `hub.newSession`.

### 2B. Reconnect with token

Client sends:

```json
{
  "id": "auth_1",
  "type": "auth.token",
  "protocolVersion": 1,
  "payload": {
    "token": "device-token-from-keychain"
  }
}
```

Server replies:

```json
{
  "id": "auth_1",
  "type": "auth.token.success",
  "payload": {
    "device": {},
    "state": null,
    "hub": { "roots": ["/Users/me/code"] }
  }
}
```

A reconnecting client re-opens the session it was showing (`hub.openSession` with the saved path).

## Hub commands

The phone only sees folders inside the hub's configured `roots`; anything else fails with `OUTSIDE_ROOTS`. Paths are absolute. Session `status` is `terminal` (a Pi window owns it), `background` (the hub started Pi for it) or `stopped` (saved on disk, no Pi running).

### `hub.listProjects`

`{}` → `{ "roots": [...], "projects": [{ "path", "name", "root", "sessionCount", "running", "lastActivity"? }] }`. Each root, its direct subfolders, and every deeper folder that has sessions, sorted by running sessions, then recent activity.

### `hub.listSessions`

`{ "cwd": "/Users/me/code/app" }` → `{ "cwd", "sessions": [{ "path", "id"?, "name"?, "firstMessage", "modified"?, "messageCount", "status", "busy" }] }`. Live sessions first, then newest. A brand-new live session with nothing on disk yet is included with `messageCount: 0`.

### `hub.listFolders`

`{ "path": "/Users/me/code" }` → `{ "path", "folders": [{ "path", "name" }] }`. Visible subfolders only; files are never listed.

### `hub.openSession`

`{ "sessionPath": "/…/session.jsonl" }` → `{ "session": { "path", "cwd", "name"?, "status" }, "state": {…} }`, or `SESSION_UNAVAILABLE` when the file is not a session in the shared folders. Attaching to a running session replays an open `interaction.question`. For a `stopped` session `state` is read from the file; `session.history`, `session.getState` and `session.abort` are answered from disk, and any other command starts Pi for it first (`hub.sessionStatus` with `reason: "started"`, then the command's own response).

### `hub.newSession`

`{ "cwd": "/Users/me/code/app" }` → same result as `hub.openSession`, with `status: "background"`. Starts `pi --mode rpc` in that folder.

### `hub.detach`

`{}` → `{ "detached": true }`. Stop receiving the session's events.

### Hub events

| Event | Payload | Meaning |
|---|---|---|
| `hub.attached` | `{ reason: "replaced", session, state }` | The attached session moved to another Pi process: the Pi window switched session (`/new`, `/resume`, `/fork`), a terminal took it over from the hub, or a terminal opened the stopped session this phone is showing. Reload history. |
| `hub.sessionStatus` | `{ reason: "started" \| "idle" \| "exited", session }` | `started`: the hub started Pi for this session. `idle`: hub-started Pi exited after `idleExitMinutes` without work. `exited`: the Pi window closed. The phone stays on the session (now `stopped`); the next command starts Pi again. |
| `hub.detached` | `{ reason }` | The Pi process went away and its session has no file to fall back to. |

## Stable `response.ok`

All authenticated request/response commands that use `response.ok` have the same payload shape:

```json
{
  "id": "req_1",
  "type": "response.ok",
  "payload": {
    "ok": true,
    "command": "session.getState",
    "result": {}
  }
}
```

`result` is command-specific. Clients should first decode the common `response.ok` payload, then switch on `command`.

## Session state shape

The `state` object carried by `state.snapshot`, `state.changed`, `auth.*.success`, and `session.getState` is best-effort and may grow; clients should treat every field as optional except `isIdle`:

```json
{
  "isIdle": true,
  "cwd": "/Users/me/project",
  "sessionName": "my session",
  "sessionFile": "/…/session.jsonl",
  "entryCount": 42,
  "leafId": "…",
  "model": { "provider": "anthropic", "id": "claude-opus-4-8", "name": "Claude Opus 4.8" },
  "thinkingLevel": "high",
  "contextUsage": { "tokens": 45000, "contextWindow": 1000000, "percent": 4.5 },
  "hasPendingMessages": false,
  "phase": "completed",
  "host": "studio-mac",
  "branch": "feature/mobile",
  "lastRun": {
    "runId": "run_…",
    "startedAt": "2026-08-04T10:00:00.000Z",
    "completedAt": "2026-08-04T10:01:00.000Z",
    "status": "completed",
    "toolCount": 3,
    "failedToolCount": 0,
    "commands": [],
    "changedFiles": [],
    "truncated": false
  }
}
```

`thinkingLevel` is read from `pi.getThinkingLevel()`; `model` from `ctx.model`; `contextUsage` is forwarded from `ctx.getContextUsage()` and clients should parse it defensively.

`phase` is one of `idle`, `running`, `queued`, `compacting`, `needsInput`, `completed`, or `failed`. Pi events drive this state. `agent_settled`, rather than `agent_end`, marks the final transition because automatic retries, compaction, or queued continuations can follow `agent_end`.

`host` is the Pi host's hostname. `branch` is best-effort and is omitted outside a Git worktree. `lastRun` is the latest bounded completion summary and remains available across client reconnects while the Pi extension process stays alive.

Pi lifecycle and question transitions also emit `state.changed`. Their reasons are the source event name (`before_agent_start`, `agent_start`, `agent_settled`, `session_before_compact`, `session_compact`) or `questionOpened` / `questionResolved`.

## Authenticated commands

### `interaction.answer`

Answers the currently pending `remote_question` tool call. The command is authenticated and rejects stale request IDs, empty answers, and answers longer than 8,000 characters.

```json
{
  "id": "answer_1",
  "type": "interaction.answer",
  "protocolVersion": 1,
  "payload": {
    "requestId": "question_…",
    "answer": "Simulator"
  }
}
```

Response `result` is `{ "accepted": true, "requestId": "question_…" }`. The server also emits `interaction.resolved`; clients should keep the question disabled until that event arrives.

### `session.getState`

```json
{
  "id": "state_1",
  "type": "session.getState",
  "protocolVersion": 1,
  "payload": {}
}
```

Response:

```json
{
  "type": "response.ok",
  "payload": {
    "ok": true,
    "command": "session.getState",
    "result": { "state": {} }
  }
}
```

### `session.history`

Returns the current session's branch from root → leaf so a connecting client can render the existing conversation. Useful when the iOS app reconnects (or first connects) to a long-running Pi session and needs to backfill the transcript.

```json
{
  "id": "hist_1",
  "type": "session.history",
  "protocolVersion": 1,
  "payload": { "limit": 200 }
}
```

`limit` is optional; when present it is clamped to `[1, 1000]` and the most recent N entries are returned. Omit it to receive the full branch. Either way the answer is capped at 4 MiB of entry JSON: older entries are dropped first (the newest entry is always sent), and `truncated` is `true` whenever fewer than `totalEntries` entries came back. Clients must accept WebSocket messages of at least 16 MiB; the iOS app sets `maximumMessageSize` to that (the `URLSessionWebSocketTask` default of 1 MiB made long sessions fail to load and reconnect in a loop).

Response:

```json
{
  "type": "response.ok",
  "payload": {
    "ok": true,
    "command": "session.history",
    "result": {
      "entries": [
        {
          "type": "message",
          "id": "...",
          "parentId": "...",
          "timestamp": "...",
          "message": { "role": "user|assistant|toolResult", "content": [...] }
        }
      ],
      "leafId": "...",
      "totalEntries": 42,
      "truncated": false
    }
  }
}
```

`entries` are sanitized via the standard remote sanitizer (string truncation, key redaction). Other entry types include `model_change`, `thinking_level_change`, `compaction`, `branch_summary`, `custom_message`, `label`, `session_info` — clients should switch on `entry.type` and ignore unknown variants.

### `session.prompt`

```json
{
  "id": "prompt_1",
  "type": "session.prompt",
  "protocolVersion": 1,
  "payload": {
    "message": "Run tests",
    "delivery": "auto"
  }
}
```

Delivery values:

- `auto`: idle => prompt, busy => follow-up
- `prompt`: only when idle
- `steer`: redirect the active run
- `followUp`: queue after current work

The iOS client uses `auto` while idle. While Pi is busy, it exposes an explicit Queue/Steer choice and sends `followUp` or `steer`. Queue edit and removal are not supported by Pi's public extension API.

Response:

```json
{
  "type": "response.ok",
  "payload": {
    "ok": true,
    "command": "session.prompt",
    "result": { "accepted": true, "state": {} }
  }
}
```

After the response, server emits:

```json
{
  "type": "state.changed",
  "payload": {
    "reason": "promptAccepted",
    "state": {}
  }
}
```

### `session.abort`

```json
{ "id": "abort_1", "type": "session.abort", "protocolVersion": 1, "payload": {} }
```

Success emits `state.changed` with `reason: "abortRequested"` after `response.ok`.

### `session.compact`

```json
{ "id": "compact_1", "type": "session.compact", "protocolVersion": 1, "payload": {} }
```

Success emits `state.changed` with `reason: "compactRequested"` after `response.ok`.

### `session.listModels`

Lists the models Pi knows about, flagged by whether the running session has the credentials to use each one. Query only — no `state.changed`.

```json
{ "id": "models_1", "type": "session.listModels", "protocolVersion": 1, "payload": {} }
```

Response `result`:

```json
{
  "models": [
    { "provider": "anthropic", "id": "claude-opus-4-8", "name": "Claude Opus 4.8", "available": true, "reasoning": true, "contextWindow": 1000000 }
  ],
  "current": { "provider": "anthropic", "id": "claude-opus-4-8" }
}
```

`available` is `false` for models whose provider has no configured API key — clients should show them disabled. Sourced from `ctx.modelRegistry.getAll()` / `.getAvailable()`.

### `session.listSkills`

Lists the skills registered in the active Pi session. Query only — no `state.changed`.

```json
{ "id": "skills_1", "type": "session.listSkills", "protocolVersion": 1, "payload": {} }
```

Response `result`:

```json
{
  "skills": [
    { "name": "skill:diagnose", "description": "Diagnose bugs and performance regressions" }
  ]
}
```

The server returns at most 200 skills. The listing omits skill paths and other source metadata. Invoke a selected skill through `session.prompt` with a message such as `/skill:diagnose investigate this crash`; the extension validates and expands the registered skill before sending it to Pi.

### `session.setModel`

```json
{ "id": "setmodel_1", "type": "session.setModel", "protocolVersion": 1, "payload": { "provider": "anthropic", "id": "claude-opus-4-8" } }
```

Resolves the model via `ctx.modelRegistry.find(provider, id)` and calls `pi.setModel`. Fails with `COMMAND_FAILED` if the model is unknown or the provider has no API key. Success emits `state.changed` with `reason: "modelChanged"` after `response.ok`; the new model is in the attached `state.model`.

### `session.setThinkingLevel`

```json
{ "id": "think_1", "type": "session.setThinkingLevel", "protocolVersion": 1, "payload": { "level": "high" } }
```

`level` must be one of `minimal`, `low`, `medium`, `high`, `xhigh` (rejected with `BAD_REQUEST` otherwise). Pi clamps the level to what the current model supports. Success emits `state.changed` with `reason: "thinkingChanged"` after `response.ok`; `state.thinkingLevel` reflects the clamped result.

### `connection.ping`

Available before or after auth.

```json
{ "id": "ping_1", "type": "connection.ping", "protocolVersion": 1, "payload": {} }
```

Response: `connection.pong`.

## Blocking questions

The extension registers a sequential `remote_question` tool. While a phone is attached to the session, a tool call emits this event to the attached phones and waits for `interaction.answer`:

```json
{
  "type": "interaction.question",
  "payload": {
    "requestId": "question_…",
    "toolCallId": "tool_…",
    "question": "Which target should I test?",
    "options": [
      { "label": "Simulator", "description": "Run the simulator suite" },
      { "label": "Device", "description": "Run the signed device build" }
    ],
    "allowsCustomAnswer": true,
    "createdAt": "2026-08-04T10:00:00.000Z",
    "expiresAt": "2026-08-04T10:10:00.000Z"
  }
}
```

A pending question remains in the Pi process; the hub replays it to every phone that attaches to the session later. Agent abort, timeout, or the Pi process ending resolves it with a null answer. Resolution event:

```json
{
  "type": "interaction.resolved",
  "payload": {
    "requestId": "question_…",
    "answer": "Simulator",
    "reason": "answered"
  }
}
```

`reason` is `answered`, `cancelled`, `timeout`, or `remoteStopped`. If the remote server is not running, the tool uses Pi's terminal UI when available.

## Run completion evidence

After `agent_settled`, the server emits `session.run.completed`. The payload is also retained as `state.lastRun`:

```json
{
  "type": "session.run.completed",
  "payload": {
    "runId": "run_…",
    "startedAt": "2026-08-04T10:00:00.000Z",
    "completedAt": "2026-08-04T10:01:00.000Z",
    "status": "completedWithErrors",
    "toolCount": 4,
    "failedToolCount": 1,
    "commands": [
      { "toolCallId": "tool_1", "command": "npm test", "status": "succeeded" }
    ],
    "changedFiles": [
      { "filePath": "extension/index.ts", "added": 2, "removed": 1, "toolCallIds": ["tool_2"] }
    ],
    "truncated": false
  }
}
```

Run status is `completed`, `completedWithErrors`, `aborted`, or `failed`. Commands are taken from structured Bash tool inputs, and outcomes come from tool error flags. Changed-file statistics come from edit/write tool results. The extension does not parse assistant prose to claim that validation passed. Evidence is capped at 20 commands and 50 changed files; `truncated` reports omitted or clipped data.

## Pi event payload shape

Pi events are only sent to authenticated clients. Their payload shape is stable:

```json
{
  "type": "pi.agent_start",
  "payload": {
    "source": "pi",
    "name": "agent_start",
    "data": {}
  }
}
```

`data` is sanitized and size-limited. Clients should rely on `type`, `source`, and `name`; individual `data` fields may evolve as Pi event shapes evolve. `pi.agent_settled` indicates that no automatic retry, compaction, or queued continuation will run.

### `data.edit` block on `pi.tool_end`

When the wrapped Pi tool is `edit` or `write`, the extension attaches a structured `edit` block to the `pi.tool_end` `data` field so clients can render a unified-diff review of the file change:

```json
{
  "type": "pi.tool_end",
  "payload": {
    "source": "pi",
    "name": "tool_execution_end",
    "data": {
      "toolCallId": "tool_…",
      "toolName": "edit",
      "isError": false,
      "result": "…sanitized text result…",
      "edit": {
        "filePath": "src/foo.swift",
        "diff": "@@ -1,3 +1,3 @@\n-let old = 1\n+let new = 2\n unchanged",
        "firstChangedLine": 1,
        "stats": { "added": 1, "removed": 1 }
      }
    }
  }
}
```

Notes:

- The `diff` field is a unified diff string. For `edit` it's lifted verbatim from Pi's own `EditToolDetails.diff`; for `write` (which Pi doesn't diff) the extension synthesizes a `--- /dev/null` / `+++ <path>` all-added diff against the new file content.
- The `diff` field bypasses the 20K-char sanitizer cap on purpose — clients are expected to render whole diffs. The only effective ceiling is the 256 KB WebSocket frame size.
- The `edit` block is absent for non-edit tool calls (`bash`, `read`, `grep`, `find`, `ls`, custom tools). Clients should treat its presence as optional.

## Error response

```json
{
  "id": "req_1",
  "type": "response.error",
  "payload": {
    "code": "UNAUTHORIZED",
    "message": "Authenticate before sending commands"
  }
}
```

Stable error codes are listed in `extension/protocol/errors.ts`. Hub-specific ones: `NO_SESSION` (a `session.*` command before `hub.openSession`), `SESSION_UNAVAILABLE` (unknown session, or its Pi exited before answering), `OUTSIDE_ROOTS` (folder not shared with the phone).

## Pairing deep link (QR display)

`node hub/bin.mjs pair` and `/remote pair` also print a QR code encoding a deep link with the same WebSocket URL and pairing code shown in the textual status block:

```
pi-remote://pair?url=<percent-encoded wss url including #fp=<pin>>&code=<6-digit-code>
```

This is a UX convenience for iOS clients that implement a QR scanner — it carries no credentials beyond what the printed status already shows. Anyone in viewing distance of the terminal can read the pairing code either way, so QR and text have equivalent exposure.

## Host identity and discovery

- **Pin:** base64url (no padding, 43 chars) SHA-256 of the leaf certificate's DER. The short display form is the first 8 bytes as uppercase hex in groups of 4 (`6AFB 984A 305D 1BF3`), printed as `Fingerprint:` by `/remote pair` and `/remote status`.
- **One identity:** the hub's certificate lives in `~/.pi/agent/pi-remote/`, so the pin is stable across restarts.
- **Bonjour:** on macOS the hub registers `_pi-remote._tcp` (instance `Pi · <Mac name>`). TXT keys:

| Key | Value |
|---|---|
| `v` | protocol version |
| `fp` | pin |
| `host` | advertised LAN address |
| `port` | listening port |
| `path` | WebSocket path (`/v1/ws`) |
| `proj` | working-directory basename (optional) |
| `cwd` | first 16 hex chars of SHA-256 of the UTF-8 working directory (optional) |

Clients build `wss://<host>:<port><path>#fp=<fp>` from a record, and accept it only if `fp` is a valid pin. After an address change a client reconnects to the record with its pinned `fp`. It prefers the same address, then the same `cwd` tag, then a single remaining candidate.

## Server close codes

| Code | Reason | Meaning |
|---:|---|---|
| 1001 | `Server shutting down` | The hub stopped or restarted. |
| 4000 | `Heartbeat timeout` | Client stopped responding to ping/pong or messages. |
| 4001 | `Authentication timeout` | Client did not authenticate within the auth timeout window. |
| 4003 | `Device revoked` | The device was revoked (`/remote revoke`, `/remote rotate`), Forget the token and re-pair. |
