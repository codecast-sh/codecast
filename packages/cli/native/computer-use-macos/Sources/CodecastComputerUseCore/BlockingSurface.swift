import Foundation

/// A sheet or modal dialog takes its window: nothing behind it responds until
/// it closes, and a press sent to a covered control still runs that control's
/// action. So while one is up, it is the only thing the tree offers, and an
/// index from before it opened no longer resolves.
///
/// AppKit keeps a sheet inside its window's tree as an `AXSheet`, and marks
/// every modal surface, a web page's dialog included, with `AXModal`. A popover
/// is not one of these: the window behind it still takes a click.
public enum BlockingSurface {
    public static func blocks(role: String, modal: Bool) -> Bool {
        role == "AXSheet" || modal
    }

    public static func noun(role: String) -> String {
        role == "AXSheet" ? "sheet" : "dialog"
    }

    public static func note(noun: String, windowTitle: String) -> String {
        "Only this \(noun) is listed: it covers \"\(SnapshotRenderHeuristics.sanitize(windowTitle))\", which does not respond until the \(noun) closes."
    }

    public static func blockedNote(dialogTitle: String, windowId: Int) -> String {
        "Blocked: the dialog \"\(SnapshotRenderHeuristics.sanitize(dialogTitle))\" is modal, and this window does not respond until it closes. Target it with --window-id \(windowId)."
    }

    /// Surfaces that extend past the window they belong to, so the window's
    /// bounds say nothing about whether they are on screen.
    public static func extendsPastWindow(role: String) -> Bool {
        ["AXSheet", "AXPopover", "AXMenu", "AXMenuBar", "AXMenuItem"].contains(role)
    }
}

/// What a window that is too large for the node cap keeps: what is on screen.
///
/// A tree that fits lists everything, on screen or not, because an element
/// below the fold can be pressed without scrolling to it. Past the cap the walk
/// used to stop wherever it happened to be, which could spend the whole budget
/// on a sidebar and never reach the content. Then only what intersects the
/// visible region is walked, and scroll and web areas narrow that region to
/// their own frame.
public enum VisibleRegion {
    public static let note = "Off-screen content is left out because this window is large; scroll to bring more of it into the tree."

    /// A zero-size element is never skipped: web content overflows a
    /// zero-size wrapper.
    public static func isOutside(_ frame: CGRect?, region: CGRect?) -> Bool {
        guard let frame, let region, frame.width > 0, frame.height > 0 else { return false }
        return !frame.intersects(region)
    }

    public static func narrowed(_ region: CGRect?, role: String, frame: CGRect?) -> CGRect? {
        if BlockingSurface.extendsPastWindow(role: role) { return nil }
        guard let region, let frame, role == "AXScrollArea" || role == "AXWebArea" else { return region }
        let intersection = region.intersection(frame)
        return intersection.isNull ? region : intersection
    }
}
