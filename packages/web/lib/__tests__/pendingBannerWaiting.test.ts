import { expect, test } from "bun:test";
import { pendingBannerState } from "../pendingBanner";

// ct-98179: "waiting" is the daemon's verdict for a session parked on its own
// open background tasks. The message is not lost: the session takes it the
// moment the wait ends, which can be many minutes away. Escalating to "stuck"
// once the 60s boot budget passes drew "No confirmation from the agent yet"
// with Resend and Cancel (turnBlocks.tsx), and the person cancelled and
// resent messages the agent then answered.
test("a message to a session parked on its background tasks stays queued past the boot budget", () => {
  const state = pendingBannerState("waiting", {
    retryEligible: true,
    restartInFlight: false,
    idleGraceElapsed: true,
    bootGraceElapsed: true,
    messageReachedSession: false,
  });
  expect(state).not.toBe("stuck");
});
