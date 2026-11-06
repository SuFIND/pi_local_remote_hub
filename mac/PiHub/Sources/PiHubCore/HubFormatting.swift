import Foundation

/// Text the menu shows for hub data.
public enum HubFormatting {
  /// `/Users/me/code/app` → `~/code/app`.
  public static func abbreviate(_ path: String, home: String = NSHomeDirectory()) -> String {
    guard !home.isEmpty else { return path }
    if path == home { return "~" }
    let prefix = home.hasSuffix("/") ? home : home + "/"
    return path.hasPrefix(prefix) ? "~/" + path.dropFirst(prefix.count) : path
  }

  /// The session's name, else its folder's name.
  public static func title(of agent: AgentSummary) -> String {
    if let name = agent.sessionName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
    let folder = (agent.cwd as NSString).lastPathComponent
    return folder.isEmpty ? agent.cwd : folder
  }

  /// What a phone is looking at: a session's name or folder, or the browser.
  public static func activity(of phone: PhoneSummary, agents: [AgentSummary]) -> String {
    if let agentID = phone.agentId, let agent = agents.first(where: { $0.agentId == agentID }) {
      return "Viewing \(title(of: agent))"
    }
    if let session = phone.session {
      if let name = session.name, !name.isEmpty { return "Viewing \(name) (stopped)" }
      return "Viewing a stopped session in \((session.cwd as NSString).lastPathComponent)"
    }
    return "Browsing sessions"
  }

  public static func date(_ iso: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: iso) { return date }
    return ISO8601DateFormatter().date(from: iso)
  }

  /// "just now", "5 min ago", "3 h ago", "2 d ago".
  public static func relative(_ iso: String, now: Date = Date()) -> String {
    guard let date = date(iso) else { return "" }
    let seconds = max(0, now.timeIntervalSince(date))
    switch seconds {
    case ..<60: return "just now"
    case ..<3_600: return "\(Int(seconds / 60)) min ago"
    case ..<86_400: return "\(Int(seconds / 3_600)) h ago"
    default: return "\(Int(seconds / 86_400)) d ago"
    }
  }

  /// "1:45" until the pairing window closes; nil once it has.
  public static func countdown(until iso: String?, now: Date = Date()) -> String? {
    guard let iso, let end = date(iso) else { return nil }
    let remaining = Int(end.timeIntervalSince(now).rounded(.down))
    guard remaining > 0 else { return nil }
    return String(format: "%d:%02d", remaining / 60, remaining % 60)
  }

  /// "3 min", "1.5 min".
  public static func minutes(_ value: Double) -> String {
    value.rounded() == value ? "\(Int(value)) min" : String(format: "%.1f min", value)
  }
}
