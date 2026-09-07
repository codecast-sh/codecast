import XCTest
@testable import CodecastComputerUseCore

final class SecureTextRedactionTests: XCTestCase {
    func testOnlyTextLikeRolesAreProbed() {
        XCTAssertTrue(SecureTextRedaction.roleCouldHoldASecret("AXTextField"))
        XCTAssertTrue(SecureTextRedaction.roleCouldHoldASecret("AXSearchField"))
        XCTAssertTrue(SecureTextRedaction.roleCouldHoldASecret("AXComboBox"))
        XCTAssertFalse(SecureTextRedaction.roleCouldHoldASecret("AXGroup"))
        XCTAssertFalse(SecureTextRedaction.roleCouldHoldASecret("AXButton"))
    }

    func testSecureSubroleRedactsTheValue() {
        XCTAssertEqual(
            SecureTextRedaction.redactedValue("hunter2", role: "AXTextField", subrole: "AXSecureTextField"),
            "[redacted]"
        )
    }

    func testEveryMetadataFieldCanMarkAFieldSecret() {
        XCTAssertTrue(SecureTextRedaction.isSecureField(role: "AXTextField", title: "Password"))
        XCTAssertTrue(SecureTextRedaction.isSecureField(role: "AXTextField", label: "Device passcode"))
        XCTAssertTrue(SecureTextRedaction.isSecureField(role: "AXTextField", placeholder: "One-time code"))
        XCTAssertTrue(SecureTextRedaction.isSecureField(role: "AXTextField", placeholder: "Verification code"))
    }

    func testAnOrdinaryFieldKeepsItsValue() {
        XCTAssertEqual(
            SecureTextRedaction.redactedValue("hello", role: "AXTextField", title: "Document"),
            "hello"
        )
    }

    func testAButtonNamedPasswordIsNotRedacted() {
        XCTAssertFalse(SecureTextRedaction.isSecureField(role: "AXButton", title: "Show password"))
    }

    func testTheRenderedValueIsTheOnlyPlaceASecretWouldHaveAppeared() {
        let node = SnapshotRenderNode(
            role: "AXTextField",
            roleDescription: "secure text field",
            label: "Password",
            value: SecureTextRedaction.redactedValue("hunter2", role: "AXTextField", subrole: "AXSecureTextField")
        )

        let line = SnapshotRenderHeuristics.line(index: 11, node: node)

        XCTAssertTrue(line.contains("[redacted]"))
        XCTAssertFalse(line.contains("hunter2"))
    }
}
