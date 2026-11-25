import Cocoa
import WebKit

/// Spike and test aid, off unless the shim is launched with
/// CODECAST_APPSHIM_DEBUG_DIR (`open --env`). SIGUSR1 toggles the tray popover;
/// SIGUSR2 writes PNGs of the app's own surfaces (window page, status button,
/// popover page) into that directory; SIGINFO picks the app menu's "Uninstall"
/// item, as a click would. Drawing its own views needs no Screen Recording
/// grant, which a test runner usually lacks. At launch it writes the menu's
/// titles to menu.txt there, since the menu bar is outside a window's
/// accessibility tree.
extension AppDelegate {
    func installDebugSignals() {
        guard let dir = ProcessInfo.processInfo.environment["CODECAST_APPSHIM_DEBUG_DIR"] else { return }
        let out = URL(fileURLWithPath: dir)
        for (sig, handler) in [(SIGUSR1, { [weak self] in self?.debugToggleTray() }),
                               (SIGUSR2, { [weak self] in self?.debugSnapshot(into: out) }),
                               (SIGINFO, { [weak self] in self?.debugPickMenu("Uninstall") })] as [(Int32, () -> Void)] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            source.setEventHandler(handler: handler)
            source.resume()
            debugSources.append(source)
        }
        shimLog("debug signals on, snapshots to \(dir)")
        let titles = (NSApp.mainMenu?.items ?? []).flatMap { top in
            [top.title] + (top.submenu?.items ?? []).map { "  " + ($0.isSeparatorItem ? "---" : $0.title) }
        }
        try? titles.joined(separator: "\n").write(to: out.appendingPathComponent("menu.txt"), atomically: true, encoding: .utf8)
    }

    private func debugPickMenu(_ prefix: String) {
        for top in NSApp.mainMenu?.items ?? [] {
            for item in top.submenu?.items ?? [] where item.title.hasPrefix(prefix) {
                if let action = item.action { NSApp.sendAction(action, to: item.target, from: item) }
                return
            }
        }
    }

    private func debugToggleTray() {
        if let button = statusItem?.button { toggleTray(button) }
    }

    private func debugSnapshot(into dir: URL) {
        func write(_ image: NSImage?, _ name: String) {
            guard let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return }
            try? png.write(to: dir.appendingPathComponent("\(name).png"))
            shimLog("snapshot \(name)")
        }
        webView.takeSnapshot(with: nil) { image, _ in write(image, "window") }
        trayWebView?.takeSnapshot(with: nil) { image, _ in write(image, "tray-popover") }
        if let button = statusItem?.button, let rep = button.bitmapImageRepForCachingDisplay(in: button.bounds) {
            button.cacheDisplay(in: button.bounds, to: rep)
            let image = NSImage(size: button.bounds.size)
            image.addRepresentation(rep)
            write(image, "status-item")
            shimLog("status item frame \(button.window?.frame ?? .zero)")
        }
    }
}
