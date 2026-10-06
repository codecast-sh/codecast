import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "../testDb";
import { teamDayBounds, teamDayFor, teamTimezone } from "./teamDay";

describe("teamTimezone", () => {
  const TEAM = "team_1" as any;
  const seed = (team: Record<string, any>, members: Array<[string, "admin" | "member", number, string | undefined]>) => ({
    db: makeFakeDb({
      teams: [{ _id: TEAM, name: "T", ...team }],
      team_memberships: members.map(([user_id, role, joined_at], i) => ({ _id: `m${i}`, team_id: TEAM, user_id, role, joined_at })),
      users: members.map(([user_id, , , timezone]) => ({ _id: user_id, name: user_id, timezone })),
    }),
  });

  test("teams.timezone wins", async () => {
    const ctx = seed({ timezone: "Asia/Tokyo" }, [["u1", "admin", 1, "America/New_York"]]);
    expect(await teamTimezone(ctx, TEAM)).toBe("Asia/Tokyo");
  });

  test("else the earliest admin with a real zone; members never count", async () => {
    const ctx = seed({}, [
      ["member_early", "member", 0, "Asia/Tokyo"],
      ["admin_late", "admin", 3, "Europe/Paris"],
      ["admin_no_zone", "admin", 1, undefined],
      ["admin_bad_zone", "admin", 2, "Mars/Olympus"],
    ]);
    expect(await teamTimezone(ctx, TEAM)).toBe("Europe/Paris");
  });

  test("an unknown teams.timezone falls through to the admins", async () => {
    const ctx = seed({ timezone: "Nope/Nope" }, [["u1", "admin", 1, "Europe/Paris"]]);
    expect(await teamTimezone(ctx, TEAM)).toBe("Europe/Paris");
  });

  test("UTC when nobody has a zone", async () => {
    const ctx = seed({}, [["u1", "admin", 1, undefined]]);
    expect(await teamTimezone(ctx, TEAM)).toBe("UTC");
    const day = await teamDayFor(ctx, TEAM, Date.parse("2026-10-02T23:30:00Z"));
    expect(day).toMatchObject({ date: "2026-10-02", timezone: "UTC" });
  });

  test("teamDayFor and teamDayBounds read the team's zone", async () => {
    const ctx = seed({}, [["u1", "admin", 1, "America/Los_Angeles"]]);
    const day = await teamDayFor(ctx, TEAM, Date.parse("2026-10-03T03:00:00Z"));
    expect(day.date).toBe("2026-10-02");
    expect(await teamDayBounds(ctx, TEAM, "2026-10-02")).toEqual(day);
  });
});
