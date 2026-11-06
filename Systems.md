# Systems.md — Expanded System Prompt for This Repository

> [!NOTE]
> Superseded in part: Pi Remote now runs as one resident **Pi Remote Hub** per Mac (`hub/`), and `/remote start`/`stop`/`autostart` are gone. See `AGENTS.md`, `README.md` and `docs/PROTOCOL.md` for the current architecture; the rest of this file is kept as design history. The iOS app (`Pi/`, `Project.swift`, `Tuist/`, `docs/SWIFT_CLIENT_NOTES.md`) has moved to [pi_local_remote_ios](https://github.com/SuFIND/pi_local_remote_ios); paths to it below refer to that repository.

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
- `RemoteEventStream`: owns Pi event mapping, structured phase changes, and remote event broadcast.
- `QuestionBroker`: owns one reconnect-safe pending `remote_question` interaction.
- `RemoteSessionMonitor`: owns the session phase shown to remote clients.
- `RunEvidenceCollector`: owns bounded run evidence until `agent_settled`.

## Security posture

Default to trusted local-network use:

- bind to the Pi host's LAN interface for `/remote start`;
- do not expose the listener to the public Internet;
- never add unauthenticated command execution or Pi event broadcast;
- avoid logging secrets and large prompt/tool payloads;
- never include session content in Live Activity or notification text;
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
- pairing UX with code entry and QR deep links;
- explicit Queue/Steer delivery while Pi is busy;
- blocking question cards above the composer;
- host, branch, and structured phase context;
- completion evidence with command outcomes and changed files;
- iOS 26 continued-processing monitoring for user-started runs;
- privacy-safe local needs-input and completion notifications.

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
tuist install
tuist generate --no-open
xcodebuild -workspace Pi.xcworkspace -scheme Pi -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -skipMacroValidation test
```

`Project.swift` and `Tuist/Package.swift` are the iOS project source of truth. The pre-Tuist project remains available in Git history.

For new protocol/auth behaviour, add or update a WebSocket integration test.
