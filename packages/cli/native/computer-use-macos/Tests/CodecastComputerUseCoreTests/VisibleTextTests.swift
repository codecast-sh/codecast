import XCTest
@testable import CodecastComputerUseCore

final class VisibleTextTests: XCTestCase {
    func testTitleBarButtonsAndUnnamedPressesAreNotControlsToActOn() {
        XCTAssertFalse(VisibleText.isApplicationControl(role: "AXButton", subrole: "AXCloseButton", named: true, enabled: true, hasAction: true))
        XCTAssertFalse(VisibleText.isApplicationControl(role: "AXButton", subrole: nil, named: false, enabled: true, hasAction: true))
        XCTAssertFalse(VisibleText.isApplicationControl(role: "AXButton", subrole: nil, named: true, enabled: false, hasAction: true))
        XCTAssertFalse(VisibleText.isApplicationControl(role: "AXGroup", subrole: nil, named: true, enabled: true, hasAction: true))
        XCTAssertTrue(VisibleText.isApplicationControl(role: "AXButton", subrole: nil, named: true, enabled: true, hasAction: true))
        XCTAssertTrue(VisibleText.isApplicationControl(role: "AXTextField", subrole: nil, named: false, enabled: true, hasAction: false))
    }

    func testTextTheTreeAlreadySaysIsDropped() {
        let anchors = [
            VisibleText.Anchor(index: 0, frame: CGRect(x: 0, y: 0, width: 400, height: 200), line: "0 standard window Bench Canvas", unnamedPressable: false),
        ]
        let title = VisibleTextItem(text: "Bench  canvas", frame: CGRect(x: 150, y: 4, width: 90, height: 14))
        XCTAssertEqual(VisibleText.place(title, anchors: anchors), .duplicate)
    }

    func testTextOnAnUnnamedControlNamesTheSmallestOne() {
        let anchors = [
            VisibleText.Anchor(index: 0, frame: CGRect(x: 0, y: 0, width: 400, height: 200), line: "0 standard window Bench Canvas", unnamedPressable: false),
            VisibleText.Anchor(index: 1, frame: CGRect(x: 0, y: 100, width: 400, height: 100), line: "1 button", unnamedPressable: true),
            VisibleText.Anchor(index: 2, frame: CGRect(x: 20, y: 130, width: 220, height: 50), line: "2 button", unnamedPressable: true),
        ]
        let label = VisibleTextItem(text: "LAUNCH PROBE", frame: CGRect(x: 30, y: 140, width: 150, height: 24))
        XCTAssertEqual(VisibleText.place(label, anchors: anchors), .names(index: 2))
        let loose = VisibleTextItem(text: "CANVAS HELLO", frame: CGRect(x: 30, y: 40, width: 150, height: 24))
        XCTAssertEqual(VisibleText.place(loose, anchors: anchors), .standalone)
    }

    func testReadingOrderIsByLineThenLeftToRight() {
        let items = [
            VisibleTextItem(text: "right", frame: CGRect(x: 200, y: 12, width: 40, height: 16)),
            VisibleTextItem(text: "below", frame: CGRect(x: 0, y: 60, width: 40, height: 16)),
            VisibleTextItem(text: "left", frame: CGRect(x: 10, y: 10, width: 40, height: 16)),
        ]
        XCTAssertEqual(VisibleText.readingOrder(items).map(\.text), ["left", "right", "below"])
    }

    func testLinesParseAsElementLines() {
        XCTAssertEqual(VisibleText.line(index: 7, text: "Get\nLucky"), "7 visible text Get Lucky")
        XCTAssertEqual(VisibleText.seenSuffix(["LAUNCH", "PROBE"]), ", Seen: LAUNCH PROBE")
    }
}
