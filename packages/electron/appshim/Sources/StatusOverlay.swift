import Cocoa

/// Covers the page when the app cannot work (HostState): what is wrong, in a
/// title and one line, and the one button that fixes it.
final class StatusOverlay: NSVisualEffectView {
    /// `background`: a color to draw instead of the window material (the
    /// page's color, when the title bar wears it, so cover and title bar read
    /// as one surface).
    init(state: HostState, appName: String, background: NSColor? = nil, target: AnyObject, action: Selector) {
        super.init(frame: .zero)
        material = .windowBackground
        blendingMode = .withinWindow
        if let background {
            let fill = NSView()
            fill.wantsLayer = true
            fill.layer?.backgroundColor = background.cgColor
            fill.translatesAutoresizingMaskIntoConstraints = false
            addSubview(fill)
            NSLayoutConstraint.activate([
                fill.leadingAnchor.constraint(equalTo: leadingAnchor), fill.trailingAnchor.constraint(equalTo: trailingAnchor),
                fill.topAnchor.constraint(equalTo: topAnchor), fill.bottomAnchor.constraint(equalTo: bottomAnchor),
            ])
        }

        let icon = FullColorImageView(image: StatusOverlay.appIcon())
        icon.imageScaling = .scaleProportionallyUpOrDown
        icon.widthAnchor.constraint(equalToConstant: 64).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 64).isActive = true

        let title = NSTextField(labelWithString: state.title)
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.alignment = .center

        let detail = NSTextField(wrappingLabelWithString: state.detail(app: appName))
        detail.font = .systemFont(ofSize: 13)
        detail.textColor = .secondaryLabelColor
        detail.alignment = .center
        detail.preferredMaxLayoutWidth = 280

        let button = NSButton(title: state.action, target: target, action: action)
        button.bezelStyle = .rounded
        button.controlSize = .large
        button.keyEquivalent = "\r"
        button.setAccessibilityIdentifier("host-state-action")

        let stack = NSStackView(views: [icon, title, detail, button])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 10
        stack.setCustomSpacing(18, after: detail)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
        ])
        setAccessibilityIdentifier("host-state")
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// The app's own icon in color: the bundle's app.icns, else what Finder
    /// shows for the bundle.
    static func appIcon() -> NSImage {
        let image = Bundle.main.image(forResource: "app") ?? NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
        image.isTemplate = false
        return image
    }

    // Swallow clicks so the page underneath cannot be used.
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) ?? self }
}

/// An image view the vibrant overlay does not tint: it draws the icon as is.
final class FullColorImageView: NSImageView {
    override var allowsVibrancy: Bool { false }
}
