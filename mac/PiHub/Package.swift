// swift-tools-version: 6.2
import PackageDescription

// Pi Hub: the macOS menu bar app that runs the Pi Remote Hub in the
// background and shows its sessions, phones and shared folders.
// Build the .app with `scripts/build-mac-app.mjs`.
let package = Package(
  name: "PiHub",
  platforms: [.macOS(.v26)],
  targets: [
    .target(name: "PiHubCore"),
    .executableTarget(name: "PiHub", dependencies: ["PiHubCore"]),
    .testTarget(name: "PiHubCoreTests", dependencies: ["PiHubCore"]),
  ]
)
