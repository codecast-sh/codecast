import AppKit
import ApplicationServices
import CodecastComputerUseCore
import CoreGraphics
import Darwin
import Foundation
import ImageIO

// The codecast computer helper. One signed app with a fixed identity asks for
// Accessibility and Screen Recording, so the human grants them once and every
// codecast release keeps the grant. Nothing else in codecast may ask.

private let providerVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"

struct Request: Decodable {
    let id: Int
    let method: String
    let params: [String: JSONValue]?
    let token: String?
}

enum JSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    var string: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    var number: Double? {
        if case let .number(value) = self { return value }
        return nil
    }

    var bool: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }
}

struct ProviderError: Error {
    let code: ComputerErrorCode
    let message: String

    init(_ code: ComputerErrorCode, _ message: String) {
        self.code = code
        self.message = message
    }
}

struct AppDescriptor {
    let name: String
    let bundleId: String?
    let pid: pid_t
    let app: NSRunningApplication

    /// Chromium and Electron apps expose nothing until asked. Applying this
    /// broadly is harmful: on a native Cocoa app it can collapse the tree to
    /// the app root, so the list is exact rather than heuristic.
    var needsManualAccessibilityMode: Bool {
        guard let bundleId = bundleId?.lowercased() else { return false }
        return bundleId.hasPrefix("com.google.chrome") ||
            bundleId.hasPrefix("com.microsoft.edgemac") ||
            bundleId.hasPrefix("com.brave.browser") ||
            bundleId.hasPrefix("com.operasoftware.opera") ||
            bundleId.hasPrefix("com.vivaldi.vivaldi") ||
            bundleId == "com.github.electron" ||
            bundleId == "com.tinyspeck.slackmacgap" ||
            bundleId == "com.spotify.client" ||
            bundleId == "com.hnc.discord" ||
            bundleId == "com.microsoft.teams2" ||
            bundleId == "notion.id"
    }

    var isKnownBrowser: Bool {
        let bundle = bundleId?.lowercased() ?? ""
        let appName = name.lowercased()
        return bundle == "com.apple.safari" ||
            bundle == "org.mozilla.firefox" ||
            bundle == "company.thebrowser.browser" ||
            bundle == "app.zen-browser.zen" ||
            bundle.hasPrefix("com.google.chrome") ||
            bundle.hasPrefix("com.microsoft.edgemac") ||
            bundle.hasPrefix("com.brave.browser") ||
            bundle.hasPrefix("com.operasoftware.opera") ||
            bundle.hasPrefix("com.vivaldi.vivaldi") ||
            appName == "safari" ||
            appName == "firefox" ||
            appName == "arc" ||
            appName == "zen" ||
            appName.contains("chrome") ||
            appName.contains("chromium") ||
            appName.contains("edge") ||
            appName.contains("brave") ||
            appName.contains("opera") ||
            appName.contains("vivaldi")
    }
}

final class ElementRecord {
    let index: Int
    let element: AXUIElement
    let localFrame: CGRect?
    let actions: [String]
    let signature: String

    init(index: Int, element: AXUIElement, localFrame: CGRect?, actions: [String], signature: String) {
        self.index = index
        self.element = element
        self.localFrame = localFrame
        self.actions = actions
        self.signature = signature
    }
}

struct Snapshot {
    let id: String
    let app: AppDescriptor
    let windowTitle: String
    let windowBounds: CGRect
    let windowId: CGWindowID
    let windowLayer: Int
    let treeText: String
    let focusedElementId: Int?
    let screenshot: ScreenshotPayload?
    let screenshotStatus: ScreenshotStatus
    let elements: [Int: ElementRecord]
    let truncated: Bool
    let maxDepthReached: Bool

    /// A cached snapshot exists to prove element identity. Holding megabytes of
    /// base64 in a process that lives for minutes is how a helper grows.
    func withoutScreenshotPayload() -> Snapshot {
        Snapshot(
            id: id,
            app: app,
            windowTitle: windowTitle,
            windowBounds: windowBounds,
            windowId: windowId,
            windowLayer: windowLayer,
            treeText: treeText,
            focusedElementId: focusedElementId,
            screenshot: nil,
            screenshotStatus: .skipped,
            elements: elements,
            truncated: truncated,
            maxDepthReached: maxDepthReached
        )
    }
}

struct ScreenshotPayload {
    let data: String
    let width: Int
    let height: Int
    let scale: Double
}

enum ScreenshotStatus {
    case captured
    case skipped
    case failed(String)
}

private struct CachedSnapshotEntry {
    let snapshotId: String
    let keys: [String]
    let createdAt: Date
}

final class Provider {
    private var snapshots: [String: Snapshot] = [:]
    private var snapshotEntries: [CachedSnapshotEntry] = []

    func handle(method: String, params: [String: JSONValue]) throws -> Any {
        switch method {
        case "handshake":
            return try ProviderCapabilities(providerVersion: providerVersion).jsonObject()
        case "listApps":
            return ["apps": listApps().map(renderListedApp)]
        case "listWindows":
            return try listWindows(params: params)
        case "getAppState":
            return renderSnapshot(try observe(params: params))
        case "click":
            return try actionResult(params: params) { try click(params: params) }
        case "performSecondaryAction":
            return try actionResult(params: params) { try performSecondaryAction(params: params) }
        case "setValue":
            return try actionResult(params: params) { try setValue(params: params) }
        case "typeText":
            return try actionResult(params: params) { try typeText(params: params) }
        case "pressKey":
            return try actionResult(params: params) { try pressKey(params: params) }
        case "hotkey":
            return try actionResult(params: params) { try hotkey(params: params) }
        case "pasteText":
            return try actionResult(params: params) { try pasteText(params: params) }
        case "scroll":
            return try actionResult(params: params) { try scroll(params: params) }
        default:
            throw ProviderError(.invalidArgument, "unknown method '\(method)'")
        }
    }

    /// Every action returns a fresh snapshot, so the agent never has to ask for
    /// state between two actions.
    private func actionResult(params: [String: JSONValue], action runAction: () throws -> [String: Any]) throws -> [String: Any] {
        var action = try runAction()
        do {
            return renderActionResult(action: action, snapshot: try observe(params: params))
        } catch let error as ProviderError
            where (error.code == .windowNotFound || error.code == .windowStale) && hasRequestedWindowSelector(params) {
            var fallbackParams = params
            fallbackParams.removeValue(forKey: "windowId")
            fallbackParams.removeValue(forKey: "windowIndex")
            if action["verification"] == nil {
                action["verification"] = ["state": "unverified", "reason": "window_changed"]
            }
            return renderActionResult(action: action, snapshot: try observe(params: fallbackParams))
        }
    }

    private func observe(params: [String: JSONValue]) throws -> Snapshot {
        let query = try requiredString(params, "app")
        let windowId = try requestedWindowId(params)
        let windowIndex = try requestedWindowIndex(params)
        let app = try resolveApp(query)
        let restoreWindow = params["restoreWindow"]?.bool == true
        if restoreWindow {
            raiseWindow(app)
        }
        let snapshot = try buildSnapshot(
            app: app,
            includeScreenshot: params["noScreenshot"]?.bool != true,
            windowId: windowId,
            windowIndex: windowIndex,
            restoreWindow: restoreWindow
        )
        rememberSnapshot(query: query, app: app, snapshot: snapshot.withoutScreenshotPayload(), windowIndex: windowIndex)
        return snapshot
    }

    private func rememberSnapshot(query: String, app: AppDescriptor, snapshot cached: Snapshot, windowIndex: Int?) {
        let keys = SnapshotCacheKeys.aliases(
            query: query,
            appName: app.name,
            bundleId: app.bundleId,
            pid: app.pid,
            windowId: cached.windowId,
            windowIndex: windowIndex
        )
        for key in keys {
            snapshots[key] = cached
        }
        snapshotEntries.append(CachedSnapshotEntry(snapshotId: cached.id, keys: keys, createdAt: Date()))
        pruneSnapshotCache()
    }

    private func pruneSnapshotCache() {
        let now = Date()
        while let oldest = snapshotEntries.first,
              ComputerSnapshotCachePolicy.shouldPrune(
                  entryCount: snapshotEntries.count,
                  createdAt: oldest.createdAt,
                  now: now
              ) {
            let expired = snapshotEntries.removeFirst()
            for key in expired.keys where snapshots[key]?.id == expired.snapshotId {
                snapshots.removeValue(forKey: key)
            }
        }
    }

    /// Re-observation before every action. Cached frames go stale after a window
    /// moves or a list scrolls, and stale geometry turns an intended action into
    /// a misclick.
    private func currentSnapshot(params: [String: JSONValue]) throws -> Snapshot {
        pruneSnapshotCache()
        let cached = try cachedSnapshot(params: params)
        if let cached {
            try ensureWindowStillAvailable(cached)
        }
        let snapshot = try observe(params: params.merging(["noScreenshot": .bool(true)]) { _, replacement in replacement })
        try validateRequestedElements(cached: cached, current: snapshot, params: params)
        return snapshot
    }

    private func cachedSnapshot(params: [String: JSONValue]) throws -> Snapshot? {
        guard let query = params["app"]?.string, !query.isEmpty else { return nil }
        let keys = SnapshotCacheKeys.lookupOrder(
            query: query,
            windowId: try requestedWindowId(params),
            windowIndex: try requestedWindowIndex(params)
        )
        for key in keys {
            if let cached = snapshots[key] { return cached }
        }
        return nil
    }

    private func validateRequestedElements(cached: Snapshot?, current: Snapshot, params: [String: JSONValue]) throws {
        guard params["elementIndex"]?.number != nil else { return }
        let index = try requiredInteger(params, "elementIndex")
        guard let cached else {
            throw ProviderError(
                .elementNotFound,
                "element indexes require a fresh get-app-state snapshot for this app and window"
            )
        }
        guard let expected = cached.elements[index], let actual = current.elements[index] else {
            throw ProviderError(
                .elementNotFound,
                "element \(index) is stale; run get-app-state again and use a fresh element index"
            )
        }
        guard expected.signature == actual.signature else {
            throw ProviderError(
                .elementNotFound,
                "element \(index) changed since the last snapshot; run get-app-state again and use a fresh element index"
            )
        }
    }

    private func ensureWindowStillAvailable(_ snapshot: Snapshot) throws {
        guard WindowCapture.candidates(pid: snapshot.app.pid).contains(where: { $0.windowId == snapshot.windowId }) else {
            throw ProviderError(
                .windowStale,
                "window \(Int(snapshot.windowId)) is no longer available; run get-app-state again to refresh the target window"
            )
        }
    }

    private func listApps() -> [AppDescriptor] {
        var seen = Set<String>()
        return NSWorkspace.shared.runningApplications
            .filter { !$0.isTerminated && $0.activationPolicy == .regular }
            .compactMap { app in
                guard let name = app.localizedName, !name.isEmpty else { return nil }
                let pid = app.processIdentifier
                guard pid > 0, pidIsLive(pid) else { return nil }
                let key = (app.bundleIdentifier ?? "pid:\(pid)").lowercased()
                guard seen.insert(key).inserted else { return nil }
                return AppDescriptor(name: name, bundleId: app.bundleIdentifier, pid: pid, app: app)
            }
            .sorted { lhs, rhs in
                if lhs.app.isActive != rhs.app.isActive {
                    return lhs.app.isActive && !rhs.app.isActive
                }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
    }

    private func renderListedApp(_ app: AppDescriptor) -> [String: Any] {
        [
            "name": app.name,
            "bundleId": jsonNullable(app.bundleId),
            "pid": Int(app.pid),
            "isRunning": true,
            "lastUsedAt": NSNull(),
            "useCount": NSNull(),
        ]
    }

    private func resolveApp(_ query: String) throws -> AppDescriptor {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw ProviderError(.invalidArgument, "app query must not be empty")
        }
        if let pid = parsePid(trimmed) {
            guard let app = appByPid(pid) else {
                throw ProviderError(.appNotFound, "app '\(trimmed)' not found")
            }
            try rejectBlockedApp(app)
            return app
        }
        if AppBlockList.isBlocked(trimmed) {
            throw ProviderError(.appBlocked, AppBlockList.blockedMessage(trimmed))
        }
        guard let app = listApps().first(where: { matches($0, query: trimmed) }) else {
            throw ProviderError(.appNotFound, "app '\(trimmed)' not found")
        }
        try rejectBlockedApp(app)
        return app
    }

    private func rejectBlockedApp(_ app: AppDescriptor) throws {
        guard let bundle = app.bundleId, AppBlockList.isBlocked(bundle) else { return }
        throw ProviderError(.appBlocked, AppBlockList.blockedMessage(bundle))
    }

    private func listWindows(params: [String: JSONValue]) throws -> [String: Any] {
        let app = try resolveApp(try requiredString(params, "app"))
        let windows = WindowCapture.candidates(pid: app.pid)
            .filter { $0.layer == 0 }
            .enumerated()
            .map { index, candidate -> [String: Any] in
                [
                    "index": index,
                    "app": [
                        "name": app.name,
                        "bundleId": jsonNullable(app.bundleId),
                        "pid": Int(app.pid),
                    ],
                    "id": Int(candidate.windowId),
                    "title": candidate.title ?? "",
                    "x": Int(candidate.bounds.origin.x.rounded()),
                    "y": Int(candidate.bounds.origin.y.rounded()),
                    "width": Int(candidate.bounds.width.rounded()),
                    "height": Int(candidate.bounds.height.rounded()),
                    "isMinimized": false,
                    "isOffscreen": !candidate.isOnScreen,
                    "screenIndex": jsonNullable(screenIndex(for: candidate.bounds)),
                    "isMain": NSNull(),
                    "platform": ["layer": candidate.layer, "alpha": candidate.alpha],
                ]
            }
        return ["app": renderListedApp(app), "windows": windows]
    }

    private func appByPid(_ pid: pid_t) -> AppDescriptor? {
        guard let app = NSRunningApplication(processIdentifier: pid),
              !app.isTerminated,
              let name = app.localizedName
        else {
            return nil
        }
        return AppDescriptor(name: name, bundleId: app.bundleIdentifier, pid: pid, app: app)
    }

    private func buildSnapshot(
        app: AppDescriptor,
        includeScreenshot: Bool,
        windowId: CGWindowID?,
        windowIndex: Int?,
        restoreWindow: Bool
    ) throws -> Snapshot {
        guard accessibilityTrustedSettled() else {
            // Agents retry failed observations, so a runtime call stays quiet.
            // Only the explicit setup flow opens a macOS privacy prompt.
            throw ProviderError(
                .permissionDenied,
                "Accessibility permission is required. Run `cast computer permissions --id accessibility`, grant Accessibility to codecast computer in System Settings, then retry."
            )
        }
        let appElement = AXUIElementCreateApplication(app.pid)
        enableManualAccessibilityIfNeeded(appElement, app: app)
        let windowCandidates = WindowCapture.candidates(pid: app.pid)
        let focused = try focusedWindow(
            appElement: appElement,
            app: app,
            visibleWindowCount: windowCandidates.count,
            allowRecovery: restoreWindow
        )
        let focusedTitle = stringAttribute(focused, kAXTitleAttribute as String) ?? app.name
        let canCaptureScreenshot = includeScreenshot && screenCaptureTrustedSettled()
        guard let capture = WindowCapture.resolve(
            candidates: windowCandidates,
            titleHint: focusedTitle,
            windowId: windowId,
            windowIndex: windowIndex,
            captureImage: canCaptureScreenshot
        ) else {
            throw ProviderError(.windowNotFound, "app '\(app.name)' has no on-screen window")
        }
        guard let window = matchingWindow(
            appElement: appElement,
            capture: capture,
            focused: focused,
            explicitTarget: windowId != nil || windowIndex != nil
        ) else {
            throw ProviderError(
                .windowNotFound,
                "could not match an accessibility window to the requested window; run get-app-state again or retry without a window selector"
            )
        }
        let title = stringAttribute(window, kAXTitleAttribute as String) ?? capture.title ?? app.name
        let renderer = TreeRenderer(
            windowBounds: capture.bounds,
            focused: focusedElement(appElement: appElement),
            compactBrowserTabs: app.isKnownBrowser
        )
        renderer.render(window)
        let screenshot = includeScreenshot ? capture.screenshotPayload() : nil
        let screenshotStatus: ScreenshotStatus = if screenshot != nil {
            .captured
        } else if includeScreenshot && !canCaptureScreenshot {
            .failed("Screen Recording permission is required for codecast computer; grant it or pass --no-screenshot to read the accessibility tree only.")
        } else if includeScreenshot {
            .failed("window screenshot capture returned no image; retry with --no-screenshot if the accessibility tree is enough.")
        } else {
            .skipped
        }
        return Snapshot(
            id: UUID().uuidString,
            app: app,
            windowTitle: title,
            windowBounds: capture.bounds,
            windowId: capture.windowId,
            windowLayer: capture.layer,
            treeText: renderTreeText(
                app: app,
                title: title,
                lines: renderer.lines,
                focused: renderer.focusedSummary
            ),
            focusedElementId: renderer.focusedElementId,
            screenshot: screenshot,
            screenshotStatus: screenshotStatus,
            elements: renderer.records,
            truncated: renderer.truncated,
            maxDepthReached: renderer.maxDepthReached
        )
    }

    private func renderSnapshot(_ snapshot: Snapshot) -> [String: Any] {
        var screenshot: Any = NSNull()
        if let payload = snapshot.screenshot {
            screenshot = [
                "data": payload.data,
                "format": "png",
                "width": payload.width,
                "height": payload.height,
                "scale": payload.scale,
            ]
        }
        return [
            "snapshot": [
                "id": snapshot.id,
                "app": [
                    "name": snapshot.app.name,
                    "bundleId": jsonNullable(snapshot.app.bundleId),
                    "pid": Int(snapshot.app.pid),
                ],
                "window": [
                    "id": Int(snapshot.windowId),
                    "title": snapshot.windowTitle,
                    "x": Int(snapshot.windowBounds.origin.x.rounded()),
                    "y": Int(snapshot.windowBounds.origin.y.rounded()),
                    "width": Int(snapshot.windowBounds.width.rounded()),
                    "height": Int(snapshot.windowBounds.height.rounded()),
                    "isMinimized": false,
                    "isOffscreen": false,
                    "screenIndex": jsonNullable(screenIndex(for: snapshot.windowBounds)),
                    "platform": ["layer": snapshot.windowLayer],
                ],
                "coordinateSpace": "window",
                "treeText": snapshot.treeText,
                "elementCount": snapshot.elements.count,
                "focusedElementId": jsonNullable(snapshot.focusedElementId),
                "truncation": [
                    "truncated": snapshot.truncated,
                    "maxNodes": SnapshotLimits.maxNodes,
                    "maxDepth": SnapshotLimits.maxDepth,
                    "maxDepthReached": snapshot.maxDepthReached,
                ],
            ],
            "screenshot": screenshot,
            "screenshotStatus": renderScreenshotStatus(snapshot.screenshotStatus, snapshot: snapshot),
        ]
    }

    private func renderActionResult(action: [String: Any], snapshot: Snapshot) -> [String: Any] {
        var result = renderSnapshot(snapshot)
        var metadata = action
        metadata["targetWindowId"] = Int(snapshot.windowId)
        result["action"] = metadata
        return result
    }

    /// A click never raises. An agent that needs the window forward asks for it
    /// with `--restore-window`, and the `window_not_focused` recovery names the
    /// flag, so it finds it on the first failure.
    private func click(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let button = try mouseButton(params["mouseButton"]?.string)
        let count = try positiveInteger(params["clickCount"]?.number, defaultValue: 1, name: "clickCount")
        guard count <= SyntheticMouseClickDelivery.maxClickCount else {
            throw ProviderError(.invalidArgument, "clickCount must be at most \(SyntheticMouseClickDelivery.maxClickCount)")
        }
        let modifiers = try parseModifiers(params["modifiers"]?.string)
        if let elementIndex = try optionalInteger(params, "elementIndex") {
            let record = try element(snapshot, elementIndex)
            if modifiers.isEmpty,
               count <= 1,
               button.hasAccessibilityAction,
               let actionName = performClickAction(record: record, mouseButton: button) {
                return actionMetadata(path: "accessibility", actionName: actionName)
            }
            guard let point = center(record.localFrame, in: snapshot.windowBounds) else {
                throw ProviderError(.elementNotClickable, "element \(record.index) has no clickable frame")
            }
            try requireTargetWindowFocused(snapshot, restoreWindowRequested: params["restoreWindow"]?.bool == true)
            try Input.click(at: point, button: button, count: count, modifiers: modifiers, targetWindow: snapshot)
            return actionMetadata(
                path: "synthetic",
                fallbackReason: "actionUnsupported",
                verification: unverifiedAction(reason: "synthetic_input")
            )
        }
        let point = try coordinatePoint(params: params, xKey: "x", yKey: "y", snapshot: snapshot)
        try requireTargetWindowFocused(snapshot, restoreWindowRequested: params["restoreWindow"]?.bool == true)
        try Input.click(at: point, button: button, count: count, modifiers: modifiers, targetWindow: snapshot)
        return actionMetadata(path: "synthetic", verification: unverifiedAction(reason: "synthetic_input"))
    }

    private func performClickAction(record: ElementRecord, mouseButton: MouseButtonSelection) -> String? {
        if mouseButton == .right {
            return performAction(record.element, "AXShowMenu") ? "AXShowMenu" : nil
        }
        for action in ["AXPress", "AXConfirm", "AXOpen"] where performAction(record.element, action) {
            return action
        }
        return nil
    }

    private func performSecondaryAction(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let record = try element(snapshot, try requiredInteger(params, "elementIndex"))
        let requested = try requiredString(params, "action")
        let action = record.actions.first {
            SnapshotRenderHeuristics.prettyAction($0).caseInsensitiveCompare(requested) == .orderedSame ||
                $0.caseInsensitiveCompare(requested) == .orderedSame
        }
        guard let action else {
            throw ProviderError(
                .actionNotSupported,
                "'\(requested)' is not a secondary action advertised by element \(record.index)"
            )
        }
        guard performAction(record.element, action) else {
            throw ProviderError(.accessibilityError, "AXUIElementPerformAction(\(action)) failed")
        }
        return actionMetadata(path: "accessibility", actionName: action)
    }

    /// Verified by read back, matched against the value the write actually
    /// carried, so a numeric field that stored 3 for "3" still reads as verified.
    private func setValue(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let record = try element(snapshot, try requiredInteger(params, "elementIndex"))
        let expected = try requiredStringAllowingEmpty(params, "value")
        guard isSettable(record.element, kAXValueAttribute as String) else {
            throw ProviderError(.valueNotSettable, "element \(record.index) does not accept a value write")
        }
        let coercion = AttributeValueCoercion(
            existingValue: rawAttributeValue(record.element, kAXValueAttribute as String),
            requested: expected
        )
        let result: AXError
        switch coercion.writeValue {
        case .string:
            result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, expected as CFString)
        case let .integer(value):
            result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, NSNumber(value: value))
        case let .double(value):
            result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, NSNumber(value: value))
        case let .boolean(value):
            result = AXUIElementSetAttributeValue(record.element, kAXValueAttribute as CFString, value ? kCFBooleanTrue : kCFBooleanFalse)
        }
        guard result == .success else {
            throw ProviderError(.accessibilityError, "AXUIElementSetAttributeValue failed with \(result.rawValue)")
        }
        let verification: [String: Any]
        switch coercion.compare(readback: rawAttributeValue(record.element, kAXValueAttribute as String)) {
        case let .match(actualPreview):
            verification = verifiedAction(property: "value", expected: expected, actualPreview: actualPreview)
        case let .mismatch(actualPreview):
            verification = unverifiedAction(reason: "value_mismatch", expected: expected, actualPreview: actualPreview)
        case .unsupported:
            verification = unverifiedAction(reason: "readback_unsupported", expected: expected)
        }
        return actionMetadata(path: "accessibility", actionName: "AXSetValue", verification: verification)
    }

    private func typeText(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        let text = try requiredString(params, "text")
        if let focused = focusedRecord(snapshot), let verification = TextInput.replaceSelection(focused.element, with: text) {
            return actionMetadata(path: "accessibility", actionName: "AXReplaceSelection", verification: verification)
        }
        try requireTargetWindowFocused(snapshot, restoreWindowRequested: params["restoreWindow"]?.bool == true)
        try Input.typeText(text)
        return actionMetadata(
            path: "synthetic",
            actionName: "typeText",
            verification: unverifiedAction(reason: "synthetic_input")
        )
    }

    private func pressKey(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        try requireTargetWindowFocused(snapshot, restoreWindowRequested: params["restoreWindow"]?.bool == true)
        try Input.pressChord(try requiredString(params, "key"))
        return actionMetadata(
            path: "synthetic",
            actionName: "pressKey",
            verification: unverifiedAction(reason: "synthetic_input")
        )
    }

    private func hotkey(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        let key = try requiredString(params, "key")
        if KeyChord.isSelectAll(key), let focused = focusedRecord(snapshot), TextInput.selectAll(focused.element) {
            return actionMetadata(
                path: "accessibility",
                actionName: "AXSelectAll",
                verification: TextInput.selectionVerification(focused.element)
            )
        }
        try requireTargetWindowFocused(snapshot, restoreWindowRequested: params["restoreWindow"]?.bool == true)
        try Input.pressChord(key)
        return actionMetadata(
            path: "synthetic",
            actionName: "hotkey",
            verification: unverifiedAction(reason: "synthetic_input")
        )
    }

    private func pasteText(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentKeyboardSnapshot(params: params)
        let text = try requiredString(params, "text")
        guard PasteSafety.isWithinCap(text.utf8.count) else {
            throw ProviderError(.invalidArgument, PasteSafety.tooLargeMessage)
        }
        if let focused = focusedRecord(snapshot), let verification = TextInput.replaceSelection(focused.element, with: text) {
            return actionMetadata(path: "accessibility", actionName: "AXReplaceSelection", verification: verification)
        }
        try requireTargetWindowFocused(snapshot, restoreWindowRequested: params["restoreWindow"]?.bool == true)
        try Input.pasteText(text)
        return actionMetadata(
            path: "clipboard",
            actionName: "paste",
            verification: unverifiedAction(reason: "clipboard_paste")
        )
    }

    private func scroll(params: [String: JSONValue]) throws -> [String: Any] {
        let snapshot = try currentSnapshot(params: params)
        let direction = try scrollDirection(try requiredString(params, "direction"))
        let pages = try positiveNumber(params["pages"]?.number, defaultValue: 1, name: "pages")
        if let elementIndex = try optionalInteger(params, "elementIndex") {
            let record = try element(snapshot, elementIndex)
            let action = "AXScroll\(direction.capitalized)ByPage"
            if pages.rounded() == pages,
               let pageCount = boundedInteger(pages, as: Int.self),
               record.actions.contains(action) {
                for _ in 0..<max(1, pageCount) {
                    _ = performAction(record.element, action)
                }
                return actionMetadata(path: "accessibility", actionName: action)
            }
            guard let point = center(record.localFrame, in: snapshot.windowBounds) else {
                throw ProviderError(.elementNotClickable, "element \(record.index) has no scrollable frame")
            }
            try Input.scroll(pid: snapshot.app.pid, at: point, direction: direction, pages: pages)
            return actionMetadata(path: "synthetic", fallbackReason: "actionUnsupported")
        }
        let point = try coordinatePoint(params: params, xKey: "x", yKey: "y", snapshot: snapshot)
        try Input.scroll(pid: snapshot.app.pid, at: point, direction: direction, pages: pages)
        return actionMetadata(path: "synthetic")
    }

    /// Accessibility text replacement and select all post no global input, so
    /// only the synthetic fallbacks need the window to be focused.
    private func currentKeyboardSnapshot(params: [String: JSONValue]) throws -> Snapshot {
        try currentSnapshot(params: params.merging(["noScreenshot": .bool(true)]) { _, replacement in replacement })
    }

    private func element(_ snapshot: Snapshot, _ index: Int) throws -> ElementRecord {
        guard let record = snapshot.elements[index] else {
            throw ProviderError(
                .elementNotFound,
                "element \(index) is stale; run get-app-state again and use a fresh element index"
            )
        }
        return record
    }

    private func focusedRecord(_ snapshot: Snapshot) -> ElementRecord? {
        guard let focusedElementId = snapshot.focusedElementId else { return nil }
        return snapshot.elements[focusedElementId]
    }
}

private func requiredString(_ params: [String: JSONValue], _ key: String) throws -> String {
    guard let value = params[key]?.string, !value.isEmpty else {
        throw ProviderError(.invalidArgument, "missing \(key)")
    }
    return value
}

private func requiredStringAllowingEmpty(_ params: [String: JSONValue], _ key: String) throws -> String {
    guard let value = params[key]?.string else {
        throw ProviderError(.invalidArgument, "missing \(key)")
    }
    return value
}

private func requiredNumber(_ params: [String: JSONValue], _ key: String) throws -> Double {
    guard let value = params[key]?.number, value.isFinite else {
        throw ProviderError(.invalidArgument, "missing \(key)")
    }
    return value
}

private func requiredInteger(_ params: [String: JSONValue], _ key: String) throws -> Int {
    guard let value = boundedInteger(try requiredNumber(params, key), as: Int.self) else {
        throw ProviderError(.invalidArgument, "\(key) is out of range")
    }
    return value
}

private func optionalInteger(_ params: [String: JSONValue], _ key: String) throws -> Int? {
    guard let raw = params[key]?.number else { return nil }
    guard let value = boundedInteger(raw, as: Int.self) else {
        throw ProviderError(.invalidArgument, "\(key) is out of range")
    }
    return value
}

private func positiveInteger(_ value: Double?, defaultValue: Int, name: String) throws -> Int {
    switch ActionArgumentValidation.positiveInteger(value, defaultValue: defaultValue, name: name) {
    case let .success(value): return value
    case let .failure(error): throw ProviderError(.invalidArgument, error.message)
    }
}

private func positiveNumber(_ value: Double?, defaultValue: Double, name: String) throws -> Double {
    switch ActionArgumentValidation.positiveNumber(value, defaultValue: defaultValue, name: name) {
    case let .success(value): return value
    case let .failure(error): throw ProviderError(.invalidArgument, error.message)
    }
}

private func scrollDirection(_ value: String) throws -> String {
    switch ActionArgumentValidation.scrollDirection(value) {
    case let .success(value): return value
    case let .failure(error): throw ProviderError(.invalidArgument, error.message)
    }
}

private func mouseButton(_ raw: String?) throws -> MouseButtonSelection {
    switch ActionArgumentValidation.mouseButton(raw) {
    case let .success(button): return button
    case let .failure(error): throw ProviderError(.invalidArgument, error.message)
    }
}

private func parseModifiers(_ raw: String?) throws -> [KeyModifierName] {
    switch KeyChord.parseModifiers(raw) {
    case let .success(modifiers): return modifiers
    case let .failure(error): throw ProviderError(.invalidArgument, error.message)
    }
}

private func parsePid(_ query: String) -> pid_t? {
    guard query.hasPrefix("pid:"), let pid = Int32(query.dropFirst(4)), pid > 0 else { return nil }
    return pid
}

private func matches(_ app: AppDescriptor, query: String) -> Bool {
    app.name.caseInsensitiveCompare(query) == .orderedSame ||
        app.bundleId?.caseInsensitiveCompare(query) == .orderedSame
}

private func pidIsLive(_ pid: pid_t) -> Bool {
    kill(pid, 0) == 0
}

/// A freshly launched process gets transient TCC denials before the real answer
/// arrives, so the first probe after a grant reads as denied without a settle.
private func accessibilityTrustedSettled() -> Bool {
    PermissionTrustSettling.settle(probe: { AXIsProcessTrusted() }).settled
}

private func screenCaptureTrustedSettled() -> Bool {
    PermissionTrustSettling.settle(timeoutMs: 2_000, probe: { CGPreflightScreenCaptureAccess() }).settled
}

private func permissionStatusSnapshotSettled() -> PermissionStatusSnapshot {
    PermissionStatusSnapshotProbe.capture(
        accessibilityProbe: accessibilityTrustedSettled,
        screenshotsProbe: screenCaptureTrustedSettled
    )
}

private func openSystemSettings(_ value: String) {
    guard let url = URL(string: value) else { return }
    NSWorkspace.shared.open(url)
}

private func enableManualAccessibilityIfNeeded(_ appElement: AXUIElement, app: AppDescriptor) {
    guard app.needsManualAccessibilityMode else { return }
    _ = AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    _ = AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
}

private func focusedWindow(
    appElement: AXUIElement,
    app: AppDescriptor,
    visibleWindowCount: Int,
    allowRecovery: Bool
) throws -> AXUIElement {
    let systemWide = AXUIElementCreateSystemWide()
    if let window = lookupUsableWindow(systemWide: systemWide, appElement: appElement, app: app) {
        return window
    }
    if allowRecovery {
        raiseWindow(app)
        if let window = lookupUsableWindow(systemWide: systemWide, appElement: appElement, app: app) {
            return window
        }
    }
    if visibleWindowCount > 0 {
        var settledWindow: AXUIElement?
        let outcome = PermissionTrustSettling.settle {
            settledWindow = lookupUsableWindow(systemWide: systemWide, appElement: appElement, app: app)
            return settledWindow != nil
        }
        if let window = settledWindow, outcome.settled {
            return window
        }
        throw ProviderError(
            .permissionDenied,
            "app '\(app.name)' has visible windows but no accessibility window (AX reads stayed blocked for \(outcome.waitedMs)ms). Toggle codecast computer off and on again under Accessibility in System Settings."
        )
    }
    throw ProviderError(
        .windowNotFound,
        "app '\(app.name)' has no accessibility window; make sure it has a visible window, then retry with --restore-window."
    )
}

private func lookupUsableWindow(systemWide: AXUIElement, appElement: AXUIElement, app: AppDescriptor) -> AXUIElement? {
    if let window = focusedSystemWindow(systemWide: systemWide, app: app) {
        return window
    }
    if let window = copyElement(appElement, kAXFocusedWindowAttribute as String), usableWindow(window) {
        return window
    }
    if let windows = copyArray(appElement, kAXWindowsAttribute as String) {
        return windows.first(where: usableWindow)
    }
    return nil
}

private func focusedSystemWindow(systemWide: AXUIElement, app: AppDescriptor) -> AXUIElement? {
    guard let focusedApp = copyElement(systemWide, kAXFocusedApplicationAttribute as String),
          pidAttribute(focusedApp) == app.pid
    else {
        return nil
    }
    if let window = copyElement(systemWide, kAXFocusedWindowAttribute as String), usableWindow(window) {
        return window
    }
    if let window = copyElement(focusedApp, kAXFocusedWindowAttribute as String), usableWindow(window) {
        return window
    }
    if let windows = copyArray(focusedApp, kAXWindowsAttribute as String) {
        return windows.first(where: usableWindow)
    }
    return nil
}

private func isTargetWindowFocused(_ snapshot: Snapshot) -> Bool {
    guard let focusedWindow = focusedSystemWindow(systemWide: AXUIElementCreateSystemWide(), app: snapshot.app) else {
        return false
    }
    if windowNumber(focusedWindow) == snapshot.windowId {
        return true
    }
    guard let frame = absoluteFrame(focusedWindow) else { return false }
    let intersection = frame.intersection(snapshot.windowBounds)
    return !intersection.isNull && intersection.area >= min(frame.area, snapshot.windowBounds.area) * 0.75
}

private enum AXElementProbe {
    case value(AXUIElement)
    case absent
    case unavailable
}

private func copyElementProbe(_ element: AXUIElement, _ attribute: String) -> AXElementProbe {
    var value: CFTypeRef?
    switch AXUIElementCopyAttributeValue(element, attribute as CFString, &value) {
    case .success:
        guard let value else { return .unavailable }
        return .value(value as! AXUIElement)
    case .noValue:
        return .absent
    default:
        return .unavailable
    }
}

private func currentSyntheticClickRecipient(
    snapshot: Snapshot,
    point: CGPoint
) -> SyntheticMouseClickDelivery.RecipientObservation {
    let target = SyntheticMouseClickDelivery.Recipient(ownerPID: snapshot.app.pid, windowID: snapshot.windowId)
    var cachedTargetCandidates: [WindowCandidate]?
    func targetCandidates() -> [WindowCandidate] {
        if let cachedTargetCandidates { return cachedTargetCandidates }
        let candidates = WindowCapture.candidates(pid: snapshot.app.pid)
        cachedTargetCandidates = candidates
        return candidates
    }
    switch focusedSyntheticClickRecipient(targetPID: snapshot.app.pid, targetCandidates: targetCandidates) {
    case let .focused(focused):
        guard focused == target else { return .focused(focused) }
        switch hitTestSyntheticClickRecipient(at: point, targetPID: snapshot.app.pid, targetCandidates: targetCandidates) {
        case let .focused(recipient):
            return .focused(recipient)
        case .dismissed, .unavailable:
            return .unavailable
        }
    case .dismissed:
        return .dismissed
    case .unavailable:
        return .unavailable
    }
}

private func focusedSyntheticClickRecipient(
    targetPID: pid_t,
    targetCandidates: () -> [WindowCandidate]
) -> SyntheticMouseClickDelivery.RecipientObservation {
    let systemWide = AXUIElementCreateSystemWide()
    let focusedApp: AXUIElement
    switch copyElementProbe(systemWide, kAXFocusedApplicationAttribute as String) {
    case let .value(value): focusedApp = value
    case .absent: return .dismissed
    case .unavailable: return .unavailable
    }
    guard let ownerPID = pidAttribute(focusedApp) else { return .unavailable }

    let focusedWindow: AXUIElement
    switch copyElementProbe(focusedApp, kAXFocusedWindowAttribute as String) {
    case let .value(value):
        focusedWindow = value
    case .absent:
        guard ownerPID == targetPID else { return .unavailable }
        return .dismissed
    case .unavailable:
        return .unavailable
    }

    if let windowId = windowNumber(focusedWindow) {
        return .focused(SyntheticMouseClickDelivery.Recipient(ownerPID: ownerPID, windowID: windowId))
    }
    guard ownerPID == targetPID,
          let frame = absoluteFrame(focusedWindow),
          let candidate = SyntheticMouseClickDelivery.uniqueWindowCandidate(
              from: targetCandidates(),
              matching: { windowFramesMatch($0.bounds, frame) }
          )
    else {
        return .unavailable
    }
    return .focused(SyntheticMouseClickDelivery.Recipient(ownerPID: ownerPID, windowID: candidate.windowId))
}

private func hitTestSyntheticClickRecipient(
    at point: CGPoint,
    targetPID: pid_t,
    targetCandidates: () -> [WindowCandidate]
) -> SyntheticMouseClickDelivery.RecipientObservation {
    let systemWide = AXUIElementCreateSystemWide()
    var hitElement: AXUIElement?
    switch AXUIElementCopyElementAtPosition(systemWide, Float(point.x), Float(point.y), &hitElement) {
    case .success: break
    case .noValue: return .dismissed
    default: return .unavailable
    }
    guard let hitElement, let ownerPID = pidAttribute(hitElement), let window = containingWindow(hitElement) else {
        return .unavailable
    }
    if let windowId = windowNumber(window) {
        return .focused(SyntheticMouseClickDelivery.Recipient(ownerPID: ownerPID, windowID: windowId))
    }
    guard ownerPID == targetPID,
          let frame = absoluteFrame(window),
          let candidate = SyntheticMouseClickDelivery.uniqueWindowCandidate(
              from: targetCandidates(),
              matching: { windowFramesMatch($0.bounds, frame) }
          )
    else {
        return .unavailable
    }
    return .focused(SyntheticMouseClickDelivery.Recipient(ownerPID: ownerPID, windowID: candidate.windowId))
}

private func containingWindow(_ element: AXUIElement) -> AXUIElement? {
    var current = element
    for _ in 0..<SnapshotLimits.maxDepth {
        if stringAttribute(current, kAXRoleAttribute as String) == kAXWindowRole as String {
            return current
        }
        if let window = copyElement(current, kAXWindowAttribute as String) {
            return window
        }
        guard let parent = copyElement(current, kAXParentAttribute as String) else { return nil }
        current = parent
    }
    return nil
}

/// Synthetic input requires the target window to be focused already. The
/// accessibility paths need nothing, which is exactly why they are preferred.
private func requireTargetWindowFocused(_ snapshot: Snapshot, restoreWindowRequested: Bool) throws {
    guard let failure = KeyboardInputSafety.syntheticInputFocusFailure(
        targetWindowFocused: isTargetWindowFocused(snapshot),
        restoreWindowRequested: restoreWindowRequested
    ) else {
        return
    }
    switch failure {
    case .targetNotFocused:
        throw ProviderError(
            .windowNotFocused,
            "synthetic input requires the target \(snapshot.app.name) window to be focused; retry with --restore-window, or prefer set-value or perform-secondary-action, which need no focus"
        )
    case .targetNotFocusedAfterRestore:
        throw ProviderError(
            .windowNotFocused,
            "synthetic input requires the target \(snapshot.app.name) window to be focused; --restore-window was already requested and the target is still not focused, so stop retrying restore and prefer set-value or perform-secondary-action"
        )
    }
}

private func matchingWindow(
    appElement: AXUIElement,
    capture: WindowCapture,
    focused: AXUIElement,
    explicitTarget: Bool
) -> AXUIElement? {
    guard let windows = copyArray(appElement, kAXWindowsAttribute as String) else { return nil }
    if let byNumber = windows.first(where: { windowNumber($0) == capture.windowId }) {
        return byNumber
    }
    if let byBounds = windows.first(where: { window in
        guard usableWindow(window), let frame = absoluteFrame(window) else { return false }
        let intersection = frame.intersection(capture.bounds)
        return !intersection.isNull && intersection.area >= min(frame.area, capture.bounds.area) * 0.75
    }) {
        return byBounds
    }
    if explicitTarget { return nil }
    guard let titleHint = capture.title, !titleHint.isEmpty else { return focused }
    return windows.first {
        usableWindow($0) && stringAttribute($0, kAXTitleAttribute as String) == titleHint
    } ?? focused
}

/// The one raise in the feature, and only ever from `--restore-window`.
private func raiseWindow(_ app: AppDescriptor, windowId: CGWindowID? = nil, windowBounds: CGRect? = nil) {
    _ = app.app.unhide()
    _ = app.app.activate(options: [.activateAllWindows])
    let appElement = AXUIElementCreateApplication(app.pid)
    let focusedWindow = copyElement(appElement, kAXFocusedWindowAttribute as String)
    var cachedWindows: [AXUIElement]?
    func windows() -> [AXUIElement] {
        if let cachedWindows { return cachedWindows }
        let value = copyArray(appElement, kAXWindowsAttribute as String) ?? []
        cachedWindows = value
        return value
    }
    let targetWindow: AXUIElement?
    if let focusedWindow,
       windowId == nil && windowBounds == nil ||
       windowMatchesCapture(focusedWindow, windowId: windowId, windowBounds: windowBounds) {
        targetWindow = focusedWindow
    } else {
        let exactWindow = windowId.flatMap { targetId in windows().first { windowNumber($0) == targetId } }
        targetWindow = exactWindow ?? windowBounds.flatMap { targetBounds in
            windows().first { window in
                absoluteFrame(window).map { windowFramesMatch($0, targetBounds) } == true
            }
        }
    }
    if let window = targetWindow ?? focusedWindow ?? windows().first {
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        _ = AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        _ = AXUIElementSetAttributeValue(window, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    }
    Thread.sleep(forTimeInterval: 0.4)
}

private func windowMatchesCapture(_ window: AXUIElement, windowId: CGWindowID?, windowBounds: CGRect?) -> Bool {
    if let windowId, windowNumber(window) == windowId { return true }
    guard let windowBounds, let frame = absoluteFrame(window) else { return false }
    return windowFramesMatch(frame, windowBounds)
}

private func windowFramesMatch(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
    let tolerance: CGFloat = 2
    return abs(lhs.minX - rhs.minX) <= tolerance &&
        abs(lhs.minY - rhs.minY) <= tolerance &&
        abs(lhs.width - rhs.width) <= tolerance &&
        abs(lhs.height - rhs.height) <= tolerance
}

private func hasRequestedWindowSelector(_ params: [String: JSONValue]) -> Bool {
    params["windowId"] != nil || params["windowIndex"] != nil
}

private func requestedWindowId(_ params: [String: JSONValue]) throws -> CGWindowID? {
    guard let raw = params["windowId"] else { return nil }
    guard let value = raw.number, value >= 0, let id = boundedInteger(value, as: UInt32.self) else {
        throw ProviderError(.invalidArgument, "windowId is out of range")
    }
    return CGWindowID(id)
}

private func requestedWindowIndex(_ params: [String: JSONValue]) throws -> Int? {
    guard let raw = params["windowIndex"] else { return nil }
    guard let value = raw.number, value >= 0, let index = boundedInteger(value, as: Int.self) else {
        throw ProviderError(.invalidArgument, "windowIndex is out of range")
    }
    return index
}

private func usableWindow(_ element: AXUIElement) -> Bool {
    stringAttribute(element, kAXRoleAttribute as String) == kAXWindowRole as String &&
        boolAttribute(element, kAXMinimizedAttribute as String) != true
}

private func focusedElement(appElement: AXUIElement) -> AXUIElement? {
    copyElement(appElement, kAXFocusedUIElementAttribute as String)
}

private func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    return (value as! AXUIElement)
}

private func copyArray(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    return value as? [AXUIElement]
}

private func pidAttribute(_ element: AXUIElement) -> pid_t? {
    var pid: pid_t = 0
    guard AXUIElementGetPid(element, &pid) == .success else { return nil }
    return pid
}

private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
        return nil
    }
    if CFGetTypeID(value) == CFStringGetTypeID(), let string = value as? String {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    if CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL {
        return url.absoluteString
    }
    return nil
}

private func rawStringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
    guard let value = rawAttributeValue(element, attribute), CFGetTypeID(value) == CFStringGetTypeID() else {
        return nil
    }
    return value as? String
}

private func rawAttributeValue(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value
}

private func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? Bool
}

private func numberAttribute(_ element: AXUIElement, _ attribute: String) -> NSNumber? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
    return value as? NSNumber
}

private func windowNumber(_ element: AXUIElement) -> CGWindowID? {
    guard let number = numberAttribute(element, "AXWindowNumber") else { return nil }
    return CGWindowID(number.uint32Value)
}

private func absoluteFrame(_ element: AXUIElement) -> CGRect? {
    var positionValue: CFTypeRef?
    var sizeValue: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionValue) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeValue) == .success,
          let positionValue,
          let sizeValue
    else {
        return nil
    }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
    else {
        return nil
    }
    return CGRect(origin: point, size: size)
}

private extension CGRect {
    var area: CGFloat { max(width, 0) * max(height, 0) }
}

private func actions(_ element: AXUIElement) -> [String] {
    var value: CFArray?
    guard AXUIElementCopyActionNames(element, &value) == .success, let value else { return [] }
    return value as? [String] ?? []
}

private func performAction(_ element: AXUIElement, _ action: String) -> Bool {
    actions(element).contains { $0.caseInsensitiveCompare(action) == .orderedSame } &&
        AXUIElementPerformAction(element, action as CFString) == .success
}

private func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
    var settable = DarwinBoolean(false)
    return AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
}

private func center(_ localFrame: CGRect?, in windowBounds: CGRect) -> CGPoint? {
    guard let localFrame else { return nil }
    return CGPoint(x: windowBounds.minX + localFrame.midX, y: windowBounds.minY + localFrame.midY)
}

private func screenIndex(for bounds: CGRect) -> Int? {
    NSScreen.screens.firstIndex { $0.frame.intersects(bounds) }
}

/// Action coordinates are window local. The screenshot scale converts a pixel
/// the agent read off the picture back into one of these points.
private func coordinatePoint(
    params: [String: JSONValue],
    xKey: String,
    yKey: String,
    snapshot: Snapshot
) throws -> CGPoint {
    let x = try requiredNumber(params, xKey)
    let y = try requiredNumber(params, yKey)
    return CGPoint(x: snapshot.windowBounds.minX + x, y: snapshot.windowBounds.minY + y)
}

extension MouseButtonSelection {
    /// macOS has no dedicated middle button event family; it rides `otherMouse*`
    /// with the button number carried by the event constructor.
    var cgButton: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }

    var downEvent: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }

    var upEvent: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }
}

extension KeyModifierName {
    var flag: CGEventFlags {
        switch self {
        case .command: return .maskCommand
        case .control: return .maskControl
        case .option: return .maskAlternate
        case .shift: return .maskShift
        }
    }

    var keyCode: CGKeyCode { CGKeyCode(KeyChord.modifierKeyCode(self)) }
}

private func renderTreeText(app: AppDescriptor, title: String, lines: [String], focused: String?) -> String {
    var output = [
        "App=\(app.bundleId ?? app.name.replacingOccurrences(of: " ", with: "_")) (pid \(app.pid))",
        "Window: \"\(SnapshotRenderHeuristics.sanitize(title))\", App: \(SnapshotRenderHeuristics.sanitize(app.name)).",
        "",
    ]
    output.append(contentsOf: lines)
    output.append("")
    output.append(focused.map { "The focused UI element is \($0)." } ?? "No UI element is currently focused.")
    return output.joined(separator: "\n")
}

/// A failed capture is not a failed command: the tree is still the answer, and
/// the status says why the pixels are missing.
private func renderScreenshotStatus(_ status: ScreenshotStatus, snapshot: Snapshot) -> [String: Any] {
    let metadata: [String: Any] = ["engine": "cgWindowList", "windowId": Int(snapshot.windowId)]
    switch status {
    case .captured:
        return ["state": "captured", "metadata": metadata]
    case .skipped:
        return ["state": "skipped", "reason": "no_screenshot_flag"]
    case let .failed(message):
        return [
            "state": "failed",
            "code": ComputerErrorCode.screenshotFailed.rawValue,
            "message": message,
            "metadata": metadata,
        ]
    }
}

private func actionMetadata(
    path: String,
    actionName: String? = nil,
    fallbackReason: String? = nil,
    verification: [String: Any]? = nil
) -> [String: Any] {
    var metadata: [String: Any] = [
        "path": path,
        "actionName": jsonNullable(actionName),
        "fallbackReason": jsonNullable(fallbackReason),
    ]
    if let verification {
        metadata["verification"] = verification
    }
    return metadata
}

private func verifiedAction(property: String, expected: String? = nil, actualPreview: String? = nil) -> [String: Any] {
    [
        "state": "verified",
        "property": property,
        "expected": jsonNullable(expected),
        "actualPreview": jsonNullable(actualPreview),
    ]
}

private func unverifiedAction(reason: String, expected: String? = nil, actualPreview: String? = nil) -> [String: Any] {
    [
        "state": "unverified",
        "reason": reason,
        "expected": jsonNullable(expected),
        "actualPreview": jsonNullable(actualPreview),
    ]
}

private func jsonNullable<T>(_ value: T?) -> Any {
    value ?? NSNull()
}

private final class TreeRenderer {
    let windowBounds: CGRect
    let focused: AXUIElement?
    let compactBrowserTabs: Bool
    var lines: [String] = []
    var records: [Int: ElementRecord] = [:]
    var focusedSummary: String?
    var focusedElementId: Int?
    var truncated = false
    var maxDepthReached = false
    private let reader = AXSnapshotReader()
    private var nextIndex = 0

    init(windowBounds: CGRect, focused: AXUIElement?, compactBrowserTabs: Bool) {
        self.windowBounds = windowBounds
        self.focused = focused
        self.compactBrowserTabs = compactBrowserTabs
    }

    func render(_ element: AXUIElement, depth: Int = 0, ancestors: [AXUIElement] = []) {
        guard nextIndex < SnapshotLimits.maxNodes else {
            truncated = true
            return
        }
        guard depth < SnapshotLimits.maxDepth else {
            truncated = true
            maxDepthReached = true
            return
        }
        guard !ancestors.contains(where: { CFEqual($0, element) }) else { return }

        let role = reader.stringAttribute(element, kAXRoleAttribute as String) ?? "AXUnknown"
        let children = reader.primaryChildren(element, role: role, windowBounds: windowBounds)
        let value = reader.valueString(element, role: role)
        let placeholder = reader.placeholderString(element)
        let rawActions = reader.actions(element)
        let rowSummary = reader.rowTextSummary(element, role: role)
        let roleDescription = reader.stringAttribute(element, kAXRoleDescriptionAttribute as String)
        let title = reader.stringAttribute(element, kAXTitleAttribute as String)
        let label = reader.stringAttribute(element, kAXDescriptionAttribute as String)
        let url = reader.stringAttribute(element, kAXURLAttribute as String)
        let linkText = role == "AXLink"
            ? reader.descendantTextSnippets(element, limit: 2, maxDepth: 3).first
            : nil
        let baseNode = SnapshotRenderNode(
            role: role,
            roleDescription: roleDescription,
            title: title,
            label: label,
            linkText: linkText,
            value: value,
            placeholder: placeholder,
            url: url,
            rawActions: rawActions,
            childCount: children.count,
            rowSummary: rowSummary
        )
        let name = SnapshotRenderHeuristics.displayName(baseNode)
        let meaningful = SnapshotRenderHeuristics.meaningfulActions(rawActions, role: role)
        let localFrame = reader.frame(element, windowBounds: windowBounds)
        let traits = reader.traitsFor(element, role: role)
        let webAreaDepth = reader.webAreaDepth(role: role, ancestors: ancestors)
        let summary = reader.genericTextSummary(element, role: role, name: name, actions: meaningful, traits: traits)
        let node = SnapshotRenderNode(
            role: role,
            roleDescription: roleDescription,
            title: title,
            label: label,
            linkText: linkText,
            value: value,
            placeholder: placeholder,
            url: url,
            traits: traits,
            rawActions: rawActions,
            childCount: children.count,
            summary: summary,
            rowSummary: rowSummary,
            webAreaDepth: webAreaDepth
        )
        if SnapshotRenderHeuristics.shouldElide(node) {
            for child in children {
                render(child, depth: depth, ancestors: ancestors + [element])
            }
            return
        }

        let index = nextIndex
        nextIndex += 1
        let line = SnapshotRenderHeuristics.line(index: index, node: node)
        lines.append(String(repeating: "\t", count: depth) + line)
        records[index] = ElementRecord(
            index: index,
            element: element,
            localFrame: localFrame,
            actions: rawActions,
            signature: ElementSignature.of(node)
        )
        if let focused, CFEqual(focused, element) {
            focusedElementId = index
            focusedSummary = line
        }
        if summary != nil || SnapshotRenderHeuristics.shouldSuppressChildren(node) {
            return
        }
        if compactBrowserTabs, let compaction = tabStripCompaction(parent: node, children: children) {
            for (childIndex, child) in children.enumerated() where compaction.retainedIndexes.contains(childIndex) {
                render(child, depth: depth + 1, ancestors: ancestors + [element])
            }
            lines.append(
                RenderedBrowserTabCompaction.omittedLine(
                    indent: String(repeating: "\t", count: depth + 1),
                    count: compaction.omittedCount
                )
            )
            return
        }
        let childLineStart = lines.count
        for child in children {
            render(child, depth: depth + 1, ancestors: ancestors + [element])
        }
        if compactBrowserTabs {
            compactRenderedBrowserTabs(parent: node, startLine: childLineStart, depth: depth + 1)
        }
    }

    private func tabStripCompaction(parent: SnapshotRenderNode, children: [AXUIElement]) -> SnapshotTabStripCompaction? {
        let childNodes = children.map { child in
            let role = reader.stringAttribute(child, kAXRoleAttribute as String) ?? "AXUnknown"
            return SnapshotRenderNode(
                role: role,
                roleDescription: reader.stringAttribute(child, kAXRoleDescriptionAttribute as String),
                title: reader.stringAttribute(child, kAXTitleAttribute as String),
                label: reader.stringAttribute(child, kAXDescriptionAttribute as String),
                value: reader.valueString(child, role: role),
                traits: reader.traitsFor(child, role: role)
            )
        }
        return SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: childNodes)
    }

    /// A strip that only becomes recognizable after its children are lines. The
    /// records for the removed tabs go with them, so no index outlives its line.
    private func compactRenderedBrowserTabs(parent: SnapshotRenderNode, startLine: Int, depth: Int) {
        guard SnapshotRenderHeuristics.roleText(parent) == "scroll area" else { return }
        let indent = String(repeating: "\t", count: depth)
        guard let plan = RenderedBrowserTabCompaction.plan(lines: lines, from: startLine, indent: indent) else {
            return
        }
        for lineIndex in plan.removedLineIndexes.reversed() {
            if let recordIndex = RenderedBrowserTabCompaction.renderedElementIndex(lines[lineIndex], indent: indent) {
                records.removeValue(forKey: recordIndex)
                if focusedElementId == recordIndex {
                    focusedElementId = nil
                    focusedSummary = nil
                }
            }
            lines.remove(at: lineIndex)
        }
        lines.insert(
            RenderedBrowserTabCompaction.omittedLine(indent: indent, count: plan.omittedCount),
            at: plan.insertionIndex
        )
    }
}

private final class AXSnapshotReader {
    private enum CachedAttribute {
        case missing
        case found(CFTypeRef)
    }

    private final class ElementCache {
        let element: AXUIElement
        var loadedAttributeNames = false
        var advertisedAttributes: Set<String>?
        var attributes: [String: CachedAttribute] = [:]
        var actions: [String]?
        var settable: [String: Bool] = [:]

        init(element: AXUIElement) {
            self.element = element
        }
    }

    private var elementsByHash: [CFHashCode: [ElementCache]] = [:]

    func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let value = copyAttribute(element, attribute) else { return nil }
        if CFGetTypeID(value) == CFStringGetTypeID(), let string = value as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        if CFGetTypeID(value) == CFURLGetTypeID(), let url = value as? URL {
            return url.absoluteString
        }
        return nil
    }

    func boolAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
        copyAttribute(element, attribute) as? Bool
    }

    func numberAttribute(_ element: AXUIElement, _ attribute: String) -> NSNumber? {
        copyAttribute(element, attribute) as? NSNumber
    }

    func copyArray(_ element: AXUIElement, _ attribute: String) -> [AXUIElement]? {
        copyAttribute(element, attribute) as? [AXUIElement]
    }

    func actions(_ element: AXUIElement) -> [String] {
        let cache = cache(for: element)
        if let actions = cache.actions { return actions }
        var value: CFArray?
        let actions = AXUIElementCopyActionNames(element, &value) == .success ? value as? [String] ?? [] : []
        cache.actions = actions
        return actions
    }

    func isSettable(_ element: AXUIElement, _ attribute: String) -> Bool {
        let cache = cache(for: element)
        if let cached = cache.settable[attribute] { return cached }
        var settable = DarwinBoolean(false)
        let value = AXUIElementIsAttributeSettable(element, attribute as CFString, &settable) == .success && settable.boolValue
        cache.settable[attribute] = value
        return value
    }

    func frame(_ element: AXUIElement, windowBounds: CGRect) -> CGRect? {
        guard let absolute = absoluteFrame(element) else { return nil }
        return CGRect(
            x: absolute.minX - windowBounds.minX,
            y: absolute.minY - windowBounds.minY,
            width: absolute.width,
            height: absolute.height
        )
    }

    func primaryChildren(_ element: AXUIElement, role: String, windowBounds: CGRect) -> [AXUIElement] {
        if SnapshotRenderHeuristics.usesRowsAsPrimaryChildren(role: role),
           let rows = copyArray(element, kAXRowsAttribute as String),
           !rows.isEmpty {
            return visibleRows(rows, parent: element, windowBounds: windowBounds)
        }
        return copyArray(element, kAXChildrenAttribute as String) ?? []
    }

    func valueString(_ element: AXUIElement, role: String) -> String? {
        if SecureTextRedaction.isSecureField(
            role: role,
            subrole: stringAttribute(element, kAXSubroleAttribute as String),
            title: stringAttribute(element, kAXTitleAttribute as String),
            label: stringAttribute(element, kAXDescriptionAttribute as String),
            placeholder: placeholderString(element)
        ) {
            return SecureTextRedaction.placeholder
        }
        if let string = stringAttribute(element, kAXValueAttribute as String) {
            return string
        }
        return numberAttribute(element, kAXValueAttribute as String)?.stringValue
    }

    func placeholderString(_ element: AXUIElement) -> String? {
        stringAttribute(element, "AXPlaceholderValue") ?? stringAttribute(element, "AXPlaceholder")
    }

    func traitsFor(_ element: AXUIElement, role: String) -> [String] {
        var traits: [String] = []
        if boolAttribute(element, kAXSelectedAttribute as String) == true { traits.append("selected") }
        if boolAttribute(element, kAXExpandedAttribute as String) == true { traits.append("expanded") }
        if boolAttribute(element, kAXEnabledAttribute as String) == false { traits.append("disabled") }
        if valueSettableRoles.contains(role), isSettable(element, kAXValueAttribute as String) { traits.append("settable") }
        return traits
    }

    func genericTextSummary(
        _ element: AXUIElement,
        role: String,
        name: String?,
        actions: [String],
        traits: [String]
    ) -> String? {
        guard role == kAXGroupRole as String || role == kAXUnknownRole as String,
              name == nil,
              actions.isEmpty,
              traits.isEmpty,
              isPlainTextSubtree(element, maxDepth: SnapshotLimits.textCollapseDepth)
        else {
            return nil
        }
        return SnapshotRenderHeuristics.textCollapseSummary(
            descendantTextSnippets(
                element,
                limit: SnapshotLimits.textCollapseSnippetLimit,
                maxDepth: SnapshotLimits.textCollapseDepth
            )
        )
    }

    func rowTextSummary(_ element: AXUIElement, role: String) -> String? {
        guard ["AXRow", "AXCell", "AXOutlineRow"].contains(role) else { return nil }
        let texts = descendantTextSnippets(
            element,
            limit: SnapshotLimits.rowSummarySnippetLimit,
            maxDepth: SnapshotLimits.rowSummaryDepth
        )
        guard !texts.isEmpty else { return nil }
        return texts.joined(separator: " ")
    }

    func descendantTextSnippets(_ element: AXUIElement, limit: Int, maxDepth: Int) -> [String] {
        var values: [String] = []
        var seen = Set<String>()

        func collect(_ node: AXUIElement, depth: Int) {
            guard values.count < limit, depth <= maxDepth else { return }
            let role = stringAttribute(node, kAXRoleAttribute as String) ?? ""
            if role == kAXStaticTextRole as String || role == "AXLink" {
                for candidate in [
                    stringAttribute(node, kAXValueAttribute as String),
                    stringAttribute(node, kAXTitleAttribute as String),
                    stringAttribute(node, kAXDescriptionAttribute as String),
                ] {
                    guard let candidate else { continue }
                    let text = SnapshotRenderHeuristics.preview(candidate, maxLength: SnapshotLimits.snippetPreviewLength)
                    guard !text.isEmpty, seen.insert(text).inserted else { continue }
                    values.append(text)
                    if values.count >= limit { return }
                }
            }
            for child in copyArray(node, kAXChildrenAttribute as String) ?? [] {
                collect(child, depth: depth + 1)
                if values.count >= limit { return }
            }
        }

        collect(element, depth: 0)
        return values
    }

    func webAreaDepth(role: String, ancestors: [AXUIElement]) -> Int? {
        if role == "AXWebArea" { return 0 }
        guard let index = ancestors.firstIndex(where: {
            stringAttribute($0, kAXRoleAttribute as String) == "AXWebArea"
        }) else {
            return nil
        }
        return ancestors.count - index
    }

    /// Asking for the advertised attribute names once and skipping the copies
    /// that are not listed is what keeps the walk from being noticeably slow.
    private func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        let cache = cache(for: element)
        if let cached = cache.attributes[attribute] {
            switch cached {
            case .missing: return nil
            case let .found(value): return value
            }
        }
        if let advertisedAttributes = advertisedAttributes(cache),
           !SnapshotRenderHeuristics.supportsAttribute(attribute, advertisedAttributes: advertisedAttributes) {
            cache.attributes[attribute] = .missing
            return nil
        }
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value else {
            cache.attributes[attribute] = .missing
            return nil
        }
        cache.attributes[attribute] = .found(value)
        return value
    }

    private func advertisedAttributes(_ cache: ElementCache) -> Set<String>? {
        if cache.loadedAttributeNames { return cache.advertisedAttributes }
        cache.loadedAttributeNames = true
        var value: CFArray?
        guard AXUIElementCopyAttributeNames(cache.element, &value) == .success,
              let attributes = value as? [String]
        else {
            return nil
        }
        cache.advertisedAttributes = Set(attributes)
        return cache.advertisedAttributes
    }

    private func absoluteFrame(_ element: AXUIElement) -> CGRect? {
        guard let positionValue = copyAttribute(element, kAXPositionAttribute as String),
              let sizeValue = copyAttribute(element, kAXSizeAttribute as String)
        else {
            return nil
        }
        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(positionValue as! AXValue, .cgPoint, &point),
              AXValueGetValue(sizeValue as! AXValue, .cgSize, &size)
        else {
            return nil
        }
        return CGRect(origin: point, size: size)
    }

    private func visibleRows(_ rows: [AXUIElement], parent: AXUIElement, windowBounds: CGRect) -> [AXUIElement] {
        guard let parentFrame = frame(parent, windowBounds: windowBounds) else {
            return Array(rows.prefix(SnapshotLimits.maxRows))
        }
        let intersecting = rows.indices.filter { index in
            guard let rowFrame = frame(rows[index], windowBounds: windowBounds) else { return false }
            return rowFrame.intersects(parentFrame)
        }
        return SnapshotRenderHeuristics
            .visibleRowSelection(rowsIntersectingParent: intersecting, totalRows: rows.count)
            .map { rows[$0] }
    }

    private func isPlainTextSubtree(_ element: AXUIElement, maxDepth: Int) -> Bool {
        var sawText = false
        let allowedContainerRoles: Set<String> = [
            kAXGroupRole as String,
            kAXUnknownRole as String,
            kAXStaticTextRole as String,
            "AXLink",
            "AXImage",
        ]

        func visit(_ node: AXUIElement, depth: Int) -> Bool {
            guard depth <= maxDepth else { return false }
            let role = stringAttribute(node, kAXRoleAttribute as String) ?? "AXUnknown"
            guard allowedContainerRoles.contains(role) else { return false }
            if role == kAXStaticTextRole as String || role == "AXLink" {
                sawText = true
            }
            guard SnapshotRenderHeuristics.meaningfulActions(actions(node), role: role).isEmpty else { return false }
            for child in copyArray(node, kAXChildrenAttribute as String) ?? [] {
                guard visit(child, depth: depth + 1) else { return false }
            }
            return true
        }

        return visit(element, depth: 0) && sawText
    }

    private func cache(for element: AXUIElement) -> ElementCache {
        let hash = CFHash(element)
        if let cache = elementsByHash[hash]?.first(where: { CFEqual($0.element, element) }) {
            return cache
        }
        let cache = ElementCache(element: element)
        elementsByHash[hash, default: []].append(cache)
        return cache
    }
}

private let valueSettableRoles: Set<String> = [
    kAXCheckBoxRole as String,
    kAXComboBoxRole as String,
    kAXRadioButtonRole as String,
    "AXSearchField",
    kAXSliderRole as String,
    kAXTextAreaRole as String,
    kAXTextFieldRole as String,
]

struct WindowCandidate {
    let windowId: CGWindowID
    let layer: Int
    let bounds: CGRect
    let title: String?
    let alpha: CGFloat
    let isOnScreen: Bool

    var score: Int {
        var value = Int(bounds.width * bounds.height)
        if layer == 0 { value += 1_000_000_000 }
        if title?.isEmpty == false { value += 10_000_000 }
        if isOnScreen { value += 1_000_000 }
        if alpha >= 0.99 { value += 100_000 }
        return value
    }
}

struct WindowCapture {
    let windowId: CGWindowID
    let layer: Int
    let bounds: CGRect
    let title: String?
    let image: CGImage?

    static func resolve(
        candidates: [WindowCandidate],
        titleHint: String?,
        windowId: CGWindowID?,
        windowIndex: Int?,
        captureImage: Bool
    ) -> WindowCapture? {
        if let windowId {
            guard let candidate = candidates.first(where: { $0.windowId == windowId }) else { return nil }
            return WindowCapture(candidate: candidate, captureImage: captureImage)
        }
        if let windowIndex {
            let visibleWindows = candidates.filter { $0.layer == 0 }
            guard visibleWindows.indices.contains(windowIndex) else { return nil }
            return WindowCapture(candidate: visibleWindows[windowIndex], captureImage: captureImage)
        }
        guard let best = candidates.sorted(by: { lhs, rhs in
            if let titleHint, lhs.title == titleHint, rhs.title != titleHint { return true }
            if let titleHint, rhs.title == titleHint, lhs.title != titleHint { return false }
            return lhs.score > rhs.score
        }).first else {
            return nil
        }
        return WindowCapture(candidate: best, captureImage: captureImage)
    }

    /// Probing the image APIs before the TCC preflight can raise a Screen
    /// Recording prompt, even for a `--no-screenshot` call.
    private init(candidate: WindowCandidate, captureImage: Bool) {
        windowId = candidate.windowId
        layer = candidate.layer
        bounds = candidate.bounds
        title = candidate.title
        image = captureImage ? WindowCapture.captureWindowImage(candidate.windowId) : nil
    }

    /// ScreenCaptureKit is the replacement macOS advertises, but it is async and
    /// needs a running app loop per capture, which costs seconds on a helper
    /// that answers one request at a time. The deliberate deprecation warning
    /// below is the whole record of that choice, and it lives at one site.
    private static func captureWindowImage(_ windowId: CGWindowID) -> CGImage? {
        CGWindowListCreateImage(.null, [.optionIncludingWindow], windowId, [.boundsIgnoreFraming, .bestResolution])
    }

    static func candidates(pid: pid_t) -> [WindowCandidate] {
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else {
            return []
        }
        // The raw preflight, not the settling one: this decides how to read a
        // field, and a stale answer for one call costs nothing.
        let screenRecordingGranted = CGPreflightScreenCaptureAccess()
        return infos.compactMap { info in
            guard let ownerPid = info[kCGWindowOwnerPID as String] as? pid_t, ownerPid == pid,
                  let number = info[kCGWindowNumber as String] as? NSNumber,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  let boundsDictionary = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
            else {
                return nil
            }
            let alpha = info[kCGWindowAlpha as String] as? CGFloat ?? 1
            guard WindowCandidateFilter.keeps(
                width: bounds.width,
                height: bounds.height,
                alpha: alpha,
                sharingState: (info[kCGWindowSharingState as String] as? NSNumber)?.intValue,
                screenRecordingGranted: screenRecordingGranted
            ) else {
                return nil
            }
            return WindowCandidate(
                windowId: CGWindowID(number.uint32Value),
                layer: layer,
                bounds: bounds,
                title: info[kCGWindowName as String] as? String,
                alpha: alpha,
                isOnScreen: (info[kCGWindowIsOnscreen as String] as? Bool) ?? true
            )
        }
        .sorted { $0.score > $1.score }
    }

    func screenshotPayload() -> ScreenshotPayload? {
        guard let image, let bounded = boundedPngData(image) else { return nil }
        return ScreenshotPayload(
            data: bounded.data.base64EncodedString(),
            width: bounded.width,
            height: bounded.height,
            scale: Double(bounded.width) / max(Double(bounds.width), 1)
        )
    }
}

private struct BoundedPNG {
    let data: Data
    let width: Int
    let height: Int
}

private func boundedPngData(_ image: CGImage) -> BoundedPNG? {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let data = rep.representation(using: .png, properties: [:]) else { return nil }
    var best = BoundedPNG(data: data, width: image.width, height: image.height)
    if ScreenshotBoundPolicy.fits(data.count) { return best }
    for scale in ScreenshotBoundPolicy.scaleSequence(width: image.width, height: image.height) {
        guard let resized = resizePng(image, scale: CGFloat(scale)) else { break }
        best = resized
        if ScreenshotBoundPolicy.fits(resized.data.count) { return resized }
    }
    return best
}

private func resizePng(_ image: CGImage, scale: CGFloat) -> BoundedPNG? {
    let width = max(1, Int(CGFloat(image.width) * scale))
    let height = max(1, Int(CGFloat(image.height) * scale))
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
        return nil
    }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let resized = context.makeImage(),
          let data = NSBitmapImageRep(cgImage: resized).representation(using: .png, properties: [:])
    else {
        return nil
    }
    return BoundedPNG(data: data, width: width, height: height)
}

private enum Input {
    /// Clicks post to the HID event tap, not to a pid: a pid targeted mouse
    /// event reaches the app with no window association, so AppKit never routes
    /// it as a real press.
    static func click(
        at point: CGPoint,
        button: MouseButtonSelection,
        count: Int,
        modifiers: [KeyModifierName],
        targetWindow: Snapshot
    ) throws {
        guard let source = CGEventSource(stateID: .combinedSessionState) else {
            throw ProviderError(.accessibilityError, "failed to create event source")
        }
        let flags = modifiers.reduce(into: CGEventFlags()) { result, modifier in result.insert(modifier.flag) }
        let target = SyntheticMouseClickDelivery.Recipient(
            ownerPID: targetWindow.app.pid,
            windowID: targetWindow.windowId
        )
        do {
            try SyntheticMouseClickDelivery.deliver(
                clickCount: count,
                target: target,
                currentObservation: { currentSyntheticClickRecipient(snapshot: targetWindow, point: point) },
                makeEvent: { step in
                    let type: CGEventType
                    switch step {
                    case .move: type = .mouseMoved
                    case .buttonDown: type = button.downEvent
                    case .buttonUp: type = button.upEvent
                    }
                    guard let event = CGEvent(
                        mouseEventSource: source,
                        mouseType: type,
                        mouseCursorPosition: point,
                        mouseButton: button.cgButton
                    ) else {
                        throw ProviderError(.accessibilityError, "failed to create mouse event")
                    }
                    event.flags = flags
                    let clickState = SyntheticMouseClickDelivery.clickState(for: step)
                    if clickState > 0 {
                        event.setIntegerValueField(.mouseEventClickState, value: clickState)
                    }
                    return event
                },
                post: { $0.post(tap: .cghidEventTap) },
                pause: { _ = usleep($0) }
            )
        } catch let failure as SyntheticMouseClickDelivery.FenceFailure {
            switch failure {
            case let .recipientChanged(expected, actual, deliveredPresses):
                let actualDescription = actual.map { "pid \($0.ownerPID) window \($0.windowID)" } ?? "no focused window"
                let recovery = deliveredPresses == 0
                    ? "bring the target window forward, run get-app-state again, and retry"
                    : "\(deliveredPresses) press(es) may already have been delivered; run get-app-state and check the state before retrying"
                throw ProviderError(
                    .windowNotFocused,
                    "coordinate click aborted because target pid \(expected.ownerPID) window \(expected.windowID) is no longer the focused topmost recipient (current: \(actualDescription)); \(recovery)"
                )
            }
        }
    }

    static func scroll(pid: pid_t, at point: CGPoint, direction: String, pages: Double) throws {
        guard let delta = boundedInteger(max(1, (12 * pages).rounded()), as: Int32.self) else {
            throw ProviderError(.invalidArgument, "pages is out of range")
        }
        let wheel1: Int32 = direction == "up" ? delta : direction == "down" ? -delta : 0
        let wheel2: Int32 = direction == "left" ? delta : direction == "right" ? -delta : 0
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 2,
            wheel1: wheel1,
            wheel2: wheel2,
            wheel3: 0
        ) else {
            throw ProviderError(.accessibilityError, "failed to create scroll event")
        }
        event.location = point
        event.postToPid(pid)
    }

    static func typeText(_ text: String) throws {
        for unit in text.utf16 {
            var character = unit
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
            else {
                throw ProviderError(.accessibilityError, "failed to create keyboard event")
            }
            down.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
            up.keyboardSetUnicodeString(stringLength: 1, unicodeString: &character)
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
        }
    }

    /// One chord, pressed and released together. A modifier is never left held
    /// across two commands, because an interrupted agent would leave it down
    /// for the human.
    static func pressChord(_ key: String) throws {
        let parsed: ParsedKeyChord
        switch KeyChord.parse(key) {
        case let .success(value): parsed = value
        case let .failure(error): throw ProviderError(.invalidArgument, error.message)
        }
        var flags = CGEventFlags()
        var pressedModifiers: [KeyModifierName] = []
        defer {
            for modifier in pressedModifiers.reversed() {
                flags.remove(modifier.flag)
                try? keyEvent(modifier.keyCode, down: false, flags: flags)
            }
        }
        for modifier in parsed.modifiers {
            flags.insert(modifier.flag)
            try keyEvent(modifier.keyCode, down: true, flags: flags)
            pressedModifiers.append(modifier)
        }
        try keyEvent(CGKeyCode(parsed.keyCode), down: true, flags: flags)
        try keyEvent(CGKeyCode(parsed.keyCode), down: false, flags: flags)
    }

    /// The human's clipboard is not ours to keep.
    static func pasteText(_ text: String) throws {
        let pasteboard = NSPasteboard.general
        let previousItems: [NSPasteboardItem] = pasteboard.pasteboardItems?.map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) {
                    copy.setData(data, forType: type)
                }
            }
            return copy
        } ?? []
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        defer {
            pasteboard.clearContents()
            if !previousItems.isEmpty {
                pasteboard.writeObjects(previousItems)
            }
        }
        try pressChord("cmd+v")
    }

    private static func keyEvent(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags) throws {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else {
            throw ProviderError(.accessibilityError, "failed to create key event")
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }
}

private enum TextInput {
    static func replaceSelection(_ element: AXUIElement, with text: String) -> [String: Any]? {
        guard isSettable(element, kAXValueAttribute as String),
              let current = rawStringAttribute(element, kAXValueAttribute as String)
        else {
            return nil
        }
        let selectedRange = selectedTextRange(element) ?? CFRange(location: current.utf16.count, length: 0)
        let startOffset = max(0, min(selectedRange.location, current.utf16.count))
        let endOffset = max(startOffset, min(startOffset + selectedRange.length, current.utf16.count))
        let start = String.Index(utf16Offset: startOffset, in: current)
        let end = String.Index(utf16Offset: endOffset, in: current)
        let next = String(current[..<start]) + text + String(current[end...])
        guard AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, next as CFString) == .success else {
            return nil
        }
        setSelectedTextRange(element, CFRange(location: startOffset + text.utf16.count, length: 0))
        guard rawStringAttribute(element, kAXValueAttribute as String) == next else { return nil }
        return verifiedAction(
            property: "focusedText",
            expected: text,
            actualPreview: SnapshotRenderHeuristics.preview(next)
        )
    }

    static func selectAll(_ element: AXUIElement) -> Bool {
        guard let current = rawStringAttribute(element, kAXValueAttribute as String) else { return false }
        return setSelectedTextRange(element, CFRange(location: 0, length: current.utf16.count))
    }

    static func selectionVerification(_ element: AXUIElement) -> [String: Any] {
        guard let current = rawStringAttribute(element, kAXValueAttribute as String),
              let selectedRange = selectedTextRange(element),
              selectedRange.location == 0,
              selectedRange.length == current.utf16.count
        else {
            return unverifiedAction(reason: "provider_unavailable")
        }
        return verifiedAction(property: "selection", actualPreview: SnapshotRenderHeuristics.preview(current))
    }

    private static func selectedTextRange(_ element: AXUIElement) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &value) == .success,
              let value,
              CFGetTypeID(value) == AXValueGetTypeID()
        else {
            return nil
        }
        var range = CFRange(location: 0, length: 0)
        guard AXValueGetValue(value as! AXValue, .cfRange, &range) else { return nil }
        return range
    }

    @discardableResult
    private static func setSelectedTextRange(_ element: AXUIElement, _ range: CFRange) -> Bool {
        var mutableRange = range
        guard let value = AXValueCreate(.cfRange, &mutableRange) else { return false }
        return AXUIElementSetAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, value) == .success
    }
}

@MainActor
private final class AgentRuntime: NSObject, NSApplicationDelegate {
    private let socketPath: String
    private let token: String
    private var listener: SocketListener?
    private var unclaimedTimeout: DispatchWorkItem?
    private var idleTimeout: DispatchWorkItem?

    init(socketPath: String, token: String) {
        self.socketPath = socketPath
        self.token = token
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let timeout = DispatchWorkItem {
                fputs("\(ComputerHelperLifetime.unclaimedMessage)\n", stderr)
                NSApp.terminate(nil)
            }
            unclaimedTimeout = timeout
            let listener = try SocketListener(
                socketPath: socketPath,
                token: token,
                onSessionClaimed: { [weak self] in
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated {
                            timeout.cancel()
                            self?.cancelIdleTimeout()
                        }
                    }
                },
                onSessionDrained: { [weak self] in
                    DispatchQueue.main.async {
                        MainActor.assumeIsolated { self?.startIdleTimeout() }
                    }
                }
            )
            self.listener = listener
            listener.start()
            DispatchQueue.main.asyncAfter(deadline: .now() + ComputerHelperLifetime.unclaimedDeadline, execute: timeout)
        } catch let error as ProviderError {
            fputs("failed to start the computer helper socket: \(error.message)\n", stderr)
            NSApp.terminate(nil)
        } catch {
            fputs("failed to start the computer helper socket: \(error)\n", stderr)
            NSApp.terminate(nil)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        unclaimedTimeout?.cancel()
        unclaimedTimeout = nil
        cancelIdleTimeout()
        listener?.stop()
    }

    /// The helper outlives its last connection by exactly the snapshot cache
    /// age, so the indexes it handed out stay valid for a reconnecting CLI and
    /// not one second longer.
    private func startIdleTimeout() {
        cancelIdleTimeout()
        let timeout = DispatchWorkItem { MainActor.assumeIsolated { NSApp.terminate(nil) } }
        idleTimeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + ComputerHelperLifetime.idleDeadline, execute: timeout)
    }

    private func cancelIdleTimeout() {
        idleTimeout?.cancel()
        idleTimeout = nil
    }
}

private final class SocketListener: @unchecked Sendable {
    private let socketPath: String
    private let token: String
    private let onSessionClaimed: () -> Void
    private let onSessionDrained: () -> Void
    private let provider = Provider()
    private let providerLock = NSLock()
    private let sessionLock = NSLock()
    private var sessionOwnership = AgentSessionOwnership()
    private var lastConnectionID: UInt64 = 0
    private var castBinary: String?
    private var socketFd: Int32 = -1
    private var isStopped = false

    init(
        socketPath: String,
        token: String,
        onSessionClaimed: @escaping () -> Void,
        onSessionDrained: @escaping () -> Void
    ) throws {
        self.socketPath = socketPath
        self.token = token
        self.onSessionClaimed = onSessionClaimed
        self.onSessionDrained = onSessionDrained
        try bindSocket()
    }

    func start() {
        Thread.detachNewThread { [weak self] in self?.acceptLoop() }
    }

    func stop() {
        isStopped = true
        if socketFd >= 0 {
            close(socketFd)
            socketFd = -1
        }
        // The client owns the private temp directory and its cleanup. The helper
        // never unlinks a caller supplied path.
    }

    private func bindSocket() throws {
        socketFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard socketFd >= 0 else {
            throw ProviderError(.accessibilityError, "failed to create the computer socket")
        }

        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let maxPathLength = MemoryLayout.size(ofValue: address.sun_path)
        guard socketPath.utf8.count < maxPathLength else {
            throw ProviderError(.invalidArgument, "computer socket path is too long")
        }
        _ = withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            socketPath.withCString { source in
                strncpy(UnsafeMutableRawPointer(pointer).assumingMemoryBound(to: CChar.self), source, maxPathLength)
            }
        }

        let result = withUnsafePointer(to: &address) { pointer -> Int32 in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sockaddrPointer in
                bind(socketFd, sockaddrPointer, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else {
            let bindErrno = errno
            let message = String(cString: strerror(bindErrno))
            close(socketFd)
            socketFd = -1
            if UnixSocketPathSafety.shouldRejectExistingPathAfterBindFailure(
                bindErrno: bindErrno,
                existingMode: existingPathMode(socketPath)
            ) {
                throw ProviderError(.invalidArgument, "refusing to replace a non socket file at the computer socket path")
            }
            throw ProviderError(.accessibilityError, "failed to bind the computer socket: \(message)")
        }
        chmod(socketPath, 0o600)

        guard listen(socketFd, 8) == 0 else {
            let message = String(cString: strerror(errno))
            close(socketFd)
            socketFd = -1
            throw ProviderError(.accessibilityError, "failed to listen on the computer socket: \(message)")
        }
    }

    private func acceptLoop() {
        while !isStopped {
            let fd = accept(socketFd, nil, nil)
            if fd < 0 {
                if !isStopped {
                    fputs("computer socket accept failed: \(String(cString: strerror(errno)))\n", stderr)
                }
                continue
            }
            guard let connectionID = allocateConnectionID() else {
                fputs("computer socket exhausted connection identities\n", stderr)
                close(fd)
                continue
            }
            Thread.detachNewThread { [weak self] in self?.handleConnection(fd, connectionID: connectionID) }
        }
    }

    private func allocateConnectionID() -> AgentSessionConnectionID? {
        sessionLock.lock()
        defer { sessionLock.unlock() }
        guard lastConnectionID < UInt64.max else { return nil }
        lastConnectionID += 1
        return AgentSessionConnectionID(rawValue: lastConnectionID)
    }

    private func handleConnection(_ fd: Int32, connectionID: AgentSessionConnectionID) {
        var registeredSession = false
        var hangupMonitor: AuthenticatedConnectionHangupMonitor?
        defer {
            hangupMonitor?.cancel()
            if registeredSession {
                disconnectSession(connectionID)
            }
            close(fd)
        }
        let peer = peerProcessId(fd).map(describePeer)
        let decoder = JSONDecoder()
        while let line = readLine(from: fd) {
            guard let data = line.data(using: .utf8),
                  let request = try? decoder.decode(Request.self, from: data)
            else {
                continue
            }
            let verdict = authorize(request: request, peer: peer)
            if verdict == .authorized, !registeredSession {
                let monitor: AuthenticatedConnectionHangupMonitor
                do {
                    monitor = try AuthenticatedConnectionHangupMonitor(
                        fileDescriptor: fd,
                        onHangup: { [weak self] in self?.disconnectSession(connectionID) }
                    )
                } catch {
                    fputs("computer helper hangup monitor failed: \(error)\n", stderr)
                    return
                }
                sessionLock.lock()
                let registration = sessionOwnership.registerConnection(connectionID, authenticated: true)
                sessionLock.unlock()
                guard registration != .rejected else {
                    monitor.cancel()
                    return
                }
                registeredSession = true
                hangupMonitor = monitor
                monitor.start()
                if registration == .claimed {
                    onSessionClaimed()
                }
            }
            writeJSON(respond(to: request, verdict: verdict), to: fd)
        }
    }

    /// The peer's identity is checked on every request, not only at the
    /// handshake: a valid token from an unexpected process is still refused.
    private func authorize(request: Request, peer: SocketHandshake.Peer?) -> SocketHandshake.Verdict {
        sessionLock.lock()
        let recorded = castBinary
        sessionLock.unlock()
        // Resolved on both sides, because the peer path comes back resolved and
        // a caller's own path routinely runs through a symlinked bin directory.
        let claimed = request.params?["castBinary"]?.string.map(resolvedPath)
        let verdict = SocketHandshake.evaluate(
            expectedToken: token,
            requestToken: request.token,
            peer: peer,
            castBinary: recorded ?? claimed,
            daemonPid: daemonPid()
        )
        if verdict == .authorized, recorded == nil, let claimed, !claimed.isEmpty {
            sessionLock.lock()
            castBinary = claimed
            sessionLock.unlock()
        }
        return verdict
    }

    private func respond(to request: Request, verdict: SocketHandshake.Verdict) -> Any {
        if let code = verdict.errorCode {
            return [
                "id": request.id,
                "ok": false,
                "error": ["code": code.rawValue, "message": verdict.message ?? ""],
            ]
        }
        if request.method == "terminate" {
            DispatchQueue.main.async { NSApp.terminate(nil) }
            return ["id": request.id, "ok": true, "result": ["ok": true]]
        }
        do {
            providerLock.lock()
            defer { providerLock.unlock() }
            let result = try provider.handle(method: request.method, params: request.params ?? [:])
            return ["id": request.id, "ok": true, "result": result]
        } catch let error as ProviderError {
            return ["id": request.id, "ok": false, "error": ["code": error.code.rawValue, "message": error.message]]
        } catch {
            return [
                "id": request.id,
                "ok": false,
                "error": ["code": ComputerErrorCode.accessibilityError.rawValue, "message": String(describing: error)],
            ]
        }
    }

    private func disconnectSession(_ connectionID: AgentSessionConnectionID) {
        sessionLock.lock()
        let drained = sessionOwnership.disconnect(connectionID)
        sessionLock.unlock()
        if drained {
            onSessionDrained()
        }
    }
}

private func existingPathMode(_ path: String) -> mode_t? {
    var statInfo = stat()
    guard lstat(path, &statInfo) == 0 else { return nil }
    return statInfo.st_mode
}

private func peerProcessId(_ fd: Int32) -> pid_t? {
    var pid = pid_t(0)
    var length = socklen_t(MemoryLayout<pid_t>.size)
    // SOL_LOCAL is 0 and LOCAL_PEERPID is 2; neither is exposed to Swift.
    let result = withUnsafeMutablePointer(to: &pid) { pointer in
        getsockopt(fd, 0, 2, pointer, &length)
    }
    return result == 0 && pid > 0 ? pid : nil
}

/// Four hops covers a tmux pane shell sitting between the daemon and the CLI.
private func describePeer(_ pid: pid_t) -> SocketHandshake.Peer {
    var chain: [pid_t] = []
    var current = pid
    for _ in 0..<SocketHandshake.maxParentHops {
        guard let parent = parentProcessId(current), parent > 1 else { break }
        chain.append(parent)
        current = parent
    }
    return SocketHandshake.Peer(executablePath: executablePath(of: pid), parentChain: chain)
}

/// The design reads this with `ps -p <pid> -o comm=`, which prints argv[0] and
/// so answers "cast" rather than a path whenever the binary was invoked by name
/// off PATH. `proc_pidpath` always answers the resolved executable, which is
/// what the check is actually about, and it costs no subprocess.
private func executablePath(of pid: pid_t) -> String? {
    var buffer = [UInt8](repeating: 0, count: Int(MAXPATHLEN) * 4)
    let length = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    guard length > 0 else { return nil }
    return resolvedPath(String(decoding: buffer.prefix(Int(length)), as: UTF8.self))
}

private func resolvedPath(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().path
}

/// One sysctl per hop instead of one `/bin/ps` per hop, because this walk runs
/// on every request and a fork storm under load is a real cost.
private func parentProcessId(_ pid: pid_t) -> pid_t? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&name, 4, &info, &size, nil, 0) == 0, size > 0 else { return nil }
    let parentPid = info.kp_eproc.e_ppid
    return parentPid > 1 ? parentPid : nil
}

private func daemonPid() -> pid_t? {
    let path = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codecast/daemon.pid")
    guard let text = try? String(contentsOf: path, encoding: .utf8),
          let pid = pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)),
          pid > 1
    else {
        return nil
    }
    return pid
}

private func readLine(from fd: Int32) -> String? {
    var bytes: [UInt8] = []
    var byte: UInt8 = 0
    while true {
        let count = read(fd, &byte, 1)
        if count == 0 {
            return bytes.isEmpty ? nil : String(bytes: bytes, encoding: .utf8)
        }
        if count < 0 {
            return nil
        }
        if byte == 10 {
            return String(bytes: bytes, encoding: .utf8)
        }
        bytes.append(byte)
    }
}

private func writeJSON(_ object: Any, to fd: Int32) {
    guard JSONSerialization.isValidJSONObject(object),
          let data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
    else {
        return
    }
    _ = writeAll(data, to: fd)
    _ = writeAll(Data([10]), to: fd)
}

private func writeAll(_ data: Data, to fd: Int32) -> Bool {
    data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else { return true }
        var offset = 0
        while offset < rawBuffer.count {
            let written = write(fd, baseAddress.advanced(by: offset), rawBuffer.count - offset)
            if written < 0 {
                if errno == EINTR { continue }
                return false
            }
            if written == 0 { return false }
            offset += written
        }
        return true
    }
}

private enum PermissionKind {
    case accessibility
    case screenshots

    static func parse(_ value: String?) -> PermissionKind? {
        switch value {
        case "accessibility": return .accessibility
        case "screenshots", "screen", "screen-recording": return .screenshots
        default: return nil
        }
    }

    var title: String {
        switch self {
        case .accessibility: return "Accessibility"
        case .screenshots: return "Screen Recording"
        }
    }

    var instruction: String {
        switch self {
        case .accessibility:
            return "Add codecast computer to the Accessibility list in System Settings, then turn it on. Reveal the helper below and drag it into the list if it is not already there."
        case .screenshots:
            return "Add codecast computer to the Screen Recording list in System Settings, then turn it on. Reveal the helper below and drag it into the list if it is not already there."
        }
    }

    var settingsURL: String {
        switch self {
        case .accessibility:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .screenshots:
            return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        }
    }

    func requestAndOpenSettings() {
        if self == .screenshots {
            _ = CGRequestScreenCaptureAccess()
        }
        openSystemSettings(settingsURL)
    }
}

/// The setup window: the System Settings pane, plus the one instruction the
/// human needs and a way to reach the helper the list wants dragged into it.
private final class PermissionRuntime: NSObject, NSApplicationDelegate {
    private let kinds: [PermissionKind]
    private var window: NSWindow?

    init(kinds: [PermissionKind]) {
        self.kinds = kinds
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)

        let heading = NSTextField(labelWithString: "codecast computer needs \(kinds.map(\.title).joined(separator: " and "))")
        heading.font = .boldSystemFont(ofSize: 15)
        stack.addArrangedSubview(heading)

        for kind in kinds {
            let detail = NSTextField(wrappingLabelWithString: kind.instruction)
            detail.preferredMaxLayoutWidth = 420
            stack.addArrangedSubview(detail)
            kind.requestAndOpenSettings()
        }

        let reveal = NSButton(title: "Reveal codecast computer in Finder", target: self, action: #selector(revealHelper))
        stack.addArrangedSubview(reveal)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 220),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "codecast computer"
        window.contentView = stack
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func revealHelper() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }
}

@MainActor
private func runAgent(socketPath: String, token: String) {
    let app = NSApplication.shared
    let delegate = AgentRuntime(socketPath: socketPath, token: token)
    app.delegate = delegate
    app.run()
}

@MainActor
private func runPermissionSetup(kinds: [PermissionKind]) {
    let app = NSApplication.shared
    let delegate = PermissionRuntime(kinds: kinds)
    app.delegate = delegate
    // Setup must foreground reliably; the long lived agent stays accessory only.
    app.setActivationPolicy(.regular)
    app.run()
}

private func writePermissionStatus(to path: String) {
    let snapshot = permissionStatusSnapshotSettled()
    let accessibility = snapshot.accessibilityGranted ? "granted" : "not-granted"
    let screenshots = snapshot.screenshotsGranted ? "granted" : "not-granted"
    let text = #"{"accessibility":"\#(accessibility)","screenshots":"\#(screenshots)"}"#
    do {
        try text.write(toFile: path, atomically: true, encoding: .utf8)
    } catch {
        fputs("failed to write the permission status: \(error)\n", stderr)
        exit(1)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
switch arguments.first {
case "--agent":
    guard arguments.count >= 2 else {
        fputs("usage: codecast-computer --agent <socket-path> --token-file <token-path>\n", stderr)
        exit(2)
    }
    let token = arguments.firstIndex(of: "--token-file").flatMap { index -> String? in
        let valueIndex = index + 1
        guard valueIndex < arguments.count else { return nil }
        return try? String(contentsOfFile: arguments[valueIndex], encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard let token, !token.isEmpty else {
        fputs("codecast-computer --agent requires a non-empty --token-file\n", stderr)
        exit(2)
    }
    runAgent(socketPath: arguments[1], token: token)
case "--permissions":
    runPermissionSetup(kinds: [.accessibility, .screenshots])
case "--permission":
    guard let kind = PermissionKind.parse(arguments.dropFirst().first) else {
        fputs("--permission must be \"accessibility\" or \"screenshots\"\n", stderr)
        exit(2)
    }
    runPermissionSetup(kinds: [kind])
case "--permission-status-file":
    guard arguments.count >= 2 else {
        fputs("usage: codecast-computer --permission-status-file <path>\n", stderr)
        exit(2)
    }
    writePermissionStatus(to: arguments[1])
default:
    fputs("the codecast computer helper is launched by `cast computer`, not by hand\n", stderr)
    exit(13)
}
