import XCTest
@testable import CodecastComputerUseCore

final class SnapshotRenderingTests: XCTestCase {
    func testSkipsUnsupportedAdvertisedAttributes() {
        let advertised: Set<String> = ["AXRole", "AXChildren"]

        XCTAssertTrue(SnapshotRenderHeuristics.supportsAttribute("AXRole", advertisedAttributes: advertised))
        XCTAssertFalse(SnapshotRenderHeuristics.supportsAttribute("AXTitle", advertisedAttributes: advertised))
    }

    func testUnknownAttributeAdvertisementsStayPermissive() {
        XCTAssertTrue(SnapshotRenderHeuristics.supportsAttribute("AXTitle", advertisedAttributes: nil))
    }

    func testRendersMarkdownLinksAndSuppressesTheirChildren() {
        let node = SnapshotRenderNode(role: "AXLink", linkText: "Skip [main]", url: "https://example.com/path")

        XCTAssertEqual(
            SnapshotRenderHeuristics.line(index: 7, node: node),
            "7 link [Skip \\[main\\]](https://example.com/path)"
        )
        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(node))
    }

    func testFiltersNoisyActionsAndFormatsSecondaryActions() {
        let node = SnapshotRenderNode(
            role: "AXWindow",
            title: "Document",
            rawActions: ["AXPress", "AXShowMenu", "AXScrollToVisible", "AXZoomWindow"]
        )

        XCTAssertEqual(SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role), ["AXZoomWindow"])
        XCTAssertEqual(
            SnapshotRenderHeuristics.line(index: 1, node: node),
            "1 window Document, Secondary Actions: zoom the window"
        )
    }

    func testDropsMenuOnlyNoiseActions() {
        let node = SnapshotRenderNode(role: "AXMenuItem", rawActions: ["AXCancel", "AXPick", "AXIncrement"])

        XCTAssertEqual(SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role), ["AXIncrement"])
    }

    func testSuppressesHorizontalScrollWhenVerticalScrollExists() {
        let node = SnapshotRenderNode(
            role: "AXScrollArea",
            rawActions: ["AXScrollUpByPage", "AXScrollDownByPage", "AXScrollLeftByPage", "AXScrollRightByPage"]
        )

        XCTAssertEqual(
            SnapshotRenderHeuristics.meaningfulActions(node.rawActions, role: node.role),
            ["AXScrollUpByPage", "AXScrollDownByPage"]
        )
    }

    func testTextFieldsKeepDistinctValueAndPlaceholder() {
        let node = SnapshotRenderNode(
            role: "AXTextField",
            roleDescription: "text field",
            label: "Address",
            value: "https://example.com",
            placeholder: "Search"
        )

        XCTAssertEqual(
            SnapshotRenderHeuristics.line(index: 3, node: node),
            "3 text field Address, Value: https://example.com, Placeholder: Search"
        )
    }

    func testStaticTextUsesCompactValueFormatting() {
        let node = SnapshotRenderNode(role: "AXStaticText", roleDescription: "text", value: "Home")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 4, node: node), "4 text Home")
    }

    func testHeadingDropsANumericValueThatOnlyRepeatsItsLevel() {
        let node = SnapshotRenderNode(role: "AXHeading", roleDescription: "heading", label: "Releases", value: "2")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 5, node: node), "5 heading Releases")
    }

    func testRowSummaryBecomesName() {
        let node = SnapshotRenderNode(role: "AXRow", roleDescription: "row", rowSummary: "General Settings Enabled")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 9, node: node), "9 row General Settings Enabled")
    }

    func testTraitsRenderBeforeTheName() {
        let node = SnapshotRenderNode(role: "AXCheckBox", roleDescription: "checkbox", title: "Wrap", traits: ["selected", "settable"])

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 2, node: node), "2 checkbox (selected, settable) Wrap")
    }

    func testNewlinesBecomeSpaces() {
        let node = SnapshotRenderNode(role: "AXStaticText", roleDescription: "text", value: "first\nsecond\rthird")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 0, node: node), "0 text first second third")
    }

    func testMenuBarItemsRenderWithoutARoleWord() {
        let node = SnapshotRenderNode(role: "AXMenuBarItem", title: "File")

        XCTAssertEqual(SnapshotRenderHeuristics.line(index: 6, node: node), "6 File")
    }

    func testRoleTextFallsBackToTheCamelCaseRole() {
        XCTAssertEqual(SnapshotRenderHeuristics.roleText(SnapshotRenderNode(role: "AXTextArea")), "text area")
        XCTAssertEqual(SnapshotRenderHeuristics.roleText(SnapshotRenderNode(role: "AXGroup")), "container")
        XCTAssertEqual(SnapshotRenderHeuristics.roleText(SnapshotRenderNode(role: "AXWebArea")), "html content")
    }
}
