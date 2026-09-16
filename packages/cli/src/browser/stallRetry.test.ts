/**
 * A verb that fails because the bridge's own plumbing stalled before the page
 * was touched is run once more; a failure that may have acted on the page is
 * not. The classifier is what gates the retry in runVerb (cliEngine.ts).
 */
import { describe, expect, test } from "bun:test";
import { isStallFailure } from "./cliEngine";

describe("isStallFailure", () => {
  test("the bridge's pre-action timeouts are stalls", () => {
    for (const line of [
      "CDP error (Target.setDiscoverTargets): tabs.list did not answer within 20000ms (extension last heard 7587ms ago; Chrome runs the extension at background priority, so its worker was not scheduled, not lost)",
      "CDP error (Target.attachToTarget): domain enable did not answer within 5000ms (tab frozen or discarded)",
      "CDP error (Target.attachToTarget): overlay install did not answer within 5000ms (Chrome busy or tab unresponsive)",
      "x attach did not answer within 40000ms (extension last heard 3ms ago)",
      "Chrome storage.session.get did not answer within 20000ms",
      "Chrome tabs.query did not answer within 8000ms",
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
