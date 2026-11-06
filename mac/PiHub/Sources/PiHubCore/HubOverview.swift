import Foundation

/// What the hub answers to the `overview` control request
/// (`HubOverview` in `hub/HubService.ts`).
public struct HubOverview: Decodable, Equatable, Sendable {
  public var pid: Int
  public var startedAt: String
  public var status: HubStatus
  public var roots: [String]
  public var idleExitMinutes: Double
  public var agents: [AgentSummary]
  public var phones: [PhoneSummary]
  public var devices: [TrustedDevice]
  public var configPath: String?
  public var logPath: String?
}

/// The hub's listener (`HubStatusView`); also the answer to `status` and `pair`.
public struct HubStatus: Decodable, Equatable, Sendable {
  public var running: Bool
  /// The hub's package version; nil from hubs before 0.1.0.
  public var version: String?
  public var webSocketUrl: String?
  public var displayWebSocketUrl: String?
  public var fingerprintShort: String?
  public var connections: Int?
  public var lastError: String?
  public var pairingCode: String?
  public var pairingExpiresAt: String?
  public var pairingLink: String?
  public var bonjour: Bonjour?

  public struct Bonjour: Decodable, Equatable, Sendable {
    public var active: Bool
    public var instanceName: String?
    public var reason: String?
  }
}

/// One running Pi process registered with the hub.
public struct AgentSummary: Decodable, Equatable, Sendable, Identifiable {
  public var agentId: String
  public var pid: Int
  public var mode: String
  /// `terminal` (a Pi window) or `background` (started by the hub for a phone).
  public var origin: String
  public var cwd: String
  public var sessionFile: String?
  public var sessionName: String?
  public var model: String?
  public var busy: Bool
  /// Inside a shared folder, so the phone can see it.
  public var shared: Bool
  public var connectedAt: String
  public var lastActivityAt: String
  /// Names of the phones attached to it.
  public var viewers: [String]

  public var id: String { agentId }
  public var isBackground: Bool { origin == "background" }
}

/// One signed-in phone connection.
public struct PhoneSummary: Decodable, Equatable, Sendable, Identifiable {
  public var connectionId: String
  public var deviceId: String
  public var deviceName: String
  public var remoteAddress: String?
  public var connectedAt: String
  public var agentId: String?
  public var session: Session?

  public struct Session: Decodable, Equatable, Sendable {
    public var path: String?
    public var cwd: String
    public var name: String?
  }

  public var id: String { connectionId }
}

public struct TrustedDevice: Decodable, Equatable, Sendable, Identifiable {
  public var id: String
  public var name: String
  public var createdAt: String
  public var lastSeenAt: String
  public var remoteAddress: String?
}
