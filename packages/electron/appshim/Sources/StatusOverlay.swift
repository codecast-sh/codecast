import Cocoa

/// Covers the page when the app cannot work (HostState): what is wrong, in a
/// title and one line, and the one button that fixes it.
final class StatusOverlay: NSVisualEffectView {
    init(state: HostState, appName: String, target: AnyObject, action: Selector) {
        super.init(frame: .zero)
        material = .windowBackground
        blendingMode = .withinWindow

        let icon = NSImageView(image: NSApp.applicationIconImage ?? NSImage())
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

    // Swallow clicks so the page underneath cannot be used.
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) ?? self }
}
