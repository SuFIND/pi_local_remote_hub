# Public release checklist

## Repository

- [x] Rename the repository to `pi-remote-ios`.
- [x] Add a public description and repository topics.
- [x] Add the MIT license.
- [x] Add contribution, privacy, and vulnerability-reporting guides.
- [x] Add extension and iOS test checks in GitHub Actions.
- [x] Remove local work records and the obsolete pre-Tuist project.
- [x] Scan current source and all Git refs with Gitleaks.
- [x] Remove the personal Apple development team from the Xcode project.
- [x] Scan the full Git history with Gitleaks.

## Branding

- [x] Verify that Pi and the Pi website use the MIT License.
- [x] Confirm the logo asset can be included under MIT with its notice.
- [x] Preserve the Pi website copyright and license notice.
- [x] Add a clear non-affiliation statement.
- [x] Choose an original Pi Remote app icon instead of using the official Pi logo as the product mark.

The website license grants copyright permission for its source and assets. The
press kit also publishes the logo for download and editorial placement. No
published Pi trademark policy grants the right to present the logo as another
product's primary mark. The press-kit contact is `rfc@earendil.com`.

## Pi package

- [x] Add Pi package metadata and an npm file whitelist.
- [x] Update `ws` to a release without known production advisories.
- [x] Verify the production dependency audit is clean.
- [x] Verify the package contains only the extension, protocol/security docs, and license files.
- [x] Add direct installation from the GitHub repository.
- [x] Verify the package tarball contents with `npm pack --dry-run --ignore-scripts`.
- [ ] Test `pi install git:github.com/tornikegomareli/pi-remote-ios` after publication.

npm publication is not required for the source preview. Before a later npm release:

- [ ] Update Pi after its npm package stops pinning vulnerable `brace-expansion@5.0.7`; this affects development installs only.
- [ ] Authenticate to npm and reserve `pi-remote-ios`.
- [ ] Publish with two-factor authentication and provenance.
- [ ] Test `pi install npm:pi-remote-ios@<version>` from a clean environment.

## iOS app

- [x] Build the app for a generic iOS Simulator destination.
- [x] Set the display name to `Pi Remote`.
- [x] Repair the `PiTests` target and add pairing/reconnect policy coverage.
- [x] Create original light, dark, and tinted Pi Remote app icons.
- [x] Keep iOS distribution source-only; no App Store release is planned.
- [x] Preserve third-party notices in the source distribution.
- [x] Generate the iOS app and test targets from pinned Tuist manifests.
- [x] Run 44 unit tests on an iOS Simulator.
- [x] Run live E2E for manual pairing, QR deep link, prompt completion, background return, token reconnect, and network interruption.
- [x] Build, install, and launch the signed app on a physical iPhone.
- [x] Run Linux extension pairing and token reconnect through Docker.

## First public preview

- [x] Confirm the README installation form against established Pi extensions.
- [ ] Make the repository public.
- [ ] Test a clean GitHub installation.
- [ ] Confirm the first public CI run passes.
- [ ] Enable GitHub private vulnerability reporting.
- [ ] Tag `v0.1.0` only after public CI and installation pass.
- [ ] Publish release notes with supported Pi, iOS, Xcode, Tuist, and Node versions.
