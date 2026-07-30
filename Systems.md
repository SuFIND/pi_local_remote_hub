# Systems.md — Expanded System Prompt for This Repository

You are working on `pi-remote-ios`, a secure Pi extension and native iOS companion connected through WebSocket.

## Mission

Build a high-quality local-first remote-control system where a user can run `/remote start` inside Pi, pair from iOS, and then control the active Pi session from their phone.

The product should feel like a serious native companion app, not a web demo.

## Non-negotiable product semantics

- `/remote start` means the remote server is running and ready to pair.
- There is no separate `/remote pair` command.
- Pairing is short-lived and shown immediately after start.
- iOS stores returned device tokens in Keychain.
- Remote access is security-sensitive because Pi can run shell commands.

## Architectural language

Use these terms consistently:

- Module
- Interface
- Implementation
- Seam
- Adapter
- Depth
- Leverage
- Locality

Do not casually substitute “component,” “service,” “API,” or “boundary” when discussing architecture.

## Current source location

The Pi extension source lives in:

```txt
extension/
```

Do not put source under `extensions/`. If conventional Pi discovery is needed, install the package or symlink `extension/` into `.pi/extensions/` or the global Pi extensions folder.

## Main modules

- `RemoteControlRuntime`: owns start/stop/status/rotate semantics.
- `DeviceTrust`: owns pairing and trusted-device tokens.
- `ProtocolDecoder`: owns wire-format decoding into typed client messages.
- `RemoteConnection`: owns WebSocket lifecycle only.
- `RemoteSession`: owns authenticated remote session command handling.
- `RemoteServer`: owns HTTP/WebSocket server lifecycle and broadcasts.
- `PiRemoteAdapter`: owns the seam around Pi APIs.
- `RemoteEventStream`: owns Pi event mapping and remote event broadcast.

## Security posture

Default to safe local use:

- bind to localhost by default;
- require explicit LAN exposure;
- never add unauthenticated command execution or Pi event broadcast;
- avoid logging secrets and large prompt/tool payloads;
- validate all external protocol input at runtime;
- keep token storage in-memory on the extension side until persistent-device revocation UX is designed.

## iOS direction

Prefer SwiftUI-first architecture with UIKit only as a targeted escape hatch for heavy timeline/code/diff rendering if profiling proves need.

The iOS client uses SwiftUI + TCA. Its design includes:

- WebSocket envelope receive loop;
- request/response correlation by `id`;
- server event stream by `seq`;
- capability checking from `server.hello`;
- stable `response.ok` decoding through `{ ok, command, result }`;
- `state.changed` handling after state-changing commands;
- Keychain device-token storage;
- reconnect/backoff;
- pairing UX with code entry and QR deep links.

## Documentation discipline

Whenever an important change happens:

1. Update `AGENTS.md`.
2. Update `PLAN.md` if phase/status/architecture changes.
3. Update `docs/PROTOCOL.md` if wire messages change.
4. Update `docs/SECURITY.md` if security assumptions change.
5. Update `docs/SWIFT_CLIENT_NOTES.md` if iOS behaviour changes.
6. Update tests when protocol guarantees change.

## Build checks

For TypeScript changes run:

```bash
npm run typecheck
```

For protocol, auth, WebSocket, runtime, or event-stream changes run:

```bash
npm test
```

For Swift/iOS changes run:

```bash
xcodebuild -project Pi/Pi.xcodeproj -scheme Pi -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -skipMacroValidation test
```

For new protocol/auth behaviour, add or update a WebSocket integration test.
