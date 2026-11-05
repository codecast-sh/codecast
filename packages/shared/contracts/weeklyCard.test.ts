import { describe, expect, test } from "bun:test";
import { buildWeekCard, deviceKindOf, publicWeekCard, TOKEN_HISTORY_START, weekBounds, weekRangeLabel, type WeekCardSession } from "./weeklyCard";

const H = 3_600_000;
const LA = "America/Los_Angeles";

describe("weekBounds", () => {
  test("last week is the Monday-to-Monday before the current one, in the person's zone", () => {
    // Tue Nov 3 2026, 10:00 in Los Angeles (PST, UTC-8).
    const now = Date.UTC(2026, 10, 3, 18);
    const last = weekBounds(now, LA, "last");
    expect(last.key).toBe("2026-10-26");
    // Mon Oct 26 00:00 PDT is 07:00 UTC; Mon Nov 2 00:00 PST is 08:00 UTC.
    expect(last.start).toBe(Date.UTC(2026, 9, 26, 7));
    expect(last.end).toBe(Date.UTC(2026, 10, 2, 8));
    // Sunday Nov 1 holds the clock change, so it is 25 hours long.
    expect(last.days[7] - last.days[6]).toBe(25 * H);
    expect(weekBounds(now, LA, "current").key).toBe("2026-11-02");
  });

  test("a Sunday night in Los Angeles is still that week there, though it is Monday in UTC", () => {
    const sundayNight = Date.UTC(2026, 10, 9, 6); // Sun Nov 8, 22:00 PST
    expect(weekBounds(sundayNight, LA, "current").key).toBe("2026-11-02");
    expect(weekBounds(sundayNight, "UTC", "current").key).toBe("2026-11-09");
  });

  test("Monday just after midnight starts a new week; ahead-of-UTC zones roll first", () => {
    const t = Date.UTC(2026, 10, 1, 23, 30); // Sun 23:30 UTC = Mon 08:30 in Tokyo
    expect(weekBounds(t, "Asia/Tokyo", "current").key).toBe("2026-11-02");
    expect(weekBounds(t, "UTC", "current").key).toBe("2026-10-26");
  });
});

describe("buildWeekCard", () => {
  const now = Date.UTC(2026, 10, 3, 18);
  const bounds = weekBounds(now, LA, "last");
  const mon = bounds.days[0];
  const s = (o: Partial<WeekCardSession>): WeekCardSession => ({ started_at: mon + 9 * H, updated_at: mon + 10 * H, agent_type: "claude_code", ...o });

  test("overlapping sessions count their hours once; days and agents split", () => {
    const card = buildWeekCard({
      bounds, tz: LA, now,
      sessions: [
        s({ device_id: "a" }),
        s({ started_at: mon + 9.5 * H, updated_at: mon + 11 * H, agent_type: "codex", device_id: "b" }),
        s({ started_at: bounds.days[2] + 14 * H, updated_at: bounds.days[2] + 15 * H, agent_type: "cursor", device_id: "a" }),
      ],
      devices: [{ device_id: "a", kind: "mac" }, { device_id: "b", kind: "cloud" }],
      tokenHours: [],
    });
    expect(card.sessions).toBe(3);
    expect(card.agent_hours).toBe(3);
    expect(card.active_days).toBe(2);
    expect(card.days[0]).toMatchObject({ hours: 2, sessions: 2 });
    expect(card.days[2]).toMatchObject({ hours: 1, sessions: 1 });
    expect(card.busiest_day).toBe(0);
    expect(card.agents.map((a) => a.name).sort()).toEqual(["Claude Code", "Codex", "Cursor"]);
    expect(card.machines).toEqual({ count: 2, kinds: [{ kind: "cloud", count: 1 }, { kind: "mac", count: 1 }] });
    expect(card.partial).toBe(false);
  });

  test("a session caps its credit at 8 hours and is clipped to the week", () => {
    const card = buildWeekCard({
      bounds, tz: LA, now,
      sessions: [s({ started_at: mon - 3 * 24 * H, updated_at: mon + 2 * H })],
      devices: [],
    });
    expect(card.sessions).toBe(1);
    expect(card.agent_hours).toBe(2);
  });

  test("sessions outside the week are not counted", () => {
    const card = buildWeekCard({
      bounds, tz: LA, now,
      sessions: [
        s({ started_at: bounds.end + H, updated_at: bounds.end + 2 * H }),
        s({ started_at: mon - 10 * H, updated_at: mon - 9 * H }),
        s({}),
      ],
      devices: [],
    });
    expect(card.sessions).toBe(1);
  });

  test("an empty week has no busiest day and zero hours", () => {
    const card = buildWeekCard({ bounds, tz: LA, now, sessions: [], devices: [] });
    expect(card).toMatchObject({ sessions: 0, agent_hours: 0, active_days: 0, busiest_day: -1 });
    expect(card.days).toHaveLength(7);
  });

  test("agents with no usage data still count; tokens are null when counters do not cover the week", () => {
    const card = buildWeekCard({
      bounds, tz: LA, now,
      sessions: [s({ agent_type: "opencode" }), s({ agent_type: "gemini" })],
      devices: [],
      tokenHours: [[mon + 9 * H, 1000], [bounds.end, 5]],
    });
    expect(card.agents).toHaveLength(2);
    expect(card.tokens).toBe(1000);

    const early = weekBounds(Date.UTC(2026, 8, 10), LA, "current");
    expect(early.start).toBeLessThan(TOKEN_HISTORY_START);
    expect(buildWeekCard({ bounds: early, tz: LA, now, sessions: [], devices: [], tokenHours: [[early.start + H, 50]] }).tokens).toBeNull();
    expect(buildWeekCard({ bounds, tz: LA, now, sessions: [], devices: [] }).tokens).toBeNull();
  });

  test("private sessions lend no project name; the public card drops what the owner left off", () => {
    const card = buildWeekCard({
      bounds, tz: LA, now,
      sessions: [s({ project: "codecast" }), s({ project: "secret", private: true }), s({ project: "codecast" })],
      devices: [],
      tokenHours: [[mon, 7]],
    });
    expect(card.projects).toEqual([{ name: "codecast", sessions: 2 }]);
    const pub = publicWeekCard(card, {});
    expect(pub.projects).toEqual([]);
    expect(pub.tokens).toBeNull();
    expect(publicWeekCard(card, { show_projects: true, show_tokens: true }).tokens).toBe(7);
  });

  test("the current week is marked partial", () => {
    const cur = weekBounds(now, LA, "current");
    expect(buildWeekCard({ bounds: cur, tz: LA, now, sessions: [], devices: [] }).partial).toBe(true);
  });
});

test("device kinds never use a hostname", () => {
  expect(deviceKindOf({ platform: "darwin" })).toBe("mac");
  expect(deviceKindOf({ platform: "linux", is_remote: true })).toBe("cloud");
  expect(deviceKindOf({ platform: "win32" })).toBe("windows");
  expect(deviceKindOf({ platform: "linux" })).toBe("linux");
});

test("range label spans months", () => {
  expect(weekRangeLabel({ week_start: Date.UTC(2026, 9, 26, 7), week_end: Date.UTC(2026, 10, 2, 8), tz: LA })).toBe("Oct 26 – Nov 1");
});
