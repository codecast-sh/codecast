import CoreGraphics

/// The events a background mouse gesture posts, in order, as data, so the
/// sequence is testable without a window server. `BackgroundMouse` (in the
/// helper) turns each step into a stamped event posted to the target's pid.
public enum BackgroundMousePlan {
    /// `pid`: window addressing alone, through the public post. `activate`:
    /// an AppKit activation event and a primer press in the window's middle,
    /// with the front app's focus messages held back. `skylight`: a SkyLight
    /// focus record to the target alone, then an off-screen primer press.
    public enum Technique: String, CaseIterable, Sendable {
        case pid
        case activate
        case skylight
    }

    /// What `CGEventSetWindowLocation` carries: the window-local point, the
    /// screen point, or nothing.
    public enum Stamp: String, CaseIterable, Sendable {
        case local
        case screen
        case none
    }

    public enum Kind: Equatable, Sendable {
        case move
        case down
        case dragged
        case up
    }

    public struct Step: Equatable, Sendable {
        public let kind: Kind
        public let point: CGPoint
        public let clickState: Int64
        /// The gesture phase field (0), which Chromium reads; nil leaves it unset.
        public let phase: Int64?
        /// Whether this is a primer, not the press the agent asked for.
        public let primer: Bool
        public let pauseAfterMicroseconds: UInt32

        public init(kind: Kind, point: CGPoint, clickState: Int64, phase: Int64? = nil, primer: Bool = false, pauseAfterMicroseconds: UInt32) {
            self.kind = kind
            self.point = point
            self.clickState = clickState
            self.phase = phase
            self.primer = primer
            self.pauseAfterMicroseconds = pauseAfterMicroseconds
        }
    }

    /// Outside every window: Chromium counts the press toward its user
    /// activation gate and no element receives it.
    public static let offScreen = CGPoint(x: -1, y: -1)

    /// The primer press that wakes an `activate` gesture's window, at its
    /// middle: the top-left corner holds the traffic lights, which take a
    /// press even from an inactive window.
    public static func activationPrimer(windowBounds: CGRect) -> [Step] {
        let middle = CGPoint(x: windowBounds.midX, y: windowBounds.midY)
        return [
            Step(kind: .down, point: middle, clickState: 1, primer: true, pauseAfterMicroseconds: 30_000),
            Step(kind: .up, point: middle, clickState: 1, primer: true, pauseAfterMicroseconds: 20_000),
        ]
    }

    public static func click(technique: Technique, leftButton: Bool, at point: CGPoint, count: Int) -> [Step] {
        let skylight = technique == .skylight
        var steps = [Step(kind: .move, point: point, clickState: 0, phase: skylight ? 2 : nil, pauseAfterMicroseconds: 15_000)]
        if skylight, leftButton {
            steps.append(Step(kind: .down, point: offScreen, clickState: 1, phase: 1, primer: true, pauseAfterMicroseconds: 1_000))
            steps.append(Step(kind: .up, point: offScreen, clickState: 1, phase: 2, primer: true, pauseAfterMicroseconds: 100_000))
        }
        let presses = min(max(count, 1), SyntheticMouseClickDelivery.maxClickCount)
        for press in 1...presses {
            steps.append(Step(kind: .down, point: point, clickState: Int64(press), phase: skylight ? 3 : nil, pauseAfterMicroseconds: 30_000))
            steps.append(Step(kind: .up, point: point, clickState: Int64(press), phase: skylight ? 3 : nil, pauseAfterMicroseconds: press < presses ? 80_000 : 0))
        }
        return steps
    }

    /// Down, `steps` dragged moves, up: apps start a drag only after the
    /// pointer moved a few points with the button held.
    public static func drag(from: CGPoint, to: CGPoint, steps: Int, stepMicroseconds: UInt32) -> [Step] {
        let count = max(1, steps)
        var plan = [
            Step(kind: .move, point: from, clickState: 0, pauseAfterMicroseconds: 15_000),
            Step(kind: .down, point: from, clickState: 1, pauseAfterMicroseconds: 60_000),
        ]
        for step in 1...count {
            let t = CGFloat(step) / CGFloat(count)
            plan.append(Step(kind: .dragged, point: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), clickState: 1, pauseAfterMicroseconds: stepMicroseconds))
        }
        plan.append(Step(kind: .up, point: to, clickState: 1, pauseAfterMicroseconds: 0))
        return plan
    }

    /// The point `CGEventSetWindowLocation` gets, or nil for none. The
    /// off-screen primer keeps its point in every mode.
    public static func windowLocation(_ stamp: Stamp, point: CGPoint, windowOrigin: CGPoint) -> CGPoint? {
        if point == offScreen { return stamp == .none ? nil : point }
        switch stamp {
        case .local: return CGPoint(x: point.x - windowOrigin.x, y: point.y - windowOrigin.y)
        case .screen: return point
        case .none: return nil
        }
    }
}

/// When the focus shield drops an event. Only the window server's focus
/// messages (raw types 13, 19 and 20, which have no public names) bound for
/// the human's front app are ever dropped, and only while the shield stands;
/// the moment the human presses a key or a button, it stands down for good,
/// because that press may be them switching apps.
public enum FocusShieldPolicy {
    public static let focusEventTypes: Set<UInt32> = [13, 19, 20]

    public enum Verdict: Equatable, Sendable {
        case pass
        case drop
        /// Pass this event and lower the shield.
        case standDown
    }

    /// The tap listens for these alone, so the human's keys and pointer
    /// never pass through it.
    public static var eventMask: UInt64 {
        focusEventTypes.reduce(0) { $0 | (UInt64(1) << UInt64($1)) }
    }

    /// `humanActed` is asked only for a focus message that would be dropped.
    public static func verdict(eventType: UInt32, boundForFront: Bool, standing: Bool, humanActed: () -> Bool) -> Verdict {
        guard standing, boundForFront, focusEventTypes.contains(eventType) else { return .pass }
        return humanActed() ? .standDown : .drop
    }
}
