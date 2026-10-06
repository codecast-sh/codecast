import AppKit
import QuartzCore

/// The agent's own pointer: a cursor drawn in a click-through overlay that
/// glides to wherever the agent is about to act and pulses when it presses.
///
/// The human's pointer is theirs. Most actions never touch it (accessibility
/// presses, set-value, keys), and the few that must post a real mouse event put
/// it back afterwards, so without this the agent's work is invisible: a button
/// changes state with nothing on screen saying who did it. The overlay is a
/// non-activating panel that ignores the mouse, so it can never take focus or
/// catch a click meant for the app under it.
///
/// Requests arrive on the socket thread; drawing happens on the main thread.
/// Nothing waits for the drawing: the action runs while the cursor glides, and
/// a press that comes before the cursor has arrived pulses when it does.
@MainActor
final class AgentCursor {
    static let shared = AgentCursor()

    /// Where the arrow's tip sits inside the panel, in view points (y up).
    private static let size = CGSize(width: 72, height: 48)
    private static let tip = CGPoint(x: 6, y: 42)

    private var panel: NSPanel?
    private var pulseLayer: CAShapeLayer?
    private var lastPoint: CGPoint?
    private var hideWork: DispatchWorkItem?
    /// Bumped by every glide, so only the latest one's arrival counts.
    private var glideGeneration = 0
    private var gliding = false
    private var pulseOnArrival = false

    /// `CODECAST_COMPUTER_CURSOR=0` turns it off for a whole session.
    nonisolated static var enabledByEnvironment: Bool {
        ProcessInfo.processInfo.environment["CODECAST_COMPUTER_CURSOR"] != "0"
    }

    // MARK: socket thread entry points

    /// Glide to a point (global, top-left origin).
    nonisolated static func move(to point: CGPoint) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { shared.glide(to: point, duration: nil) {} }
        }
    }

    /// Follow a drag: glide along without waiting, since the events are
    /// already on their way over the same stretch of time.
    nonisolated static func follow(to point: CGPoint, over seconds: Double) {
        DispatchQueue.main.async {
            MainActor.assumeIsolated { shared.glide(to: point, duration: seconds) { shared.pulse() } }
        }
    }

    nonisolated static func press() {
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if shared.gliding { shared.pulseOnArrival = true } else { shared.pulse() }
            }
        }
    }

    // MARK: drawing

    private func glide(to point: CGPoint, duration requested: Double?, completion: @escaping () -> Void) {
        let panel = ensurePanel()
        hideWork?.cancel()
        let target = frameOrigin(for: point)
        let from = lastPoint
        lastPoint = point
        if from == nil || !panel.isVisible {
            // First appearance: fade in a short way off the target, then glide
            // the last stretch, so it reads as arriving rather than blinking in.
            panel.setFrameOrigin(NSPoint(x: target.x - 28, y: target.y + 18))
            panel.alphaValue = 0
            panel.orderFrontRegardless()
        }
        glideGeneration += 1
        let generation = glideGeneration
        gliding = true
        let distance = from.map { hypot($0.x - point.x, $0.y - point.y) } ?? 40
        let duration = requested ?? min(0.42, max(0.16, 0.12 + Double(distance) / 2600))
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1, 0.36, 1)
            // A window animates its frame, not its origin: setFrameOrigin on
            // the animator lands without moving.
            panel.animator().setFrame(NSRect(origin: target, size: Self.size), display: false)
            panel.animator().alphaValue = 1
        }, completionHandler: { [weak self] in
            completion()
            guard let self, generation == glideGeneration else { return }
            gliding = false
            if pulseOnArrival {
                pulseOnArrival = false
                pulse()
            }
            scheduleHide()
        })
    }

    private func pulse() {
        guard let layer = pulseLayer else { return }
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.35
        grow.toValue = 1.6
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = 0.38
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        layer.add(group, forKey: "pulse")
    }

    private func scheduleHide() {
        hideWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let panel = self?.panel else { return }
                NSAnimationContext.runAnimationGroup({ context in
                    context.duration = 0.4
                    panel.animator().alphaValue = 0
                }, completionHandler: {
                    panel.orderOut(nil)
                    self?.lastPoint = nil
                })
            }
        }
        hideWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: work)
    }

    /// Global top-left coordinates to the panel origin AppKit wants (bottom-left
    /// origin, measured from the primary screen).
    private func frameOrigin(for point: CGPoint) -> NSPoint {
        let primaryHeight = NSScreen.screens.first?.frame.maxY ?? 0
        return NSPoint(x: point.x - Self.tip.x, y: primaryHeight - point.y - Self.tip.y)
    }

    private func ensurePanel() -> NSPanel {
        if let panel { return panel }
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: Self.size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.isFloatingPanel = true
        panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.overlayWindow)))
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]

        let view = NSView(frame: NSRect(origin: .zero, size: Self.size))
        view.wantsLayer = true
        let root = view.layer!

        let pulse = CAShapeLayer()
        pulse.path = CGPath(ellipseIn: CGRect(x: -14, y: -14, width: 28, height: 28), transform: nil)
        pulse.position = Self.tip
        pulse.fillColor = NSColor(calibratedRed: 1, green: 0.42, blue: 0.21, alpha: 0.35).cgColor
        pulse.strokeColor = NSColor(calibratedRed: 1, green: 0.42, blue: 0.21, alpha: 0.9).cgColor
        pulse.lineWidth = 1.5
        pulse.opacity = 0
        root.addSublayer(pulse)
        pulseLayer = pulse

        let arrow = CAShapeLayer()
        arrow.path = Self.arrowPath()
        arrow.fillColor = NSColor(calibratedRed: 1, green: 0.42, blue: 0.21, alpha: 1).cgColor
        arrow.strokeColor = NSColor.white.cgColor
        arrow.lineWidth = 1.6
        arrow.lineJoin = .round
        arrow.shadowColor = NSColor.black.cgColor
        arrow.shadowOpacity = 0.35
        arrow.shadowRadius = 2.5
        arrow.shadowOffset = CGSize(width: 0, height: -1)
        root.addSublayer(arrow)

        // A small tag, so the human can tell this pointer from their own at a glance.
        let tag = CATextLayer()
        tag.string = "agent"
        tag.font = NSFont.systemFont(ofSize: 10, weight: .semibold)
        tag.fontSize = 10
        tag.foregroundColor = NSColor.white.cgColor
        tag.backgroundColor = NSColor(calibratedRed: 0.13, green: 0.13, blue: 0.16, alpha: 0.92).cgColor
        tag.cornerRadius = 7
        tag.alignmentMode = .center
        tag.contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        tag.frame = CGRect(x: 22, y: 8, width: 42, height: 15)
        root.addSublayer(tag)

        panel.contentView = view
        self.panel = panel
        return panel
    }

    /// The classic pointer silhouette with its tip at `tip`, in a y-up view.
    private static func arrowPath() -> CGPath {
        let t = tip
        let path = CGMutablePath()
        path.move(to: t)
        path.addLine(to: CGPoint(x: t.x, y: t.y - 22))
        path.addLine(to: CGPoint(x: t.x + 5.5, y: t.y - 17))
        path.addLine(to: CGPoint(x: t.x + 9.5, y: t.y - 26))
        path.addLine(to: CGPoint(x: t.x + 13, y: t.y - 24.5))
        path.addLine(to: CGPoint(x: t.x + 9, y: t.y - 15.5))
        path.addLine(to: CGPoint(x: t.x + 16, y: t.y - 15.5))
        path.closeSubpath()
        return path
    }
}

