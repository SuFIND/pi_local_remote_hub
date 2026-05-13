# Pi Remote Control Protocol

Protocol version: `1`.

Transport: WebSocket at `/v1/ws`.

`/remote start` starts the server and enables a short-lived pairing code. There is intentionally no separate `/remote pair` command.

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
ws://host:3769/v1/ws
```

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
      "commands": ["session.getState", "session.prompt", "session.abort", "session.compact"],
      "features": {
        "sequenceNumbers": true,
        "stableOkEnvelope": true,
        "stateChangedEvents": true,
        "authenticatedPiEventsOnly": true
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
    "deviceName": "Tornike's iPhone"
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
      "name": "Tornike's iPhone",
      "createdAt": "...",
      "lastSeenAt": "..."
    },
    "state": {}
  }
}
```

Store `token` in iOS Keychain. The server stores only a token hash in memory.

After auth, server also emits:

```json
{
  "type": "state.snapshot",
  "payload": { "state": {} }
}
```

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
    "state": {}
  }
}
```

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

## Authenticated commands

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

`limit` is optional; when present it is clamped to `[1, 1000]` and the most recent N entries are returned. Omit it to receive the full branch.

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
- `steer`: steer active run
- `followUp`: queue after current run

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

### `connection.ping`

Available before or after auth.

```json
{ "id": "ping_1", "type": "connection.ping", "protocolVersion": 1, "payload": {} }
```

Response: `connection.pong`.

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

`data` is sanitized and size-limited. Clients should rely on `type`, `source`, and `name`; individual `data` fields may evolve as Pi event shapes evolve.

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

Stable error codes are listed in `extension/protocol/errors.ts`.

## Pairing deep link (QR display)

`/remote start` also prints a QR code encoding a deep link with the same WebSocket URL and pairing code shown in the textual status block:

```
pi-remote://pair?url=<percent-encoded ws url>&code=<6-digit-code>
```

This is a UX convenience for iOS clients that implement a QR scanner — it carries no credentials beyond what the printed status already shows. Anyone in viewing distance of the terminal can read the pairing code either way, so QR and text have equivalent exposure.

## Server close codes

| Code | Reason | Meaning |
|---:|---|---|
| 1001 | `Server shutting down` | `/remote stop`, Pi shutdown, reload, or server restart. |
| 4000 | `Heartbeat timeout` | Client stopped responding to ping/pong or messages. |
| 4001 | `Authentication timeout` | Client did not authenticate within the auth timeout window. |
