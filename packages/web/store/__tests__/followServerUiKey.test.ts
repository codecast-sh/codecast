import { describe, expect, it } from "bun:test";
import { followServerUiKey, mergeStampedBagLww } from "../inboxStore";

// A per-device key is unstamped, so once a client holds it, local wins every
// merge. A client that only reads another device's choice (the phone reading
// the web's modern_style) names the key with followServerUiKey, and then the
// server's value wins on that client.
describe("followServerUiKey", () => {
  it("an unstamped key a client holds is local-wins by default", () => {
    const merged = mergeStampedBagLww({ test_follow_a: true }, { test_follow_a: false }, true);
    expect(merged.test_follow_a).toBe(true);
  });

  it("a followed key takes the server's value, each time it changes", () => {
    followServerUiKey("test_follow_b");
    let local: Record<string, unknown> = { test_follow_b: true, other: 1 };
    local = mergeStampedBagLww(local, { test_follow_b: false, other: 2 }, true);
    expect(local.test_follow_b).toBe(false);
    // Other unstamped keys keep the default.
    expect(local.other).toBe(1);
    local = mergeStampedBagLww(local, { test_follow_b: true }, true);
    expect(local.test_follow_b).toBe(true);
  });

  it("a followed key the server does not hold keeps the local value", () => {
    followServerUiKey("test_follow_c");
    expect(mergeStampedBagLww({ test_follow_c: true }, { unrelated: 1 }, true).test_follow_c).toBe(true);
  });
});
