# Security Notes

Pi Remote should be treated as equivalent to terminal access to the machine running Pi.

## Current defaults

- One Pi Remote Hub process per Mac serves the phone; Pi windows never listen on the network.
- The hub binds only the host's private LAN address (preferring `en0`; VPN, bridge, and container interfaces are skipped) and rebinds when DHCP changes it.
- Peers outside loopback, RFC 1918, link-local, and IPv6 ULA ranges are dropped at the TCP level.
- Transport is TLS (`https` / `wss`, TLS 1.2 minimum) with a self-signed ECDSA P-256 host certificate.
- The service is advertised over Bonjour as `_pi-remote._tcp` (macOS `dns-sd`).
- WebSocket path is `/v1/ws`.
- Message size is limited by the WebSocket server.
- Browser `Origin` is checked when present.
- Unauthenticated clients can only receive `server.hello`, send `connection.ping`, or authenticate.
- Pi events, blocking questions, and completion evidence are delivered only to authenticated clients.
- Question text and answers are bounded and never written to structured logs.
- Authenticated clients can list skill names and descriptions; that listing omits source paths.
- Invoked skills run with the active Pi session's tools and permissions.
- Server closes unauthenticated clients after the auth timeout with close code `4001`.
- Server closes inactive clients after heartbeat timeout with close code `4000`.
- Unauthenticated connections close after timeout.

## Pairing model

- Pairing code is 6 digits formatted as `123-456`.
- Code is generated on request only: `node hub/bin.mjs pair` or `/remote pair`.
- Code expires after 2 minutes.
- Code allows 5 failed attempts.
- Successful pairing disables the code.
- Run `pair` again to create a fresh pairing code. The hub never opens pairing by itself.
- The QR code printed alongside the textual code encodes a `pi-remote://pair?url=...&code=...` deep link whose URL carries the certificate pin (`#fp=…`). It carries no credentials beyond what is already on screen; anyone in viewing distance of the terminal during the 2-minute window has equivalent access via either form.
- iOS registers the `pi-remote` URL scheme. When a deep link reaches the app, the reducer auto-fires `auth.pair.request` against the embedded host + code. The app refuses the deep link if the user is already authenticated to a session — they must explicitly forget the device first. The same one-time pairing-code constraints apply (2-minute window, 5 failed attempts, single successful pair).

## Token model

- Device tokens are high-entropy random values.
- Tokens are returned once after pairing.
- Swift app should store tokens in Keychain.
- Server stores only salted hashes.
- Trusted devices (token hashes + server secret) persist in `~/.pi/agent/pi-remote/trusted-devices.json` (directory `0700`, file `0600`; override the directory with `PI_REMOTE_STATE_DIR`). Revoked devices that are connected are closed with `4003` at once.
- A corrupt trust file is moved aside and treated as empty (fail closed).
- `/remote rotate` also rotates the server secret, invalidating every outstanding token.

## Local network transport

- The hub exposes `wss://<host-lan-address>:3769/v1/ws` to the local network (another free port if 3769 is taken; Bonjour tells the phone).
- The host identity (`tls-key.pem` `0600`, `tls-cert.pem`) lives next to the trust file. Its pin is the base64url SHA-256 of the certificate DER; `/remote status` prints its first 8 bytes as `Fingerprint: XXXX XXXX XXXX XXXX`.
- The pin travels only in URL fragments (`wss://…#fp=<pin>`), which are never sent on the wire, and in the Bonjour TXT record.
- The iOS app pins the leaf certificate: a different certificate fails the handshake. A URL entered without `#fp=` is pinned on first use (TOFU) — compare the fingerprint the app shows with the Mac before pairing.
- The app refuses plain `ws://` except to loopback hosts.
- Bonjour TXT exposes only the public fingerprint, address, port, path, project folder name, and a 16-hex SHA-256 tag of the working directory. A spoofed advertisement cannot pass the pin check.
- Pairing codes and device tokens still control access; TLS protects them in transit.

## Execution policy

Pi Remote does not add an approval gate around Pi tools. A paired phone can steer the agent, answer questions, and cause Pi to continue using the active session's tools and permissions. This is intentional YOLO execution, so pairing grants terminal-equivalent control.

The `remote_question` tool pauses only when Pi needs a user decision and a phone is attached. Pending questions stay in the Pi process for reconnect, expire after ten minutes, and are cancelled when Pi aborts or exits.

Completion evidence can include Bash commands and changed file paths. It uses the same authenticated WebSocket boundary as transcript tool output and must not be copied into diagnostics.

## Background monitoring and notifications

A prompt sent from the iOS app can start an iOS 26 continued-processing task. This keeps the existing authenticated local WebSocket eligible for background runtime while the system grants the task. iOS owns the resulting Live Activity.

Live Activity titles, phase subtitles, and local notifications contain only generic state such as working, needs input, completed, failed, or stopped. They never contain prompts, responses, tool output, commands, file paths, hostnames, branch names, tokens, or pairing codes.

This path does not use APNs. Monitoring stops if iOS expires the task, the user removes the app from the app switcher, reconnect attempts fail, or the user disconnects. Stopping mobile monitoring does not stop Pi on the host computer.

## Hub

- **Local socket.** Pi processes register over `hub.sock` in the state directory (`0700` directory, `0600` socket). Only processes of the same user can connect, and that user already has terminal access; the socket also carries the management commands of `/remote`, the hub CLI and the Pi Hub menu bar app (pairing, revoking, sharing folders, idle time, stopping a hub-started Pi).
- **Shared folders.** The phone can list, open and create sessions only in folders inside `roots` (`hub.json`), compared after resolving symlinks; anything else is `OUTSIDE_ROOTS`. File contents are never listed. `roots` bounds what the phone can browse and where the hub starts Pi; it is not a sandbox, because Pi's tools keep the user's full permissions.
- **Hub-started Pi.** The hub runs `pi --mode rpc` as the user, in the session's folder, with the user's Pi settings and extensions, and marks it with a random `PI_REMOTE_SPAWN_TOKEN`. It only ever stops processes it started itself (tokens it issued in this run), and never one with a run in progress. Terminal-only dialogs (`select`, `confirm`, `input`, `editor`) are cancelled at once, so a permission prompt from another extension fails closed instead of waiting.
- **Session files.** The hub reads saved sessions without writing them; only the Pi process that owns a session appends to it. When a terminal opens a session the hub is running, the terminal takes over and the hub's Pi exits.
- **Login item.** `install` writes a per-user launchd agent (`~/Library/LaunchAgents/com.pi-remote.hub.plist`) that runs the hub as the user; `uninstall` removes it.

## Do not

- Expose the local port to the public Internet.
- Forward port `3769` through a router, tunnel, or public proxy.
- Use Pi Remote on public, guest, or untrusted Wi-Fi.
- Log tokens, pairing codes, full prompts, or tool outputs.
- Add unauthenticated command endpoints.
