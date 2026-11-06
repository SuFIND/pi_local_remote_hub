#if DEBUG
import AppKit
import PiHubCore
import SwiftUI

/// Debug builds only: `PI_HUB_SNAPSHOT=/tmp/menu.png swift run PiHub` renders
/// the menu (light, dark, pairing), the menu bar icons and each settings
/// pane with sample data to PNG files next to that path, and quits. For checking layout without clicking the menu bar.
/// Borderless, but key, so prominent buttons render active like the open menu.
private final class KeyWindow: NSWindow {
  override var canBecomeKey: Bool { true }
}

@MainActor
enum MenuSnapshot {
  private struct Shot {
    let path: String
    let view: AnyView
    /// nil: the view's own fitting size.
    let size: CGSize?
    let dark: Bool
  }

  static func write(to path: String) {
    let overview = try! JSONDecoder().decode(HubOverview.self, from: Data(sampleJSON.utf8))
    let pairing = try! JSONDecoder().decode(HubStatus.self, from: Data(samplePairingJSON.utf8))
    let base = (path as NSString).deletingPathExtension
    func menu(_ model: HubModel) -> AnyView { AnyView(MenuView(model: model)) }
    func settings(_ pane: SettingsPane, pairing: HubStatus? = nil) -> AnyView {
      AnyView(SettingsView(model: HubModel(preview: overview, pairing: pairing, pane: pane), managesActivation: false))
    }
    let settingsSize = CGSize(width: 760, height: 540)
    var shots: [Shot] = [
      Shot(path: "\(base)-light.png", view: menu(HubModel(preview: overview)), size: nil, dark: false),
      Shot(path: "\(base)-dark.png", view: menu(HubModel(preview: overview)), size: nil, dark: true),
      Shot(path: "\(base)-pairing.png", view: menu(HubModel(preview: overview, pairing: pairing)), size: nil, dark: true),
      Shot(path: "\(base)-icons-light.png", view: AnyView(IconStrip()), size: nil, dark: false),
      Shot(path: "\(base)-icons-dark.png", view: AnyView(IconStrip()), size: nil, dark: true),
    ]
    for pane in SettingsPane.allCases {
      shots.append(Shot(path: "\(base)-settings-\(pane.rawValue).png", view: settings(pane), size: settingsSize, dark: false))
    }
    shots.append(Shot(path: "\(base)-settings-general-dark.png", view: settings(.general), size: settingsSize, dark: true))
    shots.append(Shot(path: "\(base)-settings-pairing.png", view: settings(.iphones, pairing: pairing), size: settingsSize, dark: false))

    var windows: [NSWindow] = []
    for shot in shots {
      let appearance = NSAppearance(named: shot.dark ? .darkAqua : .aqua)
      let hosting = NSHostingView(rootView: shot.view
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, shot.dark ? .dark : .light)
        .environment(\.appearsActive, true))
      hosting.appearance = appearance
      let size = shot.size ?? CGSize(width: 380, height: 800)
      let window = KeyWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
      window.contentView = hosting
      window.appearance = appearance
      window.backgroundColor = shot.dark ? NSColor(white: 0.16, alpha: 1) : NSColor(white: 0.96, alpha: 1)
      windows.append(window)
      window.setFrameOrigin(NSPoint(x: 40 + CGFloat(windows.count % 3) * 60, y: 80))
      window.orderFrontRegardless()
    }
    NSApp.activate()
    // Let onGeometryChange size the scroll area, then capture one window
    // at a time, each as the key window so prominent buttons look active.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
      capture(windows, paths: shots.map(\.path), fitting: shots.map { $0.size == nil }, index: 0)
    }
  }

  /// Each menu bar state, large, on a menu-bar-like strip.
  private struct IconStrip: View {
    var body: some View {
      HStack(spacing: 18) {
        ForEach(MenuBarIcon.State.allCases, id: \.self) { state in
          VStack(spacing: 6) {
            HStack(spacing: 10) {
              // Actual size and 4x, as the template renders in the menu bar.
              Image(nsImage: MenuBarIcon.image(state)).renderingMode(.template)
              Image(nsImage: MenuBarIcon.image(state)).renderingMode(.template)
                .resizable()
                .interpolation(.high)
                .frame(width: 72, height: 72)
            }
            Text(String(describing: state)).font(.caption)
          }
        }
      }
      .foregroundStyle(.primary)
      .padding(16)
    }
  }

  private static func capture(_ windows: [NSWindow], paths: [String], fitting: [Bool], index: Int) {
    guard index < windows.count else {
      NSApp.terminate(nil)
      return
    }
    let window = windows[index]
    if fitting[index], let hosting = window.contentView {
      let size = hosting.fittingSize
      window.setContentSize(size)
      hosting.frame = CGRect(origin: .zero, size: size)
      hosting.layoutSubtreeIfNeeded()
    }
    window.makeKeyAndOrderFront(nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
      let url = URL(fileURLWithPath: paths[index])
      // Liquid Glass is composited by the window server, so prefer a
      // window-server capture of our own window; cacheDisplay misses it.
      if let image = windowImage(window), let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) {
        try? png.write(to: url)
      } else if let hosting = window.contentView, let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) {
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: url)
      }
      capture(windows, paths: paths, fitting: fitting, index: index + 1)
    }
  }

  /// `CGWindowListCreateImage` is unavailable in the current SDK but still
  /// exported; capturing our own window needs no screen-recording grant.
  private static func windowImage(_ window: NSWindow) -> CGImage? {
    typealias Capture = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
    guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return nil }
    let capture = unsafeBitCast(symbol, to: Capture.self)
    // .null rect, .optionIncludingWindow (8), .boundsIgnoreFraming (1) | .bestResolution (8)
    return capture(.null, 8, UInt32(window.windowNumber), 1 | 8)?.takeRetainedValue()
  }

  static let samplePairingJSON = """
  {"running":true,"pairingCode":"482913","pairingExpiresAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(105)))",
   "pairingLink":"pi-remote://pair?url=wss%3A%2F%2F192.168.1.20%3A3769%2Fv1%2Fws%23fp%3DXk2Q&code=482913"}
  """

  static let sampleJSON = """
  {"pid":6162,"startedAt":"2026-11-06T05:39:00.000Z",
   "status":{"running":true,"version":"0.1.0","webSocketUrl":"wss://192.168.1.20:3769/v1/ws#fp=Xk2Q","displayWebSocketUrl":"wss://192.168.1.20:3769/v1/ws",
     "fingerprintShort":"3F2A 9C41 D07B 6E58","bonjour":{"active":true,"instanceName":"Pi · Mac"},"connections":1},
   "roots":["\(NSHomeDirectory())/Downloads/work","\(NSHomeDirectory())/Downloads/projects"],"idleExitMinutes":3,
   "agents":[
     {"agentId":"a1","pid":100,"mode":"tui","origin":"terminal","cwd":"\(NSHomeDirectory())/Downloads/projects/pi-remote-ios-hub",
      "sessionName":"Hub menu bar app","model":"gpt-5","busy":true,"shared":true,"connectedAt":"2026-11-06T05:39:10.000Z",
      "lastActivityAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-20)))","viewers":["Kai's iPhone"]},
     {"agentId":"a2","pid":101,"mode":"rpc","origin":"background","cwd":"\(NSHomeDirectory())/Downloads/work/api",
      "busy":false,"shared":true,"connectedAt":"2026-11-06T05:39:10.000Z",
      "lastActivityAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-150)))","viewers":[]},
     {"agentId":"a3","pid":102,"mode":"tui","origin":"terminal","cwd":"/private/tmp/scratch","busy":false,"shared":false,
      "connectedAt":"2026-11-06T05:39:10.000Z","lastActivityAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-4000)))","viewers":[]}],
   "phones":[{"connectionId":"c1","deviceId":"Ab3dE5gH7jK9mN1p","deviceName":"Kai's iPhone","remoteAddress":"192.168.1.21",
     "connectedAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600)))","agentId":"a1"}],
   "devices":[{"id":"Ab3dE5gH7jK9mN1p","name":"Kai's iPhone","createdAt":"2026-11-01T00:00:00.000Z",
     "lastSeenAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-30)))"},
     {"id":"Q2b9xLmT0aPz7KcE","name":"iPhone 15","createdAt":"2026-10-20T00:00:00.000Z",
     "lastSeenAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3 * 86_400)))"}]}
  """
}
#endif
