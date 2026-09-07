import Foundation

/// Element indexes are a cache, and acting on a stale entry clicks the wrong
/// thing. Each index carries a signature of the fields that name the element;
/// an action re-observes and rejects an index whose signature moved.
///
/// Value, placeholder and summary are deliberately excluded. They change when a
/// field takes focus or the user types, and rejecting on that would break every
/// text control the moment an agent clicked into it.
public enum ElementSignature {
    public static let separator = "\u{1f}"

    public static func of(_ node: SnapshotRenderNode) -> String {
        [
            node.role,
            node.roleDescription ?? "",
            node.title ?? "",
            node.label ?? "",
            node.linkText ?? "",
            node.url ?? "",
            SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role).joined(separator: ","),
        ].joined(separator: separator)
    }
}
