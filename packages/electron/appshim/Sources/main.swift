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
    /// The manifest's window.minWidth / minHeight; zero leaves AppKit's minimum.
    let minSize: NSSize
    let resizable: Bool
    /// window.titleBar "hidden": the page runs under a transparent title bar.
    let titleBarHidden: Bool
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
            minSize: size("CodecastMinWidth", "CodecastMinHeight", 0, 0),
            resizable: (info["CodecastResizable"] as? NSNumber)?.boolValue ?? true,
            titleBarHidden: info["CodecastTitleBar"] as? String == "hidden",
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
    WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate, NSMenuItemValidation {
    let config: ShimConfig
    var window: NSWindow!
    var webView: WKWebView!
    var trayWebView: WKWebView?
    var statusItem: NSStatusItem?
    var trayPanel: TrayPanel?
    var engine: EngineSocket!
    var debugSources: [DispatchSourceSignal] = []
    /// The page version each surface loaded, from the X-Cast-Version response header.
    var loadedVersion: [String: Int] = [:]
    var hostState: HostState = .ready
    /// Why the page itself did not load (offline, its server down); nil once it loads.
    var pageState: HostState?
    /// What the cover shows now: HostState.cover of the two above.
    var coverState: HostState = .ready
    var pageRetry: Timer?
    var statusView: StatusOverlay?
    var pageColorObservations: [NSKeyValueObservation] = []
    /// When the tray panel last closed: the status item click that closed it must not reopen it.
    var trayClosedAt = Date.distantPast
    var trayShownAt = Date.distantPast
    /// Under a hidden title bar: the strip at the top that moves the window.
    var dragStrip: DragStrip?
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
        NSWindow.allowsAutomaticWindowTabbing = false
        NSApp.mainMenu = buildMenu()
        installDebugSignals()

        webView = makeWebView(surface: "window")
        webView.pageZoom = UserDefaults.standard.object(forKey: Self.zoomKey) as? Double ?? 1
        makeWindow()
        window.delegate = self
        window.isReleasedWhenClosed = false
        placeWindow()
        observePageColor()
        webView.load(URLRequest(url: config.url(surface: "window")))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if hostInstalled { engine.connect() } else { setHostState(.missing) }
        shimLog("ready \(config.slug) pid=\(getpid())")
    }

    /// The app's window from the manifest's window options: its size, minimum
    /// size and resizability, and with titleBar "hidden" a transparent title
    /// bar over the page with the traffic lights kept. WKWebView ignores
    /// `-webkit-app-region`, so under a hidden title bar a 28 px strip across
    /// the top (DragStrip, above the page) moves the window and zooms it on a
    /// double click; the page keeps that band free of controls.
    func makeWindow() {
        var style: NSWindow.StyleMask = [.titled, .closable, .miniaturizable]
        if config.resizable { style.insert(.resizable) }
        if config.titleBarHidden { style.insert(.fullSizeContentView) }
        window = NSWindow(contentRect: NSRect(origin: .zero, size: config.windowSize),
                          styleMask: style, backing: .buffered, defer: false)
        window.title = config.name
        // Until the page paints, the window shows the color the page had last
        // time (the system's window color the first time), never white.
        window.backgroundColor = Self.rememberedPageColor ?? .windowBackgroundColor
        // WebKit paints its own under-page layer when the page commits; until
        // the page paints, that is the same color (nil after: the page's own).
        webView.underPageBackgroundColor = window.backgroundColor
        if config.resizable { window.collectionBehavior.insert(.fullScreenPrimary) }
        if config.minSize.width > 0 || config.minSize.height > 0 {
            window.contentMinSize = NSSize(width: max(config.minSize.width, 1), height: max(config.minSize.height, 1))
        }
        let content = NSView(frame: NSRect(origin: .zero, size: config.windowSize))
        webView.frame = content.bounds
        webView.autoresizingMask = [.width, .height]
        content.addSubview(webView)
        if config.titleBarHidden {
            window.titlebarAppearsTransparent = true
            window.titleVisibility = .hidden
            let strip = DragStrip(frame: NSRect(x: 0, y: content.bounds.height - DragStrip.height,
                                                width: content.bounds.width, height: DragStrip.height))
            strip.autoresizingMask = [.width, .minYMargin]
            content.addSubview(strip)
            dragStrip = strip
        }
        window.contentView = content
        tintTitleBar()
    }

    static let frameName = "CodecastAppWindow"

    /// The first time, centered on the screen the person is working on (the
    /// one under the pointer), a little above the middle as NSWindow.center
    /// does. After that where they left it, which AppKit keeps under the
    /// frame autosave name, unless that place is on no screen now.
    func placeWindow() {
        let restored = window.setFrameUsingName(Self.frameName)
        if !restored || !NSScreen.screens.contains(where: { $0.visibleFrame.intersects(window.frame) }) {
            let pointer = NSEvent.mouseLocation
            if let area = (NSScreen.screens.first { NSMouseInRect(pointer, $0.frame, false) } ?? NSScreen.main)?.visibleFrame {
                var frame = window.frame
                frame.size.width = min(frame.width, area.width)
                frame.size.height = min(frame.height, area.height)
                frame.origin.x = area.midX - frame.width / 2
                frame.origin.y = area.minY + (area.height - frame.height) * 2 / 3
                window.setFrame(frame.integral, display: false)
            }
        }
        window.setFrameAutosaveName(Self.frameName)
    }

    // MARK: Page color

    static let pageColorKey = "CodecastPageColor"
    static let zoomKey = "CodecastPageZoom"

    static var rememberedPageColor: NSColor? {
        guard let c = UserDefaults.standard.array(forKey: pageColorKey) as? [Double], c.count == 3 else { return nil }
        return NSColor(srgbRed: c[0], green: c[1], blue: c[2], alpha: 1)
    }

    /// The page's own color (its theme-color, else its background), as
    /// WebKit reports it once the page paints. The window takes it as its
    /// background and keeps it for the next launch.
    func observePageColor() {
        let changed = { [weak self] in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.pageColorChanged() } }
        }
        pageColorObservations = [
            webView.observe(\.themeColor) { _, _ in changed() },
            webView.observe(\.underPageBackgroundColor) { _, _ in changed() },
            window.observe(\.effectiveAppearance) { [weak self] _, _ in
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.tintTitleBar() } }
            },
        ]
    }

    func pageColorChanged() {
        // Before the first paint WebKit reports its own default, not the page's.
        guard pagePainted, let color = (webView.themeColor ?? webView.underPageBackgroundColor as NSColor?)?.usingColorSpace(.sRGB),
              color.alphaComponent > 0.99 else { return }
        window.backgroundColor = color
        UserDefaults.standard.set([color.redComponent, color.greenComponent, color.blueComponent].map(Double.init),
                                  forKey: Self.pageColorKey)
        tintTitleBar()
    }

    var pagePainted = false

    /// The title bar takes the page's color when that color suits the
    /// system's light or dark look (a dark page in dark mode), so title and
    /// page read as one surface and the title stays legible; otherwise it is
    /// the standard title bar.
    func tintTitleBar() {
        guard !config.titleBarHidden, let color = window.backgroundColor.usingColorSpace(.sRGB),
              window.backgroundColor != .windowBackgroundColor else { return }
        let luminance = 0.2126 * color.redComponent + 0.7152 * color.greenComponent + 0.0722 * color.blueComponent
        let systemDark = window.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        window.titlebarAppearsTransparent = (luminance < 0.5) == systemDark
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        // A Dock click is how the person gets a click-through overlay back,
        // and a closed window (the app kept by its menu bar item) comes back.
        restoreMouseEvents()
        if NSApp.isHidden { NSApp.unhide(nil) }
        if !flag { window.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()
        let show = NSMenuItem(title: "Show in Codecast", action: #selector(openInCodecast), keyEquivalent: "")
        show.target = self
        menu.addItem(show)
        return menu
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationDidBecomeActive(_ notification: Notification) {
        reportStatus(active: true)
        // Coming back to a window that could not load tries again at once.
        if pageState != nil { retryPage() }
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
        refreshCover()
    }

    /// Puts up the cover for what is wrong now (HostState.cover), or takes it down.
    func refreshCover() {
        let state = HostState.cover(host: hostState, page: pageState)
        guard state != coverState else { return }
        coverState = state
        statusView?.removeFromSuperview()
        statusView = nil
        guard state != .ready, let content = window.contentView else { return }
        let pageColored = window.titlebarAppearsTransparent && !config.titleBarHidden
        let overlay = StatusOverlay(state: state, appName: config.name, background: pageColored ? window.backgroundColor : nil,
                                    target: self, action: #selector(statusAction))
        overlay.frame = content.bounds
        overlay.autoresizingMask = [.width, .height]
        // Over the page; under the drag strip when there is one, so a covered
        // window still moves. (`.below` relative to nil would put it under the page.)
        if let dragStrip { content.addSubview(overlay, positioned: .below, relativeTo: dragStrip) }
        else { content.addSubview(overlay) }
        statusView = overlay
    }

    @objc func statusAction() {
        if coverState == .offline || coverState == .pageFailed { retryPage(); return }
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
        // Transparent, so what shows before the page paints is the window's
        // color, not WebKit's white (see didFinish).
        view.setValue(false, forKey: "drawsBackground")
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

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The web view stays transparent: turning WebKit's own background on
        // here showed the window gray for a few frames, since didFinish comes
        // before the page's first frame reaches the screen. A page without a
        // background of its own shows the browser's canvas color all the
        // same, through the window color set below.
        guard webView === self.webView else { return }
        if !pagePainted {
            // Handing the under-page layer back to WebKit (nil) shows its
            // default gray for a few frames before it reads the page's, so it
            // gets the page's own canvas color instead: the root's
            // background, else the body's (CSS carries it to the canvas),
            // else the browser's canvas for the page's color scheme.
            let canvas = """
                (() => { const c = (e) => e ? getComputedStyle(e).backgroundColor : ''; const clear = /^rgba\\(.*, 0\\)$/;
                  for (const e of [document.documentElement, document.body]) { const v = c(e); if (v && !clear.test(v)) return v; }
                  const d = document.createElement('div'); d.style.background = 'Canvas'; document.documentElement.appendChild(d);
                  const v = c(d); d.remove(); return v; })()
                """
            webView.evaluateJavaScript(canvas) { [weak self] value, _ in
                guard let self else { return }
                let rgb = ShimText.opaqueCssColor(value as? String ?? "") ?? [1, 1, 1]
                webView.underPageBackgroundColor = NSColor(srgbRed: rgb[0], green: rgb[1], blue: rgb[2], alpha: 1)
                self.pagePainted = true
                self.pageColorChanged()
            }
        } else {
            pageColorChanged()
        }
        if pageState != nil {
            shimLog("page loaded")
            pageState = nil
            pageRetry?.invalidate()
            pageRetry = nil
            refreshCover()
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        pageLoadFailed(webView, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        pageLoadFailed(webView, error)
    }

    /// The window's page did not load: the cover says why, and the shim keeps
    /// trying every few seconds (and at once when the person comes back to
    /// the app), so it recovers by itself when the connection returns.
    func pageLoadFailed(_ view: WKWebView, _ error: Error) {
        let e = error as NSError
        guard view === webView, let state = HostState.pageLoad(errorDomain: e.domain, code: e.code) else { return }
        if pageState != state { shimLog("page did not load (\(e.domain) \(e.code)): \(state)") }
        pageState = state
        refreshCover()
        if pageRetry == nil {
            pageRetry = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.retryPage() }
            }
        }
    }

    func retryPage() {
        guard !webView.isLoading else { return }
        webView.load(URLRequest(url: config.url(surface: "window")))
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
            trayPanel?.dismiss("removed")
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
            if surface == "tray" { trayPanel?.dismiss("page") } else { window.performClose(nil) }
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
        let tag = opts["tag"] as? String ?? UUID().uuidString
        shimLog("notify \(tag)")
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            guard granted else {
                let why = error?.localizedDescription ?? "notifications are off for \(name) in System Settings"
                shimLog("notify \(tag) denied: \(why)")
                DispatchQueue.main.async { done(["ok": false, "code": "denied", "message": why]) }
                return
            }
            let content = UNMutableNotificationContent()
            content.title = opts["title"] as? String ?? name
            content.body = opts["body"] as? String ?? ""
            if opts["silent"] as? Bool != true { content.sound = .default }
            content.userInfo = ["tag": tag]
            center.add(UNNotificationRequest(identifier: tag, content: content, trigger: nil)) { error in
                shimLog("notify \(tag) \(error.map { "failed: \($0.localizedDescription)" } ?? "posted")")
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
        shimLog("tray title \"\(button.title)\" tooltip \"\(button.toolTip ?? "")\"")
        button.target = self
        button.action = #selector(toggleTray(_:))
    }

    @objc func toggleTray(_ sender: NSStatusBarButton) {
        restoreMouseEvents()
        if let panel = trayPanel, panel.isVisible { panel.dismiss("item click"); return }
        // The click on the item that closed the panel (any click outside it
        // closes it) arrives here next; it closes, it does not reopen.
        if Date().timeIntervalSince(trayClosedAt) < 0.3 { return }
        let panel = trayPanel ?? {
            let view = makeWebView(surface: "tray")
            trayWebView = view
            let panel = TrayPanel(content: view, size: config.traySize)
            panel.onClose = { [weak self] reason in
                shimLog("tray closed (\(reason)) after \(String(format: "%.1f", Date().timeIntervalSince(self?.trayShownAt ?? Date()))) s, front \(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"), last click \(String(format: "%.2f", CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!))) s ago")
                self?.trayClosedAt = Date()
            }
            view.load(URLRequest(url: config.url(surface: "tray")))
            trayPanel = panel
            return panel
        }()
        panel.show(under: sender)
        trayShownAt = Date()
        shimLog("tray shown (front: \(NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"), app active: \(NSApp.isActive), key: \(panel.isKeyWindow), main window on top: \(window.isVisible && NSApp.orderedWindows.first === window))")
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
        func mine(_ i: NSMenuItem) -> NSMenuItem { i.target = self; return i }
        let services = item("Services", nil)
        services.submenu = NSMenu(title: "Services")
        NSApp.servicesMenu = services.submenu
        _ = submenu(name, [
            mine(item("About \(name)", #selector(showAbout))),
            .separator(),
            mine(item("Settings…", #selector(openSettings), ",")),
            .separator(),
            mine(item("Show in Codecast", #selector(openInCodecast))),
            mine(item("Uninstall \(name)…", #selector(uninstallApp))),
            .separator(),
            services,
            .separator(),
            item("Hide \(name)", #selector(NSApplication.hide(_:)), "h"),
            item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            item("Quit \(name)", #selector(NSApplication.terminate(_:)), "q"),
        ])
        _ = submenu("File", [
            item("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        // AppKit's own Start Dictation and Emoji & Symbols are turned off (main,
        // below): it appends them on several passes after launch and repeats
        // them each time. These two are the only copies.
        _ = submenu("Edit", [
            item("Undo", Selector(("undo:")), "z"),
            item("Redo", Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item("Cut", #selector(NSText.cut(_:)), "x"),
            item("Copy", #selector(NSText.copy(_:)), "c"),
            item("Paste", #selector(NSText.paste(_:)), "v"),
            item("Select All", #selector(NSText.selectAll(_:)), "a"),
            .separator(),
            item("Start Dictation…", Selector(("startDictation:"))),
            item("Emoji & Symbols", #selector(NSApplication.orderFrontCharacterPalette(_:)), " ", [.command, .control]),
        ])
        // Cmd-= zooms in too, as in Safari: a hidden twin of Zoom In.
        let zoomInEquals = mine(item("Zoom In", #selector(zoomIn), "="))
        zoomInEquals.isHidden = true
        zoomInEquals.allowsKeyEquivalentWhenHidden = true
        _ = submenu("View", [
            mine(item("Reload Page", #selector(reloadPage), "r")),
            .separator(),
            mine(item("Actual Size", #selector(actualSize), "0")),
            mine(item("Zoom In", #selector(zoomIn), "+")),
            zoomInEquals,
            mine(item("Zoom Out", #selector(zoomOut), "-")),
            .separator(),
            item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
        ])
        let windowMenu = submenu("Window", [
            item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("Zoom", #selector(NSWindow.performZoom(_:))),
            .separator(),
            item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
        ])
        NSApp.windowsMenu = windowMenu
        return main
    }

    @objc func reloadPage() {
        if pageState != nil { retryPage() } else { webView.reload() }
    }

    @objc func actualSize() { setPageZoom(1) }
    @objc func zoomIn() { setPageZoom(ShimText.zoom(from: webView.pageZoom, by: 1)) }
    @objc func zoomOut() { setPageZoom(ShimText.zoom(from: webView.pageZoom, by: -1)) }

    /// The window page's zoom, kept for the next launch.
    func setPageZoom(_ zoom: Double) {
        webView.pageZoom = zoom
        UserDefaults.standard.set(zoom, forKey: Self.zoomKey)
    }

    func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        switch menuItem.action {
        case #selector(actualSize): return webView.pageZoom != 1
        case #selector(zoomIn): return webView.pageZoom < ShimText.zoomSteps.last!
        case #selector(zoomOut): return webView.pageZoom > ShimText.zoomSteps.first!
        case #selector(openSettings): return hostInstalled
        default: return true
        }
    }

    /// Codecast's Settings > Installed apps, on this app, through Codecast's
    /// own link (which also starts Codecast when it is not running).
    @objc func openSettings() {
        let link = ShimText.settingsLink(slug: config.slug)
        guard let host = NSWorkspace.shared.urlForApplication(withBundleIdentifier: config.hostBundleId) else { return }
        // The test aid never hands links to the person's own Codecast.
        if ProcessInfo.processInfo.environment["CODECAST_APPSHIM_DEBUG_DIR"] != nil {
            shimLog("would open \(link.absoluteString) in \(host.path)")
            return
        }
        NSWorkspace.shared.open([link], withApplicationAt: host, configuration: NSWorkspace.OpenConfiguration())
    }

    /// The standard About panel with this app's name and icon, the page
    /// version it shows, its address (without the gate keys) and who made the
    /// app shell.
    @objc func showAbout() {
        let address = ShimText.displayAddress(config.pageUrl)
        let center = NSMutableParagraphStyle()
        center.alignment = .center
        let font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)
        let credits = NSMutableAttributedString(string: address, attributes: [
            .font: font, .paragraphStyle: center, .link: URL(string: address) as Any,
        ])
        let spaced = center.mutableCopy() as! NSMutableParagraphStyle
        spaced.paragraphSpacingBefore = 6
        credits.append(NSAttributedString(string: "\nMade with Codecast", attributes: [
            .font: font, .paragraphStyle: spaced, .foregroundColor: NSColor.secondaryLabelColor,
        ]))
        // The version the page loaded, else the one installed (the bundle's).
        let version = loadedVersion["window"].flatMap { $0 > 0 ? String($0) : nil }
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: config.name,
            .applicationIcon: StatusOverlay.appIcon(),
            .applicationVersion: version,
            .version: "",
            .credits: credits,
        ])
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Opens this page in the main Codecast window. Codecast decides where it
    /// goes; without it, Codecast is at least brought forward.
    @objc func openInCodecast() {
        engine.hostCall("open-in-codecast") { [weak self] reply in
            if reply["ok"] as? Bool != true { self?.openHost() }
        }
    }

    /// Asks once here, then Codecast removes the bundle, its data and its
    /// record and replies when that finished. Meanwhile the window and menu
    /// bar item are hidden; on ok this process exits at once (no state saved
    /// on the way out, and Codecast sweeps the data again after it is gone),
    /// and on a failure the window comes back with the reason in an alert.
    @objc func uninstallApp() {
        let alert = NSAlert()
        alert.messageText = "Uninstall \(config.name)?"
        alert.informativeText = "Removes the app and the data it keeps on this Mac."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Uninstall")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        window.isRestorable = false
        window.orderOut(nil)
        trayPanel?.dismiss("uninstall")
        statusItem?.isVisible = false
        engine.hostCall("uninstall") { [weak self] reply in
            guard let self else { return }
            if reply["ok"] as? Bool == true {
                shimLog("uninstalled")
                exit(0)
            }
            let message = reply["message"] as? String ?? "Codecast did not answer."
            shimLog("uninstall failed: \(message)")
            self.statusItem?.isVisible = true
            self.showWindow()
            let failed = NSAlert()
            failed.messageText = "Couldn't uninstall \(self.config.name)"
            failed.informativeText = message
            failed.alertStyle = .warning
            failed.beginSheetModal(for: self.window)
        }
    }
}

signal(SIGPIPE, SIG_IGN)
// AppKit's automatic Edit menu items, replaced by buildMenu's own (see there).
UserDefaults.standard.register(defaults: ["NSDisabledDictationMenuItem": true, "NSDisabledCharacterPaletteMenuItem": true])
let app = NSApplication.shared
let delegate = MainActor.assumeIsolated { AppDelegate(config: ShimConfig.load()) }
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
