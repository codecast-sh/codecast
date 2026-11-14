import AppKit
import CodecastComputerUseCore
import CoreGraphics
import Darwin
import Foundation

/// Mouse input for a window in the back, posted to its process so the human's
/// pointer, front app and keyboard stay theirs.
///
/// A press posted to a pid with no window addressing reaches AppKit with no
/// window, so nothing under the point sees it. What makes it land is the
/// window routing the window server normally stamps itself (the window under
/// the pointer, the window that can handle the event, the window number), a
/// window location, and an app that believes it is active enough to take a
/// first click. Two published routes give it that belief:
///
/// - `activate`: tell the app it was activated (an AppKit-defined event),
///   then a primer click in the window's middle, through the public
///   `CGEventPostToPid`. Event taps on the front app and the target drop the
///   focus messages that would otherwise tell the front app it lost focus.
/// - `skylight`: one focus event record sent to the target alone through
///   SkyLight, then a moved event and an off-screen primer press (which
///   Chromium needs to count a user activation), through `SLEventPostToPid`,
///   the path real input takes (Chromium drops presses without it).
///
/// `pid` is the addressing alone, the control.
enum BackgroundMouseTechnique: String, CaseIterable {
    case pid
    case activate
    case skylight
}

/// Where `CGEventSetWindowLocation` puts the point. Releases disagree.
enum BackgroundMouseStamp: String, CaseIterable {
    case local
    case screen
    case none
}

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
        let offScreen = point.x < 0 && point.y < 0
        switch stamp {
        case .local:
            SkyLight.setWindowLocation(event, offScreen ? point : CGPoint(x: point.x - windowBounds.minX, y: point.y - windowBounds.minY))
        case .screen:
            SkyLight.setWindowLocation(event, point)
        case .none:
            break
        }
        if technique == .skylight { SkyLight.post(event, to: pid) } else { event.postToPid(pid) }
    }

    func mouse(_ type: CGEventType, at point: CGPoint, button: CGMouseButton, clickState: Int64, flags: CGEventFlags = [], phase: Int64? = nil) throws {
        guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
            throw ProviderError(.accessibilityError, "failed to create mouse event")
        }
        event.flags = flags
        if clickState > 0 { event.setIntegerValueField(.mouseEventClickState, value: clickState) }
        let pressing = type == .leftMouseDown || type == .rightMouseDown || type == .otherMouseDown ||
            type == .leftMouseDragged || type == .rightMouseDragged || type == .otherMouseDragged
        event.setDoubleValueField(.mouseEventPressure, value: pressing ? 1 : 0)
        stampAndPost(event, at: point, phase: phase)
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
            let middle = CGPoint(x: windowBounds.midX, y: windowBounds.midY)
            try? mouse(.leftMouseDown, at: middle, button: .left, clickState: 1)
            usleep(30_000)
            try? mouse(.leftMouseUp, at: middle, button: .left, clickState: 1)
            usleep(20_000)
            return shield
        }
    }

    /// Hands the app back to the background after an `activate` gesture.
    func release(_ shield: FocusShield?) {
        guard technique == .activate else { return }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid {
            postAppKitActivation(subtype: 2)
            usleep(20_000)
        }
        shield?.lower()
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
        let technique = try params["backgroundMouse"]?.string.map { raw -> BackgroundMouseTechnique in
            guard let value = BackgroundMouseTechnique(rawValue: raw) else {
                throw ProviderError(.invalidArgument, "backgroundMouse must be one of \(BackgroundMouseTechnique.allCases.map(\.rawValue).joined(separator: ", "))")
            }
            return value
        } ?? .skylight
        let stamp = try params["backgroundStamp"]?.string.map { raw -> BackgroundMouseStamp in
            guard let value = BackgroundMouseStamp(rawValue: raw) else {
                throw ProviderError(.invalidArgument, "backgroundStamp must be one of \(BackgroundMouseStamp.allCases.map(\.rawValue).joined(separator: ", "))")
            }
            return value
        } ?? .screen
        return BackgroundMouseTarget(pid: snapshot.app.pid, windowId: snapshot.windowId, windowBounds: snapshot.windowBounds, technique: technique, stamp: stamp)
    }

    static func click(_ target: BackgroundMouseTarget, at point: CGPoint, button: MouseButtonSelection, count: Int, flags: CGEventFlags) throws {
        let shield = target.prime()
        defer { target.release(shield) }
        try target.mouse(.mouseMoved, at: point, button: button.cgButton, clickState: 0, phase: target.technique == .skylight ? 2 : nil)
        usleep(15_000)
        if target.technique == .skylight, button == .left {
            // Chromium counts a user activation only after a press it saw; one
            // outside every window advances the gate without touching the page.
            let offScreen = CGPoint(x: -1, y: -1)
            try target.mouse(.leftMouseDown, at: offScreen, button: .left, clickState: 1, phase: 1)
            usleep(1_000)
            try target.mouse(.leftMouseUp, at: offScreen, button: .left, clickState: 1, phase: 2)
            usleep(100_000)
        }
        for press in 1...max(1, count) {
            try target.mouse(button.downEvent, at: point, button: button.cgButton, clickState: Int64(press), flags: flags, phase: target.technique == .skylight ? 3 : nil)
            usleep(30_000)
            try target.mouse(button.upEvent, at: point, button: button.cgButton, clickState: Int64(press), flags: flags, phase: target.technique == .skylight ? 3 : nil)
            if press < count { usleep(80_000) }
        }
    }

    static func drag(_ target: BackgroundMouseTarget, from: CGPoint, to: CGPoint, steps: Int, stepMicroseconds: UInt32) throws {
        let shield = target.prime()
        defer { target.release(shield) }
        try target.mouse(.mouseMoved, at: from, button: .left, clickState: 0)
        usleep(15_000)
        try target.mouse(.leftMouseDown, at: from, button: .left, clickState: 1)
        usleep(60_000)
        for step in 1...max(1, steps) {
            let t = CGFloat(step) / CGFloat(max(1, steps))
            try target.mouse(.leftMouseDragged, at: CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t), button: .left, clickState: 1)
            usleep(stepMicroseconds)
        }
        try target.mouse(.leftMouseUp, at: to, button: .left, clickState: 1)
    }

    static func scroll(_ target: BackgroundMouseTarget, at point: CGPoint, wheel1: Int32, wheel2: Int32, ticks: Int) throws {
        try target.mouse(.mouseMoved, at: point, button: .left, clickState: 0)
        usleep(15_000)
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
    /// Window server focus messages, which have no public names.
    static let focusEventTypes: Set<UInt32> = [13, 19, 20]

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
                eventsOfInterest: CGEventMask.max,
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
            if app.processIdentifier != self.front { self.lower() }
        }
        DispatchQueue.global().asyncAfter(deadline: .now() + Self.deadline) { [weak self] in self?.lower() }
    }

    /// True when the human pressed a key or a button since the shield went up.
    private func humanActed() -> Bool {
        let elapsed = Date().timeIntervalSince(raisedDate)
        return [CGEventType.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .flagsChanged].contains {
            CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) < elapsed
        }
    }

    fileprivate func shouldDrop(type: CGEventType, isFront: Bool) -> Bool {
        guard isFront, Self.focusEventTypes.contains(type.rawValue) else { return false }
        guard isStanding else { return false }
        if humanActed() {
            lower()
            return false
        }
        return true
    }

    func lower() {
        let lowered: [(port: CFMachPort, source: CFRunLoopSource)] = lock.withLock {
            guard standing else { return [] }
            standing = false
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

    deinit { lower() }
}

private let focusShieldCallback: CGEventTapCallBack = { _, type, event, info in
    guard let info else { return Unmanaged.passUnretained(event) }
    let context = Unmanaged<FocusShield.Context>.fromOpaque(info).takeUnretainedValue()
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        // The window server turned the tap off because it was slow; leaving
        // it off is the safe answer, so the shield stands down.
        context.shield.lower()
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
