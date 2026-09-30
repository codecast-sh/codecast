/// How long an action waits before the snapshot it returns. Accessibility
/// actions run inside the app's own handler and mostly finish before they
/// return; synthetic events are only queued, and the app handles them on its
/// next turn of the run loop.
public enum ActionSettle {
    public static func microseconds(path: String?) -> UInt32 {
        switch path {
        case "synthetic", "clipboard": return 250_000
        default: return 120_000
        }
    }
}
