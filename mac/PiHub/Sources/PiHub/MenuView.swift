import PiHubCore
import ServiceManagement
import SwiftUI

/// The menu bar window: hub status, running Pi sessions, phones, shared
/// folders, paired iPhones and settings.
///
/// macOS 26+ look: content sits in grouped, continuous-corner platters like
/// System Settings, with Settings-style icon tiles; Liquid Glass is kept to
/// the controls layer (status capsule, copy button, footer buttons), on top
/// of the system glass of the menu bar window itself.
struct MenuView: View {
  @Bindable var model: HubModel
  @State private var contentHeight: CGFloat = 0

  private static let maxContentHeight: CGFloat = 540

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HeaderView(model: model, showsAddress: model.pairing == nil)
      if model.pairing != nil {
        PairingPanel(model: model)
      } else {
        ScrollView {
          sections
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { contentHeight = $0 }
        }
        .scrollIndicators(.never)
        .frame(height: min(max(contentHeight, 60), Self.maxContentHeight))
      }
      if let error = model.actionError {
        Label(error, systemImage: "exclamationmark.triangle.fill")
          .font(.callout)
          .foregroundStyle(.red)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(10)
          .background(.red.opacity(0.12), in: .rect(cornerRadius: Metrics.platterRadius, style: .continuous))
          .padding(.horizontal, Metrics.margin)
          .padding(.bottom, 8)
      }
      FooterView(model: model)
    }
    .frame(width: 360)
  }

  @ViewBuilder
  private var sections: some View {
    VStack(alignment: .leading, spacing: 16) {
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
        Platter {
          RowLayout(icon: .progress, title: "Starting the hub…")
        }
      case .outdated:
        Notice(
          icon: IconTile(symbol: "arrow.clockwise", color: .orange),
          title: "The hub is out of date",
          text: "It was started before this version of Pi Hub. Restart it to show its sessions.",
          action: ("Restart Hub", { Task { await model.restartHub() } })
        )
      case .stopped(let problem):
        Notice(
          icon: IconTile(symbol: "bolt.horizontal.fill", color: .red),
          title: "The hub is not running",
          text: problem ?? "Phones can't reach this Mac until it runs.",
          action: ("Start Hub", { Task { await model.restartHub() } })
        )
      }
    }
    .padding(.horizontal, Metrics.margin)
    .padding(.bottom, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

private enum Metrics {
  static let margin: CGFloat = 14
  static let platterRadius: CGFloat = 14
  static let platterInset: CGFloat = 4
  /// Concentric with the platter.
  static let rowRadius: CGFloat = platterRadius - platterInset
  static let iconSize: CGFloat = 26
  static let footerButton: CGFloat = 32
  /// Where row text starts, for inset separators.
  static let textLeading: CGFloat = platterInset + 8 + iconSize + 10
}

// MARK: - Header and footer

private struct HeaderView: View {
  let model: HubModel
  let showsAddress: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Image(nsImage: NSApp.applicationIconImage)
          .resizable()
          .frame(width: 36, height: 36)
        VStack(alignment: .leading, spacing: 1) {
          Text("Pi Remote Hub").font(.headline)
          Text(summary)
            .font(.caption)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        Spacer(minLength: 8)
        StatusCapsule(model: model)
      }
      if showsAddress, let status = model.overview?.status, let url = status.displayWebSocketUrl ?? status.webSocketUrl {
        Platter {
          HStack(spacing: 10) {
            IconTile(symbol: "network", color: .blue)
            VStack(alignment: .leading, spacing: 2) {
              Text(HubFormatting.hostAndPort(of: url))
                .font(.system(.body, design: .monospaced).weight(.medium))
                .lineLimit(1)
                .textSelection(.enabled)
                .help(url)
              HStack(spacing: 10) {
                if let fingerprint = status.fingerprintShort {
                  Label(fingerprint, systemImage: "lock.fill")
                }
                if let bonjour = status.bonjour {
                  Label(bonjour.active ? "Nearby" : "Not nearby", systemImage: "dot.radiowaves.left.and.right")
                    .help(bonjour.active ? "Advertised over Bonjour as “\(bonjour.instanceName ?? "Pi")”" : (bonjour.reason ?? "Bonjour is off"))
                }
              }
              .font(.caption)
              .foregroundStyle(.secondary)
              .labelStyle(CompactLabelStyle())
            }
            Spacer(minLength: 4)
            Button {
              model.copy(status.webSocketUrl ?? url)
            } label: {
              Image(systemName: "doc.on.doc")
            }
            .buttonStyle(.glass)
            .buttonBorderShape(.circle)
            .controlSize(.small)
            .help("Copy the pinned address")
          }
          .padding(8)
        }
        if let error = status.lastError {
          Label(error, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
        }
      }
    }
    .padding(.horizontal, Metrics.margin)
    .padding(.top, 14)
    .padding(.bottom, 14)
  }

  private var summary: String {
    guard let overview = model.overview else { return "Pi on your iPhone, over the local network" }
    let sessions = overview.agents.count
    let phones = overview.phones.count
    let folders = overview.roots.count
    return [
      "\(sessions) \(sessions == 1 ? "session" : "sessions")",
      "\(phones) \(phones == 1 ? "iPhone" : "iPhones")",
      "\(folders) \(folders == 1 ? "folder" : "folders")",
    ].joined(separator: " · ")
  }
}

private struct StatusCapsule: View {
  let model: HubModel

  var body: some View {
    let (text, color): (String, Color) = switch model.connection {
    case .running where model.overview?.status.running == true: ("Running", .green)
    case .running: ("Not listening", .orange)
    case .starting: ("Starting", .secondary)
    case .outdated: ("Outdated", .orange)
    case .stopped: ("Stopped", .red)
    }
    HStack(spacing: 5) {
      Circle().fill(color).frame(width: 7, height: 7)
      Text(text).font(.caption.weight(.semibold))
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .glassEffect(.regular.tint(color.opacity(0.18)), in: .capsule)
    .help(model.hubIsExternal ? "Started outside this app; quitting Pi Hub leaves it running." : "Runs as part of Pi Hub.")
  }
}

private struct FooterView: View {
  let model: HubModel

  var body: some View {
    GlassEffectContainer(spacing: 8) {
      HStack(spacing: 8) {
        // The open pairing panel has its own Cancel.
        if model.pairing == nil {
          Button {
            Task { await model.startPairing() }
          } label: {
            Label("Pair iPhone…", systemImage: "qrcode")
              .padding(.horizontal, 4)
          }
          .buttonStyle(.glassProminent)
          .controlSize(.large)
          .disabled(model.overview?.status.running != true)
        }

        Spacer()

        // A glass button that pops up a native menu: SwiftUI's Menu does not
        // take the circular glass look.
        Button {
          PopUpMenu.show([
            .init(title: "Open Hub Log", symbol: "doc.text") { model.openLog() },
            .init(title: "Show State Folder", symbol: "folder") { model.reveal(model.launch.stateDirectory) },
            nil,
            .init(title: model.hubIsExternal ? "Restart Hub in Pi Hub" : "Restart Hub", symbol: "arrow.clockwise") {
              Task { await model.restartHub() }
            },
          ])
        } label: {
          Image(systemName: "ellipsis")
            .font(.system(size: 13, weight: .semibold))
            .frame(width: Metrics.footerButton, height: Metrics.footerButton)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .help("More")

        Button {
          NSApp.terminate(nil)
        } label: {
          Image(systemName: "power")
            .font(.system(size: 13, weight: .semibold))
            .frame(width: Metrics.footerButton, height: Metrics.footerButton)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .help(model.ownsHub ? "Quit Pi Hub and stop the hub" : "Quit Pi Hub")
      }
    }
    .padding(.horizontal, Metrics.margin)
    .padding(.top, 4)
    .padding(.bottom, Metrics.margin)
  }
}

/// A native menu at the pointer, for actions behind a custom button.
@MainActor
private enum PopUpMenu {
  struct Item {
    let title: String
    let symbol: String
    let action: () -> Void
  }

  private final class Target: NSObject {
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func run() { action() }
  }

  /// `nil` items are separators.
  static func show(_ items: [Item?]) {
    let menu = NSMenu()
    var targets: [Target] = []
    for item in items {
      guard let item else {
        menu.addItem(.separator())
        continue
      }
      let target = Target(item.action)
      targets.append(target)
      let menuItem = NSMenuItem(title: item.title, action: #selector(Target.run), keyEquivalent: "")
      menuItem.target = target
      menuItem.image = NSImage(systemSymbolName: item.symbol, accessibilityDescription: nil)
      menu.addItem(menuItem)
    }
    // popUp blocks until the menu closes, which keeps `targets` alive.
    menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    _ = targets
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

  var body: some View {
    HoverRow { hovering in
      HStack(alignment: .top, spacing: 10) {
        IconTile(
          symbol: agent.isBackground ? "iphone.gen3" : "apple.terminal.fill",
          color: agent.isBackground ? .blue : .gray
        )
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(HubFormatting.title(of: agent))
              .font(.body.weight(.medium))
              .lineLimit(1)
            Spacer(minLength: 4)
            if agent.isBackground, hovering {
              Button {
                Task { await model.stop(agent) }
              } label: {
                Image(systemName: "stop.fill")
              }
              .buttonStyle(.glass)
              .buttonBorderShape(.circle)
              .controlSize(.mini)
              .help("Stop this hub-started Pi (the session stays on disk)")
            } else if agent.busy {
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
            Spacer(minLength: 0)
            Text(HubFormatting.relative(agent.lastActivityAt)).foregroundStyle(.tertiary)
          }
          .font(.caption2)
          .lineLimit(1)
        }
      }
    }
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
        HoverRow { _ in
          RowLayout(
            icon: .tile(IconTile(symbol: "iphone", color: .blue)),
            title: phone.deviceName,
            subtitle: HubFormatting.activity(of: phone, agents: overview.agents),
            footnote: [phone.remoteAddress, "since \(HubFormatting.relative(phone.connectedAt))"].compactMap { $0 }.joined(separator: " · ")
          )
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
        HoverRow { _ in
          RowLayout(icon: .folder(root), title: HubFormatting.abbreviate(root)) {
            ConfirmButton(symbol: "minus", confirmText: "Stop Sharing", help: "Stop sharing this folder") {
              Task { await model.removeRoot(root) }
            }
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
        HoverRow { _ in
          RowLayout(icon: .tile(IconTile(symbol: "plus", color: .accentColor)), title: "Share a Folder…", tint: true)
        }
      }
      .buttonStyle(.plain)
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
        HoverRow { _ in
          RowLayout(
            icon: .tile(IconTile(symbol: "checkmark.shield.fill", color: .green)),
            title: device.name,
            subtitle: "Last seen \(HubFormatting.relative(device.lastSeenAt)) · \(device.id.prefix(8))"
          ) {
            ConfirmButton(symbol: "xmark", confirmText: "Revoke", help: "Revoke this iPhone; it must pair again") {
              Task { await model.revoke(device) }
            }
          }
        }
      }
    }
  }
}

private struct SettingsSection: View {
  let model: HubModel
  let overview: HubOverview

  private static let idleChoices: [Double] = [1, 2, 3, 5, 10, 15, 30, 60, 120]

  var body: some View {
    MenuSection(title: "Settings", count: nil) {
      RowLayout(icon: .tile(IconTile(symbol: "moon.zzz.fill", color: .indigo)), title: "Stop idle background Pi", subtitle: "Hub-started Pi with no work") {
        Picker("Stop idle background Pi", selection: idleBinding) {
          ForEach(idleChoices, id: \.self) { minutes in
            Text(HubFormatting.minutes(minutes)).tag(minutes)
          }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .fixedSize()
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 7)
      RowLayout(icon: .tile(IconTile(symbol: "power", color: .gray)), title: "Open Pi Hub at Login") {
        Toggle("Open Pi Hub at Login", isOn: loginBinding)
          .labelsHidden()
          .toggleStyle(.switch)
          .controlSize(.small)
      }
      .padding(.horizontal, 8)
      .padding(.vertical, 7)
      if model.loginItemStatus == .requiresApproval {
        Button("Approve in System Settings › Login Items…") { model.openLoginItemsSettings() }
          .buttonStyle(.link)
          .font(.caption)
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
      }
    }
  }

  private var idleChoices: [Double] {
    let current = overview.idleExitMinutes
    return Self.idleChoices.contains(current) ? Self.idleChoices : (Self.idleChoices + [current]).sorted()
  }

  private var idleBinding: Binding<Double> {
    Binding(get: { overview.idleExitMinutes }, set: { minutes in Task { await model.setIdleMinutes(minutes) } })
  }

  private var loginBinding: Binding<Bool> {
    Binding(
      get: { model.loginItemStatus == .enabled || model.loginItemStatus == .requiresApproval },
      set: { model.setOpenAtLogin($0) }
    )
  }
}

// MARK: - Building blocks

/// A titled group: the title above a platter whose rows are separated by
/// inset dividers.
private struct MenuSection<Content: View>: View {
  let title: String
  let count: Int?
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 5) {
        Text(title)
        if let count { Text("\(count)").foregroundStyle(.tertiary) }
      }
      .font(.subheadline.weight(.semibold))
      .foregroundStyle(.secondary)
      .padding(.leading, 6)
      Platter {
        Group(subviews: content) { rows in
          ForEach(rows) { row in
            if row.id != rows.first?.id {
              Divider().padding(.leading, Metrics.textLeading - Metrics.platterInset).padding(.trailing, 8)
            }
            row
          }
        }
      }
    }
  }
}

/// The grouped background, like a System Settings section.
private struct Platter<Content: View>: View {
  @ViewBuilder let content: Content

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      content
    }
    .padding(Metrics.platterInset)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.fill.quinary, in: .rect(cornerRadius: Metrics.platterRadius, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: Metrics.platterRadius, style: .continuous)
        .strokeBorder(.separator.opacity(0.6), lineWidth: 0.5)
    }
  }
}

/// A row that highlights under the pointer, inset and concentric with its platter.
private struct HoverRow<Content: View>: View {
  @ViewBuilder let content: (Bool) -> Content
  @State private var hovering = false

  var body: some View {
    content(hovering)
      .padding(.horizontal, 8)
      .padding(.vertical, 7)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        hovering ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.clear),
        in: .rect(cornerRadius: Metrics.rowRadius, style: .continuous)
      )
      .contentShape(.rect(cornerRadius: Metrics.rowRadius, style: .continuous))
      .onHover { hovering = $0 }
      .animation(.easeOut(duration: 0.12), value: hovering)
  }
}

private enum RowIcon {
  case tile(IconTile)
  case folder(String)
  case progress
}

/// Icon, title, optional subtitle and footnote, and a trailing accessory.
private struct RowLayout<Accessory: View>: View {
  let icon: RowIcon
  let title: String
  var subtitle: String?
  var footnote: String?
  var tint = false
  @ViewBuilder var accessory: Accessory

  var body: some View {
    HStack(spacing: 10) {
      iconView
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.body.weight(tint ? .regular : .medium))
          .foregroundStyle(tint ? AnyShapeStyle(.tint) : AnyShapeStyle(.primary))
          .lineLimit(1)
          .truncationMode(.middle)
        if let subtitle {
          Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
        if let footnote {
          Text(footnote).font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
        }
      }
      Spacer(minLength: 6)
      accessory
    }
  }

  @ViewBuilder
  private var iconView: some View {
    switch icon {
    case .tile(let tile):
      tile
    case .folder(let path):
      Image(nsImage: NSWorkspace.shared.icon(forFile: path))
        .resizable()
        .frame(width: Metrics.iconSize, height: Metrics.iconSize)
    case .progress:
      ProgressView()
        .controlSize(.small)
        .frame(width: Metrics.iconSize, height: Metrics.iconSize)
    }
  }
}

extension RowLayout where Accessory == EmptyView {
  init(icon: RowIcon, title: String, subtitle: String? = nil, footnote: String? = nil, tint: Bool = false) {
    self.init(icon: icon, title: title, subtitle: subtitle, footnote: footnote, tint: tint) { EmptyView() }
  }
}

/// A white SF Symbol on a colored continuous-corner tile, like System Settings.
private struct IconTile: View {
  let symbol: String
  let color: Color

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(.white)
      .frame(width: Metrics.iconSize, height: Metrics.iconSize)
      .background(color.gradient, in: .rect(cornerRadius: 7, style: .continuous))
  }
}

private struct Tag: View {
  let text: String
  let color: Color
  var spinning = false

  init(_ text: String, color: Color, spinning: Bool = false) {
    self.text = text
    self.color = color
    self.spinning = spinning
  }

  var body: some View {
    HStack(spacing: 4) {
      if spinning {
        ProgressView().controlSize(.mini).tint(color)
      }
      Text(text)
    }
    .font(.system(size: 10.5, weight: .semibold))
    .foregroundStyle(color)
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .background(color.opacity(0.14), in: .capsule)
  }
}

/// Icon and title close together, for dense secondary lines.
private struct CompactLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 3) {
      configuration.icon.imageScale(.small)
      configuration.title
    }
  }
}

private struct Placeholder: View {
  let text: String

  init(_ text: String) {
    self.text = text
  }

  var body: some View {
    Text(text)
      .font(.callout)
      .foregroundStyle(.secondary)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, 8)
      .padding(.vertical, 9)
  }
}

private struct Notice: View {
  let icon: IconTile
  let title: String
  let text: String
  let action: (String, () -> Void)

  var body: some View {
    Platter {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .top, spacing: 10) {
          icon
          VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.body.weight(.semibold))
            Text(text)
              .font(.callout)
              .foregroundStyle(.secondary)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        Button(action.0, action: action.1)
          .buttonStyle(.glassProminent)
          .frame(maxWidth: .infinity, alignment: .trailing)
      }
      .padding(10)
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
      .buttonStyle(.glassProminent)
      .tint(.red)
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
          .font(.system(size: 10, weight: .bold))
      }
      .buttonStyle(.glass)
      .buttonBorderShape(.circle)
      .controlSize(.small)
      .help(help)
    }
  }
}
