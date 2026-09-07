import Testing
@testable import CodecastComputerUseCore

/// A clock the test drives. Sleeping is the only thing that moves it, except in
/// the one case that measures a slow probe.
private final class FakeClock {
    var ms = 0
}

@Suite("PermissionTrustSettling")
struct PermissionTrustSettlingTests {
    @Test("already-trusted probe returns immediately")
    func immediateSuccess() {
        let clock = FakeClock()
        var sleeps: [Int] = []
        let outcome = PermissionTrustSettling.settle(
            nowMs: { clock.ms },
            sleepMs: { sleeps.append($0); clock.ms += $0 },
            probe: { true }
        )

        #expect(outcome == .init(settled: true, attempts: 1, waitedMs: 0))
        #expect(sleeps.isEmpty)
    }

    @Test("transient denial settles after retries")
    func lateGrant() {
        let clock = FakeClock()
        var calls = 0
        var sleeps: [Int] = []
        let outcome = PermissionTrustSettling.settle(
            nowMs: { clock.ms },
            sleepMs: { sleeps.append($0); clock.ms += $0 },
            probe: {
                calls += 1
                return calls >= 4
            }
        )

        #expect(outcome == .init(settled: true, attempts: 4, waitedMs: 300))
        #expect(sleeps == [100, 100, 100])
    }

    @Test("persistent denial stops at the timeout")
    func neverGranted() {
        let clock = FakeClock()
        let outcome = PermissionTrustSettling.settle(
            timeoutMs: 1_000,
            intervalMs: 300,
            nowMs: { clock.ms },
            sleepMs: { clock.ms += $0 },
            probe: { false }
        )

        #expect(outcome == .init(settled: false, attempts: 5, waitedMs: 1_000))
    }

    @Test("final interval is clamped to the timeout")
    func clampsFinalInterval() {
        let clock = FakeClock()
        var sleeps: [Int] = []
        let outcome = PermissionTrustSettling.settle(
            timeoutMs: 250,
            intervalMs: 100,
            nowMs: { clock.ms },
            sleepMs: { sleeps.append($0); clock.ms += $0 },
            probe: { false }
        )

        #expect(sleeps == [100, 100, 50])
        #expect(outcome == .init(settled: false, attempts: 4, waitedMs: 250))
    }

    /// The regression this loop was rewritten for (ct-49671). A probe that
    /// itself costs more than the budget must be paid for once, not sixteen
    /// times: the old accounting counted only the naps, so a 600 ms
    /// `AXIsProcessTrusted()` cost 16 * 600 ms on a Mac with no TCC row for the
    /// helper, and `cast computer permissions` timed out more often than it
    /// answered.
    @Test("a probe slower than the budget is paid for once, not per attempt")
    func slowProbeIsNotMultiplied() {
        let clock = FakeClock()
        var sleeps: [Int] = []
        var calls = 0
        let outcome = PermissionTrustSettling.settle(
            timeoutMs: 1_500,
            intervalMs: 100,
            nowMs: { clock.ms },
            sleepMs: { sleeps.append($0); clock.ms += $0 },
            probe: {
                calls += 1
                clock.ms += 1_600 // tccd answering an unknown client
                return false
            }
        )

        #expect(outcome.settled == false)
        #expect(outcome.attempts == 1)
        #expect(outcome.waitedMs == 1_600)
        #expect(sleeps.isEmpty)
    }

    /// The retry still exists: a probe that costs some time and then flips is
    /// exactly what the settle is for.
    @Test("a probe that costs time and then flips still settles")
    func slowProbeThatSettles() {
        let clock = FakeClock()
        var calls = 0
        let outcome = PermissionTrustSettling.settle(
            timeoutMs: 1_500,
            intervalMs: 100,
            nowMs: { clock.ms },
            sleepMs: { clock.ms += $0 },
            probe: {
                calls += 1
                clock.ms += 300
                return calls >= 3
            }
        )

        #expect(outcome == .init(settled: true, attempts: 3, waitedMs: 1_100))
    }
}
