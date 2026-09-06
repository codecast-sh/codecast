import { describe, expect, test } from "bun:test";
import { BrowserBannerGate, bannerRank, showsBannerEntity } from "./notificationGate";

// A manual scheduler, so the 250 ms grace runs without real time.
function fakeClock() {
  let t = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let next = 1;
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (id: unknown) => timers.delete(id as number),
    async advance(ms: number) {
      t += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= t) {
          timers.delete(id);
          timer.fn();
        }
      }
      await Promise.resolve();
    },
  };
}

function rig() {
  const clock = fakeClock();
  const gate = new BrowserBannerGate({
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, gate };
}

const reading = (active: string) => ({ focused: true, active });
const away = { focused: false, active: "/conversation/c1" };

describe("browser banner gate", () => {
  test("silences only the conversation on screen", async () => {
    const { gate } = rig();
    expect(gate.admit(reading("/conversation/c1"), { conversationId: "c1", kind: "session_idle" })).toEqual({
      shown: false,
      reason: "focused-active",
    });
    // Another conversation while reading this one: the old rule swallowed it.
    expect(await gate.admit(reading("/conversation/c1"), { conversationId: "c2", kind: "session_idle" })).toEqual({
      shown: true,
    });
    // A list page names no entity, so nothing is on screen.
    expect(await gate.admit(reading("/inbox"), { conversationId: "c3", kind: "session_idle" })).toEqual({
      shown: true,
    });
    // The same conversation with the tab in the background still banners.
    expect(await gate.admit(away, { conversationId: "c1", kind: "session_idle" })).toEqual({ shown: true });
  });

  test("a ring goes up over the conversation it is about", () => {
    const { gate } = rig();
    expect(gate.admit(reading("/conversation/c1"), { conversationId: "c1", force: true })).toEqual({ shown: true });
  });

  test("one conversation banners once per 5 s burst", async () => {
    const { gate, clock } = rig();
    expect(gate.admit(away, { conversationId: "c1", kind: "session_idle" })).toEqual({ shown: true });
    await clock.advance(1000);
    expect(gate.admit(away, { conversationId: "c1", kind: "session_error" })).toEqual({
      shown: false,
      reason: "cooldown",
    });
    // A different conversation is a different burst.
    expect(gate.admit(away, { conversationId: "c2", kind: "session_idle" })).toEqual({ shown: true });
    await clock.advance(5000);
    expect(gate.admit(away, { conversationId: "c1", kind: "session_idle" })).toEqual({ shown: true });
  });

  test("a completion arriving with a permission request is the one that fires", async () => {
    const { gate, clock } = rig();
    const request = gate.admit(away, { conversationId: "c1", kind: "permission_request" });
    expect(request instanceof Promise).toBe(true);
    expect(gate.admit(away, { conversationId: "c1", kind: "session_idle" })).toEqual({ shown: true });
    expect(await request).toEqual({ shown: false, reason: "superseded" });
    await clock.advance(500);
  });

  test("a permission request alone still banners, once the grace passes", async () => {
    const { gate, clock } = rig();
    const request = gate.admit(away, { conversationId: "c1", kind: "permission_request" });
    // A second request in the same burst rides the one already waiting.
    expect(gate.admit(away, { conversationId: "c1", kind: "permission_request" })).toEqual({
      shown: false,
      reason: "burst",
    });
    await clock.advance(250);
    expect(await request).toEqual({ shown: true });
  });

  test("banners with no conversation skip the burst rules", async () => {
    const { gate } = rig();
    expect(await gate.admit(away, { route: "/chat/general" })).toEqual({ shown: true });
    expect(await gate.admit(away, { route: "/chat/general" })).toEqual({ shown: true });
    // ...but a tab reading that channel still silences them.
    expect(gate.admit(reading("/chat/general"), { route: "/chat/general?m=9" })).toEqual({
      shown: false,
      reason: "focused-active",
    });
  });

  test("showsBannerEntity matches an entity, never a list page", () => {
    expect(showsBannerEntity("/conversation/c1", "/conversation/c1")).toBe(true);
    expect(showsBannerEntity("/chat/general", "/chat/general?m=9")).toBe(true);
    expect(showsBannerEntity("/conversation/c1", "/conversation/c2")).toBe(false);
    expect(showsBannerEntity("/tasks", "/tasks")).toBe(false);
    expect(showsBannerEntity("/inbox", "/conversation/c1")).toBe(false);
    expect(showsBannerEntity(null, "/conversation/c1")).toBe(false);
    expect(showsBannerEntity("/conversation/c1", undefined)).toBe(false);
  });

  test("bannerRank puts a completion above everything else", () => {
    expect(bannerRank("session_idle")).toBe(1);
    expect(bannerRank("permission_request")).toBe(0);
    expect(bannerRank(undefined)).toBe(0);
  });
});
