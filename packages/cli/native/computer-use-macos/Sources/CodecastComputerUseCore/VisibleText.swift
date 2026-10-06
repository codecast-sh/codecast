import Foundation

/// Text read off a window's pixels, in window points.
public struct VisibleTextItem: Equatable {
    public var text: String
    public var frame: CGRect

    public init(text: String, frame: CGRect) {
        self.text = text
        self.frame = frame
    }
}

/// Some windows draw their interface instead of describing it: a canvas, a
/// game, an Electron view with accessibility off, a button whose label is an
/// image. The tree for those is a list of unnamed containers, and the only
/// place the words exist is the pixels. Reading them gives the agent names to
/// act on without a screenshot round trip.
public enum VisibleText {
    public static let role = "visible text"
    public static let sectionNote = "Text read from the window's pixels, with no element behind it; an index here clicks at its center:"
    public static let needsScreenRecording = "This window's tree has nothing to act on, and reading its pixels needs Screen Recording (cast computer setup)."

    public struct Anchor: Equatable {
        public var index: Int
        public var frame: CGRect
        public var line: String
        /// Takes a press and has no name of its own.
        public var unnamedPressable: Bool

        public init(index: Int, frame: CGRect, line: String, unnamedPressable: Bool) {
            self.index = index
            self.frame = frame
            self.line = line
            self.unnamedPressable = unnamedPressable
        }
    }

    public enum Placement: Equatable {
        /// The tree already says this.
        case duplicate
        /// The words are the label of an element that has none.
        case names(index: Int)
        case standalone
    }

    /// A control an agent could act on by name. Title bar buttons do not count:
    /// every window has them, including one that describes nothing else.
    public static func isApplicationControl(
        role: String,
        subrole: String?,
        named: Bool,
        enabled: Bool,
        hasAction: Bool
    ) -> Bool {
        guard enabled, !windowControlSubroles.contains(subrole ?? "") else { return false }
        if textInputRoles.contains(role) { return true }
        return controlRoles.contains(role) && named && hasAction
    }

    public static func place(_ item: VisibleTextItem, anchors: [Anchor]) -> Placement {
        let center = CGPoint(x: item.frame.midX, y: item.frame.midY)
        let under = anchors.filter { $0.frame.width > 0 && $0.frame.height > 0 && $0.frame.contains(center) }
        let needle = normalized(item.text)
        if under.contains(where: { normalized($0.line).contains(needle) }) { return .duplicate }
        let unnamed = under.filter(\.unnamedPressable).min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
        if let unnamed { return .names(index: unnamed.index) }
        return .standalone
    }

    public static func line(index: Int, text: String) -> String {
        "\(index) \(role) \(SnapshotRenderHeuristics.sanitize(text))"
    }

    public static func seenSuffix(_ texts: [String]) -> String {
        ", Seen: \(SnapshotRenderHeuristics.sanitize(texts.joined(separator: " ")))"
    }

    public static func signature(_ text: String) -> String {
        [role, text].joined(separator: ElementSignature.separator)
    }

    /// Reading order: top to bottom, then left to right within a line.
    public static func readingOrder(_ items: [VisibleTextItem]) -> [VisibleTextItem] {
        items.sorted { lhs, rhs in
            if abs(lhs.frame.midY - rhs.frame.midY) > min(lhs.frame.height, rhs.frame.height) / 2 {
                return lhs.frame.midY < rhs.frame.midY
            }
            return lhs.frame.minX < rhs.frame.minX
        }
    }

    public static let maxItems = 200

    private static func normalized(_ value: String) -> String {
        value.lowercased().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private static let windowControlSubroles: Set<String> = [
        "AXCloseButton", "AXMinimizeButton", "AXZoomButton", "AXFullScreenButton", "AXToolbarButton",
    ]
    private static let textInputRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]
    private static let controlRoles: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXMenuItem",
        "AXSlider", "AXTab", "AXDisclosureTriangle", "AXIncrementor", "AXColorWell", "AXRow", "AXCell",
    ]
}
