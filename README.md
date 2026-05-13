# pi-remote-control

Secure WebSocket remote-control extension for active Pi sessions.

## Current capabilities

- `/remote start` starts the server **and immediately enables pairing**.
- `/remote status` shows URL, connection count, trusted-device count, and active pairing code if any.
- `/remote stop` shuts down the server and disables pairing.
- WebSocket protocol at `/v1/ws`.
- Short-lived pairing code auth.
- In-memory device tokens.
- Authenticated commands:
  - `session.getState`
  - `session.prompt`
  - `session.abort`
  - `session.compact`

## Try locally

```bash
npm install
npm run typecheck
npm test
pi
```

This repo includes `.pi/settings.json`, so starting Pi from the repo root loads `../extension/index.ts` automatically.

For a one-off test from any checkout, use:

```bash
pi -e ./extension/index.ts
```

Inside Pi:

```text
/remote start
```

Pi will print a WebSocket URL and pairing code. The iOS app connects to that URL, sends `auth.pair.request`, receives a device token, and stores it in Keychain.

Default bind address is `127.0.0.1:3769`.

LAN exposure is explicit:

```text
/remote start --host 0.0.0.0 --port 3769
```

> Security: remote control is equivalent to terminal access through Pi. Use only on trusted networks or behind a trusted tunnel.

Source lives in `extension/`. Do not move it under `extensions/`; project-local Pi discovery is configured through `.pi/settings.json`.

See:

- `AGENTS.md`
- `Systems.md`
- `PLAN.md`
- `docs/PROTOCOL.md`
- `docs/SECURITY.md`
- `docs/SWIFT_CLIENT_NOTES.md`
