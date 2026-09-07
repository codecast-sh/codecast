import Foundation

/// Both authentication checks run on the helper, on every request.
///
/// Be honest about what this buys. The socket lives in a 0700 directory owned
/// by the user, so only that user's processes and root reach it at all. The
/// peer check is defence in depth against a confused local program, not a
/// boundary against the user.
public enum SocketHandshake {
    public enum Verdict: Equatable, Sendable {
        case authorized
        case invalidToken
        case unauthorizedPeer

        public var errorCode: ComputerErrorCode? {
            self == .authorized ? nil : .permissionDenied
        }

        public var message: String? {
            switch self {
            case .authorized:
                return nil
            case .invalidToken:
                return "invalid computer agent token"
            case .unauthorizedPeer:
                return "computer agent peer is not authorized"
            }
        }
    }

    public struct Peer: Equatable, Sendable {
        /// The peer's resolved executable path. Both this and `castBinary` are
        /// resolved by the caller before they reach here, so the comparison is
        /// plain equality and this type stays free of the filesystem.
        public let executablePath: String?
        /// The peer's parent chain, at most four hops, stopping at pid 1.
        public let parentChain: [Int32]

        public init(executablePath: String?, parentChain: [Int32]) {
            self.executablePath = executablePath
            self.parentChain = parentChain
        }
    }

    public static let maxParentHops = 4
    public static let protocolVersion = 1

    public static func evaluate(
        expectedToken: String?,
        requestToken: String?,
        peer: Peer?,
        castBinary: String?,
        daemonPid: Int32?
    ) -> Verdict {
        if let expectedToken, requestToken != expectedToken {
            return .invalidToken
        }
        guard expectedToken != nil else { return .authorized }
        guard let peer, isAuthorizedPeer(peer, castBinary: castBinary, daemonPid: daemonPid) else {
            return .unauthorizedPeer
        }
        return .authorized
    }

    public static func isAuthorizedPeer(_ peer: Peer, castBinary: String?, daemonPid: Int32?) -> Bool {
        if let castBinary, !castBinary.isEmpty, let executablePath = peer.executablePath,
           executablePath == castBinary {
            return true
        }
        guard let daemonPid, daemonPid > 1 else { return false }
        return peer.parentChain.prefix(maxParentHops).contains(daemonPid)
    }
}

public struct AgentSessionConnectionID: Hashable, Sendable {
    public let rawValue: UInt64

    public init(rawValue: UInt64) {
        self.rawValue = rawValue
    }
}

public enum AgentSessionRegistration: Sendable {
    case rejected
    case claimed
    case retained
}

/// Codecast's CLI is short lived, so a helper that exited on the last hang up
/// would relaunch on every command and hand out element indexes against an
/// empty cache. Ownership therefore drains rather than closes: the last hang up
/// starts the idle timer, and a reconnect inside that window claims the same
/// session with its cache intact.
public struct AgentSessionOwnership: Sendable {
    private var authenticatedConnections: Set<AgentSessionConnectionID> = []
    private var hasActiveOwner = false

    public init() {}

    public mutating func registerConnection(
        _ connection: AgentSessionConnectionID,
        authenticated: Bool
    ) -> AgentSessionRegistration {
        guard authenticated else { return .rejected }
        guard authenticatedConnections.insert(connection).inserted else { return .rejected }
        guard !hasActiveOwner else { return .retained }
        hasActiveOwner = true
        return .claimed
    }

    /// True when the connection that went away was the last one, which is the
    /// moment the idle timer starts.
    public mutating func disconnect(_ connection: AgentSessionConnectionID) -> Bool {
        guard authenticatedConnections.remove(connection) != nil else { return false }
        guard hasActiveOwner, authenticatedConnections.isEmpty else { return false }
        hasActiveOwner = false
        return true
    }
}

/// The helper lives exactly as long as the element indexes it handed out stay
/// valid, and not one second longer.
public enum ComputerHelperLifetime {
    public static let unclaimedDeadline: TimeInterval = 30
    public static let idleDeadline = ComputerSnapshotCachePolicy.maxAge
    public static let unclaimedMessage = "computer helper received no authenticated session before its deadline"
}
