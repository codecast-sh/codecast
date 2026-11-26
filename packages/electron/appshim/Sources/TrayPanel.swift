import Cocoa

/// The menu bar item's page, in a panel under the item. The panel is created
/// non-activating, so it takes the keyboard (typing, Esc) while another app
/// stays in front and this app's main window stays where it is. NSPopover
/// cannot give that: its window is AppKit's own, and making it
/// non-activating after the fact does not change how the window server
/// treats a click in it. It closes on Esc, on a click anywhere outside it,
/// when it stops being the key window, and on a second click on the item.
@MainActor
final class TrayPanel: NSPanel {
    /// Why it closed: "esc", "outside click", "lost key" or the caller's reason.
    var onClose: ((String) -> Void)?
    private var outsideClicks: Any?
    private weak var highlighted: NSStatusBarButton?

    init(content: NSView, size: NSSize) {
        super.init(contentRect: NSRect(origin: .zero, size: size),
                   styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: true)
        // Borderless, so no title bar sits over the top of the page; the
        // rounded corners come from the background below and the shadow follows them.
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovable = false
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        level = .popUpMenu
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient, .ignoresCycle]
        animationBehavior = .utilityWindow

        let background = NSVisualEffectView()
        background.material = .popover
        background.state = .active
        background.blendingMode = .behindWindow
        background.wantsLayer = true
        background.layer?.cornerRadius = 10
        background.layer?.cornerCurve = .continuous
        background.layer?.masksToBounds = true
        contentView = background
        content.translatesAutoresizingMaskIntoConstraints = false
        background.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            content.topAnchor.constraint(equalTo: background.topAnchor),
            content.bottomAnchor.constraint(equalTo: background.bottomAnchor),
        ])
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// Under the status item, centered on it and kept on its screen. With an
    /// auto-hidden menu bar the item can sit above the screen, so the panel's
    /// top never goes higher than the screen's usable area.
    func show(under button: NSStatusBarButton) {
        guard let itemWindow = button.window else { return }
        let item = itemWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let screen = itemWindow.screen ?? NSScreen.screens.first(where: { $0.frame.contains(NSPoint(x: item.midX, y: item.minY - 1)) })
            ?? NSScreen.main
        let area = screen?.visibleFrame ?? item
        let size = frame.size
        let top = min(item.minY, area.maxY) - 4
        let x = max(area.minX + 6, min(item.midX - size.width / 2, area.maxX - size.width - 6))
        setFrame(NSRect(x: x, y: top - size.height, width: size.width, height: size.height), display: false)
        makeKeyAndOrderFront(nil)
        invalidateShadow()
        button.highlight(true)
        highlighted = button
        // A click in another app's window, the desktop or the menu bar never reaches this process.
        outsideClicks = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss("outside click") }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(lostKey), name: NSWindow.didResignKeyNotification, object: self)
    }

    @objc private func lostKey() { dismiss("lost key") }

    override func cancelOperation(_ sender: Any?) { dismiss("esc") }

    func dismiss(_ reason: String) {
        guard isVisible else { return }
        if let monitor = outsideClicks { NSEvent.removeMonitor(monitor) }
        outsideClicks = nil
        NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: self)
        orderOut(nil)
        highlighted?.highlight(false)
        onClose?(reason)
    }
}
