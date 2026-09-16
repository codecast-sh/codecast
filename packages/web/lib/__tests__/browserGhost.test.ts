import { describe, expect, test } from "bun:test";
import {
  applyGhostAction,
  captionText,
  createGhostStore,
  GHOST_CAPTION_CHARS,
  GHOST_CAPTION_MS,
  GHOST_EMPTY,
  GHOST_IDLE_MS,
  GHOST_RIPPLE_MS,
  GHOST_SECRET_CAPTION,
  ghostView,
} from "../browserGhost";
import type { WatchActionFrame } from "../browserWatch";

// What the agent's cursor shows is a fold over action frames plus a clock.
// Pinned here so the overlay component can stay a drawing of this answer.

const at0 = 1_000_000;
const act = (kind: WatchActionFrame["kind"], extra: Partial<WatchActionFrame> = {}): WatchActionFrame => ({
  kind,
  x: 0.5,
  y: 0.5,
  at: at0,
  ...extra,
});

describe("applyGhostAction", () => {
  test("nothing is drawn before the first action", () => {
    const v = ghostView(GHOST_EMPTY, at0);
    expect(v.visible).toBe(false);
    expect(v.point).toBeNull();
    expect(v.nextChangeAt).toBeNull();
  });

  test("a move places the arrow; it fades after the idle window", () => {
    const s = applyGhostAction(GHOST_EMPTY, act("move", { x: 0.25, y: 0.75 }));
    expect(ghostView(s, at0).point).toEqual({ x: 0.25, y: 0.75 });
    expect(ghostView(s, at0).visible).toBe(true);
    expect(ghostView(s, at0).nextChangeAt).toBe(at0 + GHOST_IDLE_MS);
    expect(ghostView(s, at0 + GHOST_IDLE_MS - 1).visible).toBe(true);
    expect(ghostView(s, at0 + GHOST_IDLE_MS).visible).toBe(false);
  });

  test("a press rings once and each press restarts the ring", () => {
    const s1 = applyGhostAction(GHOST_EMPTY, act("down"));
    expect(ghostView(s1, at0).ripple).toBe(1);
    expect(ghostView(s1, at0 + GHOST_RIPPLE_MS).ripple).toBeNull();
    const s2 = applyGhostAction(applyGhostAction(s1, act("up", { at: at0 + 50 })), act("down", { at: at0 + 900 }));
    expect(ghostView(s2, at0 + 900).ripple).toBe(2);
    // The wake for the ring comes before the wake for the idle fade.
    expect(ghostView(s2, at0 + 900).nextChangeAt).toBe(at0 + 900 + GHOST_RIPPLE_MS);
  });

  test("typing captions the field and fades after the typing window", () => {
    const s = applyGhostAction(GHOST_EMPTY, act("type", { text: "hello" }));
    expect(ghostView(s, at0).caption).toBe("hello");
    expect(ghostView(s, at0 + GHOST_CAPTION_MS).caption).toBeNull();
    // Still visible as an arrow after the caption is gone.
    expect(ghostView(s, at0 + GHOST_CAPTION_MS).visible).toBe(true);
  });

  test("a secret field shows that something is typed, never what", () => {
    const s = applyGhostAction(GHOST_EMPTY, act("type", { secret: true, text: "should not appear" }));
    expect(ghostView(s, at0).caption).toBe(GHOST_SECRET_CAPTION);
  });

  test("a long caption keeps its tail", () => {
    const long = "a".repeat(GHOST_CAPTION_CHARS) + "tail";
    expect(captionText(long)).toBe("…" + "a".repeat(GHOST_CAPTION_CHARS - 4) + "tail");
    expect(captionText("two\n lines")).toBe("two lines");
  });

  test("a scroll keeps the arrow where it was and counts as activity", () => {
    let s = applyGhostAction(GHOST_EMPTY, act("move", { x: 0.2, y: 0.3 }));
    s = applyGhostAction(s, act("scroll", { x: 0.5, y: 0.5, at: at0 + 3000 }));
    expect(s.point).toEqual({ x: 0.2, y: 0.3 });
    expect(ghostView(s, at0 + 3000 + GHOST_IDLE_MS - 1).visible).toBe(true);
    // With no arrow yet, the scroll's own point is where it appears.
    expect(applyGhostAction(GHOST_EMPTY, act("scroll", { x: 0.5, y: 0.5 })).point).toEqual({ x: 0.5, y: 0.5 });
  });

  test("a navigation is remembered without moving the arrow", () => {
    const s = applyGhostAction(applyGhostAction(GHOST_EMPTY, act("move", { x: 0.1, y: 0.2 })), act("nav", { x: 0.9, y: 0.9, url: "https://a.test/next", at: at0 + 10 }));
    expect(s.nav).toEqual({ url: "https://a.test/next", at: at0 + 10 });
    expect(s.point).toEqual({ x: 0.1, y: 0.2 });
    expect(applyGhostAction(GHOST_EMPTY, act("nav")).nav).toBeNull();
  });

  test("time never runs backwards: a late frame does not pull the arrow back", () => {
    const fresh = applyGhostAction(GHOST_EMPTY, act("move", { x: 0.8, y: 0.8, at: at0 + 100 }));
    const late = applyGhostAction(fresh, act("move", { x: 0.1, y: 0.1, at: at0 }));
    expect(late).toBe(fresh);
  });
});

describe("createGhostStore", () => {
  test("tells listeners only when the state changed, and forgets on reset", () => {
    const store = createGhostStore();
    let told = 0;
    const off = store.subscribe(() => told++);
    store.push(act("move"));
    expect(told).toBe(1);
    expect(store.getSnapshot().point).toEqual({ x: 0.5, y: 0.5 });
    store.push(act("move", { at: at0 - 1 })); // stale: no change, no wake
    expect(told).toBe(1);
    store.reset();
    expect(told).toBe(2);
    expect(store.getSnapshot()).toBe(GHOST_EMPTY);
    store.reset();
    expect(told).toBe(2);
    off();
    store.push(act("down", { at: at0 + 1 }));
    expect(told).toBe(2);
  });
});
