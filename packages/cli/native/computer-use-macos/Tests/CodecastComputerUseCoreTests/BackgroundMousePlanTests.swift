import CoreGraphics
import XCTest
@testable import CodecastComputerUseCore

final class BackgroundMousePlanTests: XCTestCase {
    private let point = CGPoint(x: 400, y: 300)

    private func targetPresses(_ steps: [BackgroundMousePlan.Step]) -> [BackgroundMousePlan.Step] {
        steps.filter { !$0.primer && $0.kind != .move }
    }

    func testSkylightLeftClickPrimesOffScreenBeforeTheRealPress() {
        let steps = BackgroundMousePlan.click(technique: .skylight, leftButton: true, at: point, count: 1)
        XCTAssertEqual(steps.map(\.kind), [.move, .down, .up, .down, .up])
        XCTAssertEqual(steps[1].point, BackgroundMousePlan.offScreen)
        XCTAssertEqual(steps[2].point, BackgroundMousePlan.offScreen)
        XCTAssertTrue(steps[1].primer && steps[2].primer)
        XCTAssertEqual(steps.map(\.phase), [2, 1, 2, 3, 3])
        XCTAssertEqual(targetPresses(steps).map(\.point), [point, point])
    }

    func testOnlyALeftClickGetsTheChromiumPrimer() {
        let steps = BackgroundMousePlan.click(technique: .skylight, leftButton: false, at: point, count: 1)
        XCTAssertFalse(steps.contains(where: \.primer))
    }

    func testPublicTechniquesSendNoPrimerAndNoPhase() {
        for technique in [BackgroundMousePlan.Technique.pid, .activate] {
            let steps = BackgroundMousePlan.click(technique: technique, leftButton: true, at: point, count: 1)
            XCTAssertEqual(steps.map(\.kind), [.move, .down, .up])
            XCTAssertTrue(steps.allSatisfy { $0.phase == nil && !$0.primer })
        }
    }

    func testRepeatedPressesNumberTheClickStateAndStayCapped() {
        let steps = BackgroundMousePlan.click(technique: .pid, leftButton: true, at: point, count: 9)
        XCTAssertEqual(targetPresses(steps).map(\.clickState), [1, 1, 2, 2, 3, 3])
        XCTAssertEqual(steps.last?.pauseAfterMicroseconds, 0)
    }

    func testActivationPrimerPressesTheMiddleNotTheTrafficLights() {
        let steps = BackgroundMousePlan.activationPrimer(windowBounds: CGRect(x: 100, y: 50, width: 600, height: 400))
        XCTAssertEqual(steps.map(\.kind), [.down, .up])
        XCTAssertTrue(steps.allSatisfy { $0.point == CGPoint(x: 400, y: 250) && $0.primer })
    }

    func testDragHoldsTheButtonAcrossEvenSteps() {
        let steps = BackgroundMousePlan.drag(technique: .pid, from: CGPoint(x: 0, y: 0), to: CGPoint(x: 120, y: 60), steps: 4, stepMicroseconds: 16_000)
        XCTAssertEqual(steps.map(\.kind), [.move, .down, .dragged, .dragged, .dragged, .dragged, .up])
        XCTAssertEqual(steps.filter { $0.kind == .dragged }.map(\.point), [
            CGPoint(x: 30, y: 15), CGPoint(x: 60, y: 30), CGPoint(x: 90, y: 45), CGPoint(x: 120, y: 60),
        ])
        XCTAssertEqual(steps.last?.point, CGPoint(x: 120, y: 60))
    }

    /// A freshly launched app spends its first press on activating, so a
    /// SkyLight drag opens with the off-screen primer, as a click does; the
    /// drag's own press comes after it.
    func testSkylightDragOpensWithTheOffScreenPrimer() {
        let steps = BackgroundMousePlan.drag(technique: .skylight, from: CGPoint(x: 10, y: 10), to: CGPoint(x: 90, y: 10), steps: 2, stepMicroseconds: 16_000)
        XCTAssertEqual(steps.map(\.kind), [.move, .down, .up, .down, .dragged, .dragged, .up])
        XCTAssertEqual(steps.filter(\.primer).map(\.point), [BackgroundMousePlan.offScreen, BackgroundMousePlan.offScreen])
        XCTAssertEqual(steps.first { $0.kind == .down && !$0.primer }?.point, CGPoint(x: 10, y: 10))
    }

    func testWindowLocationStampModes() {
        let origin = CGPoint(x: 100, y: 40)
        XCTAssertEqual(BackgroundMousePlan.windowLocation(.local, point: point, windowOrigin: origin), CGPoint(x: 300, y: 260))
        XCTAssertEqual(BackgroundMousePlan.windowLocation(.screen, point: point, windowOrigin: origin), point)
        XCTAssertNil(BackgroundMousePlan.windowLocation(.none, point: point, windowOrigin: origin))
        XCTAssertEqual(BackgroundMousePlan.windowLocation(.local, point: BackgroundMousePlan.offScreen, windowOrigin: origin), BackgroundMousePlan.offScreen)
    }
}

final class FocusShieldPolicyTests: XCTestCase {
    func testDropsOnlyFocusMessagesBoundForTheFrontApp() {
        for type in FocusShieldPolicy.focusEventTypes {
            XCTAssertEqual(FocusShieldPolicy.verdict(eventType: type, boundForFront: true, standing: true, humanActed: { false }), .drop)
            XCTAssertEqual(FocusShieldPolicy.verdict(eventType: type, boundForFront: false, standing: true, humanActed: { false }), .pass)
        }
        for type: UInt32 in [1, 2, 5, 10, 11, 22] {
            XCTAssertEqual(FocusShieldPolicy.verdict(eventType: type, boundForFront: true, standing: true, humanActed: { false }), .pass)
        }
    }

    func testTheHumansOwnInputStandsTheShieldDown() {
        XCTAssertEqual(FocusShieldPolicy.verdict(eventType: 13, boundForFront: true, standing: true, humanActed: { true }), .standDown)
    }

    func testALoweredShieldPassesEverythingWithoutAsking() {
        XCTAssertEqual(
            FocusShieldPolicy.verdict(eventType: 13, boundForFront: true, standing: false, humanActed: { XCTFail("asked"); return false }),
            .pass
        )
    }

    func testTheTapListensForFocusMessagesAlone() {
        XCTAssertEqual(FocusShieldPolicy.eventMask, (1 << 13) | (1 << 19) | (1 << 20))
    }
}
