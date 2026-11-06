import PiHubCore
import SwiftUI

enum SettingsPane: String, CaseIterable, Identifiable, Hashable {
  case general
  case folders
  case iphones
  case sessions

  var id: Self { self }

  var title: String {
    switch self {
    case .general: "General"
    case .folders: "Shared Folders"
    case .iphones: "iPhones"
    case .sessions: "Pi Sessions"
    }
  }

  var symbol: String {
    switch self {
    case .general: "gearshape.fill"
    case .folders: "folder.fill"
    case .iphones: "iphone"
    case .sessions: "terminal.fill"
    }
  }

  var color: Color {
    switch self {
    case .general: .gray
    case .folders: .blue
    case .iphones: .green
    case .sessions: .indigo
    }
  }
}

/// The settings window: hub status and startup, shared folders, paired
/// iPhones and running Pi, laid out like System Settings.
struct SettingsView: View {
  static let windowID = "settings"

  @Bindable var model: HubModel
  /// Off for snapshots, which must not turn the app into a Dock app.
  var managesActivation = true

  var body: some View {
    NavigationSplitView {
      List(SettingsPane.allCases, selection: $model.settingsPane) { pane in
        Label {
          Text(pane.title)
        } icon: {
          IconTile(symbol: pane.symbol, color: pane.color, size: 20)
        }
        .badge(badge(for: pane))
        .tag(pane)
      }
      .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 240)
    } detail: {
      let pane = model.settingsPane ?? .general
      Group {
        switch pane {
        case .general: GeneralPane(model: model)
        case .folders: FoldersPane(model: model)
        case .iphones: IPhonesPane(model: model)
        case .sessions: SessionsPane(model: model)
        }
      }
      .formStyle(.grouped)
      .navigationTitle(pane.title)
      .safeAreaInset(edge: .bottom) {
        if let error = model.actionError {
          ErrorBanner(text: error).padding()
        }
      }
    }
    .frame(minWidth: 660, minHeight: 460)
    .onAppear {
      guard managesActivation else { return }
      // A Dock icon and a place in ⌘-Tab while the window is open.
      NSApp.setActivationPolicy(.regular)
      NSApp.activate()
    }
    .onDisappear {
      guard managesActivation else { return }
      NSApp.setActivationPolicy(.accessory)
    }
  }

  private func badge(for pane: SettingsPane) -> Int {
    guard let overview = model.overview else { return 0 }
    switch pane {
    case .general, .folders: return 0
    case .iphones: return HubFormatting.phonesInUse(overview.phones).count
    case .sessions: return overview.agents.count
    }
  }
}

// MARK: - General

private struct GeneralPane: View {
  @Bindable var model: HubModel

  private static let idleChoices: [Double] = [1, 2, 3, 5, 10, 15, 30, 60, 120]

  var body: some View {
    Form {
      Section {
        LabeledContent("Status") {
          StatusCapsule(model: model)
        }
        if let overview = model.overview {
          let status = overview.status
          if let url = status.displayWebSocketUrl ?? status.webSocketUrl {
            LabeledContent("Address") {
              HStack(spacing: 8) {
                Text(HubFormatting.hostAndPort(of: url))
                  .monospaced()
                  .textSelection(.enabled)
                  .help(url)
                Button {
                  model.copy(status.webSocketUrl ?? url)
                } label: {
                  Image(systemName: "doc.on.doc")
                }
                .buttonStyle(.borderless)
                .help("Copy the pinned address")
              }
            }
          }
          if let fingerprint = status.fingerprintShort {
            LabeledContent("Certificate") {
              Text(fingerprint).monospaced().textSelection(.enabled)
            }
          }
          if let bonjour = status.bonjour {
            LabeledContent("Nearby") {
              Text(bonjour.active ? "Shown as “\(bonjour.instanceName ?? "Pi")”" : (bonjour.reason ?? "Off"))
            }
          }
          LabeledContent("Process") {
            Text(processText(overview))
          }
          if let error = status.lastError {
            Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
          }
        }
      } header: {
        Text("Hub")
      } footer: {
        HStack {
          Button(restartTitle) {
            Task { await model.restartHub() }
          }
          Button("Open Log") { model.openLog() }
          Button("Show State Folder") { model.reveal(model.launch.stateDirectory) }
          Spacer()
        }
        .padding(.top, 4)
      }

      Section {
        Toggle("Open Pi Hub at Login", isOn: loginBinding)
        if model.loginItemStatus == .requiresApproval {
          Button("Approve in System Settings › Login Items…") { model.openLoginItemsSettings() }
            .buttonStyle(.link)
        }
      } header: {
        Text("Startup")
      } footer: {
        Text("The hub runs while Pi Hub is open. Quitting Pi Hub stops it, and the iPhone can't reach this Mac until it runs again.")
          .foregroundStyle(.secondary)
      }

      if let overview = model.overview {
        Section {
          Picker("Stop idle background Pi after", selection: idleBinding(overview)) {
            ForEach(idleChoices(overview), id: \.self) { minutes in
              Text(HubFormatting.minutes(minutes)).tag(minutes)
            }
          }
        } header: {
          Text("Background Pi")
        } footer: {
          Text("Pi that the hub starts for the iPhone exits after this long without work. It never stops during a run, and Pi windows in a terminal are never stopped.")
            .foregroundStyle(.secondary)
        }
      }
    }
  }

  private var restartTitle: String {
    if case .stopped = model.connection { return "Start Hub" }
    return model.hubIsExternal ? "Restart in Pi Hub" : "Restart Hub"
  }

  private func processText(_ overview: HubOverview) -> String {
    let owner = model.hubIsExternal ? "Started outside Pi Hub" : "Runs inside Pi Hub"
    return "\(owner) · pid \(overview.pid) · started \(HubFormatting.relative(overview.startedAt))"
  }

  private func idleChoices(_ overview: HubOverview) -> [Double] {
    let current = overview.idleExitMinutes
    return Self.idleChoices.contains(current) ? Self.idleChoices : (Self.idleChoices + [current]).sorted()
  }

  private func idleBinding(_ overview: HubOverview) -> Binding<Double> {
    Binding(get: { overview.idleExitMinutes }, set: { minutes in Task { await model.setIdleMinutes(minutes) } })
  }

  private var loginBinding: Binding<Bool> {
    Binding(
      get: { model.loginItemStatus == .enabled || model.loginItemStatus == .requiresApproval },
      set: { model.setOpenAtLogin($0) }
    )
  }
}

// MARK: - Shared folders

private struct FoldersPane: View {
  let model: HubModel

  var body: some View {
    Form {
      Section {
        if let overview = model.overview {
          if overview.roots.isEmpty {
            Text("Nothing is shared yet.").foregroundStyle(.secondary)
          }
          ForEach(overview.roots, id: \.self) { root in
            FolderRow(model: model, root: root, sessions: overview.agents.filter { HubFormatting.isInside($0.cwd, root: root) }.count)
          }
        } else {
          HubNotRunning()
        }
      } header: {
        Text("Shared with your iPhones")
      } footer: {
        Text("The iPhone sees Pi sessions started anywhere inside these folders, and can start new ones there. Nothing outside them is visible.")
          .foregroundStyle(.secondary)
      }

      Section {
        Button {
          model.chooseFolderToShare()
        } label: {
          Label("Add Folder…", systemImage: "plus")
        }
        .disabled(model.overview == nil)
      }
    }
  }
}

private struct FolderRow: View {
  let model: HubModel
  let root: String
  let sessions: Int

  var body: some View {
    HStack(spacing: 10) {
      Image(nsImage: NSWorkspace.shared.icon(forFile: root))
        .resizable()
        .frame(width: 28, height: 28)
      VStack(alignment: .leading, spacing: 2) {
        Text((root as NSString).lastPathComponent).font(.body.weight(.medium))
        Text(HubFormatting.abbreviate(root))
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .textSelection(.enabled)
      }
      Spacer(minLength: 8)
      if sessions > 0 {
        Tag("\(sessions) running", color: .indigo)
      }
      Button("Show in Finder") { model.reveal(root) }
        .buttonStyle(.borderless)
        .controlSize(.small)
      ConfirmButton(symbol: "minus", confirmText: "Stop Sharing", help: "Stop sharing this folder") {
        Task { await model.removeRoot(root) }
      }
    }
    .padding(.vertical, 2)
    .contextMenu {
      Button("Show in Finder") { model.reveal(root) }
      Button("Copy Path") { model.copy(root) }
    }
  }
}

// MARK: - iPhones

private struct IPhonesPane: View {
  let model: HubModel

  var body: some View {
    Form {
      Section {
        if model.pairing != nil {
          PairingPanel(model: model)
            .padding(.top, 10)
        } else {
          HStack(spacing: 12) {
            IconTile(symbol: "qrcode", color: .accentColor, size: 32)
            VStack(alignment: .leading, spacing: 2) {
              Text("Pair an iPhone").font(.body.weight(.medium))
              Text("Shows a QR code and a six-digit code to enter in Pi Remote.")
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button("Pair iPhone…") {
              Task { await model.startPairing() }
            }
            .buttonStyle(.glassProminent)
            .disabled(model.overview?.status.running != true)
          }
          .padding(.vertical, 2)
        }
      }

      if let overview = model.overview {
        let inUse = HubFormatting.phonesInUse(overview.phones).count
        Section {
          if overview.devices.isEmpty {
            Text("No iPhone is paired yet.").foregroundStyle(.secondary)
          }
          ForEach(sortedDevices(overview)) { device in
            DeviceRow(model: model, overview: overview, device: device)
          }
        } header: {
          Text("Paired iPhones · \(overview.devices.count) paired, \(inUse) in use")
        } footer: {
          Text("Revoking signs the iPhone out at once; it has to pair again to connect.")
            .foregroundStyle(.secondary)
        }
      } else {
        Section { HubNotRunning() }
      }
    }
  }

  /// Connected first, then by last seen.
  private func sortedDevices(_ overview: HubOverview) -> [TrustedDevice] {
    overview.devices.sorted { left, right in
      let leftOnline = HubFormatting.connection(of: left, in: overview.phones) != nil
      let rightOnline = HubFormatting.connection(of: right, in: overview.phones) != nil
      if leftOnline != rightOnline { return leftOnline }
      return (HubFormatting.date(left.lastSeenAt) ?? .distantPast) > (HubFormatting.date(right.lastSeenAt) ?? .distantPast)
    }
  }
}

private struct DeviceRow: View {
  let model: HubModel
  let overview: HubOverview
  let device: TrustedDevice

  var body: some View {
    let connection = HubFormatting.connection(of: device, in: overview.phones)
    HStack(spacing: 10) {
      IconTile(symbol: "iphone", color: connection == nil ? .gray : .blue, size: 28)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(device.name).font(.body.weight(.medium)).lineLimit(1)
          if connection != nil { Tag("In Use", color: .green) }
        }
        Text(detail(connection))
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Text("Paired \(HubFormatting.relative(device.createdAt)) · \(device.id.prefix(8))")
          .font(.caption2)
          .foregroundStyle(.tertiary)
      }
      Spacer(minLength: 8)
      ConfirmButton(symbol: "xmark", confirmText: "Revoke", help: "Revoke this iPhone; it must pair again") {
        Task { await model.revoke(device) }
      }
    }
    .padding(.vertical, 2)
  }

  private func detail(_ connection: PhoneSummary?) -> String {
    guard let connection else { return "Last seen \(HubFormatting.relative(device.lastSeenAt))" }
    return [
      HubFormatting.activity(of: connection, agents: overview.agents),
      connection.remoteAddress,
      "since \(HubFormatting.relative(connection.connectedAt))",
    ].compactMap { $0 }.joined(separator: " · ")
  }
}

// MARK: - Pi sessions

private struct SessionsPane: View {
  let model: HubModel

  var body: some View {
    Form {
      if let overview = model.overview {
        Section {
          if overview.agents.isEmpty {
            Text("No Pi is running. Open a session on the iPhone, or run pi in a terminal.")
              .foregroundStyle(.secondary)
          }
          ForEach(sorted(overview.agents)) { agent in
            AgentRow(model: model, agent: agent)
          }
        } header: {
          Text("Running Pi")
        } footer: {
          Text("Terminal: a Pi window on this Mac. Background: started by the hub for an iPhone; it stops after \(HubFormatting.minutes(overview.idleExitMinutes)) without work. Not shared: outside the shared folders, so the iPhone can't see it.")
            .foregroundStyle(.secondary)
        }
      } else {
        Section { HubNotRunning() }
      }
    }
  }

  /// Watched and working sessions first, then by folder.
  private func sorted(_ agents: [AgentSummary]) -> [AgentSummary] {
    agents.sorted { left, right in
      let leftRank = (left.viewers.isEmpty ? 1 : 0, left.busy ? 0 : 1, left.shared ? 0 : 1)
      let rightRank = (right.viewers.isEmpty ? 1 : 0, right.busy ? 0 : 1, right.shared ? 0 : 1)
      if leftRank != rightRank { return leftRank < rightRank }
      return left.cwd.localizedStandardCompare(right.cwd) == .orderedAscending
    }
  }
}

private struct AgentRow: View {
  let model: HubModel
  let agent: AgentSummary

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      IconTile(
        symbol: agent.isBackground ? "iphone.gen3" : "apple.terminal.fill",
        color: agent.isBackground ? .blue : .gray,
        size: 28
      )
      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Text(HubFormatting.title(of: agent))
            .font(.body.weight(.medium))
            .lineLimit(1)
          if agent.busy {
            Tag("Working", color: .orange, spinning: true)
          }
        }
        Text(HubFormatting.abbreviate(agent.cwd))
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
        HStack(spacing: 6) {
          Tag(agent.isBackground ? "Background" : "Terminal", color: .secondary)
          if !agent.shared { Tag("Not shared", color: .secondary) }
          if !agent.viewers.isEmpty {
            Label(agent.viewers.joined(separator: ", "), systemImage: "iphone")
              .labelStyle(CompactLabelStyle())
              .foregroundStyle(.tint)
          }
          if let modelName = agent.model {
            Text(modelName).foregroundStyle(.tertiary)
          }
          Text(HubFormatting.relative(agent.lastActivityAt)).foregroundStyle(.tertiary)
        }
        .font(.caption2)
        .lineLimit(1)
      }
      Spacer(minLength: 8)
      if agent.isBackground {
        Button("Stop") {
          Task { await model.stop(agent) }
        }
        .help("Stop this hub-started Pi (the session stays on disk)")
      }
    }
    .padding(.vertical, 2)
    .contextMenu {
      Button("Show Folder in Finder") { model.reveal(agent.cwd) }
      Button("Copy Folder Path") { model.copy(agent.cwd) }
      if let file = agent.sessionFile {
        Button("Copy Session File Path") { model.copy(file) }
      }
      if agent.isBackground {
        Divider()
        Button("Stop Pi") { Task { await model.stop(agent) } }
      }
    }
  }
}

private struct HubNotRunning: View {
  var body: some View {
    Label("The hub is not running. Start it under General.", systemImage: "bolt.horizontal.fill")
      .foregroundStyle(.secondary)
  }
}
