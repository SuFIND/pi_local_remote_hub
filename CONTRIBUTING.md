# Contributing

pi_local_remote_hub contains the Pi Remote Hub, the Pi extension and the Pi Hub
menu bar app. The iOS app is in
[pi_local_remote_ios](https://github.com/SuFIND/pi_local_remote_ios). Changes often
cross the WebSocket protocol, the TypeScript implementation, the Swift types in
the iOS app, and documentation.

## Setup

Requirements:

- Node.js 22.19 or newer
- Pi (`@earendil-works/pi-coding-agent` 1.5.0)
- Xcode 26 or newer with the macOS 26 SDK, for Pi Hub
- An iPhone and Mac on the same trusted network for physical-device testing

Install Node dependencies:

```bash
npm ci
```

Run Pi with the extension directly:

```bash
pi -e ./extension/index.ts
```

Build and open the menu bar app:

```bash
node scripts/build-mac-app.mjs --install
```

## Checks

Before opening a pull request, run:

```bash
npm run check
swift test --package-path mac/PiHub
```

Before a release, run live iOS acceptance with a configured Pi model from a
pi_local_remote_ios checkout next to this one:

```bash
../pi_local_remote_ios/scripts/run-e2e.mjs
```

`scripts/verify-linux-e2e.mjs` (Linux acceptance with Docker) still drives the
removed `/remote start` and needs porting to the hub.

## Change rules

- Keep `extension/index.ts` as a small entry point.
- Keep direct Pi calls inside `PiRemoteAdapter`.
- Keep socket lifecycle inside `RemoteConnection`.
- Keep phone protocol handling inside `PhoneSession` and session commands inside `SessionCommands`.
- Mirror wire-format changes in `Pi/Pi/Core/Protocol/` in pi_local_remote_ios.
- Update `docs/PROTOCOL.md` when messages change.
- Update `docs/SECURITY.md` when security assumptions change.
- Add tests for protocol, authentication, and runtime behavior.
- Avoid unrelated formatting and refactoring.

Swift code uses two-space indentation. TypeScript follows the existing tab-based style.

## Security reports

Do not open public issues for vulnerabilities. Follow `SECURITY.md` instead.

## License

By contributing, you agree that your contribution is licensed under the MIT License.
