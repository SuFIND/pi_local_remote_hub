import Foundation

/// How the app starts the hub: `node <repo>/hub/bin.mjs run`.
///
/// `scripts/build-mac-app.mjs` records the `node` binary, the hub script and
/// a PATH that reaches `pi` into the app's Info.plist (`PiHubNodePath`,
/// `PiHubScriptPath`, `PiHubSearchPath`). The same keys in the app's user
/// defaults, or `PI_HUB_NODE` / `PI_HUB_SCRIPT` / `PI_HUB_PATH` in the
/// environment, override them.
public struct HubLaunchConfig: Equatable, Sendable {
  public var nodePath: String
  public var scriptPath: String
  /// PATH for the hub, so it can start `pi` like a terminal would.
  public var searchPath: String
  public var stateDirectory: String

  public var socketPath: String { (stateDirectory as NSString).appendingPathComponent("hub.sock") }
  public var logPath: String { (stateDirectory as NSString).appendingPathComponent("hub.log") }

  public static let defaultSearchPath = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

  public init(nodePath: String, scriptPath: String, searchPath: String, stateDirectory: String) {
    self.nodePath = nodePath
    self.scriptPath = scriptPath
    self.searchPath = searchPath
    self.stateDirectory = stateDirectory
  }

  /// Resolves the launch settings; environment beats user defaults beats Info.plist.
  public static func resolve(
    info: [String: Any],
    defaults: [String: Any],
    environment: [String: String],
    home: String
  ) -> HubLaunchConfig {
    func value(_ env: String, _ key: String) -> String? {
      for candidate in [environment[env], defaults[key] as? String, info[key] as? String] {
        if let candidate, !candidate.trimmingCharacters(in: .whitespaces).isEmpty { return candidate }
      }
      return nil
    }
    let node = value("PI_HUB_NODE", "PiHubNodePath") ?? "/usr/local/bin/node"
    let search = value("PI_HUB_PATH", "PiHubSearchPath") ?? defaultSearchPath
    let state = environment["PI_REMOTE_STATE_DIR"].flatMap { $0.isEmpty ? nil : $0 }
      ?? (home as NSString).appendingPathComponent(".pi/agent/pi-remote")
    return HubLaunchConfig(
      nodePath: node,
      scriptPath: value("PI_HUB_SCRIPT", "PiHubScriptPath") ?? "",
      searchPath: withNodeDirectory(search, node: node),
      stateDirectory: state
    )
  }

  /// Environment for the hub process: the user's, with PATH replaced.
  public func environment(base: [String: String]) -> [String: String] {
    var environment = base
    environment["PATH"] = searchPath
    if base["PI_REMOTE_STATE_DIR"] == nil,
       stateDirectory != ((base["HOME"] ?? NSHomeDirectory()) as NSString).appendingPathComponent(".pi/agent/pi-remote") {
      environment["PI_REMOTE_STATE_DIR"] = stateDirectory
    }
    return environment
  }

  /// What is missing before the hub can start, in words for the menu.
  public func problem(fileExists: (String) -> Bool) -> String? {
    if scriptPath.isEmpty { return "The hub script is not set. Rebuild Pi Hub with scripts/build-mac-app.mjs." }
    if !fileExists(nodePath) { return "Node.js was not found at \(nodePath)." }
    if !fileExists(scriptPath) { return "The hub script was not found at \(scriptPath)." }
    return nil
  }

  private static func withNodeDirectory(_ search: String, node: String) -> String {
    let directory = (node as NSString).deletingLastPathComponent
    var parts = search.split(separator: ":").map(String.init)
    if !directory.isEmpty, !parts.contains(directory) { parts.insert(directory, at: 0) }
    return parts.joined(separator: ":")
  }
}

/// Delay before restarting a hub that exited on its own: 1, 2, 5, 10, then 30 s.
/// A hub that ran for a minute counts as healthy and starts the schedule over.
public struct RestartBackoff: Equatable, Sendable {
  public private(set) var attempt = 0
  static let delays: [TimeInterval] = [1, 2, 5, 10, 30]
  static let healthyAfter: TimeInterval = 60

  public init() {}

  public mutating func nextDelay(ranFor uptime: TimeInterval) -> TimeInterval {
    if uptime >= Self.healthyAfter { attempt = 0 }
    let delay = Self.delays[min(attempt, Self.delays.count - 1)]
    attempt += 1
    return delay
  }

  public mutating func reset() { attempt = 0 }
}
