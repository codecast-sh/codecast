import Foundation

/// How long an action waits before the snapshot it returns.
///
/// The app says when it has reacted: each change to its tree posts an
/// accessibility notification, and the helper counts them. The wait ends a
/// short quiet spell after the last one, which is sooner than any fixed sleep
/// for a checkbox and later than one for a sheet that is still arriving.
///
/// An app that posts nothing gets the reaction window and no more.
/// Accessibility actions run inside the app's own handler and mostly finish
/// before they return; synthetic events are only queued, and the app handles
/// them on its next turn of the run loop.
public struct ActionSettle {
    public static let quiet: TimeInterval = 0.06
    public static let ceiling: TimeInterval = 0.8
    public static let pollMicroseconds: UInt32 = 5_000

    public static func reactionWindow(path: String?) -> TimeInterval {
        switch path {
        case "synthetic", "clipboard": return 0.25
        default: return 0.12
        }
    }

    private let reactionWindow: TimeInterval
    private let startedAt: TimeInterval
    private var lastCount: Int?
    private var lastChangeAt: TimeInterval?

    /// `countBeforeAction` is read before the action runs: an accessibility
    /// press returns after the app has handled it, so its notifications can
    /// already be counted by the time the wait starts.
    public init(path: String?, countBeforeAction: Int?, now: TimeInterval) {
        reactionWindow = ActionSettle.reactionWindow(path: path)
        startedAt = now
        lastCount = countBeforeAction
    }

    /// `count` is nil when the app cannot be observed.
    public mutating func isSettled(count: Int?, now: TimeInterval) -> Bool {
        let elapsed = now - startedAt
        guard let count, let previous = lastCount else {
            return elapsed >= reactionWindow
        }
        if count != previous {
            lastCount = count
            lastChangeAt = now
        }
        if elapsed >= ActionSettle.ceiling { return true }
        guard let lastChangeAt else { return elapsed >= reactionWindow }
        return now - lastChangeAt >= ActionSettle.quiet
    }
}
