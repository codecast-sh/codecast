import XCTest
@testable import CodecastComputerUseCore

final class AppBlockListTests: XCTestCase {
    func testEveryPasswordManagerInTheDesignIsBlocked() {
        for bundleId in [
            "com.1password.1password",
            "com.1password.safari",
            "com.bitwarden.desktop",
            "com.dashlane.dashlanephonefinal",
            "com.lastpass.LastPass",
            "com.nordsec.nordpass",
            "me.proton.pass.electron",
            "me.proton.pass.catalyst",
        ] {
            XCTAssertTrue(AppBlockList.isBlocked(bundleId), bundleId)
        }
    }

    func testMatchingIgnoresCaseAndSurroundingSpace() {
        XCTAssertTrue(AppBlockList.isBlocked("COM.1Password.1Password"))
        XCTAssertTrue(AppBlockList.isBlocked("  com.bitwarden.desktop  "))
    }

    func testOrdinaryAppsAreNotBlocked() {
        XCTAssertFalse(AppBlockList.isBlocked("com.apple.TextEdit"))
        XCTAssertFalse(AppBlockList.isBlocked(nil))
        XCTAssertFalse(AppBlockList.isBlocked(""))
    }

    func testTheMessageNamesWhatTheCallerAskedFor() {
        XCTAssertEqual(
            AppBlockList.blockedMessage("pid:1234"),
            "app 'pid:1234' is blocked for safety"
        )
    }
}
