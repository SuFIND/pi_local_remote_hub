import AppKit
import PiHubCore
import SwiftUI

// Building blocks shared by the menu bar panel and the settings window.
//
// macOS 26+ look: grouped, continuous-corner platters like System Settings,
// with Settings-style icon tiles; Liquid Glass is kept to the controls layer.

enum Metrics {
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

struct StatusCapsule: View {
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

// MARK: - Rows and platters

/// A titled group: the title above a platter whose rows are separated by
/// inset dividers.
struct MenuSection<Content: View>: View {
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
struct Platter<Content: View>: View {
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
struct HoverRow<Content: View>: View {
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

enum RowIcon {
  case tile(IconTile)
  case folder(String)
  case progress
}

/// Icon, title, optional subtitle and footnote, and a trailing accessory.
struct RowLayout<Accessory: View>: View {
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
struct IconTile: View {
  let symbol: String
  let color: Color
  var size: CGFloat = Metrics.iconSize

  var body: some View {
    Image(systemName: symbol)
      .font(.system(size: size * 0.5, weight: .semibold))
      .foregroundStyle(.white)
      .frame(width: size, height: size)
      .background(color.gradient, in: .rect(cornerRadius: size * 0.27, style: .continuous))
  }
}

struct Tag: View {
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
struct CompactLabelStyle: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 3) {
      configuration.icon.imageScale(.small)
      configuration.title
    }
  }
}

struct Placeholder: View {
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

struct Notice: View {
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
struct ConfirmButton: View {
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

// MARK: - Menu bar icon

/// The menu bar "P": a template image, so it follows the menu bar's
/// light/dark look. A dot when an iPhone is connected; faded while the hub
/// starts, and crossed out while it is down.
enum MenuBarIcon {
  enum State: CaseIterable {
    case idle
    case inUse
    case starting
    case problem
  }

  static func image(_ state: State) -> NSImage {
    let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
      draw(state, in: rect)
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Pi Hub"
    return image
  }

  private static func draw(_ state: State, in rect: NSRect) {
    let base = NSFont.systemFont(ofSize: 18, weight: .heavy)
    let font = base.fontDescriptor.withDesign(.rounded).flatMap { NSFont(descriptor: $0, size: 18) } ?? base
    let faded = state == .starting || state == .problem
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font,
      .foregroundColor: NSColor.black.withAlphaComponent(faded ? 0.45 : 1),
    ]
    let letter = "P" as NSString
    let size = letter.size(withAttributes: attributes)
    // Optically centred: the glyph has no descender, so drop the line box a little.
    let origin = NSPoint(
      x: rect.midX - size.width / 2 - (state == .inUse ? 1 : 0),
      y: rect.midY - size.height / 2 + font.descender / 2 + 0.5
    )
    letter.draw(at: origin, withAttributes: attributes)
    switch state {
    case .inUse:
      let dot = NSRect(x: rect.maxX - 5.5, y: rect.minY + 1.5, width: 5, height: 5)
      // A gap between the dot and the letter, like a system badge.
      NSGraphicsContext.current?.compositingOperation = .clear
      NSBezierPath(ovalIn: dot.insetBy(dx: -1.2, dy: -1.2)).fill()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      NSColor.black.setFill()
      NSBezierPath(ovalIn: dot).fill()
    case .problem:
      let slash = NSBezierPath()
      slash.move(to: NSPoint(x: rect.minX + 3.5, y: rect.minY + 2))
      slash.line(to: NSPoint(x: rect.maxX - 3.5, y: rect.maxY - 2))
      slash.lineCapStyle = .round
      // Cut a gap around the slash, then draw it, like `.slash` symbols.
      NSGraphicsContext.current?.compositingOperation = .clear
      slash.lineWidth = 4
      slash.stroke()
      NSGraphicsContext.current?.compositingOperation = .sourceOver
      slash.lineWidth = 1.6
      NSColor.black.setStroke()
      slash.stroke()
    case .idle, .starting:
      break
    }
  }
}
