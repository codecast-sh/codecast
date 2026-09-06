import { test, expect, describe } from "bun:test";
import { isJumpReadyToScroll, shouldFollowStreaming, shouldLoadOlder, shouldLoadNewer, shouldAdjustScrollForResize } from "./conversationScroll";

describe("shouldFollowStreaming", () => {
  test("follows normally before the user scrolls away", () => {
    expect(shouldFollowStreaming(false)).toBe(true);
  });

  test("never follows new chunks after the user scrolls away", () => {
    expect(shouldFollowStreaming(true)).toBe(false);
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

describe("shouldLoadNewer", () => {
  const can = {
    nearBottom: true,
    hasMoreBelow: true,
    isLoadingOlder: false,
    isLoadingNewer: false,
    cooldownActive: false,
  };

  test("loads when the user has scrolled down to near the bottom", () => {
    expect(shouldLoadNewer(can)).toBe(true);
  });

  test("does NOT load outside target mode (no content below the window)", () => {
    expect(shouldLoadNewer({ ...can, hasMoreBelow: false })).toBe(false);
  });

  test("does NOT load when the bottom is still far away", () => {
    expect(shouldLoadNewer({ ...can, nearBottom: false })).toBe(false);
  });

  test("does NOT re-enter while a newer page is already loading", () => {
    expect(shouldLoadNewer({ ...can, isLoadingNewer: true })).toBe(false);
  });

  test("does NOT fight an in-flight older load", () => {
    expect(shouldLoadNewer({ ...can, isLoadingOlder: true })).toBe(false);
  });

  // THE REGRESSION the user reported: loading a newer page snapped the view to
  // the new bottom (the virtualizer's end-anchor), which re-entered the trigger
  // band and looped through every remaining page. The pin-back layout effect
  // holds this cooldown while it restores the pre-load position; auto-load must
  // stand down for that whole window so the snap can't chain another load.
  test("stands down during a pagination/jump cooldown (the loop breaker)", () => {
    expect(shouldLoadNewer({ ...can, cooldownActive: true })).toBe(false);
  });
});

describe("shouldAdjustScrollForResize", () => {
  const above = { itemStart: 1000, scrollOffset: 5000, held: false, scrollDirection: null as const };

  test("a row above the viewport shifts scrollTop by its delta", () => {
    expect(shouldAdjustScrollForResize(above)).toBe(true);
  });

  // THE REGRESSION the user reported: scrolling up, the content lurched under
  // the pointer on every wheel tick. Rows above the viewport render for the
  // first time on the way up and replace their estimate with a real height;
  // the correction was skipped whenever the scroll direction was backward, so
  // every estimate error became a visible jump.
  test("still shifts while scrolling UP (backward)", () => {
    expect(shouldAdjustScrollForResize({ ...above, scrollDirection: "backward" })).toBe(true);
  });

  test("still shifts while scrolling down (forward)", () => {
    expect(shouldAdjustScrollForResize({ ...above, scrollDirection: "forward" })).toBe(true);
  });

  test("a row at or below the viewport top leaves scrollTop alone", () => {
    expect(shouldAdjustScrollForResize({ ...above, itemStart: 5000 })).toBe(false);
    expect(shouldAdjustScrollForResize({ ...above, itemStart: 7000 })).toBe(false);
  });

  test("a held row (in-row disclosure just toggled) leaves scrollTop alone even above the viewport", () => {
    expect(shouldAdjustScrollForResize({ ...above, held: true })).toBe(false);
  });
});
