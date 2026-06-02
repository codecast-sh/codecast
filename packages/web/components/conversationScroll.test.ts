import { test, expect, describe } from "bun:test";
import { shouldPinToBottom, BOTTOM_PIN_EPSILON_PX, isJumpReadyToScroll, shouldLoadOlder } from "./conversationScroll";

// Baseline: a 1000px-tall list in a 400px viewport => bottom scrollTop is 600.
const base = {
  prevHeight: 1000,
  clientHeight: 400,
  userScrolled: false,
  cooldownActive: false,
  virtualizerCorrecting: false,
};

describe("shouldPinToBottom", () => {
  test("pins when parked exactly at the bottom (streaming follow)", () => {
    expect(shouldPinToBottom({ ...base, scrollTop: 600 })).toBe(true);
  });

  test("stays pinned across repeated growth while at the bottom", () => {
    // Each growth event finds us at the (previous) bottom, so it keeps following.
    expect(shouldPinToBottom({ ...base, prevHeight: 1000, scrollTop: 600 })).toBe(true);
    expect(shouldPinToBottom({ ...base, prevHeight: 1500, scrollTop: 1100 })).toBe(true);
    expect(shouldPinToBottom({ ...base, prevHeight: 3000, scrollTop: 2600 })).toBe(true);
  });

  // THE REGRESSION: nudging up 50px stayed within the old 100px "near bottom"
  // buffer, so userScrolled never latched and the old observer snapped us down.
  test("does NOT pin after a small (50px) scroll-up — the reported bug", () => {
    expect(shouldPinToBottom({ ...base, scrollTop: 550 })).toBe(false);
  });

  test("does NOT pin after a large scroll-up", () => {
    expect(shouldPinToBottom({ ...base, scrollTop: 100 })).toBe(false);
  });

  test("absorbs sub-pixel jitter within the epsilon", () => {
    expect(shouldPinToBottom({ ...base, scrollTop: 600 - BOTTOM_PIN_EPSILON_PX })).toBe(true);
    expect(shouldPinToBottom({ ...base, scrollTop: 600 - (BOTTOM_PIN_EPSILON_PX + 1) })).toBe(false);
  });

  test("never pins while the user has explicitly scrolled (flag set)", () => {
    expect(shouldPinToBottom({ ...base, scrollTop: 600, userScrolled: true })).toBe(false);
  });

  test("never pins during a pagination/jump cooldown", () => {
    expect(shouldPinToBottom({ ...base, scrollTop: 600, cooldownActive: true })).toBe(false);
  });

  test("never pins while the virtualizer is correcting an off-screen item", () => {
    expect(shouldPinToBottom({ ...base, scrollTop: 600, virtualizerCorrecting: true })).toBe(false);
  });

  test("treats overshoot past the bottom as at-bottom", () => {
    expect(shouldPinToBottom({ ...base, scrollTop: 620 })).toBe(true);
  });
});

describe("isJumpReadyToScroll", () => {
  const ready = {
    direction: "start" as "start" | "end" | null,
    hasTimeline: true,
    isLoadingOlder: false,
    isLoadingNewer: false,
  };

  test("scrolls once the destination is loaded (start)", () => {
    expect(isJumpReadyToScroll({ ...ready, direction: "start" })).toBe(true);
  });

  test("scrolls once the destination is loaded (end)", () => {
    expect(isJumpReadyToScroll({ ...ready, direction: "end" })).toBe(true);
  });

  test("never scrolls when no jump is pending", () => {
    expect(isJumpReadyToScroll({ ...ready, direction: null })).toBe(false);
  });

  test("never scrolls before any content exists", () => {
    expect(isJumpReadyToScroll({ ...ready, hasTimeline: false })).toBe(false);
  });

  // THE REGRESSION: jump-to-top must hold while the first page is loading.
  test("does NOT scroll while the top page is still loading", () => {
    expect(isJumpReadyToScroll({ ...ready, direction: "start", isLoadingOlder: true })).toBe(false);
  });

  // THE REGRESSION the user reported: jump-to-bottom scrolled against stale
  // content because the normal-mode LoadingFirstPage state (mapped into
  // isLoadingNewer) wasn't treated as "still loading".
  test("does NOT scroll while the bottom page is still loading", () => {
    expect(isJumpReadyToScroll({ ...ready, direction: "end", isLoadingNewer: true })).toBe(false);
  });

  test("a still-loading jump only becomes ready once loading clears", () => {
    const loading = { ...ready, direction: "end" as const, isLoadingNewer: true };
    expect(isJumpReadyToScroll(loading)).toBe(false);
    expect(isJumpReadyToScroll({ ...loading, isLoadingNewer: false })).toBe(true);
  });
});

describe("shouldLoadOlder", () => {
  const can = {
    nearTop: true,
    userScrolled: true,
    hasMoreAbove: true,
    isLoadingOlder: false,
    isLoadingNewer: false,
    cooldownActive: false,
  };

  test("loads when the user has scrolled up to near the top", () => {
    expect(shouldLoadOlder(can)).toBe(true);
  });

  // THE REGRESSION the user reported: "loading up page randomly triggered
  // without user input — the up arrow spins and we start jumping."
  //
  // On a freshly-opened live session the first page is 40 messages. If they
  // render shorter than the viewport + the ~2000px preload band, the bottom of
  // the conversation is ALSO inside the band (the content-top sentinel never
  // leaves it), so `nearTop` is true while parked at the live tail. The old
  // trigger was `nearTop && hasMoreAbove && …` with no scroll-intent gate, so
  // the rAF pump auto-paginated upward page after page with the user doing
  // nothing — each 200-message prepend jolting the scroll. Concretely: a 1500px
  // window in an 800px viewport bottoms out at scrollTop 700, which is < 1200,
  // i.e. "near top" AND "at the bottom" simultaneously.
  test("does NOT load while parked at the bottom of a short window (the reported bug)", () => {
    expect(shouldLoadOlder({ ...can, userScrolled: false })).toBe(false);
  });

  test("does NOT load on initial open before the user has scrolled", () => {
    // Initial render snaps to the bottom; userScrolled starts false.
    expect(shouldLoadOlder({ ...can, userScrolled: false, nearTop: true })).toBe(false);
  });

  test("does NOT load when the user is scrolled up but not near the top", () => {
    expect(shouldLoadOlder({ ...can, nearTop: false })).toBe(false);
  });

  test("does NOT load when there is nothing older", () => {
    expect(shouldLoadOlder({ ...can, hasMoreAbove: false })).toBe(false);
  });

  test("does NOT re-enter while an older page is already loading", () => {
    expect(shouldLoadOlder({ ...can, isLoadingOlder: true })).toBe(false);
  });

  test("does NOT fight an in-flight newer/tail load", () => {
    expect(shouldLoadOlder({ ...can, isLoadingNewer: true })).toBe(false);
  });

  test("stands down during a pagination/jump cooldown", () => {
    expect(shouldLoadOlder({ ...can, cooldownActive: true })).toBe(false);
  });

  test("resumes once the user scrolls up after following the tail", () => {
    // Parked at the tail → suppressed; then a genuine scroll-up → allowed.
    expect(shouldLoadOlder({ ...can, userScrolled: false })).toBe(false);
    expect(shouldLoadOlder({ ...can, userScrolled: true })).toBe(true);
  });
});
