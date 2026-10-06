import XCTest
@testable import CodecastComputerUseCore

final class BlockingSurfaceTests: XCTestCase {
    func testSheetsAndModalSurfacesBlockAndPopoversDoNot() {
        XCTAssertTrue(BlockingSurface.blocks(role: "AXSheet", modal: false))
        XCTAssertTrue(BlockingSurface.blocks(role: "AXGroup", modal: true))
        XCTAssertFalse(BlockingSurface.blocks(role: "AXPopover", modal: false))
        XCTAssertFalse(BlockingSurface.blocks(role: "AXGroup", modal: false))
        XCTAssertEqual(BlockingSurface.noun(role: "AXSheet"), "sheet")
        XCTAssertEqual(BlockingSurface.noun(role: "AXWindow"), "dialog")
    }

    func testNotesNameTheCoveredWindowOnOneLine() {
        XCTAssertEqual(
            BlockingSurface.note(noun: "sheet", windowTitle: "Bench\nForm"),
            "Only this sheet is listed: it covers \"Bench Form\", which does not respond until the sheet closes."
        )
        XCTAssertTrue(BlockingSurface.blockedNote(dialogTitle: "Save", windowId: 42).hasSuffix("--window-id 42."))
    }

    func testOffScreenElementsAreSkippedOnlyWhenTheyHaveASize() {
        let region = CGRect(x: 0, y: 0, width: 400, height: 300)
        XCTAssertFalse(VisibleRegion.isOutside(CGRect(x: 10, y: 10, width: 20, height: 20), region: region))
        XCTAssertTrue(VisibleRegion.isOutside(CGRect(x: 10, y: 900, width: 20, height: 20), region: region))
        XCTAssertFalse(VisibleRegion.isOutside(CGRect(x: 10, y: 900, width: 0, height: 0), region: region))
        XCTAssertFalse(VisibleRegion.isOutside(nil, region: region))
        XCTAssertFalse(VisibleRegion.isOutside(CGRect(x: 10, y: 900, width: 20, height: 20), region: nil))
    }

    func testScrollAreasNarrowTheRegionAndMenusLiftIt() {
        let window = CGRect(x: 0, y: 0, width: 400, height: 300)
        let scroll = CGRect(x: 0, y: 50, width: 400, height: 100)
        XCTAssertEqual(VisibleRegion.narrowed(window, role: "AXScrollArea", frame: scroll), scroll)
        XCTAssertEqual(VisibleRegion.narrowed(window, role: "AXGroup", frame: scroll), window)
        XCTAssertNil(VisibleRegion.narrowed(window, role: "AXMenu", frame: scroll))
        XCTAssertNil(VisibleRegion.narrowed(window, role: "AXSheet", frame: scroll))
    }
}
