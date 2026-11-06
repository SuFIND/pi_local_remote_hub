# Pi Remote for iOS

<p align="center">
  <img src="./docs/assets/pi-remote-hero.webp" width="100%" alt="Pi Remote controlling the same live session in Ghostty and the iPhone Simulator">
</p>

[![CI](https://github.com/tornikegomareli/pi-remote-ios/actions/workflows/ci.yml/badge.svg)](https://github.com/tornikegomareli/pi-remote-ios/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-white.svg)](LICENSE)

Control the [Pi](https://pi.dev) coding-agent sessions on your Mac from a native iPhone app.

This repository contains all three parts:

- **Pi Remote Hub** (`hub/`): one resident process per Mac that serves the phone
  on the LAN (TLS, Bonjour, pairing) and starts Pi for sessions the phone opens;
- a TypeScript **Pi extension** that registers every Pi window with the hub;
- a SwiftUI **iOS app** that connects, authenticates, and controls a session.

> [!WARNING]
> A paired phone can submit prompts that cause Pi to run shell commands. Treat
> remote access as terminal access to your account and current project.

Pi Remote for iOS is an independent community project. It is not affiliated
with or endorsed by Earendil Inc.

## Status

The project is an early preview. The extension works as a Pi package, while the
iOS app currently requires an Xcode build from source.

The phone pairs once with the hub, browses the folders you share, and opens any
Pi session in them: one running in a terminal, or a saved one that the hub
resumes in the background (and stops again after three idle minutes).

## iOS app

<table>
  <tr>
    <td align="center" width="50%">
      <img src="./docs/assets/pi-remote-aurora.webp" width="100%" alt="Aurora Glow around an active Pi run">
      <br><strong>Aurora Glow</strong><br>
      The screen edge and run shelf show active work.
    </td>
    <td align="center" width="50%">
      <img src="./docs/assets/pi-remote-skills.webp" width="100%" alt="Pi skill autocomplete in the iOS composer">
      <br><strong>Skills</strong><br>
      Search host-side skills from the composer.
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <img src="./docs/assets/pi-remote-models.webp" width="100%" alt="Model and thinking-level controls">
      <br><strong>Model &amp; Thinking</strong><br>
      Change the active model and thinking level.
    </td>
    <td align="center" width="50%">
      <img src="./docs/assets/pi-remote-queue.webp" width="100%" alt="A queued follow-up while Pi is working">
      <br><strong>Queued follow-up</strong><br>
      Add a message without interrupting the current run.
    </td>
  </tr>
</table>

## What it can do

- Pair through a six-digit code or QR deep link.
- Store the device token in iOS Keychain.
- Reconnect with bounded backoff and keepalive checks.
- Send prompts immediately, queue follow-ups, or steer Pi's active work.
- Show sending failures inline and retry them without retyping.
- Abort and compact the active session.
- Change the active model and thinking level.
- Discover and invoke Pi skills through slash autocomplete.
- Show host, project, branch, model, and structured session status.
- Answer blocking Pi questions through first-class mobile cards.
- Show an Aurora edge glow while Pi is working.
- Stream assistant output and grouped tool execution events.
- Copy or share completed assistant responses.
- Restore current branch history and pending questions after reconnecting.
- Continue monitoring a user-started run after the app is minimized on iOS 26.
- Receive privacy-safe local alerts when Pi needs input or finishes.
- Summarize commands, failures, and changed files after Pi settles.
- Render edit and write diffs natively on iOS.
- Connect an iPhone and Pi host on the same local network.

## How it works

```text
iPhone app
    │ wss:// on the LAN (pinned TLS, paired token)
    ▼
Pi Remote Hub  (Pi Hub menu bar app or launchd agent, ~/.pi/agent/pi-remote/)
    │ Unix socket hub.sock (0600)            starts `pi --mode rpc --session …`
    ▼                                         ▼
Pi windows in your terminals            hub-started Pi (no terminal)
    └──────── Pi Remote extension in every Pi process ────────┘
```

The hub validates every incoming envelope, authenticates each connection, and
routes a phone's commands to the Pi process that owns the session it opened.
Each session has one writer: when you open a session in a terminal that the hub
is running for the phone, the terminal takes over (immediately if idle, after
the current run otherwise, reloading the newest messages by itself). The
protocol is versioned and documented in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

When a user sends a prompt, the iOS app submits an iOS 26 continued-processing
task. The system provides a Live Activity while the app monitors the run in the
background. Pi Remote sends generic local notifications for needs-input and
completion events. These surfaces never contain prompts, responses, commands,
paths, or credentials.

Background monitoring is best-effort. It stops if the user removes the app from
the app switcher, the system expires the task, or the local connection cannot be
restored. Pi continues running on the host computer. This local-only path does not use APNs.

## Compatibility

| Component | Preview baseline | Validation |
|---|---|---|
| Pi | 1.5.0 | Extension, protocol, and live-prompt E2E |
| Node.js | 22.19 or newer | Ubuntu CI and Debian Bookworm E2E |
| macOS host | Current macOS | Physical iPhone acceptance |
| Linux host | Node 22 on Debian Bookworm | Docker protocol E2E; physical iPhone-to-Linux LAN testing remains open |
| Xcode | 27.1 or newer | Checked-in `Pi/Pi.xcodeproj`, Simulator, and signed device builds |
| Tuist (optional) | 4.202.6 | Only for regenerating from `Project.swift`; pinned in `.mise.toml` |
| iOS | 26.2 or newer | Current deployment target |

The iPhone and Pi host must share a local network. On Linux, allow inbound TCP traffic on port `3769`. On macOS, allow incoming connections for `node` when the firewall asks.

The hub binds the Mac's private LAN address (preferring `en0`), skips VPN, bridge, and container interfaces, and follows the address when it changes.

## Install the Pi extension

Review the extension source before installation. Pi packages run with your full user permissions.

Install the tagged preview for all projects:

```bash
pi install git:github.com/tornikegomareli/pi-remote-ios@v0.1.0-preview.1
```

For the current project only, add `-l`:

```bash
pi install -l git:github.com/tornikegomareli/pi-remote-ios@v0.1.0-preview.1
```

Try it for one Pi process without changing settings:

```bash
pi -e git:github.com/tornikegomareli/pi-remote-ios@v0.1.0-preview.1
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

## Run the hub

The hub needs the same checkout (or package install) as the extension.

### Pi Hub menu bar app (macOS)

```bash
node scripts/build-mac-app.mjs --install   # builds and opens ~/Applications/Pi Hub.app
```

Pi Hub lives in the menu bar (no Dock icon). It starts the hub, restarts it if it
exits, and shows:

- running Pi sessions — name, folder, Terminal or Background, Working, model, the
  iPhone viewing it, and Not shared when its folder is outside the shared folders;
  hover a Background session to stop that Pi;
- connected iPhones and what each one is viewing;
- shared folders (add or remove), paired iPhones (revoke), and the idle time for
  hub-started Pi;
- **Pair iPhone…** — a QR code and the six-digit code with a countdown.

Quitting Pi Hub stops the hub it started. Turn on **Open Pi Hub at Login** in its
menu to keep it running after a restart (macOS may ask you to approve it under
System Settings › General › Login Items). A hub that already runs (from a terminal
or the launchd agent below) is only observed; **Restart Hub in Pi Hub** in the
gear menu hands it over. The build records this checkout's `hub/bin.mjs`, the
`node` that ran the script, and a PATH that reaches `pi` in the app's Info.plist,
so rebuild after moving the checkout or switching Node versions.

### Command line

From the repository root:

```bash
node hub/bin.mjs roots add ~/code      # share a folder: its sessions and subfolders
node hub/bin.mjs install               # run at login (launchd) and start now
node hub/bin.mjs pair                  # 2-minute pairing code + QR
```

`node hub/bin.mjs run` runs it in the foreground instead of installing it, and
`uninstall` removes the login item. The configuration lives in
`~/.pi/agent/pi-remote/hub.json` (`roots`, `idleExitMinutes` = 3, `port` = 3769,
`piCommand`, extra `piArgs` for hub-started Pi); the hub reloads it on change.
Sessions are read from Pi's session folder (`~/.pi/agent/sessions`, or
`PI_CODING_AGENT_SESSION_DIR` when set for the hub).
Logs go to `~/.pi/agent/pi-remote/hub.log`.

Pi windows find the hub on their own; start the hub before or after them.

## Build the iOS app

The iOS app is source-only. You need an Apple ID that Xcode can use for device signing.

Open the checked-in project. No Tuist or mise is needed:

```bash
open Pi/Pi.xcodeproj
```

A free personal team is enough. Under **Signing & Capabilities**, choose your team for the `Pi` target and, if needed, change the bundle identifier (default `com.insanearts.Pi`). Select your iPhone and press **Run**. On the first install, trust the developer under **Settings → General → VPN & Device Management**. Free-team builds expire after seven days; run again from Xcode to renew.

Aurora's shader needs the Metal toolchain: `xcodebuild -downloadComponent MetalToolchain`.

For a Simulator build:

```bash
xcodebuild -project Pi/Pi.xcodeproj \
  -scheme Pi \
  -destination 'generic/platform=iOS Simulator' \
  -skipMacroValidation \
  build
```

The Simulator does not provide the VisionKit camera scanner. Pair by pasting the `wss://` URL printed by `node hub/bin.mjs pair` and entering the code.

`Project.swift` + `Tuist/` remain for optional Tuist users (`tuist generate` writes `Pi.xcworkspace` at the repo root). Keep package pins in both places in sync.

## Pair and connect

Run `node hub/bin.mjs pair` (or `/remote pair` in any Pi window). The hub serves
a TLS WebSocket (`wss://`) on the Mac's private LAN address and advertises it
over Bonjour (`_pi-remote._tcp`). Pairing prints the URL with the certificate
pin (`#fp=…`), the short host fingerprint, a short-lived pairing code, and a QR
deep link.

Scan the QR code from the Pi Remote pairing screen or with the iPhone Camera
app. Or tap the Pi under **Nearby** (or paste the printed `wss://` URL), enter
the code, and tap **Connect & Pair**. Compare the fingerprint shown by the app
with the `Fingerprint:` line in Pi.

The pairing code expires after two minutes and stops working after one success.

The TLS identity and trusted devices live in `~/.pi/agent/pi-remote/`, so a
paired iPhone survives hub and Mac restarts. When the Mac's IP changes, the hub
rebinds and the app finds it again by fingerprint over Bonjour.

Traffic is encrypted, and the app pins the host certificate, so a LAN peer can
neither read the session nor impersonate the Mac. A paired phone still has
terminal-equivalent control: do not use port forwarding or an Internet tunnel.

## Remote commands

In any Pi window:

```text
/remote status                      hub address, shared folders, Pi sessions online
/remote pair                        pairing code + QR
/remote devices
/remote revoke <device-id-prefix>
/remote rotate                      revoke every device
/remote takeover                    reload this window's session from disk
```

The same management commands exist on the CLI: `node hub/bin.mjs status|pair|devices|revoke <id>|roots [add|remove <dir>]|idle <minutes>`.
Set `PI_REMOTE_DISABLE=1` to keep one Pi process from registering with the hub.

## Development

Install dependencies and run extension checks:

```bash
npm ci
npm run check
```

Run the Pi Hub (menu bar app) tests, and render its menu with sample data:

```bash
swift test --package-path mac/PiHub
PI_HUB_SNAPSHOT=/tmp/menu.png "$(swift build --package-path mac/PiHub --show-bin-path)/PiHub"   # writes menu-{light,dark,pairing}.png
```

Run the iOS tests:

```bash
xcodebuild -project Pi/Pi.xcodeproj \
  -scheme Pi \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -skipMacroValidation \
  test
```

The test suite covers protocol decoding, authentication, event mapping,
question recovery, run evidence, diff payloads, the session index, and hub
integration (phones over pinned `wss://`, Pi processes over the hub socket,
background start, idle exit, session switches, and terminal handoff).

Run the full iOS E2E test against a real hub, the Pi it starts, and a configured model:

```bash
scripts/run-e2e.mjs
```

It pairs, opens the shared folder, starts a session, prompts, and checks background return, cold-launch resume, and reconnect after a hub restart. If several matching Simulators exist, set `PI_E2E_SIMULATOR_ID`. Set `PI_E2E_MODEL` to use another configured model, and `PI_E2E_EXTENSIONS` (comma-separated paths) when that model's provider is registered by an extension. The run uses a throwaway `PI_REMOTE_STATE_DIR`, `PI_CODING_AGENT_SESSION_DIR` and shared folder, so it never touches your paired devices or sessions.

`scripts/verify-linux-e2e.mjs` (Linux acceptance through Docker) still drives the removed `/remote start` and needs porting to the hub.

Use `examples/edit-diff-playground.ts` to exercise edit and write diff rendering
from a connected phone without modifying application source.

The live-session app icon source is `Pi/Design/AppIcon-LiveSession.svg`.
Regenerate its light, dark, and tinted variants with Inkscape and ImageMagick:

```bash
brew install --cask inkscape
brew install imagemagick
scripts/export-app-icon.sh
```

## Documentation

- [`docs/PROTOCOL.md`](docs/PROTOCOL.md): WebSocket envelopes, commands, events, and error codes
- [`docs/SECURITY.md`](docs/SECURITY.md): threat model and security invariants
- [`docs/SWIFT_CLIENT_NOTES.md`](docs/SWIFT_CLIENT_NOTES.md): iOS integration behavior
- [`docs/TUIST_MIGRATION.md`](docs/TUIST_MIGRATION.md): generated-project setup and migration decisions
- [`PLAN.md`](PLAN.md): architecture and implementation status
- [`CONTRIBUTING.md`](CONTRIBUTING.md): development and contribution rules
- [`PRIVACY.md`](PRIVACY.md): local data flow, storage, permissions, and deletion
- [`SECURITY.md`](SECURITY.md): private vulnerability reporting
- [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md): remaining publication blockers

## License and branding

Project code is available under the [MIT License](LICENSE).

The Pi logo and animation are adapted from Pi's MIT-licensed website and press
kit. Their copyright notice is preserved in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). The MIT license does not
grant trademark rights, and use of the Pi name or logo does not imply endorsement.
