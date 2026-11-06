import PiHubCore
import SwiftUI

/// The panel under the menu bar "P": whether the hub runs, how many iPhones
/// are paired and in use, and Pair iPhone. Everything else (shared folders,
/// sessions, login item, idle time) lives in the settings window.
struct MenuView: View {
  @Bindable var model: HubModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      MenuHeader(model: model)
      if model.pairing != nil {
        PairingPanel(model: model)
      } else {
        content
          .padding(.horizontal, Metrics.margin)
          .padding(.bottom, 12)
      }
      if let error = model.actionError {
        ErrorBanner(text: error)
          .padding(.horizontal, Metrics.margin)
          .padding(.bottom, 8)
      }
      MenuFooter(model: model, openSettings: openSettings)
    }
    .frame(width: 330)
  }

  @ViewBuilder
  private var content: some View {
    VStack(alignment: .leading, spacing: 12) {
      switch model.connection {
      case .running:
        if let overview = model.overview {
          RunningContent(model: model, overview: overview, openSettings: openSettings)
        }
      case .starting:
        Platter {
          RowLayout(icon: .progress, title: "Starting the hub…")
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
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
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func openSettings(_ pane: SettingsPane) {
    model.showSettings(pane)
  }
}

private struct RunningContent: View {
  let model: HubModel
  let overview: HubOverview
  let openSettings: (SettingsPane) -> Void

  var body: some View {
    let inUse = HubFormatting.phonesInUse(overview.phones)
    HStack(spacing: 10) {
      StatTile(
        value: overview.devices.count,
        title: "Paired",
        caption: overview.devices.count == 1 ? "iPhone" : "iPhones",
        icon: IconTile(symbol: "checkmark.shield.fill", color: .green, size: 22),
        help: "iPhones that can connect without pairing again"
      ) { openSettings(.iphones) }
      StatTile(
        value: inUse.count,
        title: "In Use",
        caption: "connected now",
        icon: IconTile(symbol: "iphone.radiowaves.left.and.right", color: inUse.isEmpty ? .gray : .blue, size: 22),
        help: "iPhones with Pi Remote connected to this Mac right now"
      ) { openSettings(.iphones) }
    }

    if !inUse.isEmpty {
      Platter {
        ForEach(inUse) { phone in
          if phone.id != inUse.first?.id {
            Divider().padding(.leading, Metrics.textLeading - Metrics.platterInset).padding(.trailing, 8)
          }
          RowLayout(
            icon: .tile(IconTile(symbol: "iphone", color: .blue)),
            title: phone.deviceName,
            subtitle: HubFormatting.activity(of: phone, agents: overview.agents)
          )
          .padding(.horizontal, 8)
          .padding(.vertical, 7)
        }
      }
    }

    Platter {
      LinkRow(icon: IconTile(symbol: "terminal.fill", color: .indigo), title: "Pi Sessions", value: overview.agents.count) {
        openSettings(.sessions)
      }
      Divider().padding(.leading, Metrics.textLeading - Metrics.platterInset).padding(.trailing, 8)
      LinkRow(icon: IconTile(symbol: "folder.fill", color: .blue), title: "Shared Folders", value: overview.roots.count) {
        openSettings(.folders)
      }
    }

    Button {
      Task { await model.startPairing() }
    } label: {
      Label("Pair iPhone…", systemImage: "qrcode")
        .frame(maxWidth: .infinity)
    }
    .buttonStyle(.glassProminent)
    .controlSize(.large)
    .disabled(overview.status.running != true)
  }
}

private struct MenuHeader: View {
  let model: HubModel

  var body: some View {
    HStack(spacing: 10) {
      Image(nsImage: NSApp.applicationIconImage)
        .resizable()
        .frame(width: 34, height: 34)
      VStack(alignment: .leading, spacing: 1) {
        Text("Pi Remote Hub").font(.headline)
        subtitle
          .font(.caption)
          .foregroundStyle(.secondary)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      StatusCapsule(model: model)
    }
    .padding(.horizontal, Metrics.margin)
    .padding(.top, 14)
    .padding(.bottom, 12)
  }

  @ViewBuilder
  private var subtitle: some View {
    if let status = model.overview?.status, let url = status.displayWebSocketUrl ?? status.webSocketUrl {
      HStack(spacing: 6) {
        Text(HubFormatting.hostAndPort(of: url))
          .monospaced()
          .help(url)
        if let bonjour = status.bonjour {
          Image(systemName: bonjour.active ? "dot.radiowaves.left.and.right" : "wifi.slash")
            .imageScale(.small)
            .accessibilityLabel(bonjour.active ? "Nearby" : "Not nearby")
            .help(bonjour.active ? "Advertised over Bonjour as “\(bonjour.instanceName ?? "Pi")”" : (bonjour.reason ?? "Bonjour is off"))
        }
      }
    } else {
      Text("Pi on your iPhone, over the local network")
    }
  }
}

private struct MenuFooter: View {
  let model: HubModel
  let openSettings: (SettingsPane) -> Void

  var body: some View {
    GlassEffectContainer(spacing: 8) {
      HStack(spacing: 8) {
        Button {
          openSettings(model.settingsPane ?? .general)
        } label: {
          Label("Settings…", systemImage: "gearshape")
            .padding(.horizontal, 2)
        }
        .buttonStyle(.glass)
        .help("Shared folders, paired iPhones, Pi sessions, Open at Login")

        Spacer()

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
    .padding(.top, 2)
    .padding(.bottom, Metrics.margin)
  }
}

/// A big count with a title, opening the settings pane behind it.
private struct StatTile: View {
  let value: Int
  let title: String
  let caption: String
  let icon: IconTile
  let help: String
  let action: () -> Void
  @State private var hovering = false

  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          icon
          Spacer()
          Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.tertiary)
            .opacity(hovering ? 1 : 0)
        }
        Text("\(value)")
          .font(.system(size: 28, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .contentTransition(.numericText())
        VStack(alignment: .leading, spacing: 0) {
          Text(title).font(.callout.weight(.semibold))
          Text(caption).font(.caption).foregroundStyle(.secondary)
        }
      }
      .padding(10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        hovering ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(.fill.quinary),
        in: .rect(cornerRadius: Metrics.platterRadius, style: .continuous)
      )
      .overlay {
        RoundedRectangle(cornerRadius: Metrics.platterRadius, style: .continuous)
          .strokeBorder(.separator.opacity(0.6), lineWidth: 0.5)
      }
      .contentShape(.rect(cornerRadius: Metrics.platterRadius, style: .continuous))
    }
    .buttonStyle(.plain)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.12), value: hovering)
    .animation(.default, value: value)
    .help(help)
    .accessibilityLabel("\(title): \(value) \(caption)")
  }
}

/// A row with a count and a chevron, opening a settings pane.
private struct LinkRow: View {
  let icon: IconTile
  let title: String
  let value: Int
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HoverRow { _ in
        RowLayout(icon: .tile(icon), title: title) {
          HStack(spacing: 6) {
            Text("\(value)").foregroundStyle(.secondary).monospacedDigit()
            Image(systemName: "chevron.right")
              .font(.caption.weight(.semibold))
              .foregroundStyle(.tertiary)
          }
        }
      }
    }
    .buttonStyle(.plain)
  }
}

struct ErrorBanner: View {
  let text: String

  var body: some View {
    Label(text, systemImage: "exclamationmark.triangle.fill")
      .font(.callout)
      .foregroundStyle(.red)
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(10)
      .background(.red.opacity(0.12), in: .rect(cornerRadius: Metrics.platterRadius, style: .continuous))
  }
}
