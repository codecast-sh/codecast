import Foundation

/// Whether the app can work right now, from the shim's side. An installed app
/// works only while Codecast is installed, running and signed in, and while
/// its page loads; anything else covers the page with what is wrong and the
/// one thing to do. Foundation only, so Tests/hoststate compiles it alone.
enum HostState: Equatable {
    case ready
    /// No app with the host bundle id on this Mac.
    case missing
    /// Codecast did not answer on the socket in time.
    case notRunning
    /// Codecast answered and said nobody is signed in.
    case signedOut
    /// The page did not load because this Mac has no connection.
    case offline
    /// The page did not load for another reason (its server did not answer).
    case pageFailed

    var title: String {
        switch self {
        case .ready: return ""
        case .missing: return "Codecast isn't installed"
        case .notRunning: return "Codecast isn't running"
        case .signedOut: return "Codecast is signed out"
        case .offline: return "You're offline"
        case .pageFailed: return "The page didn't load"
        }
    }

    func detail(app name: String) -> String {
        switch self {
        case .ready: return ""
        case .missing: return "\(name) runs through the Codecast desktop app."
        case .notRunning: return "\(name) reconnects as soon as Codecast opens."
        case .signedOut: return "Sign in to Codecast to use \(name)."
        case .offline: return "\(name) loads again when your Mac is back online."
        case .pageFailed: return "\(name) tries again every few seconds."
        }
    }

    var action: String {
        switch self {
        case .missing: return "Get Codecast"
        case .offline, .pageFailed: return "Try Again"
        default: return "Open Codecast"
        }
    }

    static let downloadUrl = URL(string: "https://codecast.sh/download")!

    /// The state a `host-state` event from Codecast describes.
    static func from(event data: Any) -> HostState {
        let signedIn = (data as? [String: Any])?["signedIn"] as? Bool ?? true
        return signedIn ? .ready : .signedOut
    }

    /// What a failed load of the page shows, from the error's domain and
    /// code; nil when the load was only cancelled or replaced (a navigation
    /// the shim refused, a reload over it).
    static func pageLoad(errorDomain domain: String, code: Int) -> HostState? {
        if domain == NSURLErrorDomain {
            switch code {
            case NSURLErrorCancelled: return nil
            // Only errors that mean this Mac has no connection; a dropped
            // connection (-1005) is as often the server's doing.
            case NSURLErrorNotConnectedToInternet, NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff: return .offline
            default: return .pageFailed
            }
        }
        // WebKitErrorDomain 102: the load was interrupted by a policy change (a refused or redirected navigation).
        if domain == "WebKitErrorDomain", code == 102 { return nil }
        return .pageFailed
    }

    /// The one cover to show: what is wrong with Codecast comes first, since
    /// the page cannot work without it either way.
    static func cover(host: HostState, page: HostState?) -> HostState {
        host != .ready ? host : page ?? .ready
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

    /// The page's address as the About panel shows it: no query (it carries
    /// the install's gate keys) and no fragment.
    static func displayAddress(_ url: URL) -> String {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        c.query = nil
        c.fragment = nil
        return c.string ?? url.absoluteString
    }

    /// Where Settings… lands: Codecast's Settings > Installed apps on this app.
    /// An opaque CSS color as getComputedStyle writes it ("rgb(15, 20, 25)"),
    /// as sRGB components 0...1; nil for a transparent or unreadable one.
    static func opaqueCssColor(_ css: String) -> [Double]? {
        guard css.hasPrefix("rgb"), let open = css.firstIndex(of: "("), let close = css.lastIndex(of: ")") else { return nil }
        let parts = css[css.index(after: open)..<close].split(whereSeparator: { $0 == "," || $0 == " " || $0 == "/" })
            .compactMap { Double($0) }
        guard parts.count >= 3, parts.count == 3 || parts[3] >= 0.99 else { return nil }
        return parts.prefix(3).map { $0 / 255 }
    }

    static func settingsLink(slug: String) -> URL {
        var c = URLComponents(string: "codecast://open/settings/installed-apps")!
        c.queryItems = [URLQueryItem(name: "app", value: slug)]
        return c.url!
    }

    /// Page zoom steps, as Safari has them; `zoom(from:by:)` moves one step.
    static let zoomSteps: [Double] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

    static func zoom(from current: Double, by step: Int) -> Double {
        if step == 0 { return 1 }
        let index = zoomSteps.enumerated().min { abs($0.element - current) < abs($1.element - current) }!.offset
        return zoomSteps[max(0, min(zoomSteps.count - 1, index + step))]
    }
}
