import Darwin
import Foundation
@testable import PiHubCore
import Testing

@Suite("Hub overview")
struct HubOverviewTests {
  static let json = """
  {"pid":4242,"startedAt":"2026-11-06T01:48:04.329Z",
   "status":{"running":true,"webSocketUrl":"wss://192.168.1.5:3769/v1/ws#fp=abc","displayWebSocketUrl":"wss://192.168.1.5:3769/v1/ws",
     "fingerprintShort":"3F2A 9C41","followsLanAddress":true,"bonjour":{"active":true,"instanceName":"Pi · Mac"},"connections":1,
     "roots":["/Users/me/code"],"agents":2,"idleExitMinutes":3,"deviceTrust":{"pairing":{"active":false},"trustedDevices":[]}},
   "roots":["/Users/me/code"],"idleExitMinutes":3,
   "agents":[
     {"agentId":"a1","pid":100,"mode":"tui","origin":"terminal","cwd":"/Users/me/code/app","sessionFile":"/s/1.jsonl",
      "sessionName":"Menu work","model":"GPT","busy":true,"shared":true,"connectedAt":"2026-11-06T01:50:00.000Z",
      "lastActivityAt":"2026-11-06T01:55:00.000Z","viewers":["Kai's iPhone"]},
     {"agentId":"a2","pid":101,"mode":"rpc","origin":"background","cwd":"/Users/me/code/lib","busy":false,"shared":true,
      "connectedAt":"2026-11-06T01:50:00.000Z","lastActivityAt":"2026-11-06T01:51:00.000Z","viewers":[]}],
   "phones":[{"connectionId":"c1","deviceId":"d1","deviceName":"Kai's iPhone","remoteAddress":"192.168.1.9",
     "connectedAt":"2026-11-06T01:52:00.000Z","agentId":"a1","session":{"path":"/s/1.jsonl","cwd":"/Users/me/code/app","name":"Menu work"}}],
   "devices":[{"id":"d1","name":"Kai's iPhone","createdAt":"2026-11-01T00:00:00.000Z","lastSeenAt":"2026-11-06T01:52:00.000Z"}],
   "configPath":"/Users/me/.pi/agent/pi-remote/hub.json","logPath":"/Users/me/.pi/agent/pi-remote/hub.log"}
  """

  @Test("Decodes the hub's overview, ignoring fields the menu does not use")
  func decode() throws {
    let overview = try JSONDecoder().decode(HubOverview.self, from: Data(Self.json.utf8))
    #expect(overview.pid == 4242)
    #expect(overview.status.running && overview.status.bonjour?.active == true)
    #expect(overview.agents.map(\.origin) == ["terminal", "background"])
    #expect(overview.agents[1].isBackground && overview.agents[1].sessionName == nil)
    #expect(overview.phones.first?.agentId == "a1")
    #expect(overview.devices.first?.name == "Kai's iPhone")
  }

  @Test("Titles, phone activity and paths read like the menu shows them")
  func formatting() throws {
    let overview = try JSONDecoder().decode(HubOverview.self, from: Data(Self.json.utf8))
    #expect(HubFormatting.title(of: overview.agents[0]) == "Menu work")
    #expect(HubFormatting.title(of: overview.agents[1]) == "lib")
    #expect(HubFormatting.activity(of: overview.phones[0], agents: overview.agents) == "Viewing Menu work")
    var stopped = overview.phones[0]
    stopped.agentId = nil
    stopped.session?.name = nil
    #expect(HubFormatting.activity(of: stopped, agents: overview.agents) == "Viewing a stopped session in app")
    stopped.session = nil
    #expect(HubFormatting.activity(of: stopped, agents: overview.agents) == "Browsing sessions")
    #expect(HubFormatting.abbreviate("/Users/me/code/app", home: "/Users/me") == "~/code/app")
    #expect(HubFormatting.abbreviate("/Users/meow", home: "/Users/me") == "/Users/meow")
    #expect(HubFormatting.abbreviate("/Users/me", home: "/Users/me") == "~")
    #expect(HubFormatting.hostAndPort(of: "wss://192.168.1.20:3769/v1/ws#fp=abc") == "192.168.1.20:3769")
    #expect(HubFormatting.hostAndPort(of: "wss://mac.local/v1/ws") == "mac.local")
    #expect(HubFormatting.hostAndPort(of: "not a url") == "not a url")
  }

  @Test("An iPhone in use counts once, by its newest connection")
  func phonesInUse() throws {
    let overview = try JSONDecoder().decode(HubOverview.self, from: Data(Self.json.utf8))
    var reconnect = overview.phones[0]
    reconnect.connectionId = "c2"
    reconnect.connectedAt = "2026-11-06T01:58:00Z"
    reconnect.agentId = nil
    var other = overview.phones[0]
    other.connectionId = "c3"
    other.deviceId = "d2"
    other.connectedAt = "2026-11-06T01:53:00.000Z"
    let inUse = HubFormatting.phonesInUse([overview.phones[0], other, reconnect])
    #expect(inUse.map(\.connectionId) == ["c2", "c3"])
    #expect(HubFormatting.connection(of: overview.devices[0], in: [overview.phones[0], reconnect])?.connectionId == "c2")
    #expect(HubFormatting.connection(of: overview.devices[0], in: [other]) == nil)
    #expect(HubFormatting.phonesInUse([]).isEmpty)
    #expect(HubFormatting.isInside("/Users/me/code/app", root: "/Users/me/code"))
    #expect(HubFormatting.isInside("/Users/me/code", root: "/Users/me/code/"))
    #expect(!HubFormatting.isInside("/Users/me/codebase", root: "/Users/me/code"))
  }

  @Test("Relative times, pairing countdown and minutes")
  func times() throws {
    let now = try #require(HubFormatting.date("2026-11-06T02:00:00.000Z"))
    #expect(HubFormatting.relative("2026-11-06T01:59:30.000Z", now: now) == "just now")
    #expect(HubFormatting.relative("2026-11-06T01:55:00Z", now: now) == "5 min ago")
    #expect(HubFormatting.relative("2026-11-05T23:00:00.000Z", now: now) == "3 h ago")
    #expect(HubFormatting.countdown(until: "2026-11-06T02:01:45.000Z", now: now) == "1:45")
    #expect(HubFormatting.countdown(until: "2026-11-06T01:59:00.000Z", now: now) == nil)
    #expect(HubFormatting.minutes(3) == "3 min")
    #expect(HubFormatting.minutes(0.5) == "0.5 min")
  }
}

@Suite("Control client")
struct HubControlClientTests {
  @Test("Requests are one newline-terminated control frame")
  func encode() throws {
    let data = try HubControlClient.encodeRequest(op: "addRoot", args: ["path": .string("/code")])
    #expect(data.last == 0x0A)
    let frame = try #require(JSONSerialization.jsonObject(with: data.dropLast()) as? [String: Any])
    #expect(frame["t"] as? String == "control")
    #expect(frame["op"] as? String == "addRoot")
    #expect((frame["args"] as? [String: Any])?["path"] as? String == "/code")
  }

  @Test("Results, errors, empty answers and foreign frames")
  func decode() throws {
    let ok = Data(#"{"t":"controlResult","rid":"pi-hub-app","ok":true,"result":{"running":true}}"#.utf8)
    #expect(HubControlClient.isControlResult(ok))
    #expect(try HubControlClient.decodeResult(ok, as: HubStatus.self).running)
    let failed = Data(#"{"t":"controlResult","rid":"pi-hub-app","ok":false,"error":"Not a folder: /x"}"#.utf8)
    #expect(throws: HubControlError.rejected("Not a folder: /x")) { try HubControlClient.decodeResult(failed, as: HubStatus.self) }
    let empty = Data(#"{"t":"controlResult","rid":"pi-hub-app","ok":true}"#.utf8)
    #expect(throws: HubControlError.emptyAnswer) { try HubControlClient.decodeResult(empty, as: HubStatus.self) }
    #expect(!HubControlClient.isControlResult(Data(#"{"t":"welcome","hubPid":1}"#.utf8)))
    #expect(!HubControlClient.isControlResult(Data(#"{"t":"controlResult","rid":"cli","ok":true}"#.utf8)))
  }

  @Test("Talks to a hub over a Unix socket and skips frames that are not its answer")
  func socketRoundTrip() async throws {
    let path = NSTemporaryDirectory() + "pihub-\(UUID().uuidString.prefix(8)).sock"
    let server = try FakeHubSocket(path: path) { request in
      #expect(request.contains(#""op":"status""#))
      return [#"{"t":"welcome","hubPid":1}"#, #"{"t":"controlResult","rid":"pi-hub-app","ok":true,"result":{"running":true,"fingerprintShort":"AB CD"}}"#]
    }
    defer { server.stop() }
    let status = try await HubControlClient(socketPath: path, timeout: 2).request("status", as: HubStatus.self)
    #expect(status.fingerprintShort == "AB CD")
  }

  @Test("No socket file means the hub is not running")
  func notRunning() async {
    let client = HubControlClient(socketPath: NSTemporaryDirectory() + "missing-\(UUID().uuidString).sock", timeout: 1)
    await #expect(throws: HubControlError.notRunning) { try await client.request("status", as: HubStatus.self) }
  }

  /// Set PI_HUB_LIVE_SOCKET to a running hub's hub.sock to check the real wire format.
  @Test("Live hub overview decodes", .enabled(if: ProcessInfo.processInfo.environment["PI_HUB_LIVE_SOCKET"] != nil))
  func live() async throws {
    let path = try #require(ProcessInfo.processInfo.environment["PI_HUB_LIVE_SOCKET"])
    let overview = try await HubControlClient(socketPath: path).request("overview", as: HubOverview.self)
    print("live overview: pid \(overview.pid), \(overview.agents.count) Pi, \(overview.phones.count) phones, roots \(overview.roots)")
    #expect(overview.pid > 0)
  }
}

@Suite("Launch config")
struct HubLaunchConfigTests {
  @Test("Environment beats user defaults beats Info.plist; node's folder joins PATH")
  func precedence() {
    let info: [String: Any] = ["PiHubNodePath": "/info/node", "PiHubScriptPath": "/repo/hub/bin.mjs", "PiHubSearchPath": "/info/bin:/usr/bin"]
    let fromInfo = HubLaunchConfig.resolve(info: info, defaults: [:], environment: [:], home: "/Users/me")
    #expect(fromInfo.nodePath == "/info/node")
    #expect(fromInfo.searchPath == "/info:/info/bin:/usr/bin")
    #expect(fromInfo.stateDirectory == "/Users/me/.pi/agent/pi-remote")
    #expect(fromInfo.socketPath == "/Users/me/.pi/agent/pi-remote/hub.sock")
    let overridden = HubLaunchConfig.resolve(
      info: info,
      defaults: ["PiHubNodePath": "/defaults/node"],
      environment: ["PI_HUB_SCRIPT": "/dev/hub/bin.mjs", "PI_REMOTE_STATE_DIR": "/tmp/state"],
      home: "/Users/me"
    )
    #expect(overridden.nodePath == "/defaults/node")
    #expect(overridden.scriptPath == "/dev/hub/bin.mjs")
    #expect(overridden.stateDirectory == "/tmp/state")
  }

  @Test("The hub gets the recorded PATH and, for a custom state folder, PI_REMOTE_STATE_DIR")
  func environment() {
    let standard = HubLaunchConfig(nodePath: "/n/node", scriptPath: "/s", searchPath: "/n:/usr/bin", stateDirectory: "/Users/me/.pi/agent/pi-remote")
    let env = standard.environment(base: ["HOME": "/Users/me", "PATH": "/usr/bin", "LANG": "zh_CN.UTF-8"])
    #expect(env["PATH"] == "/n:/usr/bin")
    #expect(env["LANG"] == "zh_CN.UTF-8")
    #expect(env["PI_REMOTE_STATE_DIR"] == nil)
    let custom = HubLaunchConfig(nodePath: "/n/node", scriptPath: "/s", searchPath: "/n", stateDirectory: "/tmp/state")
    #expect(custom.environment(base: ["HOME": "/Users/me"])["PI_REMOTE_STATE_DIR"] == "/tmp/state")
  }

  @Test("Missing node or hub script is reported before launching")
  func problems() {
    let config = HubLaunchConfig(nodePath: "/n/node", scriptPath: "/s/bin.mjs", searchPath: "", stateDirectory: "/tmp")
    #expect(config.problem { _ in true } == nil)
    #expect(config.problem { $0 != "/n/node" }?.contains("Node.js") == true)
    #expect(config.problem { $0 != "/s/bin.mjs" }?.contains("hub script") == true)
    var unset = config
    unset.scriptPath = ""
    #expect(unset.problem { _ in true }?.contains("Rebuild") == true)
  }

  @Test("Restarts back off 1, 2, 5, 10, 30 s and start over after a healthy minute")
  func backoff() {
    var backoff = RestartBackoff()
    #expect((0..<6).map { _ in backoff.nextDelay(ranFor: 3) } == [1, 2, 5, 10, 30, 30])
    #expect(backoff.nextDelay(ranFor: 120) == 1)
  }
}

/// A one-connection Unix socket server standing in for the hub.
private final class FakeHubSocket: @unchecked Sendable {
  private let fd: Int32
  private let path: String

  init(path: String, reply: @escaping @Sendable (String) -> [String]) throws {
    self.path = path
    unlink(path)
    fd = socket(AF_UNIX, SOCK_STREAM, 0)
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0, listen(fd, 1) == 0 else { throw HubControlError.io("bind failed") }
    let server = fd
    DispatchQueue.global().async {
      let client = accept(server, nil, nil)
      guard client >= 0 else { return }
      var buffer = [UInt8](repeating: 0, count: 4096)
      let count = read(client, &buffer, buffer.count)
      let request = String(decoding: buffer[0..<max(count, 0)], as: UTF8.self)
      for line in reply(request) {
        let data = Array((line + "\n").utf8)
        _ = write(client, data, data.count)
      }
      close(client)
    }
  }

  func stop() {
    close(fd)
    unlink(path)
  }
}
