import Foundation

/// Whether the person's screen can be read and driven at all.
///
/// While the Mac is locked (or another user owns the console), macOS refuses
/// accessibility reads of every app and every screen capture, with the grants
/// still reading as given. Without this check the refusal surfaced as a stale
/// Accessibility grant and sent people to toggle a permission that was fine.
/// A locked screen needs the person to unlock it; nothing the agent or the
/// helper can do gets past it.
public enum ScreenSessionGate {
    public enum State: Equatable, Sendable {
        case usable
        /// The display is off but the session is unlocked: wake it, then go on.
        case displayAsleep
        case locked
        /// Another user's session owns the screen (fast user switching).
        case notOnConsole
    }

    /// `session` is CGSessionCopyCurrentDictionary() for the helper's session.
    /// The lock key is present only while the screen is locked, so a missing
    /// key means unlocked. A nil dictionary means no window server session.
    public static func state(session: [String: Any]?, displayAsleep: Bool) -> State {
        guard let session else { return .notOnConsole }
        if flag(session["CGSSessionScreenIsLocked"]) { return .locked }
        if let onConsole = session["kCGSSessionOnConsoleKey"], !flag(onConsole) { return .notOnConsole }
        return displayAsleep ? .displayAsleep : .usable
    }

    public static func refusal(_ state: State) -> String? {
        switch state {
        case .usable, .displayAsleep:
            return nil
        case .locked:
            return "the Mac's screen is locked, and macOS lets nothing read or drive apps until the human unlocks it. The grants are fine; do not touch them."
        case .notOnConsole:
            return "another user's session owns this Mac's screen, so macOS lets nothing read or drive apps in this one until the human switches back. The grants are fine; do not touch them."
        }
    }

    private static func flag(_ value: Any?) -> Bool {
        if let bool = value as? Bool { return bool }
        if let number = value as? NSNumber { return number.boolValue }
        return false
    }
}
