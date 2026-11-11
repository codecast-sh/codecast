import Foundation

/// What to tell the agent when an app has windows on screen but accessibility
/// returned none of them. Only macOS's own refusal (kAXErrorAPIDisabled) is a
/// grant problem; a busy app, or windows that are not on this Space, look the
/// same from the window list and are fixed by something else entirely.
/// Blaming the grant for every case sent people to toggle a permission that
/// was already working.
public enum WindowReadDiagnosis {
    /// AXError raw values (ApplicationServices is not imported in Core).
    public static let apiDisabled: Int32 = -25211
    public static let cannotComplete: Int32 = -25204
    public static let noValue: Int32 = -25212
    public static let success: Int32 = 0

    public struct Verdict: Equatable, Sendable {
        public let code: ComputerErrorCode
        public let message: String
    }

    /// `errors` holds the AXError of each window read the lookup made on its
    /// last attempt (focused window, window list), in any order.
    public static func verdict(appName: String, errors: [Int32], waitedMs: Int) -> Verdict {
        let named = errors.filter { $0 != success }.map(String.init).joined(separator: ", ")
        let detail = named.isEmpty ? "" : " (AXError \(named))"
        if errors.contains(apiDisabled) {
            return Verdict(
                code: .permissionDenied,
                message: "macOS refused codecast computer's reads of '\(appName)' for \(waitedMs)ms\(detail) although the grant reads as given. Toggle codecast computer off and on again under Accessibility in System Settings."
            )
        }
        if errors.contains(cannotComplete) {
            return Verdict(
                code: .actionTimeout,
                message: "app '\(appName)' did not answer window reads for \(waitedMs)ms\(detail); it is busy or hung. Retry shortly, or ask the human to quit and reopen it."
            )
        }
        return Verdict(
            code: .windowNotFound,
            message: "app '\(appName)' has windows on screen but reported no usable window for \(waitedMs)ms\(detail); its window may be on another Space, minimized, or still opening. Retry with --restore-window."
        )
    }
}
