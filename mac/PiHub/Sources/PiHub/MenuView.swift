import PiHubCore
import ServiceManagement
import SwiftUI

/// The menu bar window: hub status, running Pi sessions, phones, shared
/// folders, paired iPhones and settings.
struct MenuView: View {
  @Bindable var model: HubModel
  @State private var contentHeight: CGFloat = 0

  private static let maxContentHeight: CGFloat = 520

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HeaderView(model: model)
      Divider()
      if model.pairing != nil {
        PairingPanel(model: model)
      } else {
        ScrollView {
          sections
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { contentHeight = $0 }
        }
        .frame(height: min(max(contentHeight, 60), Self.maxContentHeight))
      }
      if let error = model.actionError {
        Divider()
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.caption)
          .foregroundStyle(.red)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
      }
      Divider()
      FooterView(model: model)
    }
    .frame(width: 380)
  }

  @ViewBuilder
  private var sections: some View {
    VStack(alignment: .leading, spacing: 14) {
      switch model.connection {
      case .running:
        if let overview = model.overview {
          SessionsSection(model: model, overview: overview)
          PhonesSection(overview: overview)
          FoldersSection(model: model, overview: overview)
          DevicesSection(model: model, overview: overview)
          SettingsSection(model: model, overview: overview)
        }
      case .starting:
        HStack(spacing: 8) {
          ProgressView().controlSize(.small)
          Text("Starting the hub…").foregroundStyle(.secondary)
        }
      case .outdated:
        Notice(
          symbol: "arrow.clockwise.circle",
          text: "The running hub is older than this app. Restart it to show its sessions.",
          action: ("Restart Hub", { Task { await model.restartHub() } })
        )
      case .stopped(let problem):
        Notice(
          symbol: "bolt.horizontal.circle",
          text: problem ?? "The hub is not running.",
          action: ("Start Hub", { Task { await model.restartHub() } })
        )
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

// MARK: - Header and footer

private struct HeaderView: View {
  let model: HubModel

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Image(systemName: model.menuBarSymbol)
          .foregroundStyle(.secondary)
        Text("Pi Remote Hub").font(.headline)
        Spacer()
        StatusPill(model: model)
      }
      if let status = model.overview?.status {
        if let url = status.displayWebSocketUrl ?? status.webSocketUrl {
          HStack(spacing: 4) {
            Text(url).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            Button {
              model.copy(status.webSocketUrl ?? url)
            } label: {
              Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .help("Copy the pinned address")
          }
          .foregroundStyle(.secondary)
        }
        HStack(spacing: 10) {
          if let fingerprint = status.fingerprintShort {
            Label(fingerprint, systemImage: "lock.shield")
          }
          if let bonjour = status.bonjour {
            Label(bonjour.active ? "Bonjour on" : "Bonjour off", systemImage: "dot.radiowaves.left.and.right")
          }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        if let error = status.lastError {
          Label(error, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
        }
      }
    }
    .padding(12)
  }
}

private struct StatusPill: View {
  let model: HubModel

  var body: some View {
    let (text, color): (String, Color) = switch model.connection {
    case .running where model.overview?.status.running == true: ("Running", .green)
    case .running: ("Not listening", .orange)
    case .starting: ("Starting…", .secondary)
    case .outdated: ("Outdated", .orange)
    case .stopped: ("Stopped", .red)
    }
    HStack(spacing: 4) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(text).font(.caption.weight(.medium))
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(.quaternary, in: Capsule())
    .help(model.hubIsExternal ? "Started outside this app; quitting Pi Hub leaves it running." : "Runs as part of Pi Hub.")
  }
}

private struct FooterView: View {
  let model: HubModel

  var body: some View {
    HStack {
      Button {
        Task { await model.startPairing() }
      } label: {
        Label("Pair iPhone…", systemImage: "qrcode")
      }
      .disabled(model.overview?.status.running != true || model.pairing != nil)

      Spacer()

      Menu {
        Button("Open Hub Log") { model.openLog() }
        Button("Show State Folder") { model.reveal(model.launch.stateDirectory) }
        Divider()
        Button(model.hubIsExternal ? "Restart Hub in Pi Hub" : "Restart Hub") {
          Task { await model.restartHub() }
        }
      } label: {
        Image(systemName: "gearshape")
      }
      .menuStyle(.borderlessButton)
      .menuIndicator(.hidden)
      .fixedSize()

      Button("Quit") { NSApp.terminate(nil) }
        .help(model.ownsHub ? "Quit Pi Hub and stop the hub" : "Quit Pi Hub")
    }
    .padding(10)
  }
}

// MARK: - Sections

private struct SessionsSection: View {
  let model: HubModel
  let overview: HubOverview

  var body: some View {
    MenuSection(title: "Pi Sessions", count: overview.agents.count) {
      if overview.agents.isEmpty {
        Placeholder("No Pi is running. Open a session on the iPhone, or run pi in a terminal.")
      }
      ForEach(sortedAgents) { agent in
        AgentRow(model: model, agent: agent)
      }
    }
  }

  /// Watched and working sessions first, then by folder.
  private var sortedAgents: [AgentSummary] {
    overview.agents.sorted { left, right in
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
  @State private var hovering = false

  var body: some View {
    HStack(alignment: .top, spacing: 8) {
      Image(systemName: agent.isBackground ? "gearshape.2" : "terminal")
        .foregroundStyle(agent.busy ? Color.orange : Color.secondary)
        .frame(width: 18)
        .padding(.top, 1)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(HubFormatting.title(of: agent))
            .font(.system(size: 13, weight: .medium))
            .lineLimit(1)
          if agent.busy { Badge("Working", color: .orange) }
          Badge(agent.isBackground ? "Background" : "Terminal", color: .secondary)
          if !agent.shared { Badge("Not shared", color: .secondary) }
          Spacer(minLength: 0)
          if agent.isBackground, hovering {
            Button {
              Task { await model.stop(agent) }
            } label: {
              Image(systemName: "stop.circle")
            }
            .buttonStyle(.borderless)
            .help("Stop this hub-started Pi (the session stays on disk)")
          }
        }
        Text(HubFormatting.abbreviate(agent.cwd))
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
          .truncationMode(.middle)
        HStack(spacing: 8) {
          if !agent.viewers.isEmpty {
            Label(agent.viewers.joined(separator: ", "), systemImage: "iphone")
              .foregroundStyle(Color.accentColor)
          }
          if let modelName = agent.model {
            Text(modelName).foregroundStyle(.tertiary)
          }
          Text("active \(HubFormatting.relative(agent.lastActivityAt))").foregroundStyle(.tertiary)
        }
        .font(.caption2)
        .lineLimit(1)
      }
    }
    .contentShape(Rectangle())
    .onHover { hovering = $0 }
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

private struct PhonesSection: View {
  let overview: HubOverview

  var body: some View {
    MenuSection(title: "Connected iPhones", count: overview.phones.count) {
      if overview.phones.isEmpty {
        Placeholder("No iPhone is connected.")
      }
      ForEach(overview.phones) { phone in
        HStack(alignment: .top, spacing: 8) {
          Image(systemName: "iphone").frame(width: 18).foregroundStyle(Color.accentColor)
          VStack(alignment: .leading, spacing: 2) {
            Text(phone.deviceName).font(.system(size: 13, weight: .medium))
            Text(HubFormatting.activity(of: phone, agents: overview.agents))
              .font(.caption)
              .foregroundStyle(.secondary)
              .lineLimit(1)
            Text([phone.remoteAddress, "since \(HubFormatting.relative(phone.connectedAt))"].compactMap { $0 }.joined(separator: " · "))
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
        }
      }
    }
  }
}

private struct FoldersSection: View {
  let model: HubModel
  let overview: HubOverview

  var body: some View {
    MenuSection(title: "Shared Folders", count: overview.roots.count) {
      if overview.roots.isEmpty {
        Placeholder("Nothing is shared. The iPhone sees only sessions inside shared folders.")
      }
      ForEach(overview.roots, id: \.self) { root in
        HStack(spacing: 8) {
          Image(systemName: "folder").frame(width: 18).foregroundStyle(.secondary)
          Text(HubFormatting.abbreviate(root))
            .lineLimit(1)
            .truncationMode(.middle)
          Spacer()
          ConfirmButton(symbol: "minus.circle", confirmText: "Stop sharing", help: "Stop sharing this folder") {
            Task { await model.removeRoot(root) }
          }
        }
        .contextMenu {
          Button("Show in Finder") { model.reveal(root) }
          Button("Copy Path") { model.copy(root) }
        }
      }
      Button {
        model.chooseFolderToShare()
      } label: {
        Label("Share a Folder…", systemImage: "plus")
      }
      .buttonStyle(.borderless)
    }
  }
}

private struct DevicesSection: View {
  let model: HubModel
  let overview: HubOverview

  var body: some View {
    MenuSection(title: "Paired iPhones", count: overview.devices.count) {
      if overview.devices.isEmpty {
        Placeholder("No iPhone is paired yet. Use Pair iPhone below.")
      }
      ForEach(overview.devices) { device in
        HStack(spacing: 8) {
          Image(systemName: "checkmark.shield").frame(width: 18).foregroundStyle(.secondary)
          VStack(alignment: .leading, spacing: 1) {
            Text(device.name)
            Text("last seen \(HubFormatting.relative(device.lastSeenAt)) · \(device.id.prefix(8))")
              .font(.caption2)
              .foregroundStyle(.tertiary)
          }
          Spacer()
          ConfirmButton(symbol: "xmark.circle", confirmText: "Revoke", help: "Revoke this iPhone; it must pair again") {
            Task { await model.revoke(device) }
          }
        }
      }
    }
  }
}

private struct SettingsSection: View {
  let model: HubModel
  let overview: HubOverview

  var body: some View {
    MenuSection(title: "Settings", count: nil) {
      HStack {
        Text("Stop idle background Pi after")
        Spacer()
        Text(HubFormatting.minutes(overview.idleExitMinutes)).monospacedDigit()
        Stepper(
          "",
          onIncrement: { Task { await model.setIdleMinutes(min(overview.idleExitMinutes.rounded(.down) + 1, 120)) } },
          onDecrement: { Task { await model.setIdleMinutes(max(overview.idleExitMinutes.rounded(.up) - 1, 1)) } }
        )
        .labelsHidden()
      }
      Toggle(
        "Open Pi Hub at Login",
        isOn: Binding(
          get: { model.loginItemStatus == .enabled || model.loginItemStatus == .requiresApproval },
          set: { model.setOpenAtLogin($0) }
        )
      )
      if model.loginItemStatus == .requiresApproval {
        Button("Approve in System Settings › Login Items…") { model.openLoginItemsSettings() }
          .buttonStyle(.link)
          .font(.caption)
      }
    }
  }
}

// MARK: - Building blocks

private struct MenuSection<Content: View>: View {
  let title: String
  let count: Int?
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 4) {
        Text(title.uppercased())
        if let count { Text("\(count)").foregroundStyle(.tertiary) }
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(.secondary)
      content
    }
  }
}

private struct Badge: View {
  let text: String
  let color: Color

  init(_ text: String, color: Color) {
    self.text = text
    self.color = color
  }

  var body: some View {
    Text(text)
      .font(.system(size: 10, weight: .medium))
      .foregroundStyle(color)
      .padding(.horizontal, 5)
      .padding(.vertical, 1)
      .overlay(Capsule().strokeBorder(color.opacity(0.5), lineWidth: 0.5))
  }
}

private struct Placeholder: View {
  let text: String

  init(_ text: String) {
    self.text = text
  }

  var body: some View {
    Text(text)
      .font(.caption)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
  }
}

private struct Notice: View {
  let symbol: String
  let text: String
  let action: (String, () -> Void)

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label(text, systemImage: symbol)
        .fixedSize(horizontal: false, vertical: true)
      Button(action.0, action: action.1)
    }
  }
}

/// A small icon button that asks once more before it acts.
private struct ConfirmButton: View {
  let symbol: String
  let confirmText: String
  let help: String
  let action: () -> Void
  @State private var armed = false

  var body: some View {
    if armed {
      Button(confirmText, role: .destructive) {
        armed = false
        action()
      }
      .controlSize(.small)
      .task {
        try? await Task.sleep(for: .seconds(4))
        armed = false
      }
    } else {
      Button {
        armed = true
      } label: {
        Image(systemName: symbol)
      }
      .buttonStyle(.borderless)
      .foregroundStyle(.secondary)
      .help(help)
    }
  }
}
