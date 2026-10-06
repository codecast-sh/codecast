import XCTest
@testable import CodecastComputerUseCore

final class ActionSettleTests: XCTestCase {
    func testAnAppThatCannotBeObservedWaitsTheReactionWindow() {
        var settle = ActionSettle(path: "accessibility", countBeforeAction: nil, now: 0)
        XCTAssertFalse(settle.isSettled(count: nil, now: 0.1))
        XCTAssertTrue(settle.isSettled(count: nil, now: 0.12))

        var synthetic = ActionSettle(path: "synthetic", countBeforeAction: nil, now: 0)
        XCTAssertFalse(synthetic.isSettled(count: nil, now: 0.2))
        XCTAssertTrue(synthetic.isSettled(count: nil, now: 0.25))
    }

    func testAQuietAppWaitsTheReactionWindow() {
        var settle = ActionSettle(path: "accessibility", countBeforeAction: 4, now: 0)
        XCTAssertFalse(settle.isSettled(count: 4, now: 0.11))
        XCTAssertTrue(settle.isSettled(count: 4, now: 0.12))
    }

    /// A press returns after the app handled it, so its notifications are
    /// already counted by the first look, and the wait ends a quiet spell later.
    func testEndsAQuietSpellAfterTheLastNotification() {
        var settle = ActionSettle(path: "accessibility", countBeforeAction: 4, now: 0)
        XCTAssertFalse(settle.isSettled(count: 6, now: 0.005))
        XCTAssertFalse(settle.isSettled(count: 6, now: 0.06))
        XCTAssertTrue(settle.isSettled(count: 6, now: 0.066))
    }

    func testANotificationRestartsTheQuietSpell() {
        var settle = ActionSettle(path: "accessibility", countBeforeAction: 0, now: 0)
        XCTAssertFalse(settle.isSettled(count: 1, now: 0.01))
        XCTAssertFalse(settle.isSettled(count: 2, now: 0.06))
        XCTAssertFalse(settle.isSettled(count: 2, now: 0.1))
        XCTAssertTrue(settle.isSettled(count: 2, now: 0.12))
    }

    func testAnAppThatNeverStopsIsCutOffAtTheCeiling() {
        var settle = ActionSettle(path: "accessibility", countBeforeAction: 0, now: 0)
        var count = 0
        var now = 0.0
        while now < ActionSettle.ceiling {
            count += 1
            XCTAssertFalse(settle.isSettled(count: count, now: now))
            now += 0.01
        }
        XCTAssertTrue(settle.isSettled(count: count + 1, now: ActionSettle.ceiling))
    }
}
