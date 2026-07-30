# Context

## Domain glossary

### Pi Remote

The local-first remote-control system that lets a paired client control an active Pi session over WebSocket.

### Active Pi session

The currently running Pi interactive session that the extension is loaded into. Phase 1 controls this session only; it does not manage headless multi-session daemon workflows.

### Remote client

A client application, primarily the native iOS app, connected to the Pi Remote WebSocket endpoint.

### Pairing window

The short-lived state created by `/remote start` during which a new remote client can exchange the displayed pairing code for a device token.

### Device Trust

The domain concept covering how a remote client becomes trusted, reconnects, and is revoked. It includes pairing, token issuance, token verification, and trusted-device listing.

### Device token

A high-entropy secret returned once after successful pairing. The iOS app stores it in Keychain. The extension stores only a hash in memory.

### Remote Session

The authenticated-or-pairing conversation between one WebSocket connection and the active Pi session. It owns auth state and authenticated command handling.

### Remote Runtime

The runtime state behind `/remote start`, `/remote stop`, `/remote status`, and `/remote rotate`. It owns the invariant that `/remote start` means running and ready to pair.

### Remote Event Stream

The mapped, sanitized, sequenced stream of Pi events sent to authenticated remote clients.

### Remote Session State

The app-visible state snapshot of the active Pi session: cwd, session file, model, idle/busy status, pending messages, and context usage.

### Connection Reliability

The policy that decides what happens when the WebSocket drops and how often the iOS client keepalives. Owns the backoff schedule, the keepalive cadence, and the rule that user-initiated disconnects never auto-reconnect. Lives behind a pure-function seam so it can be exercised without a clock or store.
