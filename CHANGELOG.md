# Changelog

Notable changes to Pi Remote. Versions follow [Semantic Versioning](https://semver.org);
the Pi package (`package.json`), the iOS app (`MARKETING_VERSION`) and Pi Hub share one
version.

## 0.1.0 — 2026-11-06

The first release: drive every Pi session on a Mac from an iPhone over the local network,
for free, with no SSH, cloud relay or terminal multiplexer.

### Pi Remote Hub

- One resident hub per Mac owns the TLS WebSocket server (self-signed certificate pinned by
  fingerprint), Bonjour advertising, pairing and trusted devices. Pi processes register with
  it over a local socket and never listen on the network.
- The phone browses the shared folders, opens any running or saved Pi session, resumes a
  saved one in a background Pi (which exits after three idle minutes), and starts new ones.
- Running and recent sessions across the shared folders, and search by name, prompts and
  folder with the matching text quoted.
- One writer per session: a terminal that opens a session takes it over, and a run driven
  from the phone is shown live in that terminal, which reloads when the run ends.
- History answers stay under 4 MiB so long sessions load on the phone.
- `status`, `GET /version` and the hub log report the version.

### iOS app

- Pairs by QR code or six-digit code, finds Macs nearby over Bonjour, and reconnects after
  network changes and Wi-Fi address changes.
- Session browser: running and recent sessions first, each shared folder as a collapsible
  tree of the projects Pi ran in, and debounced search with highlighted matches.
- Assistant Markdown laid out like the terminal: paragraphs, nested lists, tables, quotes.
- The Session Inspector shows the app version.

### Pi Hub (macOS menu bar app)

- Runs the hub as its child process and restarts it if it exits; optional Open at Login.
- A "P" in the menu bar marks a connected iPhone and a hub that is starting or down.
- Its panel shows how many iPhones are paired and in use, and Pair iPhone; a settings window
  holds General, Shared Folders, iPhones and Pi Sessions. Liquid Glass on macOS 26 and later.

### Build

- The Xcode project reads the signing team and bundle identifier from the git-ignored
  `Pi/Signing.local.xcconfig`.
