#if DEBUG
import AppKit
import PiHubCore
import SwiftUI

/// Debug builds only: `PI_HUB_SNAPSHOT=/tmp/menu.png swift run PiHub` renders
/// the menu with sample data (light and dark, plus the pairing panel) to PNG
/// files and quits. For checking layout without clicking the menu bar.
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
        .environment(\.colorScheme, dark ? .dark : .light))
      hosting.appearance = NSAppearance(named: appearance)
      let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 380, height: 800), styleMask: [.borderless], backing: .buffered, defer: false)
      window.contentView = hosting
      window.appearance = NSAppearance(named: appearance)
      window.backgroundColor = appearance == .darkAqua ? NSColor(white: 0.16, alpha: 1) : NSColor(white: 0.96, alpha: 1)
      windows.append(window)
    }
    // Let onGeometryChange size the scroll area, then capture.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
      for (index, window) in windows.enumerated() {
        guard let hosting = window.contentView else { continue }
        let size = hosting.fittingSize
        window.setContentSize(size)
        hosting.frame = CGRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { continue }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: shots[index].0))
      }
      NSApp.terminate(nil)
    }
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
