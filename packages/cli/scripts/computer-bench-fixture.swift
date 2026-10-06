import AppKit

// The app `computer-bench.ts` drives. Every control is standard AppKit, so what
// the helper reads here is what it reads in a real app, and the app writes its
// own state to a file so a result is checked against the app rather than
// against the helper's account of it.
//
// It never activates and orders its windows to the back: a benchmark that took
// the front would measure the human's reaction as well.
//
//   fixture --status-file <path> [--barren]
//
// Windows: "Bench Form" (fields, a checkbox, a popup, three ways to open a
// sheet), "Bench Table" (2000 rows) and "Bench Canvas" (text drawn as pixels,
// with no accessibility element behind it). `--barren` opens the canvas alone,
// which is an app whose tree offers nothing to act on.

final class CanvasView: NSView {
    var onClick: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.boldSystemFont(ofSize: 28),
            .foregroundColor: NSColor.black,
        ]
        ("CANVAS HELLO 4271" as NSString).draw(at: NSPoint(x: 24, y: bounds.height - 60), withAttributes: attributes)
    }

    override func isAccessibilityElement() -> Bool { false }
    override func mouseDown(with event: NSEvent) { onClick?() }
}

/// A button whose label exists only as pixels: no title and no description, so
/// the tree has a press with no name and the words are only readable by eye.
final class PixelButton: NSButton {
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.92, alpha: 1).setFill()
        bounds.fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.boldSystemFont(ofSize: 22),
            .foregroundColor: NSColor.black,
        ]
        ("LAUNCH PROBE" as NSString).draw(at: NSPoint(x: 16, y: 14), withAttributes: attributes)
    }

    override func accessibilityLabel() -> String? { nil }
    override func accessibilityTitle() -> String? { nil }
}

final class Fixture: NSObject, NSApplicationDelegate, NSTableViewDataSource, NSTableViewDelegate {
    let statusFile: String?
    let barren: Bool
    var windows: [NSWindow] = []
    let nameField = NSTextField(string: "")
    let emailField = NSTextField(string: "")
    let subscribe = NSButton(checkboxWithTitle: "Subscribe", target: nil, action: nil)
    let plan = NSPopUpButton(frame: .zero, pullsDown: false)
    let statusLabel = NSTextField(labelWithString: "Status: idle")
    var submissions = 0
    var canvasClicks = 0
    var probeLaunches = 0
    var sheetOpen = false
    /// Every time the app took the front, and what had just happened.
    var activations: [String] = []
    var lastEvent = "launch"
    /// Ticks (20 ms apart) in which the helper's agent cursor was on screen
    /// while the form window was covered by another app, and was not.
    var cursorWhileCovered = 0
    var cursorWhileVisible = 0
    /// Presses that reached a control while the sheet covered it.
    var blockedPresses = 0

    init(statusFile: String?, barren: Bool) {
        self.statusFile = statusFile
        self.barren = barren
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if !barren {
            windows.append(makeFormWindow())
            windows.append(makeTableWindow())
        }
        windows.append(makeCanvasWindow())
        if !barren { windows.append(makeFloatWindow()) }
        for window in windows where window.level == .normal { window.orderBack(nil) }
        for window in windows where window.level == .floating { window.orderFrontRegardless() }
        Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.watchCursor() }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            activations.append(lastEvent)
            writeStatus()
        }
        writeStatus()
        let ids = windows.map { "\($0.title)=\($0.windowNumber)" }.joined(separator: ",")
        print("READY pid=\(ProcessInfo.processInfo.processIdentifier) windows=\(ids)")
        fflush(stdout)
    }

    private func place(_ window: NSWindow, slot: Int) {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let origin = NSPoint(x: screen.maxX - window.frame.width - 20 - CGFloat(slot) * 30, y: screen.minY + 20 + CGFloat(slot) * 30)
        window.setFrameOrigin(origin)
    }

    private func makeWindow(title: String, size: NSSize, slot: Int) -> NSWindow {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = title
        window.isReleasedWhenClosed = false
        place(window, slot: slot)
        return window
    }

    private func row(_ label: String, _ control: NSView) -> NSView {
        let title = NSTextField(labelWithString: label)
        title.widthAnchor.constraint(equalToConstant: 80).isActive = true
        control.widthAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
        let stack = NSStackView(views: [title, control])
        stack.orientation = .horizontal
        return stack
    }

    private func makeFormWindow() -> NSWindow {
        let window = makeWindow(title: "Bench Form", size: NSSize(width: 420, height: 360), slot: 0)
        nameField.setAccessibilityLabel("Name")
        emailField.setAccessibilityLabel("Email")
        nameField.target = self
        nameField.action = #selector(fieldChanged)
        emailField.target = self
        emailField.action = #selector(fieldChanged)
        subscribe.target = self
        subscribe.action = #selector(fieldChanged)
        plan.addItems(withTitles: ["Free", "Pro", "Team"])
        plan.setAccessibilityLabel("Plan")
        plan.target = self
        plan.action = #selector(fieldChanged)

        let submit = NSButton(title: "Submit", target: self, action: #selector(submitNow))
        let slow = NSButton(title: "Submit after 300ms", target: self, action: #selector(submitSoon))
        let slower = NSButton(title: "Submit after 800ms", target: self, action: #selector(submitLater))
        let arm = NSButton(title: "Arm sheet in 400ms", target: self, action: #selector(submitArmed))
        let quiet = NSButton(title: "Count quietly", target: self, action: #selector(countQuietly))

        let stack = NSStackView(views: [
            row("Name", nameField),
            row("Email", emailField),
            subscribe,
            row("Plan", plan),
            NSStackView(views: [submit, slow]),
            NSStackView(views: [slower, arm]),
            quiet,
            statusLabel,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        window.contentView = stack
        return window
    }

    private func makeTableWindow() -> NSWindow {
        let window = makeWindow(title: "Bench Table", size: NSSize(width: 420, height: 320), slot: 1)
        let table = NSTableView()
        for (identifier, title) in [("name", "Name"), ("value", "Value")] {
            let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(identifier))
            column.title = title
            column.width = 180
            table.addTableColumn(column)
        }
        table.dataSource = self
        table.delegate = self
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 320))
        scroll.documentView = table
        scroll.hasVerticalScroller = true
        window.contentView = scroll
        return window
    }

    private func makeCanvasWindow() -> NSWindow {
        let window = makeWindow(title: "Bench Canvas", size: NSSize(width: 420, height: 200), slot: 2)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 200))
        let canvas = CanvasView(frame: NSRect(x: 0, y: 80, width: 420, height: 120))
        canvas.onClick = { [weak self] in
            self?.canvasClicks += 1
            self?.writeStatus()
        }
        content.addSubview(canvas)
        let probe = PixelButton(frame: NSRect(x: 24, y: 16, width: 220, height: 52))
        probe.isBordered = false
        probe.title = ""
        probe.target = self
        probe.action = #selector(launchProbe)
        content.addSubview(probe)
        window.contentView = content
        return window
    }

    /// Above every normal window, so the agent cursor has somewhere it should
    /// show. Floating, so it never takes the front or the keyboard.
    private func makeFloatWindow() -> NSWindow {
        let window = makeWindow(title: "Bench Float", size: NSSize(width: 220, height: 80), slot: 6)
        window.level = .floating
        let button = NSButton(title: "Float press", target: self, action: #selector(launchProbe))
        button.frame = NSRect(x: 40, y: 20, width: 140, height: 32)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 220, height: 80))
        content.addSubview(button)
        window.contentView = content
        return window
    }

    func numberOfRows(in tableView: NSTableView) -> Int { 2000 }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let text = tableColumn?.identifier.rawValue == "name" ? "Row \(row + 1)" : "Value \(row + 1)"
        let cell = NSTableCellView()
        let field = NSTextField(labelWithString: text)
        field.translatesAutoresizingMaskIntoConstraints = false
        cell.addSubview(field)
        cell.textField = field
        NSLayoutConstraint.activate([
            field.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 4),
            field.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    @objc private func fieldChanged() { writeStatus() }
    @objc private func submitNow() { openSheet(after: 0) }
    @objc private func submitSoon() { openSheet(after: 0.3) }
    @objc private func submitLater() { openSheet(after: 0.8) }
    @objc private func submitArmed() { openSheet(after: 0.4) }

    /// Changes a label through the control's own setter and nothing else, which
    /// is how an app updates text without thinking about accessibility.
    @objc private func countQuietly() {
        probeLaunches += 1
        statusLabel.stringValue = "Status: counted \(probeLaunches)"
        writeStatus()
    }

    @objc private func launchProbe() {
        probeLaunches += 1
        writeStatus()
    }

    private func openSheet(after delay: TimeInterval) {
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [self] in
            guard let window = windows.first else { return }
            guard !sheetOpen else {
                blockedPresses += 1
                writeStatus()
                return
            }
            sheetOpen = true
            writeStatus()
            let alert = NSAlert()
            alert.messageText = "Send this form?"
            alert.informativeText = "Nothing leaves this machine."
            alert.addButton(withTitle: "Confirm")
            alert.addButton(withTitle: "Cancel")
            alert.beginSheetModal(for: window) { [self] response in
                sheetOpen = false
                if response == .alertFirstButtonReturn {
                    submissions += 1
                    statusLabel.stringValue = "Status: submitted \(submissions)"
                }
                writeStatus()
            }
        }
    }

    /// Where the agent cursor's tip is while it shows, and whether the app
    /// under it there is this one: a cursor drawn over another app's window
    /// points at something the agent is not touching.
    private func watchCursor() {
        guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]],
              let panel = infos.first(where: {
                  ($0[kCGWindowOwnerName as String] as? String ?? "").lowercased().contains("codecast computer") &&
                      ($0[kCGWindowAlpha as String] as? CGFloat ?? 0) > 0.01
              }),
              let panelBounds = (panel[kCGWindowBounds as String] as? NSDictionary).flatMap({ CGRect(dictionaryRepresentation: $0) })
        else { return }
        // The tip sits 6 points in from the panel's left and top.
        let tip = CGPoint(x: panelBounds.minX + 6, y: panelBounds.minY + 6)
        let under = infos.first {
            guard ($0[kCGWindowOwnerPID as String] as? pid_t) != (panel[kCGWindowOwnerPID as String] as? pid_t),
                  let dictionary = $0[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dictionary) else { return false }
            return bounds.contains(tip) && (($0[kCGWindowLayer as String] as? Int ?? 1) == 0 || ($0[kCGWindowOwnerPID as String] as? pid_t) == ProcessInfo.processInfo.processIdentifier)
        }
        if (under?[kCGWindowOwnerPID as String] as? pid_t) == ProcessInfo.processInfo.processIdentifier {
            cursorWhileVisible += 1
        } else {
            cursorWhileCovered += 1
        }
        writeStatus()
    }

    private func writeStatus() {
        guard let statusFile else { return }
        lastEvent = "after submissions=\(submissions) launches=\(probeLaunches) sheet=\(sheetOpen) subscribe=\(subscribe.state == .on)"
        let state: [String: Any] = [
            "name": nameField.stringValue,
            "email": emailField.stringValue,
            "subscribe": subscribe.state == .on,
            "plan": plan.titleOfSelectedItem ?? "",
            "submissions": submissions,
            "sheetOpen": sheetOpen,
            "blockedPresses": blockedPresses,
            "canvasClicks": canvasClicks,
            "probeLaunches": probeLaunches,
            "active": NSApp.isActive,
            "activations": activations,
            "cursorWhileCovered": cursorWhileCovered,
            "cursorWhileVisible": cursorWhileVisible,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) else { return }
        try? data.write(to: URL(fileURLWithPath: statusFile), options: .atomic)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
let statusFile = arguments.firstIndex(of: "--status-file").flatMap { index in
    index + 1 < arguments.count ? arguments[index + 1] : nil
}
let app = NSApplication.shared
let delegate = Fixture(statusFile: statusFile, barren: arguments.contains("--barren"))
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
