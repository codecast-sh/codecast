import Foundation

/// Where an app's page may go and who may reach the bridge. Foundation only, so
/// Tests/policy compiles it alone.
enum UrlPolicy {
    /// Schemes the shim hands to the default browser or mail client. Anything
    /// else a page asks to open (file, ssh, smb, vnc, settings panes, other
    /// apps' schemes) is dropped.
    static let externalSchemes: Set<String> = ["http", "https", "mailto"]

    static func canOpenExternally(_ url: URL) -> Bool {
        externalSchemes.contains(url.scheme?.lowercased() ?? "")
    }

    /// Main-frame navigation stays on the page's origin and under its path.
    /// Paths compare percent-encoded and dot-segment free, so `/slug%2F..`
    /// and `/slug/../other` do not pass as `/slug/...`.
    static func navigable(_ url: URL, page: URL) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        if ["about", "blob", "data"].contains(scheme) { return true }
        guard scheme == page.scheme?.lowercased(), url.host?.lowercased() == page.host?.lowercased(),
              url.port == page.port else { return false }
        func path(_ u: URL) -> String {
            URLComponents(url: u.standardized, resolvingAgainstBaseURL: false)?.percentEncodedPath ?? ""
        }
        var base = path(page)
        if base.hasSuffix("/") { base.removeLast() }
        let target = path(url)
        return base.isEmpty || target == base || target.hasPrefix(base + "/")
    }

    /// The bridge answers only the main frame, and only while it shows an
    /// http(s) document under the page's path. Pages run under a CSP sandbox
    /// with an opaque origin, so the frame URL is what can be checked.
    static func bridgeAllows(isMainFrame: Bool, frameUrl: URL?, page: URL) -> Bool {
        guard isMainFrame, let frameUrl, ["http", "https"].contains(frameUrl.scheme?.lowercased() ?? "") else {
            return false
        }
        return navigable(frameUrl, page: page)
    }
}
