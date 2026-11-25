import Foundation

/// Whether the app can work right now, from the shim's side of the socket. An
/// installed app works only while Codecast is installed, running and signed in;
/// anything else covers the page with what is wrong and the one thing to do.
/// Foundation only, so Tests/hoststate compiles it alone.
enum HostState: Equatable {
    case ready
    /// No app with the host bundle id on this Mac.
    case missing
    /// Codecast did not answer on the socket in time.
    case notRunning
    /// Codecast answered and said nobody is signed in.
    case signedOut

    var title: String {
        switch self {
        case .ready: return ""
        case .missing: return "Codecast isn't installed"
        case .notRunning: return "Codecast isn't running"
        case .signedOut: return "Codecast is signed out"
        }
    }

    func detail(app name: String) -> String {
        switch self {
        case .ready: return ""
        case .missing: return "\(name) runs through the Codecast desktop app."
        case .notRunning: return "\(name) reconnects as soon as Codecast opens."
        case .signedOut: return "Sign in to Codecast to use \(name)."
        }
    }

    var action: String {
        self == .missing ? "Get Codecast" : "Open Codecast"
    }

    static let downloadUrl = URL(string: "https://codecast.sh/download")!

    /// The state a `host-state` event from Codecast describes.
    static func from(event data: Any) -> HostState {
        let signedIn = (data as? [String: Any])?["signedIn"] as? Bool ?? true
        return signedIn ? .ready : .signedOut
    }
}

enum ShimText {
    /// What the shim appends to WebKit's user agent. The server serves the
    /// installed-app response to a user agent ending in this.
    static func userAgentSuffix(hostVersion: String, slug: String) -> String {
        "CodecastApp/\(hostVersion) (\(slug))"
    }

    /// The Notifications pane of System Settings, opened at this app.
    static func notificationSettingsUrl(bundleId: String) -> String {
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(bundleId)"
    }

    /// UNAuthorizationStatus as the page and Settings read it.
    static func notificationStatus(_ raw: Int) -> String {
        switch raw {
        case 0: return "not-determined"
        case 1: return "denied"
        case 2: return "authorized"
        case 3: return "provisional"
        case 4: return "ephemeral"
        default: return "unknown"
        }
    }
}
