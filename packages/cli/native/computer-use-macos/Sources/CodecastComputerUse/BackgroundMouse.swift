import AppKit
import CodecastComputerUseCore
import CoreGraphics
import Darwin
import Foundation

typealias BackgroundMouseTechnique = BackgroundMousePlan.Technique
typealias BackgroundMouseStamp = BackgroundMousePlan.Stamp

/// Mouse input for a window in the back, posted to its process so the human's
/// pointer, front app and keyboard stay theirs (the steps and techniques are
/// in `BackgroundMousePlan`).
///
/// A press posted to a pid with no window addressing reaches AppKit with no
/// window, so nothing under the point sees it. What makes it land is the
/// window routing the window server normally stamps itself (the window under
/// the pointer, the window that can handle the event, the window number), a
/// window location, and an app that believes it is active enough to take a
/// first click.

enum SkyLight {
    private typealias PostToPid = @convention(c) (pid_t, CGEvent) -> Void
    private typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    private typealias PostEventRecordTo = @convention(c) (UnsafeRawPointer, UnsafePointer<UInt8>) -> Int32
    private typealias GetProcessForPID = @convention(c) (pid_t, UnsafeMutableRawPointer) -> Int32
    private typealias MainConnectionID = @convention(c) () -> UInt32
    private typealias GetWindowOwner = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<UInt32>) -> Int32
    private typealias GetConnectionPSN = @convention(c) (UInt32, UnsafeMutableRawPointer) -> Int32

    private static let loaded: Bool = {
        dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_LAZY | RTLD_GLOBAL) != nil
    }()

    private static func symbol<T>(_ name: String, as type: T.Type) -> T? {
        guard loaded, let pointer = dlsym(UnsafeMutableRawPointer(bitPattern: -2), name) else { return nil }
        return unsafeBitCast(pointer, to: type)
    }

    private static let postToPidFn = symbol("SLEventPostToPid", as: PostToPid.self)
    private static let setWindowLocationFn = symbol("CGEventSetWindowLocation", as: SetWindowLocation.self)
    private static let postEventRecordToFn = symbol("SLPSPostEventRecordTo", as: PostEventRecordTo.self)
    private static let getProcessForPIDFn = symbol("GetProcessForPID", as: GetProcessForPID.self)
    private static let mainConnectionIDFn = symbol("CGSMainConnectionID", as: MainConnectionID.self)
    private static let getWindowOwnerFn = symbol("SLSGetWindowOwner", as: GetWindowOwner.self)
    private static let getConnectionPSNFn = symbol("SLSGetConnectionPSN", as: GetConnectionPSN.self)
    private typealias GetFrontProcess = @convention(c) (UnsafeMutableRawPointer) -> Int32
    private typealias GetProcessPID = @convention(c) (UnsafeRawPointer, UnsafeMutablePointer<pid_t>) -> Int32
    private static let getFrontProcessFn = symbol("_SLPSGetFrontProcess", as: GetFrontProcess.self)
    private static let getProcessPIDFn = symbol("GetProcessPID", as: GetProcessPID.self)

    /// The window server's front process, read fresh (NSWorkspace's answer
    /// lags behind it on a thread without a run loop). Nil when unknown.
    static func frontProcessPID() -> pid_t? {
        guard let getFrontProcessFn, let getProcessPIDFn else { return nil }
        var psn = [UInt8](repeating: 0, count: 8)
        guard psn.withUnsafeMutableBytes({ getFrontProcessFn($0.baseAddress!) }) == 0 else { return nil }
        var pid: pid_t = 0
        guard psn.withUnsafeBytes({ getProcessPIDFn($0.baseAddress!, &pid) }) == 0 else { return nil }
        return pid
    }

    static var canPost: Bool { postToPidFn != nil }
    static var canFocus: Bool { postEventRecordToFn != nil && (getProcessForPIDFn != nil || getConnectionPSNFn != nil) }

    /// Posts through SkyLight when it resolved, through the public call otherwise.
    static func post(_ event: CGEvent, to pid: pid_t) {
        if let postToPidFn { postToPidFn(pid, event) } else { event.postToPid(pid) }
    }

    @discardableResult
    static func setWindowLocation(_ event: CGEvent, _ point: CGPoint) -> Bool {
        guard let setWindowLocationFn else { return false }
        setWindowLocationFn(event, point)
        return true
    }

    private static func psn(pid: pid_t, windowId: CGWindowID) -> [UInt8]? {
        var buffer = [UInt8](repeating: 0, count: 8)
        if let mainConnectionIDFn, let getWindowOwnerFn, let getConnectionPSNFn {
            var owner: UInt32 = 0
            if getWindowOwnerFn(mainConnectionIDFn(), windowId, &owner) == 0, owner != 0,
               buffer.withUnsafeMutableBytes({ getConnectionPSNFn(owner, $0.baseAddress!) }) == 0 {
                return buffer
            }
        }
        guard let getProcessForPIDFn, buffer.withUnsafeMutableBytes({ getProcessForPIDFn(pid, $0.baseAddress!) }) == 0 else {
            return nil
        }
        return buffer
    }

    /// The focus record yabai and Cua send to make a window's app take
    /// clicks without being raised: 248 bytes, kind 0x0d, the window id at
    /// 0x3c, 0x01 at 0x8a for focus. Only the target gets one; a defocus to
    /// the front app makes its key window stop taking the human's typing.
    @discardableResult
    static func focusWithoutRaise(pid: pid_t, windowId: CGWindowID) -> Bool {
        guard let postEventRecordToFn, let psn = psn(pid: pid, windowId: windowId) else { return false }
        var record = [UInt8](repeating: 0, count: 0xF8)
        record[0x04] = 0xF8
        record[0x08] = 0x0D
        withUnsafeBytes(of: windowId.littleEndian) { bytes in
            for (offset, byte) in bytes.enumerated() { record[0x3C + offset] = byte }
        }
        record[0x8A] = 0x01
        return psn.withUnsafeBytes { psnBytes in
            record.withUnsafeBufferPointer { postEventRecordToFn(psnBytes.baseAddress!, $0.baseAddress!) == 0 }
        }
    }
}

/// One background gesture's addressing: the window it lands in and how the
/// location is stamped.
struct BackgroundMouseTarget {
    let pid: pid_t
    let windowId: CGWindowID
    let windowBounds: CGRect
    let technique: BackgroundMouseTechnique
    let stamp: BackgroundMouseStamp
    /// Test only: how long an `activate` gesture keeps its shield up after the
    /// last event, so a test can change focus while it stands. Capped by the
    /// shield's own deadline.
    var holdMicroseconds: UInt32 = 0
    /// One id across every event of a gesture, so the press, the moves and the
    /// release coalesce into one.
    let gesture = Int64(UInt32.random(in: 1...UInt32.max))

    private static let windowNumberField = CGEventField(rawValue: 51)!
    private static let gestureField = CGEventField(rawValue: 58)!
    private static let phaseField = CGEventField(rawValue: 0)!

    func stampAndPost(_ event: CGEvent, at point: CGPoint, phase: Int64? = nil) {
        event.setIntegerValueField(.eventTargetUnixProcessID, value: Int64(pid))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowId))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowId))
        event.setIntegerValueField(Self.windowNumberField, value: Int64(windowId))
        event.setIntegerValueField(Self.gestureField, value: technique == .skylight ? gesture : 1)
        if let phase { event.setIntegerValueField(Self.phaseField, value: phase) }
        if let location = BackgroundMousePlan.windowLocation(stamp, point: point, windowOrigin: windowBounds.origin) {
            SkyLight.setWindowLocation(event, location)
        }
        if technique == .skylight { SkyLight.post(event, to: pid) } else { event.postToPid(pid) }
    }

    func post(_ steps: [BackgroundMousePlan.Step], button: MouseButtonSelection = .left, flags: CGEventFlags = []) throws {
        for step in steps {
            let type: CGEventType
            switch step.kind {
            case .move: type = .mouseMoved
            case .down: type = step.primer ? .leftMouseDown : button.downEvent
            case .up: type = step.primer ? .leftMouseUp : button.upEvent
            case .dragged: type = .leftMouseDragged
            }
            guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: step.point, mouseButton: step.primer ? .left : button.cgButton) else {
                throw ProviderError(.accessibilityError, "failed to create mouse event")
            }
            if !step.primer { event.flags = flags }
            if step.clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: step.clickState) }
            event.setDoubleValueField(.mouseEventPressure, value: step.kind == .down || step.kind == .dragged ? 1 : 0)
            stampAndPost(event, at: step.point, phase: step.phase)
            if step.pauseAfterMicroseconds > 0 { usleep(step.pauseAfterMicroseconds) }
        }
    }

    /// Readies the app to take a press in this window. Returns the shield
    /// that must be lowered when the gesture ends (nil when none went up).
    func prime() -> FocusShield? {
        switch technique {
        case .pid:
            return nil
        case .skylight:
            SkyLight.focusWithoutRaise(pid: pid, windowId: windowId)
            usleep(50_000)
            return nil
        case .activate:
            let shield = FocusShield.raise(target: pid)
            postAppKitActivation(subtype: 1)
            try? post(BackgroundMousePlan.activationPrimer(windowBounds: windowBounds))
            return shield
        }
    }

    /// Hands the app back to the background after an `activate` gesture, and
    /// says how the gesture went for the action's result.
    func release(_ shield: FocusShield?) -> [String: Any] {
        var report: [String: Any] = ["technique": technique.rawValue]
        guard technique == .activate else { return report }
        if holdMicroseconds > 0 { usleep(holdMicroseconds) }
        if SkyLight.frontProcessPID() != pid {
            postAppKitActivation(subtype: 2)
        }
        shield?.lower(.gestureEnded)
        report["shield"] = shield.map { ["loweredBy": $0.loweredBy?.rawValue ?? "standing"] } ?? ["loweredBy": "none raised"]
        return report
    }

    private func postAppKitActivation(subtype: Int16) {
        guard let event = NSEvent.otherEvent(
            with: .appKitDefined,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: Int(windowId),
            context: nil,
            subtype: subtype,
            data1: 0,
            data2: 0
        )?.cgEvent else { return }
        event.setIntegerValueField(Self.windowNumberField, value: Int64(windowId))
        event.setIntegerValueField(Self.gestureField, value: 1)
        event.postToPid(pid)
        usleep(20_000)
    }
}

enum BackgroundMouse {
    /// The technique and stamp for a background press. Explicit request
    /// parameters win, for the matrix; the default is the ladder's pick.
    static func target(snapshot: Snapshot, params: [String: JSONValue]) throws -> BackgroundMouseTarget {
        func choice<T: RawRepresentable & CaseIterable>(_ key: String, _ fallback: T) throws -> T where T.RawValue == String {
            guard let raw = params[key]?.string else { return fallback }
            guard let value = T(rawValue: raw) else {
                throw ProviderError(.invalidArgument, "\(key) must be one of \(T.allCases.map(\.rawValue).joined(separator: ", "))")
            }
            return value
        }
        return BackgroundMouseTarget(
            pid: snapshot.app.pid,
            windowId: snapshot.windowId,
            windowBounds: snapshot.windowBounds,
            technique: try choice("backgroundMouse", BackgroundMouseTechnique.skylight),
            stamp: try choice("backgroundStamp", BackgroundMouseStamp.screen),
            holdMicroseconds: UInt32(min(max(params["backgroundHoldMs"]?.number ?? 0, 0), FocusShield.deadline * 1000) * 1000)
        )
    }

    static func click(_ target: BackgroundMouseTarget, at point: CGPoint, button: MouseButtonSelection, count: Int, flags: CGEventFlags) throws -> [String: Any] {
        try gesture(target) {
            try target.post(BackgroundMousePlan.click(technique: target.technique, leftButton: button == .left, at: point, count: count), button: button, flags: flags)
        }
    }

    static func drag(_ target: BackgroundMouseTarget, from: CGPoint, to: CGPoint, steps: Int, stepMicroseconds: UInt32) throws -> [String: Any] {
        try gesture(target) {
            try target.post(BackgroundMousePlan.drag(from: from, to: to, steps: steps, stepMicroseconds: stepMicroseconds))
        }
    }

    /// Prime, post, release; the shield comes down on every path out.
    private static func gesture(_ target: BackgroundMouseTarget, _ body: () throws -> Void) throws -> [String: Any] {
        let shield = target.prime()
        do {
            try body()
        } catch {
            _ = target.release(shield)
            throw error
        }
        return target.release(shield)
    }

    static func scroll(_ target: BackgroundMouseTarget, at point: CGPoint, wheel1: Int32, wheel2: Int32, ticks: Int) throws {
        try target.post([BackgroundMousePlan.Step(kind: .move, point: point, clickState: 0, pauseAfterMicroseconds: 15_000)])
        for _ in 0..<max(1, ticks) {
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: wheel1, wheel2: wheel2, wheel3: 0) else {
                throw ProviderError(.accessibilityError, "failed to create scroll event")
            }
            event.location = point
            target.stampAndPost(event, at: point)
            usleep(8_000)
        }
    }
}

/// Event taps that keep the front app from hearing it lost focus while a
/// background app is primed. They are the riskiest thing the helper does: a
/// tap that outlives its job would swallow the human's own app switches. So
/// a shield lives for one gesture, runs on its own thread (a busy helper never
/// stalls the human's events), stands down for good the moment the human acts
/// (a key, a press, or another app coming to the front), and lowers itself
/// after `deadline` even if nobody calls `lower`. The taps die with the
/// process, so a crashed helper leaves nothing behind.
final class FocusShield: @unchecked Sendable {
    static let deadline: TimeInterval = 1.5

    private let lock = NSLock()
    private var taps: [(port: CFMachPort, source: CFRunLoopSource)] = []
    private var contexts: [Context] = []
    private var standing = true
    private let front: pid_t
    private let target: pid_t
    private let raisedDate = Date()
    private var observer: NSObjectProtocol?

    final class Context {
        unowned let shield: FocusShield
        let isFront: Bool
        init(shield: FocusShield, isFront: Bool) {
            self.shield = shield
            self.isFront = isFront
        }
    }

    private static let thread = TapThread()

    private init(front: pid_t, target: pid_t) {
        self.front = front
        self.target = target
    }

    /// Nil when there is nothing to shield (the target is already in front).
    static func raise(target: pid_t) -> FocusShield? {
        guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier, front != target else { return nil }
        let shield = FocusShield(front: front, target: target)
        shield.install()
        return shield
    }

    var isStanding: Bool { lock.withLock { standing } }

    private func install() {
        for (pid, isFront) in [(front, true), (target, false)] {
            let context = Context(shield: self, isFront: isFront)
            guard let port = CGEvent.tapCreateForPid(
                pid: pid,
                place: .headInsertEventTap,
                options: .defaultTap,
                eventsOfInterest: FocusShieldPolicy.eventMask,
                callback: focusShieldCallback,
                userInfo: Unmanaged.passUnretained(context).toOpaque()
            ), let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0) else { continue }
            contexts.append(context)
            taps.append((port, source))
            Self.thread.add(source)
            CGEvent.tapEnable(tap: port, enable: true)
        }
        observer = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
        ) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            if app.processIdentifier != self.front { self.lower(.otherAppActivated) }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.deadline) { [weak self] in self?.lower(.deadline) }
    }

    /// True when the human may be changing focus: they pressed a key or a
    /// button since the shield went up, or the window server's front process
    /// is no longer theirs (or cannot be read, which counts the same).
    private func humanTookOver() -> Bool {
        guard SkyLight.frontProcessPID() == front else { return true }
        let elapsed = Date().timeIntervalSince(raisedDate)
        return [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .flagsChanged].contains {
            CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) < elapsed
        }
    }

    fileprivate func shouldDrop(type: CGEventType, isFront: Bool) -> Bool {
        switch FocusShieldPolicy.verdict(eventType: type.rawValue, boundForFront: isFront, standing: isStanding, humanActed: humanTookOver) {
        case .pass: return false
        case .drop: return true
        case .standDown:
            lower(.humanTookOver)
            return false
        }
    }

    enum Reason: String {
        case gestureEnded, humanTookOver, otherAppActivated, deadline, tapTimedOut, released
    }

    /// What lowered the shield, nil while it stands.
    var loweredBy: Reason? { lock.withLock { lowered } }
    private var lowered: Reason?

    func lower(_ reason: Reason) {
        let lowered: [(port: CFMachPort, source: CFRunLoopSource)] = lock.withLock {
            guard standing else { return [] }
            standing = false
            self.lowered = reason
            defer { taps.removeAll() }
            return taps
        }
        for tap in lowered {
            CGEvent.tapEnable(tap: tap.port, enable: false)
            CFMachPortInvalidate(tap.port)
            Self.thread.remove(tap.source)
        }
        if let observer {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            self.observer = nil
        }
    }

    deinit { lower(.released) }
}

private let focusShieldCallback: CGEventTapCallBack = { _, type, event, info in
    guard let info else { return Unmanaged.passUnretained(event) }
    let context = Unmanaged<FocusShield.Context>.fromOpaque(info).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // The window server turned the tap off because it was slow; leaving
        // it off is the safe answer, so the shield stands down.
        context.shield.lower(.tapTimedOut)
        return Unmanaged.passUnretained(event)
    }
    return context.shield.shouldDrop(type: type, isFront: context.isFront) ? nil : Unmanaged.passUnretained(event)
}

/// A thread whose run loop serves only event taps.
private final class TapThread: @unchecked Sendable {
    private var runLoop: CFRunLoop!

    init() {
        let ready = DispatchSemaphore(value: 0)
        let thread = Thread { [unowned self] in
            runLoop = CFRunLoopGetCurrent()
            RunLoop.current.add(NSMachPort(), forMode: .default)
            ready.signal()
            while true { RunLoop.current.run() }
        }
        thread.name = "codecast-focus-shield"
        thread.qualityOfService = .userInteractive
        thread.start()
        ready.wait()
    }

    func add(_ source: CFRunLoopSource) {
        CFRunLoopAddSource(runLoop, source, .commonModes)
        CFRunLoopWakeUp(runLoop)
    }

    func remove(_ source: CFRunLoopSource) {
        CFRunLoopRemoveSource(runLoop, source, .commonModes)
        CFRunLoopWakeUp(runLoop)
    }
}
