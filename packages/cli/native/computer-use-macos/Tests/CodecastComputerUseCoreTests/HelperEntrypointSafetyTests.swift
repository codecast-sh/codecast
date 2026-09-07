import XCTest

/// The rules below are properties of the executable that no unit test on the
/// Core module can reach, and each one is a bug the design names by hand.
final class HelperEntrypointSafetyTests: XCTestCase {
    func testTheHelperNeverUnlinksACallerSuppliedPath() throws {
        let source = try helperSource()

        // `--agent` takes paths from its caller; deleting them here would remove
        // a user file if argument validation were ever bypassed.
        XCTAssertFalse(source.contains("unlink("))
    }

    func testThePermissionPreflightCannotRequestOrCaptureTheScreen() throws {
        let source = try helperSource()
        let start = try XCTUnwrap(source.range(of: "private func screenCaptureTrustedSettled()"))
        let end = try XCTUnwrap(
            source.range(of: "private func permissionStatusSnapshotSettled()", range: start.upperBound..<source.endIndex)
        )
        let preflight = source[start.lowerBound..<end.lowerBound]

        XCTAssertTrue(preflight.contains("CGPreflightScreenCaptureAccess()"))
        XCTAssertTrue(preflight.contains("timeoutMs: 2_000"))
        XCTAssertFalse(preflight.contains("CGRequestScreenCaptureAccess()"))
        XCTAssertFalse(preflight.contains("CGWindowListCreateImage"))
    }

    /// Only `--restore-window` may raise a window, and the setup flow may open
    /// System Settings. Nothing else in the helper takes the human's screen.
    func testTheOnlyRaiseSiteIsTheRestoreWindowFlag() throws {
        let source = try helperSource()

        // The definition, the `restoreWindow` branch in `observe`, and the
        // recovery inside `focusedWindow`, which only runs when the flag is set.
        XCTAssertEqual(source.components(separatedBy: "raiseWindow(").count - 1, 3)
        XCTAssertTrue(compact(try region(of: "private func observe(", until: "private func rememberSnapshot("))
            .contains("if restoreWindow { raiseWindow(app) }"))
        XCTAssertTrue(source.contains("allowRecovery: restoreWindow"))
        XCTAssertTrue(compact(try region(of: "private func focusedWindow(", until: "private func lookupUsableWindow("))
            .contains("if allowRecovery { raiseWindow(app)"))
    }

    func testAClickNeverRaisesTheTargetWindow() throws {
        let click = try region(of: "private func click(params:", until: "private func performClickAction(")

        XCTAssertFalse(click.contains("raiseWindow"))
        XCTAssertTrue(click.contains("requireTargetWindowFocused"))
    }

    func testTheDragVerbDoesNotExist() throws {
        let source = try helperSource()

        XCTAssertFalse(source.contains("case \"drag\":"))
        XCTAssertFalse(source.contains("func drag("))
    }

    /// An interrupted agent must never leave a modifier logically held for the
    /// human, so the release rides a defer rather than the happy path.
    func testSyntheticModifiersAreAlwaysReleased() throws {
        let chord = compact(try region(of: "static func pressChord(", until: "static func pasteText("))

        XCTAssertTrue(chord.contains("var pressedModifiers: [KeyModifierName] = []"))
        XCTAssertTrue(chord.contains(
            "defer { for modifier in pressedModifiers.reversed() { flags.remove(modifier.flag) try? keyEvent(modifier.keyCode, down: false, flags: flags) } }"
        ))
    }

    /// A pid targeted mouse event reaches the app with no window association,
    /// so AppKit never routes it as a real press.
    func testClicksPostToTheHidEventTap() throws {
        let click = try region(of: "static func click(", until: "static func scroll(")

        XCTAssertTrue(click.contains("post(tap: .cghidEventTap)"))
        XCTAssertFalse(click.contains("postToPid"))
    }

    func testPasteRestoresTheClipboard() throws {
        let paste = try region(of: "static func pasteText(", until: "private static func keyEvent(")

        XCTAssertTrue(paste.contains("previousItems"))
        XCTAssertTrue(paste.contains("defer {"))
        XCTAssertTrue(paste.contains("pasteboard.writeObjects(previousItems)"))
    }

    private func region(of start: String, until end: String) throws -> String {
        let source = try helperSource()
        let startRange = try XCTUnwrap(source.range(of: start), "missing \(start)")
        let endRange = try XCTUnwrap(
            source.range(of: end, range: startRange.upperBound..<source.endIndex),
            "missing \(end)"
        )
        return String(source[startRange.lowerBound..<endRange.lowerBound])
    }

    /// Collapse indentation so an assertion pins the code rather than its layout.
    private func compact(_ source: String) -> String {
        source.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }

    private func helperSource() throws -> String {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot
                .appendingPathComponent("Sources")
                .appendingPathComponent("CodecastComputerUse")
                .appendingPathComponent("main.swift"),
            encoding: .utf8
        )
    }
}
