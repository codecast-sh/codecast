import Foundation

/// A password field's value never leaves the helper. This is a rendering rule
/// on the way out, not a filter applied later: the real string is replaced
/// before the tree text exists, so nothing downstream can leak it.
public enum SecureTextRedaction {
    public static let placeholder = "[redacted]"

    /// Only text-like roles are probed, so a button labelled "Show password"
    /// does not pay for four extra attribute reads on every walk.
    public static func roleCouldHoldASecret(_ role: String) -> Bool {
        let normalized = role.lowercased()
        return normalized.contains("text") ||
            normalized.contains("field") ||
            normalized.contains("password") ||
            normalized.contains("search") ||
            normalized.contains("combo")
    }

    public static func isSecureField(
        role: String,
        subrole: String? = nil,
        title: String? = nil,
        label: String? = nil,
        placeholder: String? = nil
    ) -> Bool {
        guard roleCouldHoldASecret(role) else { return false }
        let haystack = [role, subrole ?? "", title ?? "", label ?? "", placeholder ?? ""]
            .joined(separator: " ")
            .lowercased()
        return secretMarkers.contains { haystack.contains($0) }
    }

    public static func redactedValue(
        _ value: String?,
        role: String,
        subrole: String? = nil,
        title: String? = nil,
        label: String? = nil,
        placeholder: String? = nil
    ) -> String? {
        if isSecureField(role: role, subrole: subrole, title: title, label: label, placeholder: placeholder) {
            return Self.placeholder
        }
        return value
    }

    private static let secretMarkers = [
        "secure",
        "password",
        "passcode",
        "verification code",
        "one-time code",
    ]
}
