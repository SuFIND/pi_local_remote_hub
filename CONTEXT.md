# Context

## Domain glossary

### Pi Remote

The local-first remote-control system that lets a paired client control the Pi sessions on one Mac over the LAN.

### Pi Remote Hub

The one resident process per Mac that owns the LAN listener, pairing and trusted devices, knows every running Pi process (they register over a local socket), and starts Pi for sessions the phone opens.

### Pi Hub (menu bar app)

The macOS menu bar app (`mac/PiHub`) that runs the hub as its child process, restarts it when it exits, and shows its running Pi sessions, connected and paired iPhones and shared folders. Quitting it stops the hub it started; a hub started elsewhere is only observed.

### Shared folders (roots)

The folders listed in `hub.json`. The phone can browse, open and create sessions only inside them.

### Attached session

The one session a phone connection is currently looking at. Its status is **terminal** (a Pi window owns it), **background** (a hub-started Pi owns it) or **stopped** (saved on disk; the next command starts Pi for it).

### Hub-started Pi

A `pi --mode rpc` process the hub launched for a phone. It exits after `idleExitMinutes` without work and is never stopped mid-run.

### Handoff

Moving a session from a hub-started Pi to a terminal that opened it, so a session has one writer. Immediate when idle; after the current run otherwise, followed by `/remote takeover` in the terminal.

### Remote client

A client application, primarily the native iOS app, connected to the Pi Remote WebSocket endpoint.

### Pairing window

The short-lived state created by `pair` (`node hub/bin.mjs pair` or `/remote pair`) during which a new remote client can exchange the displayed pairing code for a device token.

### Device Trust

The domain concept covering how a remote client becomes trusted, reconnects, and is revoked. It includes pairing, token issuance, token verification, and trusted-device listing.

### Device token

A high-entropy secret returned once after successful pairing. The iOS app stores it in Keychain. The hub stores only a hash, in `trusted-devices.json`.

### Remote Session

The authenticated-or-pairing conversation between one WebSocket connection and the hub (`PhoneSession`). It owns auth state, browsing, and which session the phone is attached to.

### Remote Runtime

The hub's listener state: bound LAN address, Bonjour advertisement, pairing window, and trust rotation (`status`, `pair`, `rotate`).

### Remote Event Stream

The mapped, sanitized, sequenced stream of Pi events sent to authenticated remote clients.

### Remote Session State

The app-visible state snapshot of the attached session: cwd, session file, model, idle/busy status, pending messages, and context usage.

### Connection Reliability

The policy that decides what happens when the WebSocket drops and how often the iOS client keepalives. Owns the backoff schedule, the keepalive cadence, and the rule that user-initiated disconnects never auto-reconnect. Lives behind a pure-function seam so it can be exercised without a clock or store.
