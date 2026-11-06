import AppKit
import Foundation
import Observation
import PiHubCore
import ServiceManagement

/// State and actions behind the menu: polls the hub's `overview` every two
/// seconds, keeps the hub running through `HubSupervisor`, and sends the
/// control requests the menu offers.
@MainActor
@Observable
final class HubModel {
  enum Connection: Equatable {
    case starting
    case running
    /// The hub answers but predates the menu's control requests.
    case outdated
    case stopped(String?)
  }

  private(set) var overview: HubOverview?
  private(set) var connection: Connection = .starting
  /// The last failed action, shown until the next one.
  var actionError: String?
  /// The open pairing window (code, link, expiry).
  var pairing: HubStatus?
  /// Set when a phone paired while the pairing panel was open.
  private(set) var justPaired: String?
  private(set) var loginItemStatus: SMAppService.Status = SMAppService.mainApp.status

  let launch: HubLaunchConfig
  @ObservationIgnored private let client: HubControlClient
  @ObservationIgnored private let supervisor: HubSupervisor
  @ObservationIgnored private var pollTask: Task<Void, Never>?
  @ObservationIgnored private var devicesWhenPairing: Set<String> = []

  init(launch: HubLaunchConfig = HubModel.resolveLaunch()) {
    self.launch = launch
    client = HubControlClient(socketPath: launch.socketPath, timeout: 4)
    supervisor = HubSupervisor(config: launch)
    supervisor.onRestartDue = { [weak self] in
      Task { await self?.refresh() }
    }
  }

  /// Fixed data for previews and screenshots; never starts or polls a hub.
  convenience init(preview overview: HubOverview, pairing: HubStatus? = nil) {
    self.init(launch: HubLaunchConfig(nodePath: "", scriptPath: "", searchPath: "", stateDirectory: NSTemporaryDirectory()))
    self.overview = overview
    self.pairing = pairing
    connection = .running
  }

  static func resolveLaunch() -> HubLaunchConfig {
    HubLaunchConfig.resolve(
      info: Bundle.main.infoDictionary ?? [:],
      defaults: UserDefaults.standard.dictionaryRepresentation(),
      environment: ProcessInfo.processInfo.environment,
      home: NSHomeDirectory()
    )
  }

  // MARK: - Lifecycle

  func start() {
    guard pollTask == nil else { return }
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        let fast = self?.overview == nil
        try? await Task.sleep(for: .seconds(fast ? 1 : 2))
      }
    }
  }

  var ownsHub: Bool { supervisor.ownership == .owned }
  var hubIsExternal: Bool { supervisor.ownership == .external }

  /// Before the app quits: stop the hub it started.
  func stopHub() async {
    pollTask?.cancel()
    await supervisor.stopOwned()
  }

  func refresh() async {
    do {
      let overview: HubOverview = try await client.request("overview")
      self.overview = overview
      connection = .running
      supervisor.reconcile(hubAnswers: true)
      notePairing(overview)
    } catch HubControlError.notRunning {
      overview = nil
      supervisor.reconcile(hubAnswers: false)
      connection = supervisor.isStarting ? .starting : .stopped(supervisor.lastProblem)
    } catch HubControlError.emptyAnswer {
      overview = nil
      supervisor.reconcile(hubAnswers: true)
      connection = .outdated
    } catch {
      overview = nil
      connection = .stopped(error.localizedDescription)
    }
    loginItemStatus = SMAppService.mainApp.status
  }

  // MARK: - Menu bar

  var menuBarSymbol: String {
    guard connection == .running, let overview else {
      return connection == .starting ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash"
    }
    if !overview.status.running { return "exclamationmark.triangle" }
    return overview.phones.isEmpty ? "antenna.radiowaves.left.and.right" : "iphone.radiowaves.left.and.right"
  }

  // MARK: - Actions

  func startPairing() async {
    devicesWhenPairing = Set(overview?.devices.map(\.id) ?? [])
    justPaired = nil
    await perform {
      self.pairing = try await self.client.request("pair", as: HubStatus.self)
    }
  }

  func closePairing() {
    pairing = nil
    justPaired = nil
  }

  func revoke(_ device: TrustedDevice) async {
    await perform {
      _ = try await self.client.request("revoke", args: ["id": .string(device.id)], as: TrustedDevice.self)
      await self.refresh()
    }
  }

  func addRoot(_ path: String) async {
    await update("addRoot", ["path": .string(path)])
  }

  func removeRoot(_ path: String) async {
    await update("removeRoot", ["path": .string(path)])
  }

  func setIdleMinutes(_ minutes: Double) async {
    await update("setIdle", ["minutes": .number(minutes)])
  }

  func stop(_ agent: AgentSummary) async {
    await update("stopAgent", ["agentId": .string(agent.agentId)])
  }

  /// Stops whichever hub runs and starts a fresh one under this app.
  func restartHub() async {
    connection = .starting
    let pid = hubIsExternal || connection == .outdated ? overview?.pid ?? externalPID() : nil
    overview = nil
    await supervisor.restart(externalPID: pid) { [client] in
      (try? await client.request("status", as: HubStatus.self)) != nil
    }
    await refresh()
  }

  func chooseFolderToShare() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Share"
    panel.message = "Choose a folder to share with Pi Remote. Its sessions and subfolders become visible on your iPhone."
    NSApp.activate()
    panel.begin { [weak self] response in
      guard response == .OK, let url = panel.url else { return }
      Task { await self?.addRoot(url.path) }
    }
  }

  func setOpenAtLogin(_ enabled: Bool) {
    do {
      if enabled {
        try SMAppService.mainApp.register()
      } else {
        try SMAppService.mainApp.unregister()
      }
      actionError = nil
    } catch {
      actionError = "Open at Login: \(error.localizedDescription)"
    }
    loginItemStatus = SMAppService.mainApp.status
  }

  func openLoginItemsSettings() {
    SMAppService.openSystemSettingsLoginItems()
  }

  func openLog() {
    NSWorkspace.shared.open(URL(fileURLWithPath: overview?.logPath ?? launch.logPath))
  }

  func reveal(_ path: String) {
    NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true))
  }

  func copy(_ text: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
  }

  // MARK: - Private

  private func update(_ op: String, _ args: [String: ControlValue]) async {
    await perform {
      self.overview = try await self.client.request(op, args: args, as: HubOverview.self)
    }
  }

  private func perform(_ body: () async throws -> Void) async {
    do {
      try await body()
      actionError = nil
    } catch {
      actionError = error.localizedDescription
    }
  }

  private func notePairing(_ overview: HubOverview) {
    guard pairing != nil, justPaired == nil else { return }
    if let device = overview.devices.first(where: { !devicesWhenPairing.contains($0.id) }) {
      justPaired = device.name
    }
  }

  /// The pid of a hub too old to report one, from its log line `hub_started`.
  private func externalPID() -> Int? {
    guard let log = try? String(contentsOfFile: launch.logPath, encoding: .utf8) else { return nil }
    for line in log.split(separator: "\n").reversed() where line.contains("\"hub_started\"") {
      if let range = line.range(of: #""pid":(\d+)"#, options: .regularExpression) {
        return Int(line[range].dropFirst(6))
      }
    }
    return nil
  }
}
