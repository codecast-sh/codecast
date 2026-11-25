import Cocoa
import ServiceManagement
@preconcurrency import UserNotifications
import WebKit

/// What the generated Info.plist tells the shim about its app.
struct ShimConfig {
    let slug: String
    let name: String
    let hostBundleId: String
    let pageUrl: URL
    let socketPath: String
    /// The Codecast version that wrote or last re-sealed this bundle.
    let hostVersion: String
    let windowSize: NSSize
    let traySize: NSSize

    static func load(_ info: [String: Any] = Bundle.main.infoDictionary ?? [:]) -> ShimConfig {
        let slug = info["CodecastAppSlug"] as? String ?? "unknown"
        let name = info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? slug
        let page = (info["CodecastPageUrl"] as? String).flatMap(URL.init(string:))
            ?? URL(string: "https://a.codecast.sh/\(slug)")!
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let socket = info["CodecastSocketPath"] as? String
            ?? support.appendingPathComponent("Codecast/apps.sock").path
        func size(_ w: String, _ h: String, _ dw: Double, _ dh: Double) -> NSSize {
            NSSize(width: (info[w] as? NSNumber)?.doubleValue ?? dw, height: (info[h] as? NSNumber)?.doubleValue ?? dh)
        }
        return ShimConfig(
            slug: slug, name: name,
            hostBundleId: info["CodecastHostBundleId"] as? String ?? "sh.codecast.desktop",
            pageUrl: page, socketPath: socket,
            hostVersion: info["CodecastHostVersion"] as? String ?? "0",
            windowSize: size("CodecastWindowWidth", "CodecastWindowHeight", 1000, 720),
            traySize: size("CodecastTrayWidth", "CodecastTrayHeight", 360, 480))
    }

    func url(surface: String) -> URL {
        var c = URLComponents(url: pageUrl, resolvingAgainstBaseURL: false)!
        var items = (c.queryItems ?? []).filter { $0.name != "host" && $0.name != "surface" }
        items += [URLQueryItem(name: "host", value: "app"), URLQueryItem(name: "surface", value: surface)]
        c.queryItems = items
        return c.url!
    }

    func allows(_ url: URL) -> Bool { UrlPolicy.navigable(url, page: pageUrl) }

    var bundleId: String { Bundle.main.bundleIdentifier ?? "sh.codecast.app.\(slug)" }
}

func shimLog(_ line: String) {
    FileHandle.standardError.write("[appshim] \(line)\n".data(using: .utf8)!)
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandlerWithReply,
    WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate {
    let config: ShimConfig
    var window: NSWindow!
    var webView: WKWebView!
    var trayWebView: WKWebView?
    var statusItem: NSStatusItem?
    let popover = NSPopover()
    var engine: EngineSocket!
    var debugSources: [DispatchSourceSignal] = []
    /// The page version each surface loaded, from the X-Cast-Version response header.
    var loadedVersion: [String: Int] = [:]
    var hostState: HostState = .ready
    var statusView: StatusOverlay?
    lazy var clientScript: String? = Bundle.main.url(forResource: "client", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    init(config: ShimConfig) {
        self.config = config
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        engine = EngineSocket(
            path: config.socketPath, app: config.slug,
            launchHost: { [config] in
                // A running Codecast without the socket is starting up or signed out; `open`
                // would only send it a reopen event and bring its window forward.
                guard NSRunningApplication.runningApplications(withBundleIdentifier: config.hostBundleId).isEmpty
                else { return }
                shimLog("launching \(config.hostBundleId)")
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                p.arguments = ["-g", "-b", config.hostBundleId, "--args", "--background"]
                try? p.run()
            })
        engine.log = shimLog
        engine.onEvent = { [weak self] event, data in self?.hostEvent(event, data) }
        engine.onReconnect = { [weak self] in self?.reidentify() }
        engine.onConnect = { [weak self] in self?.hostConnected() }
        engine.onDisconnect = { [weak self] in
            // A Codecast restart reconnects within a second or two; only a longer gap covers the page.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                guard let self, !self.engine.isConnected else { return }
                self.setHostState(self.hostInstalled ? .notRunning : .missing)
            }
        }
        engine.onGaveUp = { [weak self] in self?.setHostState(self?.hostInstalled == false ? .missing : .notRunning) }

        UNUserNotificationCenter.current().delegate = self
        Hotkeys.shared.onFire = { [weak self] accelerator in
            self?.dispatch("shortcut", ["accelerator": accelerator])
        }
        NSApp.mainMenu = buildMenu()
        installDebugSignals()

        webView = makeWebView(surface: "window")
        window = NSWindow(contentRect: NSRect(origin: .zero, size: config.windowSize),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = config.name
        window.contentView = webView
        window.delegate = self
        window.isReleasedWhenClosed = false
        window.center()
        window.setFrameAutosaveName("CodecastAppWindow")
        webView.load(URLRequest(url: config.url(surface: "window")))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if hostInstalled { engine.connect() } else { setHostState(.missing) }
        shimLog("ready \(config.slug) pid=\(getpid())")
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // A Dock click is how the person gets a click-through overlay back.
        restoreMouseEvents()
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        reportStatus(active: true)
    }

    func windowDidMove(_ notification: Notification) { reportStatus() }
    func windowDidEndLiveResize(_ notification: Notification) { reportStatus() }

    // MARK: Codecast

    var hostInstalled: Bool { NSWorkspace.shared.urlForApplication(withBundleIdentifier: config.hostBundleId) != nil }

    func hostConnected() {
        if hostState == .notRunning || hostState == .missing { setHostState(.ready) }
        reportStatus()
    }

    func setHostState(_ state: HostState) {
        guard state != hostState else { return }
        shimLog("host state \(state)")
        hostState = state
        statusView?.removeFromSuperview()
        statusView = nil
        guard state != .ready, let content = window.contentView else { return }
        let overlay = StatusOverlay(state: state, appName: config.name, target: self, action: #selector(statusAction))
        overlay.frame = content.bounds
        overlay.autoresizingMask = [.width, .height]
        content.addSubview(overlay)
        statusView = overlay
    }

    @objc func statusAction() {
        if hostState == .missing {
            if hostInstalled { openHost(); engine.connect(timeout: 30) } else { NSWorkspace.shared.open(HostState.downloadUrl) }
            return
        }
        openHost()
        engine.connect(timeout: 30)
    }

    /// Brings Codecast forward (the person asked for it).
    func openHost() {
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: config.hostBundleId) else { return }
        NSWorkspace.shared.openApplication(at: url, configuration: NSWorkspace.OpenConfiguration())
    }

    /// Tells Codecast what only this process knows: whether macOS lets it
    /// notify, where its window is (Codecast centers the consent sheet on it),
    /// and that it came forward.
    func reportStatus(active: Bool = false) {
        // Only over an open connection: a report never launches Codecast.
        guard engine.isConnected else { return }
        notificationStatus { [weak self] status in
            guard let self else { return }
            var data: [String: Any] = ["notifications": status, "active": active]
            if let frame = self.windowFrameTopLeft() { data["frame"] = frame }
            self.engine.hostCall("report", data: data)
        }
    }

    /// The window's frame with a top-left origin on the primary screen, as Electron's screen API counts.
    func windowFrameTopLeft() -> [String: Double]? {
        guard window.isVisible, let primary = NSScreen.screens.first else { return nil }
        let f = window.frame
        return ["x": f.minX, "y": primary.frame.maxY - f.maxY, "width": f.width, "height": f.height]
    }

    func notificationStatus(_ done: @escaping @MainActor (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = ShimText.notificationStatus(settings.authorizationStatus.rawValue)
            DispatchQueue.main.async { MainActor.assumeIsolated { done(status) } }
        }
    }

    func restoreMouseEvents() {
        if window.ignoresMouseEvents { window.ignoresMouseEvents = false }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { statusItem == nil }

    // MARK: Web views

    func makeWebView(surface: String) -> WKWebView {
        let conf = WKWebViewConfiguration()
        // WebKit appends this to its own user agent, so the agent ends in
        // " CodecastApp/<host version> (<slug>)", which the server matches.
        conf.applicationNameForUserAgent = ShimText.userAgentSuffix(hostVersion: config.hostVersion, slug: config.slug)
        let ucc = conf.userContentController
        if let clientScript {
            ucc.addUserScript(WKUserScript(source: clientScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        ucc.addScriptMessageHandler(self, contentWorld: .page, name: "castApp")
        let view = WKWebView(frame: .zero, configuration: conf)
        view.navigationDelegate = self
        view.uiDelegate = self
        view.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) { view.isInspectable = true }
        return view
    }

    func surface(of view: WKWebView?) -> String { view === trayWebView ? "tray" : "window" }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, action.targetFrame?.isMainFrame ?? true, !config.allows(url) else {
            decisionHandler(.allow)
            return
        }
        openExternally(url)
        decisionHandler(.cancel)
    }

    /// Off-path links go to the default browser or mail client; every other scheme is dropped.
    func openExternally(_ url: URL) {
        guard UrlPolicy.canOpenExternally(url) else {
            shimLog("refused to open \(url.absoluteString)")
            return
        }
        NSWorkspace.shared.open(url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void) {
        if response.isForMainFrame, let http = response.response as? HTTPURLResponse {
            loadedVersion[surface(of: webView)] = Int(http.value(forHTTPHeaderField: "X-Cast-Version") ?? "") ?? 0
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openExternally(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        completionHandler(panel.runModal() == .OK ? panel.urls : nil)
    }

    // MARK: Bridge

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        let frame = message.frameInfo
        guard UrlPolicy.bridgeAllows(isMainFrame: frame.isMainFrame, frameUrl: frame.request.url, page: config.pageUrl),
              let body = message.body as? [String: Any],
              let module = body["module"] as? String, let method = body["method"] as? String else {
            replyHandler(["ok": false, "code": "denied", "message": "only the page's own document reaches the bridge"], nil)
            return
        }
        let args = body["args"] as? [Any] ?? []
        let surface = surface(of: message.webView)
        let frameInfo: [String: Any] = ["version": loadedVersion[surface] ?? 0, "surface": surface]
        engine.call(["module": module, "method": method, "args": args], frame: frameInfo) { [weak self] reply in
            guard let self, reply["ok"] as? Bool == true else { replyHandler(reply, nil); return }
            if module == "app", method == "info" {
                // Whether macOS lets this app notify is known only here.
                self.notificationStatus { status in
                    var out = reply
                    out.removeValue(forKey: "id")
                    var value = reply["value"] as? [String: Any] ?? [:]
                    value["notifications"] = status
                    value["notificationSettingsUrl"] = ShimText.notificationSettingsUrl(bundleId: self.config.bundleId)
                    out["value"] = value
                    replyHandler(out, nil)
                }
                return
            }
            self.perform(module, method, args, surface: surface) { local in
                var out = reply
                out.removeValue(forKey: "id")
                if let local {
                    if local["ok"] as? Bool == false { replyHandler(local, nil); return }
                    if let value = local["value"] { out["value"] = value }
                }
                replyHandler(out, nil)
            }
        }
    }

    /// Runs the OS half of a call the engine allowed. `done(nil)` means there is
    /// nothing local to do and the engine's answer stands.
    func perform(_ module: String, _ method: String, _ args: [Any], surface: String,
                 done: @escaping ([String: Any]?) -> Void) {
        let first = args.first
        let opts = first as? [String: Any] ?? [:]
        func ok(_ value: Any = NSNull()) { done(["ok": true, "value": value]) }
        func fail(_ code: String, _ message: String) { done(["ok": false, "code": code, "message": message]) }
        switch (module, method) {
        case ("app", "badge"):
            let n = (first as? NSNumber)?.intValue ?? 0
            NSApp.dockTile.badgeLabel = n > 0 ? String(n) : nil
            ok()
        case ("app", "notify"):
            notify(opts, done: done)
        case ("tray", "set"):
            setTray(opts)
            ok()
        case ("tray", "remove"):
            if let item = statusItem { NSStatusBar.system.removeStatusItem(item) }
            statusItem = nil
            popover.close()
            ok()
        case ("shortcuts", "register"):
            guard let accelerator = first as? String else { return fail("bad-args", "an accelerator string") }
            if let error = Hotkeys.shared.register(accelerator) { return fail("failed", error) }
            ok()
        case ("shortcuts", "unregister"):
            guard let accelerator = first as? String else { return fail("bad-args", "an accelerator string") }
            Hotkeys.shared.unregister(accelerator)
            ok()
        case ("window", "setAlwaysOnTop"):
            let on = (first as? Bool) ?? false
            window.level = on ? .floating : .normal
            if on { window.collectionBehavior.insert(.fullScreenAuxiliary) }
            else { window.collectionBehavior.remove(.fullScreenAuxiliary) }
            ok()
        case ("window", "setVisibleOnAllWorkspaces"):
            if (first as? Bool) ?? false { window.collectionBehavior.insert(.canJoinAllSpaces) }
            else { window.collectionBehavior.remove(.canJoinAllSpaces) }
            ok()
        case ("window", "setIgnoreMouseEvents"):
            window.ignoresMouseEvents = (first as? Bool) ?? false
            ok()
        case ("login", "set"):
            setOpenAtLogin((first as? Bool) ?? false, done: done)
        case ("window", "setSize"):
            guard let w = (args.first as? NSNumber)?.doubleValue, let h = (args.dropFirst().first as? NSNumber)?.doubleValue
            else { return fail("bad-args", "setSize(width, height)") }
            window.setContentSize(NSSize(width: w, height: h))
            ok()
        case ("window", "setTitle"):
            window.title = first as? String ?? config.name
            ok()
        case ("window", "focus"):
            showWindow()
            ok()
        case ("window", "minimize"):
            window.miniaturize(nil)
            ok()
        case ("window", "close"):
            if surface == "tray" { popover.close() } else { window.performClose(nil) }
            ok()
        default:
            done(nil)
        }
    }

    /// Codecast's events: the ones about the host (`host-state`, `host-reload`,
    /// `host-quit`) stay here; the rest go to the page. On a new version
    /// Codecast sends `version` to the page, then `host-reload`.
    func hostEvent(_ event: String, _ data: Any) {
        switch event {
        case "host-state":
            setHostState(HostState.from(event: data))
        case "host-reload":
            webView.reload()
            trayWebView?.reload()
        case "host-quit":
            // Codecast is uninstalling this app and removes its files once we are gone.
            NSApp.terminate(nil)
        default:
            dispatch(event, data)
        }
    }

    func dispatch(_ event: String, _ data: Any) {
        guard let json = try? JSONSerialization.data(withJSONObject: ["event": event, "data": data]),
              let text = String(data: json, encoding: .utf8) else { return }
        for view in [webView, trayWebView].compactMap({ $0 }) {
            view.evaluateJavaScript("window.__castAppEvent && window.__castAppEvent(\(text))")
        }
    }

    /// After the socket comes back: the host only learns which app a connection
    /// is from its first call, so ask `app.info` at once. That routes host events
    /// here again, and its grants tell the page what may have changed meanwhile.
    func reidentify() {
        let frame: [String: Any] = ["version": loadedVersion["window"] ?? 0, "surface": "window"]
        engine.call(["module": "app", "method": "info", "args": []], frame: frame) { [weak self] reply in
            guard reply["ok"] as? Bool == true, let info = reply["value"] as? [String: Any] else { return }
            self?.dispatch("grants", ["grants": info["grants"] ?? [], "version": info["version"] ?? 0])
        }
    }

    func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: Login

    /// Registers this bundle itself as a login item, so it is this app (not
    /// Codecast) that opens at login.
    func setOpenAtLogin(_ on: Bool, done: @escaping ([String: Any]?) -> Void) {
        guard #available(macOS 13.0, *) else {
            done(["ok": false, "code": "failed", "message": "open at login needs macOS 13"])
            return
        }
        do {
            let service = SMAppService.mainApp
            if on, service.status != .enabled { try service.register() }
            if !on, service.status == .enabled { try service.unregister() }
            done(["ok": true, "value": NSNull()])
        } catch {
            done(["ok": false, "code": "failed", "message": error.localizedDescription])
        }
    }

    // MARK: Notifications

    func notify(_ opts: [String: Any], done: @escaping ([String: Any]?) -> Void) {
        let center = UNUserNotificationCenter.current()
        let name = config.name
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            guard granted else {
                let why = error?.localizedDescription ?? "notifications are off for \(name) in System Settings"
                DispatchQueue.main.async { done(["ok": false, "code": "denied", "message": why]) }
                return
            }
            let content = UNMutableNotificationContent()
            content.title = opts["title"] as? String ?? name
            content.body = opts["body"] as? String ?? ""
            if opts["silent"] as? Bool != true { content.sound = .default }
            let tag = opts["tag"] as? String ?? UUID().uuidString
            content.userInfo = ["tag": tag]
            center.add(UNNotificationRequest(identifier: tag, content: content, trigger: nil)) { error in
                DispatchQueue.main.async {
                    if let error { done(["ok": false, "code": "failed", "message": error.localizedDescription]) }
                    else { done(["ok": true, "value": ["tag": tag]]) }
                }
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let tag = response.notification.request.content.userInfo["tag"] as? String ?? ""
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                self.showWindow()
                self.dispatch("notification-click", ["tag": tag])
            }
        }
        completionHandler()
    }

    // MARK: Tray

    func setTray(_ opts: [String: Any]) {
        let item = statusItem ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        guard let button = item.button else { return }
        if button.image == nil, let icon = NSApp.applicationIconImage.copy() as? NSImage {
            icon.size = NSSize(width: 18, height: 18)
            button.image = icon
            button.imagePosition = .imageLeading
        }
        let badge = (opts["badge"] as? NSNumber).map { " \($0)" } ?? ""
        button.title = (opts["title"] as? String ?? "") + badge
        button.toolTip = opts["tooltip"] as? String ?? config.name
        button.target = self
        button.action = #selector(toggleTray(_:))
    }

    @objc func toggleTray(_ sender: NSStatusBarButton) {
        restoreMouseEvents()
        if popover.isShown { popover.performClose(sender); return }
        if trayWebView == nil {
            let view = makeWebView(surface: "tray")
            trayWebView = view
            let controller = NSViewController()
            controller.view = view
            popover.contentViewController = controller
            popover.contentSize = config.traySize
            popover.behavior = .transient
            view.load(URLRequest(url: config.url(surface: "tray")))
        }
        popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
        dispatch("tray-click", [:])
    }

    // MARK: Menu

    func buildMenu() -> NSMenu {
        let name = config.name
        let main = NSMenu()
        func submenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            holder.submenu = menu
            main.addItem(holder)
            return menu
        }
        func item(_ title: String, _ action: Selector?, _ key: String = "",
                  _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            return i
        }
        let openInHost = item("Open in Codecast", #selector(openInCodecast))
        openInHost.target = self
        let remove = item("Uninstall \(name)…", #selector(uninstallApp))
        remove.target = self
        _ = submenu(name, [
            item("About \(name)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            openInHost,
            remove,
            .separator(),
            item("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit \(name)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        let reload = item("Reload", #selector(reloadPage), "r")
        reload.target = self
        _ = submenu("View", [reload])
        let windowMenu = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            item("Close", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.windowsMenu = windowMenu
        return main
    }

    @objc func reloadPage() { webView.reload() }

    /// Opens this page in the main Codecast window. Codecast decides where it
    /// goes; without it, Codecast is at least brought forward.
    @objc func openInCodecast() {
        engine.hostCall("open-in-codecast") { [weak self] reply in
            if reply["ok"] as? Bool != true { self?.openHost() }
        }
    }

    /// Asks once here, then Codecast removes the bundle, its data and its
    /// record; this process quits so nothing writes the data back.
    @objc func uninstallApp() {
        let alert = NSAlert()
        alert.messageText = "Uninstall \(config.name)?"
        alert.informativeText = "Removes the app and the data it keeps on this Mac."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Uninstall")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        engine.hostCall("uninstall") { reply in
            if reply["ok"] as? Bool == true {
                NSApp.terminate(nil)
                return
            }
            let failed = NSAlert()
            failed.messageText = "Couldn't uninstall \(self.config.name)"
            failed.informativeText = reply["message"] as? String ?? "Codecast did not answer."
            failed.runModal()
        }
    }
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate(config: ShimConfig.load()) }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
