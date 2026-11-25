import Foundation

/// The shim's line to the engine in Codecast's main process: a Unix socket
/// carrying newline-delimited JSON (installedApps/protocol.js serveSocket).
/// Each call is {app, frame: {version, surface}, msg: {id, module, method, args}};
/// the reply is {id, ok, value} or {id, ok:false, code, message}. A line
/// without an id is a host event {event, data}. The shim's own requests to the
/// host (uninstall, open in Codecast, status reports) go as {app, host, data,
/// msg: {id}}: a page call can never take that shape, because the shim builds
/// every envelope itself.
/// After a dropped connection it reconnects on its own, polling quietly without
/// launching Codecast, and calls `onReconnect` so the app can re-identify itself.
/// All methods run on the main thread; a reader thread hands lines back to it.
final class EngineSocket {
    typealias Message = [String: Any]

    private let path: String
    private let app: String
    private let launchHost: () -> Void
    private var fd: Int32 = -1
    private var nextId = 1
    private var pending: [Int: (Message) -> Void] = [:]
    private var queued: [(Message, (Message) -> Void)] = []
    private var connecting = false
    /// Set by a drop, cleared by the next connect, which then calls `onReconnect`.
    private var dropped = false
    /// Seconds between quiet reconnect attempts after a drop.
    var reconnectInterval: TimeInterval = 1
    var onEvent: ((String, Any) -> Void)?
    var onReconnect: (() -> Void)?
    /// Called when a connect attempt runs out of time without reaching Codecast.
    var onGaveUp: (() -> Void)?
    /// Called each time a connection opens.
    var onConnect: (() -> Void)?
    /// Called when an open connection drops.
    var onDisconnect: (() -> Void)?
    var log: (String) -> Void = { _ in }

    init(path: String, app: String, launchHost: @escaping () -> Void) {
        self.path = path
        self.app = app
        self.launchHost = launchHost
    }

    var isConnected: Bool { fd >= 0 }

    /// `msg` is {module, method, args}; `frame` is {version, surface} of the calling surface.
    func call(_ msg: Message, frame: Message, reply: @escaping (Message) -> Void) {
        let envelope: Message = ["app": app, "frame": frame, "msg": msg]
        enqueue(envelope, reply: reply)
    }

    /// A request from the shim itself to Codecast's main process: `action` names it.
    func hostCall(_ action: String, data: Message = [:], reply: @escaping (Message) -> Void = { _ in }) {
        enqueue(["app": app, "host": action, "data": data, "msg": Message()], reply: reply)
    }

    private func enqueue(_ envelope: Message, reply: @escaping (Message) -> Void) {
        if fd >= 0 { send(envelope, reply: reply); return }
        queued.append((envelope, reply))
        connect()
    }

    /// Connects, launching Codecast once in the background when the socket is
    /// not there, and polling for it for up to `timeout` seconds.
    func connect(timeout: TimeInterval = 15) {
        guard fd < 0, !connecting else { return }
        connecting = true
        let deadline = Date().addingTimeInterval(timeout)
        var launched = false
        func attempt() {
            if openSocket() {
                connected()
                return
            }
            if !launched { launched = true; launchHost() }
            if Date() < deadline {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: attempt)
                return
            }
            connecting = false
            log("gave up on \(path)")
            let waiting = queued
            queued = []
            for (_, reply) in waiting {
                reply(["ok": false, "code": "failed", "message": "Codecast is not running or not signed in"])
            }
            onGaveUp?()
            // Keep listening for Codecast without launching it again, so the app
            // recovers on its own when the person opens Codecast.
            dropped = true
            reconnectQuietly()
        }
        attempt()
    }

    private func connected() {
        connecting = false
        log("connected \(path)")
        let waiting = queued
        queued = []
        for (message, reply) in waiting { send(message, reply: reply) }
        onConnect?()
        if dropped {
            dropped = false
            onReconnect?()
        }
    }

    /// After a drop: retry until the socket is back, never launching Codecast
    /// (the person may have quit it). A call in the meantime takes the normal path.
    private func reconnectQuietly() {
        DispatchQueue.main.asyncAfter(deadline: .now() + reconnectInterval) { [weak self] in
            guard let self, self.fd < 0, !self.connecting else { return }
            if self.openSocket() {
                self.connected()
            } else {
                self.reconnectQuietly()
            }
        }
    }

    private func openSocket() -> Bool {
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return false }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { close(s); return false }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(s, $0, size) }
        }
        guard ok == 0 else { close(s); return false }
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        fd = s
        startReader(s)
        return true
    }

    private func send(_ envelope: Message, reply: @escaping (Message) -> Void) {
        let id = nextId
        nextId += 1
        var line = envelope
        var msg = envelope["msg"] as? Message ?? [:]
        msg["id"] = id
        line["msg"] = msg
        guard var data = try? JSONSerialization.data(withJSONObject: line) else {
            reply(["ok": false, "code": "bad-args", "message": "arguments are not JSON"])
            return
        }
        data.append(0x0A)
        pending[id] = reply
        let sent = data.withUnsafeBytes { raw -> Bool in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                if n <= 0 { return false }
                offset += n
            }
            return true
        }
        if !sent { disconnected() }
    }

    private func startReader(_ s: Int32) {
        Thread.detachNewThread { [weak self] in
            var buffer = Data()
            var chunk = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let n = read(s, &chunk, chunk.count)
                if n <= 0 { break }
                buffer.append(contentsOf: chunk[0..<n])
                while let nl = buffer.firstIndex(of: 0x0A) {
                    let line = buffer.subdata(in: buffer.startIndex..<nl)
                    buffer.removeSubrange(buffer.startIndex...nl)
                    guard let message = (try? JSONSerialization.jsonObject(with: line)) as? Message else { continue }
                    DispatchQueue.main.async { self?.receive(message) }
                }
            }
            DispatchQueue.main.async { if self?.fd == s { self?.disconnected() } }
        }
    }

    private func receive(_ message: Message) {
        if let id = (message["id"] as? NSNumber)?.intValue, let reply = pending.removeValue(forKey: id) {
            reply(message)
        } else if let event = message["event"] as? String {
            onEvent?(event, message["data"] ?? NSNull())
        }
    }

    private func disconnected() {
        log("disconnected")
        if fd >= 0 { close(fd) }
        fd = -1
        dropped = true
        let waiting = pending
        pending = [:]
        for reply in waiting.values {
            reply(["ok": false, "code": "failed", "message": "lost the connection to Codecast"])
        }
        onDisconnect?()
        reconnectQuietly()
    }
}
