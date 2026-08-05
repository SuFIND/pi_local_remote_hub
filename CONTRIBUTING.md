# Contributing

Pi Remote for iOS contains a Pi extension and an iOS app. Changes often cross
the WebSocket protocol, TypeScript implementation, Swift types, and documentation.

## Setup

Requirements:

- Node.js 22.19 or newer
- Pi (`@earendil-works/pi-coding-agent` 0.83.0)
- Xcode 26.2 or newer
- Tuist 4.202.6, pinned in `.mise.toml`
- An iPhone and Mac on the same trusted network for physical-device testing

Install Node dependencies:

```bash
npm ci
```

Run Pi with the extension directly:

```bash
pi -e ./extension/index.ts
```

Generate the iOS workspace and run its tests:

```bash
mise trust
mise install
tuist install
tuist generate --no-open
xcodebuild -workspace Pi.xcworkspace \
  -scheme Pi \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -skipMacroValidation \
  test
```

## Checks

Before opening a pull request, run:

```bash
npm run check
tuist install
tuist generate --no-open
xcodebuild -workspace Pi.xcworkspace \
  -scheme Pi \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -skipMacroValidation \
  test
```

Before a release, run live iOS acceptance with a configured Pi model:

```bash
scripts/run-e2e.mjs
```

Run Linux extension acceptance with Docker:

```bash
scripts/verify-linux-e2e.mjs
```

## Change rules

- Keep `extension/index.ts` as a small entry point.
- Keep direct Pi calls inside `PiRemoteAdapter`.
- Keep socket lifecycle inside `RemoteConnection`.
- Keep authenticated command handling inside `RemoteSession`.
- Mirror wire-format changes in `Pi/Pi/Core/Protocol/`.
- Treat `Project.swift` and `Tuist/Package.swift` as the iOS project source of truth.
- Regenerate after adding source files or changing project settings.
- Update `docs/PROTOCOL.md` when messages change.
- Update `docs/SECURITY.md` when security assumptions change.
- Add tests for protocol, authentication, and runtime behavior.
- Avoid unrelated formatting and refactoring.

Swift code uses two-space indentation. TypeScript follows the existing tab-based style.

## Security reports

Do not open public issues for vulnerabilities. Follow `SECURITY.md` instead.

## License

By contributing, you agree that your contribution is licensed under the MIT License.
