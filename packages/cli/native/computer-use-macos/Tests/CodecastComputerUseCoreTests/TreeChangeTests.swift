import XCTest
@testable import CodecastComputerUseCore

final class TreeChangeTests: XCTestCase {
    private func tree(_ title: String, _ lines: [String], focus: String = "No UI element is currently focused.") -> String {
        (["App=x (pid 1)", "Window: \"\(title)\", App: x.", ""] + lines + ["", focus]).joined(separator: "\n")
    }

    func testRenumberedElementsAndANewWindowTitleAreNoChange() {
        let before = tree("A", ["\t0 window A", "\t\t1 checkbox Subscribe", "\t\ttext Hello"])
        let after = tree("B", ["\t0 window A", "\t\t7 checkbox Subscribe", "\t\ttext Hello"])
        XCTAssertFalse(TreeChange.bodyChanged(before, after))
    }

    func testAChangedValueDepthOrFocusIsAChange() {
        let before = tree("A", ["\t0 window A", "\t\t1 checkbox Subscribe, value 0"])
        XCTAssertTrue(TreeChange.bodyChanged(before, tree("A", ["\t0 window A", "\t\t1 checkbox Subscribe, value 1"])))
        XCTAssertTrue(TreeChange.bodyChanged(before, tree("A", ["\t0 window A", "\t1 checkbox Subscribe, value 0"])))
        XCTAssertTrue(TreeChange.bodyChanged(before, tree("A", ["\t0 window A", "\t\t1 checkbox Subscribe, value 0"], focus: "The focused UI element is 1 checkbox.")))
    }

    func testAnAddedLineIsAChange() {
        let before = tree("A", ["\t0 window A"])
        XCTAssertTrue(TreeChange.bodyChanged(before, tree("A", ["\t0 window A", "\t\t1 sheet"])))
    }
}
