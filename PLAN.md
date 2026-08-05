# Pi Remote for iOS Architecture Plan

## Status

- Phase A — Refactor skeleton: implemented.
- Phase B — WebSocket server foundation: implemented.
- Phase C — Pairing/auth: implemented with `/remote start` creating the pairing window.
- Phase D — More command routing/hardening: core commands implemented; command execution now lives behind RemoteSession.
- Architecture deepening pass: DeviceTrust, ProtocolDecoder, RemoteSession, RemoteControlRuntime, and RemoteEventStream are implemented.
- Swift-facing protocol polish: server capabilities, documented close codes, stable `response.ok`, stable Pi event wrapper, and `state.changed` are implemented.
- Single-session supervision: structured phases, host/branch context, remote questions, Queue/Steer, and run completion evidence are implemented.
- Remote reachability: `/remote start` binds to the Pi host's LAN interface. The iPhone and host must use the same trusted local network.
- Public preview preparation: repository renamed to `pi-remote-ios`; licensing, package metadata, CI, contribution guidance, and release checks added. Public visibility remains pending.
- iOS project generation: Tuist 4.202.6 manifests now define the app, tests, settings, resources, schemes, and pinned Swift packages. The pre-migration Xcode project remains as a rollback reference.
- Minimized run monitoring: user-started prompts submit an iOS 26 continued-processing task. The system presents its Live Activity while the app keeps the local WebSocket active, and generic local notifications report needs-input and completion events. APNs is not used.

## Goal

Build a secure, high-quality Pi extension that lets a native Swift app control an active Pi session over a trusted local network.

This is not a throwaway web demo. The extension should expose a stable, versioned remote-control protocol with a clean TypeScript architecture, strong pairing/authentication, robust WebSocket streaming, and room for future native clients.

## Non-goals for the first serious version

- Multi-session daemon/headless Pi management.
- Custom cloud relay service.
- Direct public exposure of the local WebSocket port.
- Recreating the full Pi TUI in the client.
- Permission/approval policy system beyond basic abort/prompt controls.

## Primary client

Native Swift app.

The extension may still serve a tiny diagnostic page later, but the product contract is the WebSocket/HTTP protocol, not bundled browser UI.

---

# Architecture Overview

```txt
Pi interactive process
  └─ Pi Remote extension
      ├─ command layer
      │   └─ /remote start|stop|status|rotate
      ├─ server layer
      │   ├─ HTTPS/HTTP listener
      │   ├─ WebSocket upgrade handler
      │   └─ minimal health/version endpoints
      ├─ auth layer
      │   ├─ pairing code
      │   ├─ ephemeral pairing session
      │   ├─ device tokens
      │   └─ token rotation/revocation
      ├─ protocol layer
      │   ├─ JSON message schemas
      │   ├─ request/response correlation
      │   ├─ event envelopes
      │   └─ protocol version negotiation
      ├─ Pi adapter layer
      │   ├─ captures Pi events
      │   ├─ serializes/sanitizes events
      │   ├─ sends prompt/steer/follow-up
      │   ├─ aborts/compacts where supported
      │   └─ exposes session state snapshots
      └─ lifecycle layer
          ├─ startup/shutdown
          ├─ connection registry
          ├─ heartbeat/reconnect
          └─ structured logging
```

## Package layout

```txt
pi-remote-ios/
  Project.swift              # Tuist source of truth for iOS targets
  Tuist.swift                # shared Tuist configuration
  Tuist/Package.swift        # pinned Swift package declarations
  package.json
  tsconfig.json
  PLAN.md
  README.md
  docs/
    PROTOCOL.md              # exact wire protocol
    SECURITY.md              # threat model + security behavior
    SWIFT_CLIENT_NOTES.md    # native app integration notes
  extension/                 # source of the Pi extension package
    index.ts                 # thin Pi extension entry point only
    command.ts               # /remote command parsing and command handlers
    config.ts                # defaults, env overrides, validation
    runtime/
      RemoteControlRuntime.ts # start/stop/status/rotate semantics
    server/
      RemoteServer.ts        # HTTP server + WebSocket upgrade lifecycle
      routes.ts              # health/version endpoints
    connections/
      RemoteConnection.ts    # WebSocket lifecycle only
      RemoteSession.ts       # auth state + command execution session
      ConnectionRegistry.ts
    auth/
      DeviceTrust.ts         # pairing + trusted-device interface
      PairingManager.ts      # internal pairing code/session implementation
      TokenStore.ts          # internal token hashing implementation
      crypto.ts              # random IDs, constant-time compare, hashing
    protocol/
      ProtocolDecoder.ts     # raw client message -> typed command
      envelopes.ts           # inbound/outbound message envelope types
      validation.ts          # envelope validation helpers
      errors.ts              # protocol error codes
    pi/
      PiRemoteAdapter.ts     # single seam around ExtensionAPI/ctx
      eventMapper.ts         # Pi event -> remote event
      stateSnapshot.ts       # current session state
      sanitizer.ts           # redact/limit event payloads
    events/
      RemoteEventStream.ts   # Pi event mapping + broadcast
    questions/
      QuestionBroker.ts      # reconnect-safe pending question
      registerRemoteQuestionTool.ts
    session/
      RemoteSessionMonitor.ts
      RunEvidenceCollector.ts
    logging/
      logger.ts
  .pi/extensions/            # optional local symlink/install target, not source
```

`index.ts` should be small: create dependencies, register command, register Pi event hooks, handle shutdown.

---

# Transport Choice

Use WebSocket for the native app protocol.

Reasons:

- Bidirectional real-time control and event streaming.
- Better fit for Swift `URLSessionWebSocketTask`.
- Allows request/response correlation and async server pushes on one connection.
- Easier future support for reconnect/resume, progress updates, and mobile foreground/background lifecycle.

Use `ws` on the extension side unless Pi SDK provides a preferred WebSocket server helper later.

Why not SSE + REST for final architecture:

- Two transports instead of one.
- More auth surfaces.
- Harder correlation between command responses and streamed state.
- Less natural for mobile reconnection semantics.

---

# Security Model

## Default exposure

The default command binds to the Pi host's local network interface:

```txt
/remote start
# binds 0.0.0.0 and advertises the host's LAN address
```

Use this only when the iPhone and Pi host share a trusted private network. Pi shows
a warning when it starts the LAN listener.

## Threat model

Remote control can indirectly run shell commands through Pi. Treat access as equivalent to terminal access to the current project and user account.

Protect against:

- random LAN users connecting
- stale pairing codes
- stolen/replayed unauthenticated commands
- cross-origin browser drive-by attacks
- accidental Internet exposure
- oversized payload DoS
- malformed protocol messages

Not fully solved in v1:

- compromised paired device
- malicious local user on the same machine
- hostile extensions inside the same Pi process

## Pairing flow

Pairing is short-lived and tied to server startup. There is intentionally no separate `/remote pair` command.

```txt
User: /remote start
Pi:
  Remote server started and pairing enabled for 2 minutes
  URL: ws://192.168.1.10:3769/v1/ws
  Code: 742-193
```

Client flow:

1. Swift app opens WebSocket unauthenticated.
2. Server sends `server.hello` with protocol version, server nonce, and pairing capability.
3. Client sends `auth.pair.request` with pairing code and client metadata.
4. Server validates active pairing code.
5. Server returns `auth.pair.success` with device token once.
6. Swift app stores device token in Keychain.
7. Future connections use token auth.

Pairing code requirements:

- 6 digits grouped as `123-456` for UX.
- expires after 2 minutes.
- max attempts, e.g. 5 failed attempts per pairing session.
- disabled automatically after successful pairing.
- never stored in session files.

## Device token model

Generate a high-entropy token:

```txt
remote_device_token = 32+ random bytes, base64url
```

Store only a hash server-side:

```txt
sha256(token + serverSecret)
```

Token persistence options:

- v1 simple: in-memory only, lost when Pi exits. Most secure/easiest.
- v1.1 optional: persist hashed token via Pi extension custom entries or a local file with `0600` permissions.

Recommendation for first serious version: **in-memory tokens only**. Add persistent trusted devices later after we design revocation UX.

## Authenticated WebSocket handshake

Use WebSocket subprotocol or first message auth.

Preferred v1: first-message auth, because Swift and `ws` both handle it simply.

Connection state machine:

```txt
TCP connected
  -> WS open
  -> unauthenticated
      -> server.hello
      -> client auth.token or auth.pair.request
  -> authenticated
      -> state.snapshot
      -> normal command/event flow
  -> closed
```

Unauthenticated connections:

- can receive only `server.hello`
- can send only auth messages
- close after 10 seconds without auth
- strict payload size limit

## Origin checks

For native app, `Origin` might be absent. Browser clients should not be trusted by default.

Rules:

- If `Origin` exists and is not allowed, reject upgrade.
- Default allowed origins: none or localhost diagnostics only.
- Native app auth depends on token, not Origin.

## TLS

Local LAN v1 uses `ws://` with pairing-code and device-token authentication.
The traffic is not encrypted. Do not expose the port to the Internet or use the
app on untrusted Wi-Fi.

---

# Protocol Design

All WebSocket messages are JSON envelopes.

## Envelope

```ts
type ClientEnvelope = {
  id?: string;                  // required for commands expecting response
  type: string;                 // e.g. "session.prompt"
  protocolVersion: 1;
  payload?: unknown;
};

type ServerEnvelope = {
  id?: string;                  // mirrors request id for responses
  type: string;                 // event/response/error type
  protocolVersion: 1;
  timestamp: string;
  payload?: unknown;
};
```

## Request/response commands

Client sends:

```json
{
  "id": "req_123",
  "protocolVersion": 1,
  "type": "session.prompt",
  "payload": {
    "message": "Run tests",
    "delivery": "auto"
  }
}
```

Server replies:

```json
{
  "id": "req_123",
  "protocolVersion": 1,
  "type": "response.ok",
  "timestamp": "...",
  "payload": {
    "accepted": true
  }
}
```

or:

```json
{
  "id": "req_123",
  "protocolVersion": 1,
  "type": "response.error",
  "timestamp": "...",
  "payload": {
    "code": "AGENT_BUSY",
    "message": "Agent is busy. Use steer or follow-up."
  }
}
```

## Core client commands

```txt
auth.pair.request
auth.token
interaction.answer
session.getState
session.prompt
session.abort
session.compact
connection.ping
```

Prompt delivery modes:

```txt
auto      idle => prompt, busy => followUp
prompt    only when idle
steer     interrupt/steer active run
followUp  run after current work completes
```

## Core server events

```txt
server.hello
auth.pair.success
auth.token.success
state.snapshot
state.changed
pi.session_start
pi.session_shutdown
pi.agent_start
pi.agent_end
pi.agent_settled
interaction.question
interaction.resolved
session.run.completed
pi.turn_start
pi.turn_end
pi.message_start
pi.message_delta
pi.message_end
pi.tool_start
pi.tool_update
pi.tool_end
pi.model_changed
pi.thinking_changed
connection.pong
```

## Event design principle

Do not blindly forward raw Pi events forever.

Instead:

- v1 may include sanitized raw debug payloads under `debug.raw` behind a config flag.
- stable client-facing events should be mapped and documented.
- large fields should be truncated.
- sensitive fields should be redacted.

---

# Pi Adapter Boundary

Only `PiRemoteAdapter` should execute active Pi session operations. Command, tool, and event modules may use Pi's narrow registration surfaces.

Responsibilities:

- hold latest `ExtensionContext`
- answer `getState()`
- execute `prompt(message, delivery)`
- execute `abort()` if available
- execute `compact()` if available
- map Pi events into stable remote events

This keeps the server/protocol/auth code testable without Pi.

---

# Connection Lifecycle

## Heartbeat

Server sends ping every 20 seconds.

If no pong or client message for 60 seconds, close connection.

Swift app should reconnect with exponential backoff:

```txt
0.5s, 1s, 2s, 5s, 10s max
```

## Reconnect

On reconnect:

1. client authenticates with token
2. server sends fresh `state.snapshot`
3. server resumes live events from now onward

No event replay in v1. Event replay can be added later with a ring buffer and sequence numbers.

## Sequence numbers

Add monotonic `seq` to server events from the beginning even if we do not support replay yet.

```ts
type ServerEnvelope = {
  seq: number;
  ...
}
```

This helps Swift detect gaps after reconnect.

---

# Runtime Validation

All external input must be runtime validated.

Options:

1. Use `typebox` because Pi already exposes it for extensions.
2. Use small manual validators to avoid dependency complexity.

Recommendation: use small manual validators for protocol envelopes first. Protocol is simple and security-sensitive.

Validation rules:

- max message size, e.g. 256 KB
- require object envelopes
- require `protocolVersion === 1`
- require known message type
- require string length limits
- reject unknown auth commands while unauthenticated
- ignore or reject unknown payload fields consistently

---

# Error Codes

Stable error codes for Swift:

```txt
BAD_REQUEST
UNAUTHORIZED
PAIRING_DISABLED
PAIRING_EXPIRED
PAIRING_ATTEMPTS_EXCEEDED
PROTOCOL_VERSION_UNSUPPORTED
UNKNOWN_COMMAND
AGENT_BUSY
COMMAND_FAILED
PAYLOAD_TOO_LARGE
INTERNAL_ERROR
```

---

# Observability

Add lightweight structured logger:

```ts
logger.info("remote_started", { host, port })
logger.warn("auth_failed", { reason })
logger.error("command_failed", { command, error })
```

Do not log tokens, pairing codes, full prompts, or full tool results by default.

---

# Testing Plan

## Unit tests

- pairing code expiry
- max attempts
- token hashing/verification
- protocol validation
- command routing
- event sanitization/truncation
- state snapshot mapping

## Integration tests

- start server on random port
- connect WebSocket client
- unauthenticated timeout
- pairing success
- token auth success/failure
- prompt command calls fake Pi adapter
- event broadcast reaches authenticated clients only
- heartbeat closes dead clients

## Manual Pi test

```bash
pi
/remote start --host 127.0.0.1 --port 3769
```

This repo includes `.pi/settings.json`, so Pi started from the repo root loads the extension automatically. For a one-off explicit load, use `pi -e ./extension/index.ts`.

Then use a small Node or Swift test client.

---

# Implementation Phases

## Phase A — Refactor skeleton

- Replace monolithic `index.ts` with module layout.
- Keep extension entry point thin.
- Add typed config and logger.
- Add `PiRemoteAdapter` abstraction.

Exit criteria:

- `npm run typecheck` passes.
- `/remote status` works.

## Phase B — WebSocket server foundation

- Add `ws` dependency.
- Implement `RemoteServer` lifecycle.
- Implement upgrade handling.
- Add connection registry.
- Add heartbeat.

Exit criteria:

- server starts/stops cleanly from `/remote`.
- unauthenticated clients connect and receive `server.hello`.
- dead clients are cleaned up.

## Phase C — Pairing/auth

- Implement `PairingManager`.
- Implement in-memory `TokenStore`.
- Implement auth state machine.
- Make `/remote start` start the server and create the pairing window.
- Add `/remote rotate` for revoking in-memory devices and creating a fresh pairing code.

Exit criteria:

- unauthorized clients cannot execute commands.
- pairing expires and enforces attempt limit.
- paired token can reconnect.

## Phase D — Protocol commands

- Implement command router.
- Implement `session.getState`.
- Implement `session.prompt`.
- Implement `session.abort`.
- Implement `session.compact`.
- Add stable error responses.

Exit criteria:

- Swift/Node client can control Pi reliably.

## Phase E — Stable Pi event mapping

- Map Pi events into stable remote event names.
- Add sequence numbers.
- Add sanitization and truncation.
- Add optional debug raw event mode.

Exit criteria:

- client receives useful session/message/tool timeline.
- no unbounded payloads.

## Phase F — Docs and Swift contract

- Write `docs/PROTOCOL.md`.
- Write `docs/SECURITY.md`.
- Write `docs/SWIFT_CLIENT_NOTES.md`.
- Keep Swift protocol types aligned with the extension.

Exit criteria:

- native app can be implemented against docs without reading extension internals.

---

# Current Next Step

Prepare the first public preview:

- run CI against the extension and iOS app;
- publish a tagged release after the repository becomes public.
