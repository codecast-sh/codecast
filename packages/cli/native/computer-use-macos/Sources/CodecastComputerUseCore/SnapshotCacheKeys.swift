import Foundation

/// A snapshot is stored under every name the caller could later use to address
/// the same app and window: the raw selector, the app name, the bundle id and
/// `pid:N`, each also qualified by the window it targeted.
public enum SnapshotCacheKeys {
    public static func aliases(
        query: String,
        appName: String,
        bundleId: String?,
        pid: Int32,
        windowId: UInt32,
        windowIndex: Int?
    ) -> [String] {
        var keys: [String] = [canonicalWindowId(windowId)]
        if let windowIndex {
            keys.append(canonicalWindowIndex(windowIndex))
        }
        for selector in [query, appName, bundleId ?? "", "pid:\(pid)"] where !selector.isEmpty {
            let base = selector.lowercased()
            keys.append(base)
            keys.append(windowQualified(base, windowId: windowId))
            if let windowIndex {
                keys.append(windowIndexQualified(base, windowIndex: windowIndex))
            }
        }
        var seen = Set<String>()
        return keys.filter { seen.insert($0).inserted }
    }

    /// The keys a lookup tries, most specific first, for one request.
    public static func lookupOrder(query: String, windowId: UInt32?, windowIndex: Int?) -> [String] {
        let base = query.lowercased()
        if let windowId {
            return [canonicalWindowId(windowId), windowQualified(base, windowId: windowId)]
        }
        if let windowIndex {
            return [canonicalWindowIndex(windowIndex), windowIndexQualified(base, windowIndex: windowIndex)]
        }
        return [base]
    }

    public static func canonicalWindowId(_ windowId: UInt32) -> String {
        "window-id:\(Int(windowId))"
    }

    public static func canonicalWindowIndex(_ windowIndex: Int) -> String {
        "window-index:\(windowIndex)"
    }

    public static func windowQualified(_ base: String, windowId: UInt32) -> String {
        "\(base.lowercased())#window:\(Int(windowId))"
    }

    public static func windowIndexQualified(_ base: String, windowIndex: Int) -> String {
        "\(base.lowercased())#windowindex:\(windowIndex)"
    }
}
