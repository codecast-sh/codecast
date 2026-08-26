import { describe, expect, it } from "bun:test";
import {
  WALL_BURST_FLOOR_MS,
  WALL_FACE_PX,
  WALL_TAP_MS,
  buildWall,
  hasFleetActivity,
  isWallTap,
  wallFacePx,
  wallTier,
} from "./peopleWallLayout";
import { memberPresenceVisual, type FleetSummary } from "../presence/memberPresence";

const fleet = (over: Partial<FleetSummary> = {}): FleetSummary => ({
  working: 0,
  needsYou: 0,
  topStatus: null,
  topTitle: null,
  topSessionKey: null,
  ...over,
});

describe("the tap / hold boundary", () => {
  it("calls a quick press a tap", () => {
    expect(isWallTap(1000, 1120)).toBe(true);
  });

  it("calls a long press a hold", () => {
    expect(isWallTap(1000, 2400)).toBe(false);
  });

  it("gives the boundary itself to the hold", () => {
    // Exactly 300ms is somebody holding a key. A tie must not close a mic.
    expect(isWallTap(1000, 1000 + WALL_TAP_MS)).toBe(false);
    expect(isWallTap(1000, 1000 + WALL_TAP_MS - 1)).toBe(true);
  });

  it("never calls a tap something the engine would keep", () => {
    // The whole reason a tap can safely open the microphone: every gesture
    // short enough to be a click is short enough for the engine to discard, so
    // clicking a face can never land a burst in somebody's DM. If either
    // constant moves, this is what says so.
    expect(WALL_TAP_MS).toBeLessThan(WALL_BURST_FLOOR_MS);
    for (const held of [0, 1, 150, WALL_TAP_MS - 1]) {
      expect(isWallTap(0, held)).toBe(true);
      expect(held).toBeLessThan(WALL_BURST_FLOOR_MS);
    }
  });
});

describe("how big a face is drawn", () => {
  it("puts somebody with agents running at the top size", () => {
    expect(wallTier("active", fleet({ working: 2 }))).toBe("loud");
    expect(wallTier("active", fleet({ needsYou: 1 }))).toBe("loud");
    expect(wallFacePx("active", fleet({ working: 1 }))).toBe(WALL_FACE_PX.loud);
  });

  it("draws somebody present and quiet one size down", () => {
    expect(wallTier("active", fleet())).toBe("here");
    expect(wallTier("active", null)).toBe("here");
  });

  it("does not shrink busy — they are at the machine and said so", () => {
    expect(wallTier("busy", null)).toBe("here");
    expect(wallTier("busy", fleet({ working: 3 }))).toBe("loud");
  });

  it("steps down through idle, away and offline", () => {
    expect(wallTier("idle", fleet({ working: 9 }))).toBe("idle");
    expect(wallTier("away", fleet({ working: 9 }))).toBe("away");
    expect(wallTier("offline", fleet({ working: 9 }))).toBe("gone");
  });

  it("only ever gets smaller as presence fades", () => {
    const sizes = (["active", "idle", "away", "offline"] as const).map((v) => wallFacePx(v, null));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThan(sizes[i - 1]);
    expect(wallFacePx("active", fleet({ working: 1 }))).toBeGreaterThan(wallFacePx("active", null));
  });

  it("reads a real member row the same way the badge does", () => {
    // The wall must never disagree with the badge beside it, so both go through
    // memberPresenceVisual rather than each reading presence_state themselves.
    const inHuddle = { _id: "u1", presence_state: "away", in_huddle: true };
    expect(memberPresenceVisual(inHuddle)).toBe("active");
    expect(wallTier(memberPresenceVisual(inHuddle), null)).toBe("here");
  });

  it("counts activity only when something is actually running or waiting", () => {
    expect(hasFleetActivity(null)).toBe(false);
    expect(hasFleetActivity(fleet())).toBe(false);
    expect(hasFleetActivity(fleet({ working: 1 }))).toBe(true);
    expect(hasFleetActivity(fleet({ needsYou: 1 }))).toBe(true);
  });
});

describe("the wall's layout", () => {
  type M = { _id: string; name: string; presence_state?: string; status?: string };
  const wallOf = (members: M[], fleets: Record<string, FleetSummary> = {}) =>
    buildWall(
      members,
      (m) => memberPresenceVisual(m),
      (m) => fleets[m._id] ?? null,
      (m) => m._id,
      (m) => m.name,
    );

  const roster: M[] = [
    { _id: "zed", name: "Zed", presence_state: "active" },
    { _id: "ann", name: "Ann", presence_state: "active" },
    { _id: "ivy", name: "Ivy", presence_state: "idle" },
    { _id: "oli", name: "Oli", presence_state: "offline" },
    { _id: "ada", name: "Ada", presence_state: "offline" },
  ];

  it("keeps the people who are not there in their own group", () => {
    const wall = wallOf(roster);
    expect(wall.present.map((f) => f.id)).toEqual(["ann", "zed", "ivy"]);
    expect(wall.gone.map((f) => f.id)).toEqual(["ada", "oli"]);
  });

  it("orders by size first, then by name", () => {
    const wall = wallOf(roster, { zed: fleet({ working: 4 }) });
    expect(wall.present.map((f) => f.id)).toEqual(["zed", "ann", "ivy"]);
    expect(wall.present.map((f) => f.px)).toEqual([
      WALL_FACE_PX.loud,
      WALL_FACE_PX.here,
      WALL_FACE_PX.idle,
    ]);
  });

  it("drops rows with no id rather than drawing a faceless circle", () => {
    const wall = wallOf([...roster, { _id: "", name: "Nobody" }]);
    expect(wall.present.length + wall.gone.length).toBe(roster.length);
  });
});
