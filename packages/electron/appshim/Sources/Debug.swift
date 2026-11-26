import Cocoa
@preconcurrency import UserNotifications
import WebKit

/// Spike and test aid, off unless the shim is launched with
/// CODECAST_APPSHIM_DEBUG_DIR (`open --env`). SIGUSR1 toggles the tray panel
/// (from another app in front, as a menu bar click would);
/// SIGUSR2 writes PNGs of the app's own surfaces (window page, status button,
/// tray page, the window's native frame, and each of its windows as the
/// screen shows it), menu.txt and dock-menu.txt into that directory, and logs
/// the notifications macOS has delivered for the app; SIGINFO picks the menu
/// item whose title starts with the first line of pick.txt there ("Uninstall"
/// without one), as a click would. Drawing its own views needs no Screen Recording
/// grant, which a test runner usually lacks. At launch it writes the menu's
/// titles to menu.txt there, since the menu bar is outside a window's
/// accessibility tree.
extension AppDelegate {
    func installDebugSignals() {
        guard let dir = ProcessInfo.processInfo.environment["CODECAST_APPSHIM_DEBUG_DIR"] else { return }
        let out = URL(fileURLWithPath: dir)
        for (sig, handler) in [(SIGUSR1, { [weak self] in self?.debugToggleTray() }),
                               (SIGUSR2, { [weak self] in self?.debugSnapshot(into: out) }),
                               (SIGINFO, { [weak self] in
                                   let pick = (try? String(contentsOf: out.appendingPathComponent("pick.txt"), encoding: .utf8))?
                                       .split(separator: "\n").first.map(String.init)
                                   self?.debugPickMenu(pick ?? "Uninstall")
                               })] as [(Int32, () -> Void)] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler(handler: handler)
            source.resume()
            debugSources.append(source)
        }
        shimLog("debug signals on, snapshots to \(dir)")
        debugWriteMenu(into: out)
        // A burst of the window as the screen shows it, to catch what draws before the page paints.
        if ProcessInfo.processInfo.environment["CODECAST_APPSHIM_DEBUG_LAUNCH_FRAMES"] != nil {
            for i in 0..<50 {
                DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(i * 80)) { [weak self] in
                    self?.debugCaptureOwnWindows(into: out, prefix: String(format: "launch-%02d", i))
                }
            }
        }
    }

    /// Each on-screen window of this process (the app window, the tray
    /// panel, the About panel, an alert) as the screen shows it, into
    /// `<prefix>-<n>.png`. A process may capture its own windows without the
    /// Screen Recording grant.
    func debugCaptureOwnWindows(into dir: URL, prefix: String) {
        let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        var n = 0
        for info in infos where (info[kCGWindowOwnerPID as String] as? Int32) == getpid() {
            guard let id = info[kCGWindowNumber as String] as? CGWindowID,
                  let image = CGWindowListCreateImage(.null, .optionIncludingWindow, id, [.boundsIgnoreFraming, .bestResolution]),
                  image.width > 4, image.height > 4 else { continue }
            let rep = NSBitmapImageRep(cgImage: image)
            let name = "\(prefix)-\(n).png"
            try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent(name))
            let bounds = info[kCGWindowBounds as String] as? [String: Any] ?? [:]
            shimLog("captured \(name) \(info[kCGWindowName as String] as? String ?? "") layer \(info[kCGWindowLayer as String] ?? 0) \(bounds)")
            n += 1
        }
    }

    /// The menu bar's titles, one item per line, into menu.txt, and the Dock
    /// menu's into dock-menu.txt. AppKit adds items of its own after launch,
    /// so each snapshot writes them again.
    private func debugWriteMenu(into dir: URL) {
        let titles = (NSApp.mainMenu?.items ?? []).flatMap { top in
            // As the menu bar shows them: hidden items (Cmd-='s Zoom In twin) left out, Option alternates (Close All) marked.
            [top.title] + (top.submenu?.items ?? []).filter { !$0.isHidden }.map {
                "  " + ($0.isSeparatorItem ? "---" : $0.title + ($0.isAlternate ? " [option]" : ""))
            }
        }
        try? titles.joined(separator: "\n").write(to: dir.appendingPathComponent("menu.txt"), atomically: true, encoding: .utf8)
        let dock = (applicationDockMenu(NSApp)?.items ?? []).map(\.title)
        try? dock.joined(separator: "\n").write(to: dir.appendingPathComponent("dock-menu.txt"), atomically: true, encoding: .utf8)
    }

    private func debugPickMenu(_ prefix: String) {
        shimLog("pick \(prefix)")
        for top in NSApp.mainMenu?.items ?? [] {
            for item in top.submenu?.items ?? [] where item.title.hasPrefix(prefix) && !item.isHidden {
                // An inactive app has no key window for a nil-targeted item; the app window answers as it would.
                guard let action = item.action else { return }
                if item.target == nil, window.tryToPerform(action, with: item) { return }
                NSApp.sendAction(action, to: item.target, from: item)
                return
            }
        }
    }

    /// As a click on the menu bar item: usually another app is in front then.
    private func debugToggleTray() {
        guard let button = statusItem?.button else { return }
        if trayPanel?.isVisible == true || !NSApp.isActive { toggleTray(button); return }
        NSApp.deactivate()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.toggleTray(button) }
    }

    private func debugSnapshot(into dir: URL) {
        debugWriteMenu(into: dir)
        shimLog("state active=\(NSApp.isActive) front=\(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?") key=\(NSApp.keyWindow.map { String(describing: type(of: $0)) } ?? "none") "
            + "window visible=\(window.isVisible) mini=\(window.isMiniaturized) full=\(window.styleMask.contains(.fullScreen)) "
            + "frame=\(window.frame) zoom=\(webView.pageZoom) hidden=\(NSApp.isHidden) cover=\(coverState) "
            + "windows=\(NSApp.windows.filter(\.isVisible).map { "\(type(of: $0)):\($0.title)" })")
        // Which apps' normal windows sit above the main window on screen, front to back.
        let onScreen = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
        let normal = onScreen.filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
        if let at = normal.firstIndex(where: { ($0[kCGWindowNumber as String] as? Int) == window.windowNumber }) {
            let above = normal[..<at].compactMap { $0[kCGWindowOwnerName as String] as? String }
            shimLog("z main window under: \(Array(Set(above)).sorted())")
        }
        func write(_ image: NSImage?, _ name: String) {
            guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return }
            try? png.write(to: dir.appendingPathComponent("\(name).png"))
            shimLog("snapshot \(name)")
        }
        webView.takeSnapshot(with: nil) { image, _ in write(image, "window") }
        // The window's native views (title bar, status overlay, drag strip); the page draws blank here.
        if let frameView = window.contentView?.superview,
           let rep = frameView.bitmapImageRepForCachingDisplay(in: frameView.bounds) {
            frameView.cacheDisplay(in: frameView.bounds, to: rep)
            let image = NSImage(size: frameView.bounds.size)
            image.addRepresentation(rep)
            write(image, "window-frame")
        }
        trayWebView?.takeSnapshot(with: nil) { image, _ in write(image, "tray") }
        debugCaptureOwnWindows(into: dir, prefix: "screen")
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            shimLog("delivered notifications \(delivered.map(\.request.identifier).sorted())")
        }
        if let button = statusItem?.button, let rep = button.bitmapImageRepForCachingDisplay(in: button.bounds) {
            button.cacheDisplay(in: button.bounds, to: rep)
            let image = NSImage(size: button.bounds.size)
            image.addRepresentation(rep)
            write(image, "status-item")
            shimLog("status item frame \(button.window?.frame ?? .zero)")
        }
    }
}
