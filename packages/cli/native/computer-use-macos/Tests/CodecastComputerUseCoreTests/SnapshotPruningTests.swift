import XCTest
@testable import CodecastComputerUseCore

final class SnapshotPruningTests: XCTestCase {
    func testElidesAnonymousWrappers() {
        XCTAssertTrue(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXGroup", childCount: 1)))
        XCTAssertTrue(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXUnknown", childCount: 4)))
    }

    func testKeepsAWrapperThatCarriesAnything() {
        XCTAssertFalse(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXGroup", title: "Sidebar")))
        XCTAssertFalse(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXGroup", traits: ["expanded"])))
        XCTAssertFalse(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXGroup", rawActions: ["AXIncrement"])))
        XCTAssertFalse(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXGroup", summary: "One Two")))
        XCTAssertFalse(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXScrollArea")))
    }

    func testAnUnnamedWrapperCarryingOnlyANoisyActionStillElides() {
        let node = SnapshotRenderNode(role: "AXGroup", rawActions: ["AXPress", "AXScrollToVisible"], childCount: 2)

        XCTAssertTrue(SnapshotRenderHeuristics.shouldElide(node))
    }

    func testPreservesWebAreaContainersWithMultipleChildren() {
        XCTAssertFalse(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXGroup", childCount: 3, webAreaDepth: 1)))
        XCTAssertTrue(SnapshotRenderHeuristics.shouldElide(SnapshotRenderNode(role: "AXGroup", childCount: 1, webAreaDepth: 1)))
    }

    func testSuppressesChildrenForNamedCompactControls() {
        let button = SnapshotRenderNode(role: "AXButton", roleDescription: "button", label: "Install", childCount: 1)
        let heading = SnapshotRenderNode(role: "AXHeading", roleDescription: "heading", label: "Navigation", value: "2", childCount: 1)

        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(button))
        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(heading))
        XCTAssertTrue(SnapshotRenderHeuristics.shouldSuppressChildren(SnapshotRenderNode(role: "AXMenuBarItem")))
    }

    func testKeepsChildrenForAnUnnamedCompactControlAndForRows() {
        XCTAssertFalse(SnapshotRenderHeuristics.shouldSuppressChildren(SnapshotRenderNode(role: "AXButton", childCount: 2)))
        XCTAssertFalse(SnapshotRenderHeuristics.shouldSuppressChildren(
            SnapshotRenderNode(role: "AXRow", roleDescription: "row", childCount: 3, rowSummary: "Liked Songs")
        ))
    }

    func testTablesReadRowsRatherThanChildren() {
        for role in ["AXTable", "AXOutline", "AXList", "AXBrowser"] {
            XCTAssertTrue(SnapshotRenderHeuristics.usesRowsAsPrimaryChildren(role: role), role)
        }
        XCTAssertFalse(SnapshotRenderHeuristics.usesRowsAsPrimaryChildren(role: "AXGroup"))
    }

    func testRowSelectionKeepsTheVisibleRowsAndCapsThemAtTwenty() {
        let visible = SnapshotRenderHeuristics.visibleRowSelection(rowsIntersectingParent: [3, 4, 5], totalRows: 500)

        XCTAssertEqual(visible, [3, 4, 5])
        XCTAssertEqual(SnapshotRenderHeuristics.visibleRowSelection(rowsIntersectingParent: Array(0..<80), totalRows: 80).count, 20)
    }

    func testRowSelectionFallsBackToEveryRowWhenNoneIntersect() {
        XCTAssertEqual(SnapshotRenderHeuristics.visibleRowSelection(rowsIntersectingParent: [], totalRows: 3), [0, 1, 2])
        XCTAssertEqual(SnapshotRenderHeuristics.visibleRowSelection(rowsIntersectingParent: [], totalRows: 90).count, 20)
    }

    func testTextCollapseNeedsTwoSnippetsAndStaysUnderTheLengthCap() {
        XCTAssertNil(SnapshotRenderHeuristics.textCollapseSummary(["only one"]))
        XCTAssertEqual(SnapshotRenderHeuristics.textCollapseSummary(["one", "two"]), "one two")
        XCTAssertNil(SnapshotRenderHeuristics.textCollapseSummary([String(repeating: "x", count: 200), String(repeating: "y", count: 200)]))
    }

    func testPreviewTruncatesWithAnEllipsis() {
        XCTAssertEqual(SnapshotRenderHeuristics.preview("short", maxLength: 10), "short")
        XCTAssertEqual(SnapshotRenderHeuristics.preview(String(repeating: "a", count: 12), maxLength: 10), String(repeating: "a", count: 10) + "...")
    }

    func testCompactsLargeBrowserTabStripsToSelectedTab() {
        let parent = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "tab bar")
        let children = (0..<12).map { index in
            SnapshotRenderNode(role: "AXRadioButton", roleDescription: "tab", title: "Tab \(index)", traits: index == 7 ? ["selected"] : [])
        }

        XCTAssertEqual(
            SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children),
            SnapshotTabStripCompaction(retainedIndexes: [7], omittedCount: 11)
        )
    }

    func testUsesOneValueAsSelectedBrowserTabFallback() {
        let parent = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "scroll area")
        let children = (0..<12).map { index in
            SnapshotRenderNode(role: "AXRadioButton", roleDescription: "tab", title: "Tab \(index)", value: index == 4 ? "1" : "0")
        }

        XCTAssertEqual(
            SnapshotRenderHeuristics.tabStripCompaction(parent: parent, children: children),
            SnapshotTabStripCompaction(retainedIndexes: [4], omittedCount: 11)
        )
    }

    func testKeepsTabCollectionsThatAreNotBrowserStrips() {
        let group = SnapshotRenderNode(role: "AXGroup")
        let selectedTabs = (0..<12).map { index in
            SnapshotRenderNode(role: "AXRadioButton", roleDescription: "tab", title: "Pane \(index)", traits: index == 2 ? ["selected"] : [])
        }
        let strip = SnapshotRenderNode(role: "AXScrollArea", roleDescription: "tab bar")
        let unselectedTabs = (0..<12).map { index in SnapshotRenderNode(role: "AXTab", title: "Tab \(index)", value: "0") }
        let smallGroup = SnapshotRenderNode(role: "AXTabGroup", roleDescription: "tab group")
        let fewTabs = (0..<3).map { index in
            SnapshotRenderNode(role: "AXRadioButton", roleDescription: "tab", title: "Pane \(index)", traits: index == 1 ? ["selected"] : [])
        }

        XCTAssertNil(SnapshotRenderHeuristics.tabStripCompaction(parent: group, children: selectedTabs))
        XCTAssertNil(SnapshotRenderHeuristics.tabStripCompaction(parent: strip, children: unselectedTabs))
        XCTAssertNil(SnapshotRenderHeuristics.tabStripCompaction(parent: smallGroup, children: fewTabs))
    }

    func testSecondPassRemovesRenderedTabsAndNamesTheirIndexes() {
        let indent = "\t"
        var lines = ["0 scroll area"]
        lines += (1...12).map { index in
            index == 3 ? "\(indent)3 tab (selected) Inbox" : "\(indent)\(index) tab, Value: 0"
        }

        let plan = RenderedBrowserTabCompaction.plan(lines: lines, from: 1, indent: indent)

        XCTAssertEqual(plan?.omittedCount, 11)
        XCTAssertEqual(plan?.insertionIndex, 1)
        XCTAssertEqual(
            plan?.removedLineIndexes.compactMap { RenderedBrowserTabCompaction.renderedElementIndex(lines[$0], indent: indent) },
            [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]
        )
    }

    func testSecondPassIgnoresGrandchildLinesAndStripsUnderTheTabThreshold() {
        let indent = "\t"
        let nested = ["0 scroll area"] + (1...12).map { "\(indent)\t\($0) tab (selected)" }
        let small = ["0 scroll area"] + (1...4).map { "\(indent)\($0) tab (selected)" }

        XCTAssertNil(RenderedBrowserTabCompaction.plan(lines: nested, from: 1, indent: indent))
        XCTAssertNil(RenderedBrowserTabCompaction.plan(lines: small, from: 1, indent: indent))
    }

    /// The pattern deliberately only claims a line whose role word ends the
    /// segment, so a `tab bar` container or a `tabs` label is never mistaken
    /// for a tab and deleted.
    func testTheSecondPassPatternDoesNotClaimNeighbouringRoles() {
        let indent = "\t"

        XCTAssertTrue(RenderedBrowserTabCompaction.isDirectTabLine("\(indent)4 tab", indent: indent))
        XCTAssertTrue(RenderedBrowserTabCompaction.isDirectTabLine("\(indent)4 tab (selected) Inbox", indent: indent))
        XCTAssertFalse(RenderedBrowserTabCompaction.isDirectTabLine("\(indent)4 tab bar", indent: indent))
        XCTAssertFalse(RenderedBrowserTabCompaction.isDirectTabLine("\(indent)4 table", indent: indent))
    }

    func testCapsAreTheOnesTheDesignFixes() {
        XCTAssertEqual(SnapshotLimits.maxNodes, 1200)
        XCTAssertEqual(SnapshotLimits.maxDepth, 64)
        XCTAssertEqual(SnapshotLimits.maxRows, 20)
        XCTAssertEqual(SnapshotLimits.browserTabStripMinimumTabs, 10)
    }
}
