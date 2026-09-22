// A read-only action is asked once more after the socket dropped under it.
// Sentry JAVASCRIPT-REACT-5V (2026-09-18..22): every reconnect during the org
// health report surfaced as a feeder error for a read the next tick repeats.
import { test, expect, describe } from "bun:test";
import { ACTION_CONNECTION_LOST, callWithReconnectRetry } from "../useSyncOrgHealth";

describe("callWithReconnectRetry", () => {
  test("a dropped connection is retried once and the second answer wins", async () => {
    let calls = 0;
    const result = await callWithReconnectRetry(async () => {
      calls += 1;
      if (calls === 1) throw new Error(`[CONVEX A(orgHealth:healthReport)] ${ACTION_CONNECTION_LOST}`);
      return "report";
    }, 0);
    expect(result).toBe("report");
    expect(calls).toBe(2);
  });

  test("a second drop is the caller's error", async () => {
    let calls = 0;
    await expect(callWithReconnectRetry(async () => {
      calls += 1;
      throw new Error(ACTION_CONNECTION_LOST);
    }, 0)).rejects.toThrow(ACTION_CONNECTION_LOST);
    expect(calls).toBe(2);
  });

  test("any other failure is not retried", async () => {
    let calls = 0;
    await expect(callWithReconnectRetry(async () => {
      calls += 1;
      throw new Error("Your request timed out performing too many system operations.");
    }, 0)).rejects.toThrow("too many system operations");
    expect(calls).toBe(1);
  });
});
