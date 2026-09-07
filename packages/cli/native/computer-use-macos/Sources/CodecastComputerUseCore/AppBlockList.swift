import Foundation

/// Password managers are never driven. The list lives here rather than in the
/// CLI so a client that forgets the check still cannot read a vault.
public enum AppBlockList {
    public static let bundleIds: Set<String> = [
        "com.1password.1password",
        "com.1password.safari",
        "com.bitwarden.desktop",
        "com.dashlane.dashlanephonefinal",
        "com.lastpass.lastpass",
        "com.nordsec.nordpass",
        "me.proton.pass.electron",
        "me.proton.pass.catalyst",
    ]

    /// Matched case insensitively, because a selector and a bundle id can differ
    /// in case and both routes (`--app <bundle>` and `pid:N`) must be blocked.
    public static func isBlocked(_ bundleId: String?) -> Bool {
        guard let bundleId else { return false }
        return bundleIds.contains(bundleId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    public static func blockedMessage(_ selector: String) -> String {
        "app '\(selector)' is blocked for safety"
    }
}
