import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "../testDb";
import { spendCapUntil, spendCapsOf, weeklyLimitUntil, withSpendCap } from "./spendCaps";

describe("spendCapUntil — a spend-limit park names the week that lifts it", () => {
  const ts = Date.UTC(2026, 10, 12, 23, 44);
  test("reads the org form's weekly reset in UTC", () => {
    const banner = "You've hit your org's monthly spend limit · ask your admin to raise it at https://claude.ai/admin-settings/usage · your weekly limit resets Nov 19, 5am (UTC)";
    expect(spendCapUntil(banner, ts)).toBe(Date.UTC(2026, 10, 19, 5));
  });
  test("resolves a named zone and rolls into next year", () => {
    const banner = "You've hit your monthly spend limit · your weekly limit resets Jan 2, 5:30pm (America/New_York)";
    expect(spendCapUntil(banner, Date.UTC(2026, 11, 30))).toBe(Date.UTC(2027, 0, 2, 22, 30));
  });
  test("ignores other limit banners", () => {
    expect(spendCapUntil("You've hit your weekly limit · resets Nov 19, 5am (UTC)", ts)).toBeUndefined();
  });
});

describe("weeklyLimitUntil — a weekly park names the week that is already spent", () => {
  const ts = Date.UTC(2026, 10, 12, 23, 44);
  test("reads the dated reset, with or without 'at'", () => {
    expect(weeklyLimitUntil("You've hit your weekly limit · resets Nov 19, 7pm (UTC)", ts)).toBe(Date.UTC(2026, 10, 19, 19));
    expect(weeklyLimitUntil("You've hit your weekly limit · resets Nov 16 at 1pm (America/New_York)", ts)).toBe(Date.UTC(2026, 10, 16, 18));
    expect(weeklyLimitUntil("You’ve hit your weekly limit · resets Nov 19, 5am (UTC)", ts)).toBe(Date.UTC(2026, 10, 19, 5));
  });
  test("rolls into next year", () => {
    expect(weeklyLimitUntil("You've hit your weekly limit · resets Jan 2, 5:30pm (America/New_York)", Date.UTC(2026, 11, 30))).toBe(Date.UTC(2027, 0, 2, 22, 30));
  });
  test("ignores a Fable banner, a 5-hour banner, a dateless weekly line, and a spend banner", () => {
    expect(weeklyLimitUntil("You've reached your Fable limit. Run /usage-credits to continue or switch models with /model.", ts)).toBeUndefined();
    expect(weeklyLimitUntil("You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.", ts)).toBeUndefined();
    expect(weeklyLimitUntil("You've hit your 5-hour limit · resets 5:50am (UTC)", ts)).toBeUndefined();
    expect(weeklyLimitUntil("You've hit your session limit · resets 11:30pm (America/New_York)", ts)).toBeUndefined();
    expect(weeklyLimitUntil("You've hit your weekly limit · resets 7am (UTC)", ts)).toBeUndefined();
    expect(weeklyLimitUntil("You've hit your org's monthly spend limit · your weekly limit resets Nov 19, 5am (UTC)", ts)).toBeUndefined();
  });
});

describe("withSpendCap — the printed reset marks that account", () => {
  const until = Date.UTC(2026, 10, 19, 19);
  const profiles = [
    { name: "claude7", usage: { weekly: { resets_at: until } } },
    { name: "mike", usage: { weekly: { resets_at: until + 3 * 24 * 3600_000 } } },
    { name: "empty", usage: { session: { percent: 0 } } },
  ];
  test("blocks the account whose week resets with the banner, and no other", () => {
    const marked = withSpendCap(profiles, [until]);
    expect(marked[0].usage.blocked_until).toBe(until);
    expect(marked[1].usage.blocked_until).toBeUndefined();
    expect(marked[2].usage.blocked_until).toBeUndefined();
  });
});

describe("spendCapsOf — an earlier weekly banner still blocks after a later hop", () => {
  test("keeps the weekly reset when the newest banner is a 5-hour limit", async () => {
    const now = Date.UTC(2026, 10, 13, 0, 50);
    const weekly = "You've hit your weekly limit · resets Nov 19, 7pm (UTC)";
    const session = "You've hit your 5-hour limit · resets 5:50am (UTC)";
    const db = makeFakeDb({
      conversations: [{ _id: "c1", user_id: "users_a", pending_api_error: true, pending_api_error_kind: "limit" }],
      messages: [
        { _id: "m1", conversation_id: "c1", role: "assistant", content: weekly, timestamp: now - 30 * 60_000 },
        { _id: "m2", conversation_id: "c1", role: "assistant", content: session, timestamp: now - 60_000 },
      ],
    });
    expect(await spendCapsOf({ db }, "users_a" as any, now)).toEqual([Date.UTC(2026, 10, 19, 19)]);
  });
});
