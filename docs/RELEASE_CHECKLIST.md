# Public release checklist

## Repository

- [x] Split pi-remote-ios into `pi_local_remote_hub` (this repository) and `pi_local_remote_ios`, keeping the original author's commits.
- [x] Add the MIT license, keeping the original copyright notice.
- [x] Add contribution, privacy, and vulnerability-reporting guides.
- [x] Add extension, hub and Pi Hub test checks in GitHub Actions.
- [x] Remove personal Apple teams, bundle identifiers, hostnames, addresses and work email from the source and the history.
- [ ] Add a public description and repository topics.
- [ ] Confirm the first CI run passes.
- [ ] Enable GitHub private vulnerability reporting.

## Branding

- [x] Verify that Pi and the Pi website use the MIT License.
- [x] Confirm the logo asset can be included under MIT with its notice.
- [x] Preserve the Pi website copyright and license notice.
- [x] Add a clear non-affiliation statement.
- [x] Use the original Pi Remote app icon (not the official Pi logo) for Pi Hub.

The website license grants copyright permission for its source and assets. The
press kit also publishes the logo for download and editorial placement. No
published Pi trademark policy grants the right to present the logo as another
product's primary mark. The press-kit contact is `rfc@earendil.com`.

## Pi package

- [x] Add Pi package metadata and an npm file whitelist.
- [x] Update `ws` to a release without known production advisories.
- [x] Verify the production dependency audit is clean.
- [x] Verify the package contains only the extension, hub, protocol/security docs, and license files.
- [x] Verify the package tarball contents with `npm pack --dry-run --ignore-scripts`.
- [ ] Test `pi install git:github.com/SuFIND/pi_local_remote_hub@v0.1.0` from a clean environment.

npm publication is not required for the source release. Before a later npm release:

- [ ] Update Pi after its npm package stops pinning vulnerable `brace-expansion@5.0.7`; this affects development installs only.
- [ ] Authenticate to npm and reserve `pi-local-remote-hub`.
- [ ] Publish with two-factor authentication and provenance.
- [ ] Test `pi install npm:pi-local-remote-hub@<version>` from a clean environment.

## Hub and Pi Hub

- [x] Run the Node suite, including hub integration over pinned `wss://`.
- [x] Run the Pi Hub core tests and render the menu and settings snapshots.
- [x] Pair, browse, open and prompt from a physical iPhone against the hub.
- [ ] Port `scripts/verify-linux-e2e.mjs` to the hub.
- [ ] Verify QR pairing, IP-change reconnect and revoke on a physical iPhone.
- [ ] Publish release notes with supported Pi, macOS and Node versions.
