import Foundation

/// The `handshake` result, and also the `cast computer capabilities` payload.
/// One definition, so the two can never drift.
public struct ProviderCapabilities: Codable, Equatable, Sendable {
    public struct Apps: Codable, Equatable, Sendable {
        public var list = true
        public var bundleIds = true
        public var pids = true
    }

    public struct Windows: Codable, Equatable, Sendable {
        public var list = true
        public var targetById = true
        public var targetByIndex = true
        /// False on purpose. Focusing a window is not a verb an agent may call;
        /// only `--restore-window` raises, and it is an observation flag.
        public var focus = false
        public var moveResize = false
    }

    public struct Observation: Codable, Equatable, Sendable {
        public var screenshot = true
        public var annotatedScreenshot = false
        public var elementFrames = true
        public var ocr = false
    }

    public struct Actions: Codable, Equatable, Sendable {
        public var click = true
        public var typeText = true
        public var pressKey = true
        public var hotkey = true
        public var pasteText = true
        public var scroll = true
        /// Drag cannot be verified and its only delivery route does nothing in
        /// many apps, so the verb does not exist in v1.
        public var drag = false
        public var setValue = true
        public var performAction = true
    }

    public struct Surfaces: Codable, Equatable, Sendable {
        public var menus = false
        public var dialogs = false
        public var dock = false
        public var menubar = false
    }

    public struct Supports: Codable, Equatable, Sendable {
        public var apps = Apps()
        public var windows = Windows()
        public var observation = Observation()
        public var actions = Actions()
        public var surfaces = Surfaces()
    }

    public var platform = "darwin"
    public var provider = ProviderIdentity.name
    public var providerVersion: String
    public var protocolVersion = SocketHandshake.protocolVersion
    public var supports = Supports()

    public init(providerVersion: String) {
        self.providerVersion = providerVersion
    }

    /// The socket writes results with JSONSerialization, so hand it a plain
    /// dictionary rather than a second hand written copy of these fields.
    public func jsonObject() throws -> [String: Any] {
        let data = try JSONEncoder().encode(self)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw ProviderIdentity.encodingFailure
        }
        return object
    }
}

public enum ProviderIdentity {
    public static let name = "codecast-computer-macos"
    public static let bundleId = "sh.codecast.computer"
    public static let encodingFailure = NSError(
        domain: "sh.codecast.computer",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "failed to encode capabilities"]
    )
}
