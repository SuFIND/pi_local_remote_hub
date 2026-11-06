import AppKit
import SwiftUI

/// Pi Hub: a menu bar app (no Dock icon) that keeps the Pi Remote Hub
/// running and shows what it serves.
@main
struct PiHubApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra {
      MenuView(model: delegate.model)
    } label: {
      MenuBarLabel(model: delegate.model)
    }
    .menuBarExtraStyle(.window)
  }
}

private struct MenuBarLabel: View {
  let model: HubModel

  var body: some View {
    Image(systemName: model.menuBarSymbol)
      .accessibilityLabel("Pi Hub")
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let model = HubModel()
  private var terminationSignal: DispatchSourceSignal?

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Also when run outside the .app bundle (`swift run`), which has no LSUIElement.
    NSApp.setActivationPolicy(.accessory)
    #if DEBUG
    if let path = ProcessInfo.processInfo.environment["PI_HUB_SNAPSHOT"] {
      MenuSnapshot.write(to: path)
      return
    }
    #endif
    if let bundleID = Bundle.main.bundleIdentifier,
       NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
       .contains(where: { $0 != NSRunningApplication.current }) {
      // Another Pi Hub already shows the hub.
      NSApp.terminate(nil)
      return
    }
    // `kill`/`pkill` sends SIGTERM, which would skip applicationShouldTerminate
    // and leave the hub running without the app.
    signal(SIGTERM, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    source.setEventHandler {
      // Not from inside this main-queue block: .terminateLater waits in a nested
      // run loop that cannot drain the main queue (where stopHub runs) until
      // this block returns, so terminating here would deadlock.
      RunLoop.main.perform { MainActor.assumeIsolated { NSApp.terminate(nil) } }
    }
    source.resume()
    terminationSignal = source
    model.start()
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard model.ownsHub else { return .terminateNow }
    Task { @MainActor in
      await model.stopHub()
      sender.reply(toApplicationShouldTerminate: true)
    }
    return .terminateLater
  }
}
