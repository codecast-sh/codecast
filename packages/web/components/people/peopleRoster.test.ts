import { describe, expect, it } from "bun:test";
import {
  dmBadgesByMember,
  isStrayWorkspace,
  roomsByMember,
  rosterSig,
  unreadBadgeText,
} from "./peopleRoster";
import { groupMembersByBand } from "../presence/memberPresence";

const member = (over: Record<string, any> = {}) => ({
  _id: "u1",
  name: "Ann",
  presence_state: "active",
  ...over,
});

describe("rosterSig", () => {
  it("is stable across a heartbeat that changes nothing the row draws", () => {
    const a = member({ presence_input_at: 1000, daemon_last_seen: 1000 });
    const b = member({ presence_input_at: 9999, daemon_last_seen: 9999 });
    expect(rosterSig([a])).toBe(rosterSig([b]));
  });

  it("wakes on every field a row does draw", () => {
    const base = member();
    for (const change of [
      { presence_state: "idle" },
      { status: "busy" },
      { name: "Anna" },
      { image: "/a.png" },
      { github_avatar_url: "/g.png" },
      { email: "ann@x.com" },
      { in_room_key: "dm:a:b" },
      { in_huddle: true },
      { timezone: "Europe/Berlin" },
    ]) {
      expect(rosterSig([{ ...base, ...change }])).not.toBe(rosterSig([base]));
    }
  });

  it("wakes when somebody joins or leaves the team", () => {
    const one = rosterSig([member()]);
    expect(rosterSig([member(), member({ _id: "u2", name: "Bo" })])).not.toBe(one);
    expect(rosterSig([])).toBe("");
    expect(rosterSig(null)).toBe("");
  });

  it("skips rows with no id instead of signing undefined", () => {
    expect(rosterSig([null as any, { name: "ghost" } as any])).toBe("");
  });
});

describe("dmBadgesByMember", () => {
  const dm = (id: string, others: string[], over: Record<string, any> = {}) =>
    ({ id, kind: "dm", dmMemberIds: others, unreadCount: 0, mentionCount: 0, ...over }) as any;

  it("keys a one-to-one room by the OTHER person", () => {
    const map = dmBadgesByMember([dm("c1", ["u2"], { unreadCount: 3, mentionCount: 1 })]);
    expect(map.get("u2")).toEqual({ channelId: "c1", unread: 3, mentions: 1, muted: false });
  });

  it("ignores group DMs, so one room never counts against three people", () => {
    const map = dmBadgesByMember([dm("c1", ["u2", "u3", "u4"], { unreadCount: 5 })]);
    expect(map.size).toBe(0);
  });

  it("ignores channels that are not DMs", () => {
    const map = dmBadgesByMember([
      { id: "c9", kind: "public", unreadCount: 4 } as any,
      { id: "c8", kind: "private", memberIds: ["u2"], unreadCount: 4 } as any,
    ]);
    expect(map.size).toBe(0);
  });

  it("keeps a muted room's count and says it is muted", () => {
    const map = dmBadgesByMember([dm("c1", ["u2"], { unreadCount: 7, muted: true })]);
    expect(map.get("u2")).toMatchObject({ unread: 7, muted: true });
  });

  it("survives a rail row with no member ids at all", () => {
    expect(dmBadgesByMember([{ id: "c1", kind: "dm" } as any]).size).toBe(0);
  });
});

describe("roomsByMember", () => {
  const room = (roomKey: string, ids: string[]) => ({
    roomKey,
    members: ids.map((user_id) => ({ user_id })),
  });

  it("maps every occupant to their room", () => {
    const map = roomsByMember([room("r1", ["u1", "u2"]), room("r2", ["u3"])]);
    expect(map.get("u1")?.roomKey).toBe("r1");
    expect(map.get("u2")?.roomKey).toBe("r1");
    expect(map.get("u3")?.roomKey).toBe("r2");
    expect(map.get("u4")).toBeUndefined();
  });

  it("keeps the first room when a stale row lists the same person twice", () => {
    const map = roomsByMember([room("r1", ["u1"]), room("r2", ["u1"])]);
    expect(map.get("u1")?.roomKey).toBe("r1");
  });

  it("survives a room with no members array", () => {
    expect(roomsByMember([{ roomKey: "r1" } as any]).size).toBe(0);
  });
});

describe("unreadBadgeText", () => {
  it("prints the count, and stops counting past 99", () => {
    expect(unreadBadgeText(1)).toBe("1");
    expect(unreadBadgeText(99)).toBe("99");
    expect(unreadBadgeText(100)).toBe("99+");
  });
});

describe("the roster's sections (groupMembersByBand, reused from presence)", () => {
  it("cuts the roster the way the panel prints it and drops empty sections", () => {
    const groups = groupMembersByBand([
      member({ _id: "u1", name: "Zoe" }),
      member({ _id: "u2", name: "Ann", presence_state: "idle" }),
      member({ _id: "u3", name: "Bo", presence_state: "away" }),
      member({ _id: "u4", name: "Cy", presence_state: "offline" }),
      member({ _id: "u5", name: "Al", status: "busy" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Online", "Idle", "Away", "Offline"]);
    // Busy sits under Online, and a section is ordered by name, not presence.
    expect(groups[0].members.map((m: any) => m.name)).toEqual(["Al", "Zoe"]);
  });
});

describe("isStrayWorkspace", () => {
  const teams = [{ _id: "t1" }, { _id: "t2" }];

  it("is false while the pointer names a team the viewer is in", () => {
    expect(isStrayWorkspace(teams, "t1")).toBe(false);
    expect(isStrayWorkspace(teams, "t2")).toBe(false);
  });

  it("is true for a pointer at a team they have left", () => {
    expect(isStrayWorkspace(teams, "t9")).toBe(true);
  });

  it("stays false until the real team list has arrived", () => {
    // An empty list means "not told yet", never "you belong to none" — reporting
    // a stray pointer on the strength of not knowing would fire on every boot.
    expect(isStrayWorkspace([], "t9")).toBe(false);
    expect(isStrayWorkspace(null, "t9")).toBe(false);
    expect(isStrayWorkspace(undefined, "t9")).toBe(false);
  });

  it("is false with no pointer at all — the personal workspace is not stray", () => {
    expect(isStrayWorkspace(teams, undefined)).toBe(false);
    expect(isStrayWorkspace(teams, null)).toBe(false);
    expect(isStrayWorkspace(teams, "")).toBe(false);
  });

  it("compares ids as strings, not by reference", () => {
    expect(isStrayWorkspace([{ _id: { toString: () => "t1" } }], "t1")).toBe(false);
    expect(isStrayWorkspace([{ _id: null }], "t1")).toBe(true);
  });
});
