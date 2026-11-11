import XCTest
@testable import CodecastComputerUseCore

final class WindowReadDiagnosisTests: XCTestCase {
    func testOnlyMacOSRefusalBlamesTheGrant() {
        let verdict = WindowReadDiagnosis.verdict(appName: "Chrome", errors: [-25211, -25211], waitedMs: 1500)
        XCTAssertEqual(verdict.code, .permissionDenied)
        XCTAssertTrue(verdict.message.contains("Accessibility"))
        XCTAssertTrue(verdict.message.contains("-25211"))
    }

    func testABusyAppIsATimeoutNotAGrant() {
        let verdict = WindowReadDiagnosis.verdict(appName: "Chrome", errors: [-25204, 0], waitedMs: 1500)
        XCTAssertEqual(verdict.code, .actionTimeout)
        XCTAssertFalse(verdict.message.contains("Accessibility"))
    }

    /// Reads that succeed with no usable window (another Space, minimized) are
    /// a window problem; the old message sent people to toggle the grant.
    func testReadsThatSucceedWithNoWindowAreWindowNotFound() {
        let verdict = WindowReadDiagnosis.verdict(appName: "Finder", errors: [-25212, 0], waitedMs: 1500)
        XCTAssertEqual(verdict.code, .windowNotFound)
        XCTAssertFalse(verdict.message.contains("Accessibility"))
        XCTAssertFalse(verdict.message.contains("Toggle"))
    }
}
