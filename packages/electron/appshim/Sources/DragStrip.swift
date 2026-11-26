import Cocoa

/// The band across the top of a window whose title bar is hidden
/// (window.titleBar "hidden"). WKWebView does not honor
/// `-webkit-app-region: drag`, so this transparent strip sits above the page
/// under the traffic lights: dragging it moves the window, and a double click
/// zooms or minimizes it as the person's Dock setting says. The page leaves
/// this band free of controls.
final class DragStrip: NSView {
    static let height: CGFloat = 28

    override var mouseDownCanMoveWindow: Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        if event.clickCount == 2 {
            let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
            if action == "Minimize" { window.performMiniaturize(nil) } else if action != "None" { window.performZoom(nil) }
            return
        }
        window.performDrag(with: event)
    }
}
