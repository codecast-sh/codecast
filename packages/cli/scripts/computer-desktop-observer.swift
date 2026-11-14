import AppKit

// Watches what a background action must never touch, for
// `computer-bgmouse-matrix.ts`: which app is frontmost and where the real
// pointer is. It samples the pointer every 10 ms and records every app
// activation, so a pointer warped away and back, or a front app that changed
// and changed back, still shows. Needs no permission.
//
// Each line on stdin answers with one JSON line covering the time since the
// previous line: {"front": pid, "cursor": [x, y], "moved": points,
// "activations": [pid, ...]}.

final class Observer: @unchecked Sendable {
    private let lock = NSLock()
    private var origin = NSEvent.mouseLocation
    private var moved: CGFloat = 0
    private var activations: [pid_t] = []

    init() {
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.lock.withLock { self?.activations.append(app.processIdentifier) }
        }
        Timer.scheduledTimer(withTimeInterval: 0.01, repeats: true) { [weak self] _ in self?.sample() }
    }

    private func sample() {
        let now = NSEvent.mouseLocation
        lock.withLock { moved = max(moved, hypot(now.x - origin.x, now.y - origin.y)) }
    }

    func mark() -> String {
        sample()
        let now = NSEvent.mouseLocation
        let (distance, seen): (CGFloat, [pid_t]) = lock.withLock {
            defer {
                origin = now
                moved = 0
                activations = []
            }
            return (moved, activations)
        }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        let object: [String: Any] = ["front": front, "cursor": [now.x, now.y], "moved": distance, "activations": seen]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return String(decoding: data, as: UTF8.self)
    }
}

let observer = Observer()
Thread.detachNewThread {
    while let _ = readLine() {
        let line = DispatchQueue.main.sync { observer.mark() }
        print(line)
        fflush(stdout)
    }
    exit(0)
}
print("READY")
fflush(stdout)
RunLoop.main.run()
