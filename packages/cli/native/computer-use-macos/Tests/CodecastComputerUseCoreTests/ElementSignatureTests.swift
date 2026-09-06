import XCTest
@testable import CodecastComputerUseCore

final class ElementSignatureTests: XCTestCase {
    private let field = SnapshotRenderNode(
        role: "AXTextField",
        roleDescription: "text field",
        title: "Address",
        label: "Address bar",
        url: "https://example.com",
        rawActions: ["AXPress", "AXIncrement"]
    )

    func testTypingIntoAFieldDoesNotChangeItsSignature() {
        var typed = field
        typed.value = "hello"
        typed.placeholder = "Search or enter address"
        typed.summary = "hello"

        XCTAssertEqual(ElementSignature.of(field), ElementSignature.of(typed))
    }

    func testFocusTraitsDoNotChangeTheSignature() {
        var focused = field
        focused.traits = ["selected"]

        XCTAssertEqual(ElementSignature.of(field), ElementSignature.of(focused))
    }

    func testIdentityFieldsDoChangeTheSignature() {
        for mutate in [
            { (node: inout SnapshotRenderNode) in node.role = "AXTextArea" },
            { (node: inout SnapshotRenderNode) in node.roleDescription = "search field" },
            { (node: inout SnapshotRenderNode) in node.title = "Search" },
            { (node: inout SnapshotRenderNode) in node.label = "Search bar" },
            { (node: inout SnapshotRenderNode) in node.linkText = "Home" },
            { (node: inout SnapshotRenderNode) in node.url = "https://other.example" },
            { (node: inout SnapshotRenderNode) in node.rawActions = ["AXDecrement"] },
        ] {
            var changed = field
            mutate(&changed)
            XCTAssertNotEqual(ElementSignature.of(field), ElementSignature.of(changed))
        }
    }

    func testNoisyActionsAloneDoNotChangeTheSignature() {
        var reordered = field
        reordered.rawActions = ["AXIncrement", "AXShowMenu", "AXRaise"]

        XCTAssertEqual(ElementSignature.of(field), ElementSignature.of(reordered))
    }

    func testFieldsAreSeparatedSoOneCannotImpersonateAnother() {
        let split = SnapshotRenderNode(role: "AX", roleDescription: "TextField")
        let joined = SnapshotRenderNode(role: "AXTextField")

        XCTAssertNotEqual(ElementSignature.of(split), ElementSignature.of(joined))
    }
}
