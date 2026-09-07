import XCTest
@testable import CodecastComputerUseCore

final class WindowCandidateFilterTests: XCTestCase {
    func testTinyAndInvisibleWindowsAreDropped() {
        XCTAssertFalse(keeps(width: 40, height: 400))
        XCTAssertFalse(keeps(width: 400, height: 40))
        XCTAssertFalse(keeps(alpha: 0))
        XCTAssertTrue(keeps())
    }

    func testAnUnsharedWindowIsDroppedOnlyWhenTheFieldMeansSomething() {
        XCTAssertFalse(keeps(sharingState: 0, screenRecordingGranted: true))
        XCTAssertTrue(keeps(sharingState: 1, screenRecordingGranted: true))
    }

    /// Without Screen Recording macOS reports a zero sharing state for nearly
    /// every window, so honouring the field there would leave an agent with no
    /// window at all on a machine where only Accessibility is granted.
    func testWithoutScreenRecordingTheSharingStateIsIgnored() {
        XCTAssertTrue(keeps(sharingState: 0, screenRecordingGranted: false))
        XCTAssertTrue(keeps(sharingState: nil, screenRecordingGranted: false))
    }

    func testSizeAndAlphaStillApplyWithoutScreenRecording() {
        XCTAssertFalse(keeps(width: 10, height: 10, screenRecordingGranted: false))
        XCTAssertFalse(keeps(alpha: 0.001, screenRecordingGranted: false))
    }

    private func keeps(
        width: Double = 900,
        height: Double = 700,
        alpha: Double = 1,
        sharingState: Int? = 1,
        screenRecordingGranted: Bool = true
    ) -> Bool {
        WindowCandidateFilter.keeps(
            width: width,
            height: height,
            alpha: alpha,
            sharingState: sharingState,
            screenRecordingGranted: screenRecordingGranted
        )
    }
}
