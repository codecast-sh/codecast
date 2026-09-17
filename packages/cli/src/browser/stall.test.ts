/**
 * A verb that fails because the bridge's own plumbing stalled before the page
 * was touched is run once more; a failure that may have acted on the page is
 * not. The classifier gates both the engine-run retry (cliEngine.ts runVerb)
 * and the thrown-error retry around the session's tab creation (pinnedTab.ts).
 */
import { describe, expect, test } from "bun:test";
import { isStallFailure, retryOnStall, shouldRetryAfterStall } from "./stall";

describe("isStallFailure", () => {
  test("the bridge's pre-action timeouts are stalls", () => {
    for (const line of [
      "CDP error (Target.setDiscoverTargets): tabs.list did not answer within 20000ms (extension last heard 7587ms ago; Chrome runs the extension at background priority, so its worker was not scheduled, not lost)",
      "Target.createTarget: tabs.create did not answer within 15000ms (extension last heard 5748ms ago; Chrome runs the extension at background priority, so its worker was not scheduled, not lost)",
      "CDP error (Target.attachToTarget): domain enable did not answer within 5000ms (tab frozen or discarded)",
      "CDP error (Target.attachToTarget): overlay install did not answer within 5000ms (Chrome busy or tab unresponsive)",
      "x attach did not answer within 40000ms (extension last heard 3ms ago)",
      "Chrome storage.session.get did not answer within 20000ms",
      "Chrome tabs.query did not answer within 8000ms",
      "/grant did not answer within 45000ms (the bridge host verifies a grant through the extension, whose process runs at background priority and was not scheduled)",
    ]) {
      expect(isStallFailure(line)).toBe(true);
    }
  });

  test("a timeout inside the page, or any other failure, is not retried", () => {
    for (const line of [
      "the script did not settle within 15000ms",
      "Runtime.evaluate did not answer within 240s; the tab was detached (page hung or renderer frozen)",
      "no tab 1E21E9B9 in the real Chrome",
      "the cast bridge extension is not connected",
      "tab_gone",
      "",
    ]) {
      expect(isStallFailure(line)).toBe(false);
    }
  });
});

describe("retryOnStall", () => {
  test("a stall is retried once, with a note, and the second answer is returned", async () => {
    let calls = 0;
    const notes: string[] = [];
    const out = await retryOnStall(
      async () => {
        calls++;
        if (calls === 1) throw new Error("Target.createTarget: tabs.create did not answer within 15000ms (extension last heard 5ms ago)");
        return "tab";
      },
      { delayMs: 1, note: (l) => notes.push(l) },
    );
    expect(out).toBe("tab");
    expect(calls).toBe(2);
    expect(notes).toHaveLength(1);
  });

  test("a second stall, and any other failure, propagate", async () => {
    let calls = 0;
    await expect(
      retryOnStall(async () => {
        calls++;
        throw new Error("tabs.list did not answer within 40000ms");
      }, { delayMs: 1, note: () => {} }),
    ).rejects.toThrow(/did not answer/);
    expect(calls).toBe(2);
    calls = 0;
    await expect(
      retryOnStall(async () => {
        calls++;
        throw new Error("no tab 1E21E9B9 in the real Chrome");
      }, { delayMs: 1, note: () => {} }),
    ).rejects.toThrow(/no tab/);
    expect(calls).toBe(1);
  });
});

describe("shouldRetryAfterStall", () => {
  const busy = "Failed to read: Resource temporarily unavailable (os error 35) (after 5 retries - daemon may be busy or unresponsive)";
  test("the engine client giving up on a busy daemon is retried only for verbs that change nothing", () => {
    expect(shouldRetryAfterStall("open", busy)).toBe(true);
    expect(shouldRetryAfterStall("snapshot", busy)).toBe(true);
    expect(shouldRetryAfterStall("click", busy)).toBe(false);
    expect(shouldRetryAfterStall("type", busy)).toBe(false);
  });
  test("a bridge stall is retried for any verb: the page was not reached", () => {
    expect(shouldRetryAfterStall("click", "tabs.list did not answer within 40000ms")).toBe(true);
  });
});
