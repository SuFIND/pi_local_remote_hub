# Pi Remote for iOS

<p align="center">
  <img src="https://raw.githubusercontent.com/tornikegomareli/pi-remote-ios/main/Pi/Pi/Assets.xcassets/AppIcon.appiconset/AppIcon.png" width="128" alt="Pi Remote app icon">
</p>

[![CI](https://github.com/tornikegomareli/pi-remote-ios/actions/workflows/ci.yml/badge.svg)](https://github.com/tornikegomareli/pi-remote-ios/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-white.svg)](LICENSE)

Control an active [Pi](https://pi.dev) coding-agent session from a native iPhone app.

This repository contains both required halves:

- a TypeScript Pi extension that exposes a paired WebSocket endpoint;
- a SwiftUI iOS app that connects, authenticates, and controls the active session.

> [!WARNING]
> A paired phone can submit prompts that cause Pi to run shell commands. Treat
> remote access as terminal access to your account and current project.

Pi Remote for iOS is an independent community project. It is not affiliated
with or endorsed by Earendil Inc.

## Status

The project is an early preview. The extension works as a Pi package, while the
iOS app currently requires an Xcode build from source.

It controls the active interactive Pi session. It does not run a background Pi
daemon or manage multiple sessions.

## What it can do

- Pair through a six-digit code or QR deep link.
- Store the device token in iOS Keychain.
- Reconnect with bounded backoff and keepalive checks.
- Send prompts as normal, steering, or follow-up messages.
- Abort and compact the active session.
- Change the active model and thinking level.
- Stream assistant output and tool execution events.
- Restore current branch history after reconnecting.
- Render edit and write diffs natively on iOS.
- Connect across networks through an ephemeral Cloudflare Quick Tunnel.

## How it works

```text
iPhone app
    │ paired WebSocket protocol
    ▼
Pi extension inside the active terminal process
    │ Pi extension API
    ▼
Current Pi session
```

The extension validates every incoming envelope, authenticates each connection,
and sends Pi events only to authenticated clients. The protocol is versioned
and documented in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Requirements

- macOS with [Pi](https://pi.dev) installed; version 0.83.0 is currently tested
- Node.js 22.19 or newer for extension development
- Xcode 26.2 or newer
- iOS 26.2 for the current app target
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for remote access

Install `cloudflared` on macOS:

```bash
brew install cloudflared
```

## Install the Pi extension

Install the Pi package directly from GitHub:

```bash
pi install git:github.com/tornikegomareli/pi-remote-ios
```

For development from a local checkout:

```bash
git clone https://github.com/tornikegomareli/pi-remote-ios.git
cd pi-remote-ios
npm ci
pi -e ./extension/index.ts
```

The repository also includes `.pi/settings.json`, so running `pi` from its root
loads the local extension automatically.

## Build the iOS app

Open `Pi/Pi.xcodeproj` in Xcode. Select your own development team and bundle
identifier before running on a physical device.

For a simulator build:

```bash
xcodebuild -project Pi/Pi.xcodeproj \
  -scheme Pi \
  -destination 'generic/platform=iOS Simulator' \
  -skipMacroValidation \
  build
```

## Pair and connect

Start Pi, then run:

```text
/remote start
```

Pi starts a localhost WebSocket server and a Cloudflare Quick Tunnel. It prints
a public `wss://` URL, a short-lived pairing code, and a QR deep link.

Scan the QR code from the iPhone Camera app or enter the URL and code manually.
The pairing code expires after two minutes and stops working after one success.

For simulator-only access without a tunnel:

```text
/remote start --local
```

For an iPhone on the same trusted LAN:

```text
/remote start --local --host 0.0.0.0
```

LAN binding exposes the server to other devices on that network. Authentication
still applies, but only use this mode on a network you trust.

## Remote commands

```text
/remote status
/remote stop
/remote rotate
```

`/remote rotate` revokes trusted devices for the running Pi process and creates
a new pairing window.

## Development

Install dependencies and run extension checks:

```bash
npm ci
npm run check
```

Run the iOS tests:

```bash
xcodebuild -project Pi/Pi.xcodeproj \
  -scheme Pi \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -skipMacroValidation \
  test
```

The extension test suite covers protocol decoding, authentication, tunnel
lifecycle, event mapping, diff payloads, and WebSocket integration.

Use `examples/edit-diff-playground.ts` to exercise edit and write diff rendering
from a connected phone without modifying application source.

Regenerate the original app icon variants with Pillow installed:

```bash
python3 scripts/generate-app-icon.py
```

## Documentation

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md): WebSocket envelopes, commands, events, and error codes
- [`docs/SECURITY.md`](docs/SECURITY.md): threat model and security invariants
- [`docs/SWIFT_CLIENT_NOTES.md`](docs/SWIFT_CLIENT_NOTES.md): iOS integration behavior
- [`PLAN.md`](PLAN.md): architecture and implementation status
- [`CONTRIBUTING.md`](CONTRIBUTING.md): development and contribution rules
- [`SECURITY.md`](SECURITY.md): private vulnerability reporting
- [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md): remaining publication blockers

## License and branding

Project code is available under the [MIT License](LICENSE).

The Pi logo and animation are adapted from Pi's MIT-licensed website and press
kit. Their copyright notice is preserved in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The MIT license does not
grant trademark rights, and use of the Pi name or logo does not imply endorsement.
