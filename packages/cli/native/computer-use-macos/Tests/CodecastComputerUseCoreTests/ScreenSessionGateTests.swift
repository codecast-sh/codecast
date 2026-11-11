import XCTest
@testable import CodecastComputerUseCore

final class ScreenSessionGateTests: XCTestCase {
    func testALockedScreenIsRefusedWithoutBlamingTheGrant() {
        let state = ScreenSessionGate.state(
            session: ["CGSSessionScreenIsLocked": true, "kCGSSessionOnConsoleKey": true],
            displayAsleep: true
        )
        XCTAssertEqual(state, .locked)
        let message = ScreenSessionGate.refusal(state) ?? ""
        XCTAssertTrue(message.contains("locked"))
        XCTAssertFalse(message.contains("Toggle"))
    }

    func testTheLockKeyIsAbsentWhenUnlocked() {
        XCTAssertEqual(ScreenSessionGate.state(session: ["kCGSSessionOnConsoleKey": 1], displayAsleep: false), .usable)
        XCTAssertNil(ScreenSessionGate.refusal(.usable))
    }

    func testAnAsleepUnlockedDisplayIsWokenNotRefused() {
        let state = ScreenSessionGate.state(session: ["kCGSSessionOnConsoleKey": true], displayAsleep: true)
        XCTAssertEqual(state, .displayAsleep)
        XCTAssertNil(ScreenSessionGate.refusal(state))
    }

    func testAnotherUsersConsoleIsRefused() {
        XCTAssertEqual(ScreenSessionGate.state(session: ["kCGSSessionOnConsoleKey": false], displayAsleep: false), .notOnConsole)
        XCTAssertEqual(ScreenSessionGate.state(session: nil, displayAsleep: false), .notOnConsole)
        XCTAssertNotNil(ScreenSessionGate.refusal(.notOnConsole))
    }
}
