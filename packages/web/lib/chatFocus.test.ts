import { test, expect, describe } from "bun:test";
import { clearChatFocus, holdChatFocus, isChatContextOnScreen, setChatFocus } from "./chatFocus";

// The focus registry: several surfaces can be reading at once (Threads cards),
// each holds its own entry, and releasing one must never erase another's —
// the single-slot clobber this replaced.

describe("chatFocus registry", () => {
  test("a hold answers only its exact channel+thread context", () => {
    const release = holdChatFocus({ channelId: "c1" });
    expect(isChatContextOnScreen("c1")).toBe(true);
    // A room on screen does not cover its threads, nor other rooms.
    expect(isChatContextOnScreen("c1", "t1")).toBe(false);
    expect(isChatContextOnScreen("c2")).toBe(false);
    release();
    expect(isChatContextOnScreen("c1")).toBe(false);
  });

  test("releasing one card's hold leaves another's standing", () => {
    const a = holdChatFocus({ channelId: "c1", threadRootId: "t1" });
    const b = holdChatFocus({ channelId: "c1" });
    b();
    // The clobber regression: c1/t1 is still on someone's screen.
    expect(isChatContextOnScreen("c1", "t1")).toBe(true);
    expect(isChatContextOnScreen("c1")).toBe(false);
    a();
    a(); // double release is harmless
    expect(isChatContextOnScreen("c1", "t1")).toBe(false);
  });

  test("the page's single slot replaces itself and never touches card holds", () => {
    const card = holdChatFocus({ channelId: "c1" });
    setChatFocus({ channelId: "c2" });
    setChatFocus({ channelId: "c3" });
    expect(isChatContextOnScreen("c2")).toBe(false);
    expect(isChatContextOnScreen("c3")).toBe(true);
    clearChatFocus();
    expect(isChatContextOnScreen("c3")).toBe(false);
    expect(isChatContextOnScreen("c1")).toBe(true);
    card();
  });
});
