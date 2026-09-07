import Dispatch
import Foundation

/// Absorb the transient TCC denials a freshly launched process gets before the
/// real answer arrives, without turning a slow answer into a long one.
///
/// The budget is wall clock, not summed sleeps. It used to be summed sleeps,
/// and that made `timeoutMs` mean nothing on the machine it exists for: on a
/// Mac where TCC has no row for the helper, each `AXIsProcessTrusted()` /
/// `CGPreflightScreenCaptureAccess()` call costs real time, and only the 100 ms
/// naps counted against the 1500 ms budget. So the loop ran its full sixteen
/// attempts and paid for sixteen slow syscalls: measured at 3.4 s to 25.7 s for
/// one status read, against a client that waits 5 s (ct-49671).
///
/// Counting elapsed time makes a slow probe end the loop instead of repeating
/// it. That is the right trade for what this is for: the retry absorbs a denial
/// that flips within a moment or two of launch, and a probe that took longer
/// than the whole budget to answer once has already given TCC that moment.
public enum PermissionTrustSettling {
    public struct Outcome: Equatable {
        public let settled: Bool
        public let attempts: Int
        /// Wall clock spent between the first probe and the verdict.
        public let waitedMs: Int

        public init(settled: Bool, attempts: Int, waitedMs: Int) {
            self.settled = settled
            self.attempts = attempts
            self.waitedMs = waitedMs
        }
    }

    public static let defaultTimeoutMs = 1_500
    public static let defaultIntervalMs = 100

    public static func settle(
        timeoutMs: Int = defaultTimeoutMs,
        intervalMs: Int = defaultIntervalMs,
        nowMs: () -> Int = { Int(DispatchTime.now().uptimeNanoseconds / 1_000_000) },
        sleepMs: (Int) -> Void = { interval in
            Thread.sleep(forTimeInterval: TimeInterval(interval) / 1_000)
        },
        probe: () -> Bool
    ) -> Outcome {
        precondition(timeoutMs >= 0, "timeoutMs must not be negative")
        precondition(intervalMs > 0, "intervalMs must be positive")
        let start = nowMs()
        var attempts = 0
        while true {
            attempts += 1
            if probe() {
                return Outcome(settled: true, attempts: attempts, waitedMs: nowMs() - start)
            }
            let elapsed = nowMs() - start
            if elapsed >= timeoutMs {
                return Outcome(settled: false, attempts: attempts, waitedMs: elapsed)
            }
            sleepMs(min(intervalMs, timeoutMs - elapsed))
        }
    }
}
