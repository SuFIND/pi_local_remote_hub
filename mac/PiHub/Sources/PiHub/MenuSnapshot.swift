#if DEBUG
import AppKit
import PiHubCore
import SwiftUI

/// Debug builds only: `PI_HUB_SNAPSHOT=/tmp/menu.png swift run PiHub` renders
/// the menu with sample data (light and dark, plus the pairing panel) to PNG
/// files and quits. For checking layout without clicking the menu bar.
/// Borderless, but key, so prominent buttons render active like the open menu.
private final class KeyWindow: NSWindow {
  override var canBecomeKey: Bool { true }
}

@MainActor
enum MenuSnapshot {
  static func write(to path: String) {
    let overview = try! JSONDecoder().decode(HubOverview.self, from: Data(sampleJSON.utf8))
    let pairing = try! JSONDecoder().decode(HubStatus.self, from: Data(samplePairingJSON.utf8))
    let base = (path as NSString).deletingPathExtension
    let shots: [(String, HubModel, NSAppearance.Name)] = [
      ("\(base)-light.png", HubModel(preview: overview), .aqua),
      ("\(base)-dark.png", HubModel(preview: overview), .darkAqua),
      ("\(base)-pairing.png", HubModel(preview: overview, pairing: pairing), .darkAqua),
    ]
    var windows: [NSWindow] = []
    for (_, model, appearance) in shots {
      let dark = appearance == .darkAqua
      let hosting = NSHostingView(rootView: MenuView(model: model)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.colorScheme, dark ? .dark : .light)
        .environment(\.appearsActive, true))
      hosting.appearance = NSAppearance(named: appearance)
      let window = KeyWindow(contentRect: CGRect(x: 0, y: 0, width: 380, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
      window.contentView = hosting
      window.appearance = NSAppearance(named: appearance)
      window.backgroundColor = appearance == .darkAqua ? NSColor(white: 0.16, alpha: 1) : NSColor(white: 0.96, alpha: 1)
      windows.append(window)
      window.setFrameOrigin(NSPoint(x: 40 + CGFloat(windows.count) * 400, y: 80))
      window.orderFrontRegardless()
      window.makeKey()
    }
    NSApp.activate()
    // Let onGeometryChange size the scroll area, then capture one window
    // at a time, each as the key window so prominent buttons look active.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
      capture(windows, paths: shots.map(\.0), index: 0)
    }
  }

  private static func capture(_ windows: [NSWindow], paths: [String], index: Int) {
    guard index < windows.count else {
      NSApp.terminate(nil)
      return
    }
    let window = windows[index]
    if let hosting = window.contentView {
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
      capture(windows, paths: paths, index: index + 1)
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
   "status":{"running":true,"webSocketUrl":"wss://192.168.1.20:3769/v1/ws#fp=Xk2Q","displayWebSocketUrl":"wss://192.168.1.20:3769/v1/ws",
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
   "phones":[{"connectionId":"c1","deviceId":"d1","deviceName":"Kai's iPhone","remoteAddress":"192.168.1.21",
     "connectedAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600)))","agentId":"a1"}],
   "devices":[{"id":"Ab3dE5gH7jK9mN1p","name":"Kai's iPhone","createdAt":"2026-11-01T00:00:00.000Z",
     "lastSeenAt":"\(ISO8601DateFormatter().string(from: Date().addingTimeInterval(-30)))"}]}
  """
}
#endif
