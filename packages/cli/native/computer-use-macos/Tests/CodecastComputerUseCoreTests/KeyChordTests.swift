import XCTest
@testable import CodecastComputerUseCore

final class KeyChordTests: XCTestCase {
    func testParsesASingleKey() throws {
        let parsed = try XCTUnwrap(try? KeyChord.parse("Return").get())

        XCTAssertEqual(parsed.keyCode, 36)
        XCTAssertTrue(parsed.modifiers.isEmpty)
    }

    func testParsesAChordAsOneUnit() throws {
        let parsed = try XCTUnwrap(try? KeyChord.parse("CmdOrCtrl+Shift+P").get())

        XCTAssertEqual(parsed.keyCode, 35)
        XCTAssertEqual(parsed.modifiers, [.command, .shift])
    }

    func testEveryModifierSpellingMapsToTheSameKey() {
        for spelling in ["cmd", "command", "meta", "super", "win", "cmdorctrl", "commandorcontrol"] {
            XCTAssertEqual(KeyChord.modifier(spelling), .command, spelling)
        }
        XCTAssertEqual(KeyChord.modifier("ctrl"), .control)
        XCTAssertEqual(KeyChord.modifier("control"), .control)
        XCTAssertEqual(KeyChord.modifier("alt"), .option)
        XCTAssertEqual(KeyChord.modifier("option"), .option)
        XCTAssertEqual(KeyChord.modifier("shift"), .shift)
        XCTAssertNil(KeyChord.modifier("hyper"))
    }

    func testAnUnknownKeyIsRefusedByName() {
        guard case let .failure(error) = KeyChord.parse("Frobnicate") else {
            return XCTFail("expected a failure")
        }
        XCTAssertEqual(error.message, "unsupported key 'Frobnicate'")
    }

    func testClickModifiersAcceptModifiersOnly() {
        XCTAssertEqual(try? KeyChord.parseModifiers("CmdOrCtrl+Shift").get(), [.command, .shift])
        XCTAssertEqual(try? KeyChord.parseModifiers(nil).get(), [])

        guard case let .failure(error) = KeyChord.parseModifiers("cmd+a") else {
            return XCTFail("expected a failure")
        }
        XCTAssertEqual(error.message, "unsupported click modifier 'a'")
    }

    func testAnEmptyModifierPartIsRefused() {
        guard case let .failure(error) = KeyChord.parseModifiers("cmd+") else {
            return XCTFail("expected a failure")
        }
        XCTAssertTrue(error.message.contains("modifier keys only"))
    }

    func testSelectAllIsRecognizedInEverySpellingTheAgentMightSend() {
        for chord in ["cmd+a", "Command+A", "CmdOrCtrl-A", "meta + a"] {
            XCTAssertTrue(KeyChord.isSelectAll(chord), chord)
        }
        XCTAssertFalse(KeyChord.isSelectAll("ctrl+a"))
        XCTAssertFalse(KeyChord.isSelectAll("cmd+s"))
    }

    func testModifierKeyCodesAreTheOnesMacOSExpects() {
        XCTAssertEqual(KeyChord.modifierKeyCode(.command), 55)
        XCTAssertEqual(KeyChord.modifierKeyCode(.control), 59)
        XCTAssertEqual(KeyChord.modifierKeyCode(.option), 58)
        XCTAssertEqual(KeyChord.modifierKeyCode(.shift), 56)
    }
}

final class ScreenshotBoundPolicyTests: XCTestCase {
    func testAnImageInsideTheCapIsReturnedUntouched() {
        XCTAssertTrue(ScreenshotBoundPolicy.fits(899_999))
        XCTAssertTrue(ScreenshotBoundPolicy.fits(900_000))
        XCTAssertFalse(ScreenshotBoundPolicy.fits(900_001))
    }

    func testTheFirstRetryScalesTheLongestEdgeTo1280() {
        XCTAssertEqual(ScreenshotBoundPolicy.initialScale(width: 2560, height: 1440), 0.5, accuracy: 1e-9)
        XCTAssertEqual(ScreenshotBoundPolicy.initialScale(width: 1440, height: 2560), 0.5, accuracy: 1e-9)
    }

    func testAnImageAlreadyUnder1280NeverScalesUp() {
        XCTAssertEqual(ScreenshotBoundPolicy.initialScale(width: 800, height: 600), 1)
    }

    func testEachRetryShavesFifteenPercentAndStopsAtAQuarter() {
        let scales = ScreenshotBoundPolicy.scaleSequence(width: 1280, height: 720)

        XCTAssertEqual(scales.first, 1)
        XCTAssertEqual(scales[1], 0.85, accuracy: 1e-9)
        XCTAssertGreaterThanOrEqual(scales.last ?? 0, ScreenshotBoundPolicy.minimumScale)
        XCTAssertLessThan((scales.last ?? 0) * ScreenshotBoundPolicy.scaleStep, ScreenshotBoundPolicy.minimumScale)
    }
}

final class PasteSafetyTests: XCTestCase {
    func testThePasteCapIsSixteenMebibytes() {
        XCTAssertEqual(PasteSafety.maxBytes, 16 * 1024 * 1024)
        XCTAssertTrue(PasteSafety.isWithinCap(PasteSafety.maxBytes))
        XCTAssertFalse(PasteSafety.isWithinCap(PasteSafety.maxBytes + 1))
    }
}

final class SnapshotCacheKeysTests: XCTestCase {
    func testASnapshotIsAddressableByEveryNameTheCallerCouldUse() {
        let keys = SnapshotCacheKeys.aliases(
            query: "TextEdit",
            appName: "TextEdit",
            bundleId: "com.apple.TextEdit",
            pid: 4413,
            windowId: 812,
            windowIndex: nil
        )

        XCTAssertTrue(keys.contains("textedit"))
        XCTAssertTrue(keys.contains("com.apple.textedit"))
        XCTAssertTrue(keys.contains("pid:4413"))
        XCTAssertTrue(keys.contains("window-id:812"))
        XCTAssertTrue(keys.contains("textedit#window:812"))
        XCTAssertEqual(Set(keys).count, keys.count)
    }

    func testAWindowIndexAddsItsOwnAliases() {
        let keys = SnapshotCacheKeys.aliases(
            query: "pid:4413",
            appName: "TextEdit",
            bundleId: nil,
            pid: 4413,
            windowId: 812,
            windowIndex: 2
        )

        XCTAssertTrue(keys.contains("window-index:2"))
        XCTAssertTrue(keys.contains("textedit#windowindex:2"))
    }

    func testALookupPrefersTheWindowItNamed() {
        XCTAssertEqual(
            SnapshotCacheKeys.lookupOrder(query: "TextEdit", windowId: 812, windowIndex: nil),
            ["window-id:812", "textedit#window:812"]
        )
        XCTAssertEqual(
            SnapshotCacheKeys.lookupOrder(query: "TextEdit", windowId: nil, windowIndex: 1),
            ["window-index:1", "textedit#windowindex:1"]
        )
        XCTAssertEqual(SnapshotCacheKeys.lookupOrder(query: "TextEdit", windowId: nil, windowIndex: nil), ["textedit"])
    }

    func testEveryLookupKeyIsOneTheWriterStored() {
        let stored = Set(SnapshotCacheKeys.aliases(
            query: "TextEdit",
            appName: "TextEdit",
            bundleId: "com.apple.TextEdit",
            pid: 4413,
            windowId: 812,
            windowIndex: 2
        ))

        for windowId: UInt32? in [812, nil] {
            for windowIndex: Int? in [2, nil] {
                for key in SnapshotCacheKeys.lookupOrder(query: "TextEdit", windowId: windowId, windowIndex: windowIndex) {
                    XCTAssertTrue(stored.contains(key), key)
                }
            }
        }
    }
}
