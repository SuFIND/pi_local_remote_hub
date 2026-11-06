import Darwin
import Foundation
import PiHubCore

/// Runs `node hub/bin.mjs run` as a child of the app and restarts it when it
/// exits on its own. A hub that is already running (started from a terminal
/// or by launchd) is left alone and only observed.
@MainActor
final class HubSupervisor {
  enum Ownership: Equatable {
    /// No hub answers and none is starting.
    case none
    /// This app started the hub; quitting the app stops it.
    case owned
    /// Another process runs the hub.
    case external
  }

  let config: HubLaunchConfig
  private(set) var ownership: Ownership = .none
  /// Why the hub is not running (launch failure or last exit), for the menu.
  private(set) var lastProblem: String?
  /// Called when a restart is due, so the caller can check the socket first.
  var onRestartDue: (() -> Void)?

  private var process: Process?
  private var launchedAt = Date()
  private var backoff = RestartBackoff()
  private var restartTask: Task<Void, Never>?
  private var stopping = false

  init(config: HubLaunchConfig) {
    self.config = config
  }

  var isStarting: Bool { process != nil || restartTask != nil }

  /// Call after every status check: starts the hub when nothing answers.
  func reconcile(hubAnswers: Bool) {
    if hubAnswers {
      if process == nil { ownership = .external }
      lastProblem = nil
      return
    }
    if ownership == .external { ownership = .none }
    guard process == nil, restartTask == nil, !stopping else { return }
    launch()
  }

  /// Stops the hub this app started (SIGTERM, then SIGKILL after 5 s).
  func stopOwned() async {
    stopping = true
    restartTask?.cancel()
    restartTask = nil
    guard let process else { return }
    if process.isRunning { process.terminate() }
    for _ in 0..<50 where process.isRunning {
      try? await Task.sleep(for: .milliseconds(100))
    }
    if process.isRunning { kill(process.processIdentifier, SIGKILL) }
    self.process = nil
    ownership = .none
  }

  /// Stops whichever hub runs (an external one by pid) and starts it under this app.
  func restart(externalPID: Int?, stillAnswers: @escaping () async -> Bool) async {
    await stopOwned()
    if let pid = externalPID, pid > 0 {
      kill(pid_t(pid), SIGTERM)
      for _ in 0..<50 {
        if !(await stillAnswers()) { break }
        try? await Task.sleep(for: .milliseconds(100))
      }
    }
    stopping = false
    backoff.reset()
    ownership = .none
    launch()
  }

  private func launch() {
    if let problem = config.problem(fileExists: { FileManager.default.fileExists(atPath: $0) }) {
      lastProblem = problem
      return
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: config.nodePath)
    process.arguments = [config.scriptPath, "run"]
    process.environment = config.environment(base: ProcessInfo.processInfo.environment)
    process.currentDirectoryURL = URL(fileURLWithPath: config.scriptPath).deletingLastPathComponent()
    process.standardInput = FileHandle.nullDevice
    if let log = openLog() {
      process.standardOutput = log
      process.standardError = log
    }
    process.terminationHandler = { [weak self] finished in
      let status = finished.terminationStatus
      Task { @MainActor in self?.exited(finished, status: status) }
    }
    do {
      try process.run()
      self.process = process
      launchedAt = Date()
      ownership = .owned
      lastProblem = nil
    } catch {
      lastProblem = "Could not start the hub: \(error.localizedDescription)"
    }
  }

  private func exited(_ finished: Process, status: Int32) {
    guard process === finished else { return }
    process = nil
    ownership = .none
    guard !stopping else { return }
    lastProblem = "The hub exited (status \(status)). Restarting…"
    let delay = backoff.nextDelay(ranFor: Date().timeIntervalSince(launchedAt))
    restartTask = Task { [weak self] in
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      self?.restartTask = nil
      self?.onRestartDue?()
    }
  }

  /// The hub's log, opened for appending (the hub truncates it when it grows).
  private func openLog() -> FileHandle? {
    try? FileManager.default.createDirectory(
      atPath: config.stateDirectory,
      withIntermediateDirectories: true,
      attributes: [.posixPermissions: 0o700]
    )
    let fd = open(config.logPath, O_WRONLY | O_APPEND | O_CREAT, 0o600)
    return fd >= 0 ? FileHandle(fileDescriptor: fd, closeOnDealloc: true) : nil
  }
}
