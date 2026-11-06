import Darwin
import Foundation

/// A control-request argument (`args` in the hub's control frame).
public enum ControlValue: Encodable, Equatable, Sendable {
  case string(String)
  case number(Double)

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    }
  }
}

public enum HubControlError: Error, Equatable, LocalizedError {
  /// Nothing listens on the socket: the hub is not running.
  case notRunning
  case timedOut
  /// The hub answered with an error.
  case rejected(String)
  /// The hub answered without a result: it predates this request.
  case emptyAnswer
  case io(String)

  public var errorDescription: String? {
    switch self {
    case .notRunning: "Pi Remote Hub is not running"
    case .timedOut: "Pi Remote Hub did not answer"
    case .rejected(let message): message
    case .emptyAnswer: "The running hub is older than Pi Hub. Restart it."
    case .io(let message): message
    }
  }
}

/// Talks to a running hub over its local socket (`hub.sock` in the state
/// directory): one newline-delimited JSON `control` frame out, one
/// `controlResult` frame back. The same requests the hub CLI makes.
public struct HubControlClient: Sendable {
  public var socketPath: String
  public var timeout: TimeInterval

  public init(socketPath: String, timeout: TimeInterval = 5) {
    self.socketPath = socketPath
    self.timeout = timeout
  }

  public func request<Answer: Decodable & Sendable>(
    _ op: String,
    args: [String: ControlValue] = [:],
    as type: Answer.Type = Answer.self
  ) async throws -> Answer {
    let frame = try Self.encodeRequest(op: op, args: args)
    let socketPath = socketPath
    let timeout = timeout
    let line = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
      DispatchQueue.global(qos: .userInitiated).async {
        continuation.resume(with: Result<Data, Error> {
          try Self.exchange(socketPath: socketPath, request: frame, timeout: timeout)
        })
      }
    }
    return try Self.decodeResult(line, as: type)
  }

  // MARK: - Wire format

  static let requestID = "pi-hub-app"

  static func encodeRequest(op: String, args: [String: ControlValue]) throws -> Data {
    struct Frame: Encodable {
      let t = "control"
      let rid: String
      let op: String
      let args: [String: ControlValue]
    }
    var data = try JSONEncoder().encode(Frame(rid: requestID, op: op, args: args))
    data.append(0x0A)
    return data
  }

  /// Decodes a `controlResult` line into its result, or throws the hub's error.
  static func decodeResult<Answer: Decodable>(_ line: Data, as type: Answer.Type) throws -> Answer {
    let frame = try JSONDecoder().decode(ControlResultFrame<Answer>.self, from: line)
    guard frame.ok else { throw HubControlError.rejected(frame.error ?? "The hub refused the request") }
    guard let result = frame.result else { throw HubControlError.emptyAnswer }
    return result
  }

  private struct ControlResultFrame<Answer: Decodable>: Decodable {
    let ok: Bool
    let result: Answer?
    let error: String?
  }

  static func isControlResult(_ line: Data) -> Bool {
    struct Header: Decodable {
      let t: String
      let rid: String?
    }
    guard let header = try? JSONDecoder().decode(Header.self, from: line) else { return false }
    return header.t == "controlResult" && header.rid == requestID
  }

  // MARK: - Socket

  private static func exchange(socketPath: String, request: Data, timeout: TimeInterval) throws -> Data {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw HubControlError.io("socket() failed: \(String(cString: strerror(errno)))") }
    defer { close(fd) }

    var noSigPipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    var interval = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1_000_000))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size))

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let path = Array(socketPath.utf8)
    guard path.count < MemoryLayout.size(ofValue: address.sun_path) else {
      throw HubControlError.io("Socket path is too long: \(socketPath)")
    }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: path)
      raw[path.count] = 0
    }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else {
      if errno == ENOENT || errno == ECONNREFUSED { throw HubControlError.notRunning }
      throw HubControlError.io("connect() failed: \(String(cString: strerror(errno)))")
    }

    try request.withUnsafeBytes { raw in
      var offset = 0
      while offset < raw.count {
        let written = write(fd, raw.baseAddress! + offset, raw.count - offset)
        guard written > 0 else {
          if errno == EAGAIN { throw HubControlError.timedOut }
          throw HubControlError.io("write() failed: \(String(cString: strerror(errno)))")
        }
        offset += written
      }
    }

    var buffer = Data()
    var chunk = [UInt8](repeating: 0, count: 64 * 1024)
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      let count = read(fd, &chunk, chunk.count)
      if count == 0 { throw HubControlError.io("The hub closed the connection") }
      if count < 0 {
        if errno == EAGAIN || errno == EINTR { continue }
        throw HubControlError.io("read() failed: \(String(cString: strerror(errno)))")
      }
      buffer.append(contentsOf: chunk[0..<count])
      while let newline = buffer.firstIndex(of: 0x0A) {
        let line = buffer[buffer.startIndex..<newline]
        buffer.removeSubrange(buffer.startIndex...newline)
        if isControlResult(Data(line)) { return Data(line) }
      }
    }
    throw HubControlError.timedOut
  }
}
