import Foundation

/// How long the helper waits on an app that is not answering.
///
/// Every accessibility request runs on the target app's main thread, and the
/// system default wait is six seconds per request: an app stuck in a long
/// handler or hung outright held a walk of a thousand requests for minutes.
/// A read gives up after `readSeconds`; the first one that does ends the walk,
/// and the tree read until then is returned marked incomplete. An action gets
/// longer, because its handler runs inside the request; when even that runs
/// out, the action may still have landed, so it is reported as unknown and
/// never tried a second way.
public enum AppResponsiveness {
    public static let readSeconds: Float = 2
    public static let actionSeconds: Float = 5

    public static let stalledNote = "The app stopped answering accessibility requests partway through this read, so the tree above is incomplete; read again once it responds."

    public static func notResponding(app: String) -> String {
        "'\(app)' did not answer an accessibility request within \(Int(readSeconds)) s: its main thread is busy or hung. Nothing was read; try again once it responds."
    }

    public static func outcomeUnknown(_ what: String) -> String {
        "\(what) got no answer within \(Int(actionSeconds)) s, so whether it took effect is unknown. It was not retried. Read the window before acting again."
    }
}
