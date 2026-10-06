import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { rollUpUsage } from "./messages";
import { dayStartUtc } from "./lib/userSend";
import { fetchUserUsageDays, FOLD_DELAY_MS, turnCost } from "./lib/usageDaily";
import { makeFakeDb } from "./testDb";
import { fold } from "./usageDays";

const DAY = 24 * 3600000;
const T = Date.now() - 2 * DAY;
const turn = (id: string, timestamp: number, model = "claude-opus-5-5") => ({
  usage: { input_tokens: 10, output_tokens: 1000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 10_000 },
  api_message_id: id,
  inserted: true,
  model,
  timestamp,
});

function setup(conversations: any[]) {
  const db = makeFakeDb({ users: [{ _id: "users_owner", active_team_id: "teams_t" }], conversations, usage_pending: [], user_usage_daily: [] });
  const scheduled: any[] = [];
  const ctx = { db, scheduler: { async runAfter(delay: number, fn: any, args: any) { scheduled.push({ delay, fn, args }); } } };
  return { db, ctx, scheduled };
}

test("a session's turns land on their own days, never on the person's shared row inside the insert", async () => {
  const conv = { _id: "conversations_a", user_id: "users_owner", team_id: "teams_t", _creationTime: T - DAY };
  const { db, ctx, scheduled } = setup([conv]);
  await rollUpUsage(ctx, conv, [turn("m1", T), turn("m2", T - DAY)], {}, Date.now());
  await rollUpUsage(ctx, conv, [turn("m3", T + 60_000)], {}, Date.now());
  expect(db._tables.user_usage_daily).toHaveLength(0);
  expect(db._tables.usage_pending).toHaveLength(2);
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0].delay).toBe(FOLD_DELAY_MS);
  expect(getFunctionName(scheduled[0].fn)).toBe("usageDays:fold");

  await (fold as any)._handler({ db }, scheduled[0].args);
  expect(db._tables.usage_pending).toHaveLength(0);
  const days = await fetchUserUsageDays({ db }, "users_owner" as any, "teams_t" as any, 30);
  const today = days.find((d) => d.day_start === dayStartUtc(T))!;
  expect(today.token_hours.reduce((a, b) => a + b, 0)).toBe(2 * 1_011_010);
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, one hour cache writes at $8.
  const one = (10 * 4 + 1000 * 20 + 1_000_000 * 0.2 + 10_000 * 8) / 1e6;
  expect(today.spend_hours.reduce((a, b) => a + b, 0)).toBeCloseTo(2 * one, 9);
  expect(days.find((d) => d.day_start === dayStartUtc(T - DAY))).toBeDefined();
});

test("a fork counts only turns after it was created, and an unpriced model adds tokens but no spend", async () => {
  const fork = { _id: "conversations_f", user_id: "users_owner", forked_from: "conversations_a", _creationTime: T };
  const { db, ctx, scheduled } = setup([fork]);
  await rollUpUsage(ctx, fork, [turn("copied", T - 1000), turn("own", T + 1000, "gpt-5-codex")], {}, Date.now());
  await (fold as any)._handler({ db }, scheduled[0].args);
  const [day] = await fetchUserUsageDays({ db }, "users_owner" as any, undefined, 30);
  expect(day.token_hours.reduce((a, b) => a + b, 0)).toBe(1_011_010);
  expect(day.spend_hours.reduce((a, b) => a + b, 0)).toBe(0);
  expect(db._tables.user_usage_daily[0].team_id).toBe("teams_t");
  expect(turnCost("claude-fable-5-1", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.25, 9);
});

test("the punchcard shows usage in the viewer's clock, alongside sends", async () => {
  const { bucketPunchcardRows } = await import("./lib/activityPunchcard");
  const day = Date.UTC(2026, 9, 5);
  const token_hours = new Array(24).fill(0);
  const spend_hours = new Array(24).fill(0);
  token_hours[2] = 1000;
  spend_hours[2] = 1.234;
  // UTC-4 (tz offset +240): 02:00 UTC is 22:00 the day before.
  const rows = bucketPunchcardRows([], 240, [], [{ day_start: day, token_hours, spend_hours }]);
  expect(rows).toHaveLength(1);
  expect(rows[0].date).toBe("2026-10-04");
  expect(rows[0].tokens[22]).toBe(1000);
  expect(rows[0].spend[22]).toBe(1.23);
});

test("the usage rebuild counts each turn once, includes subagents, and leaves rows inserted after it began to live counting", async () => {
  const { step } = await import("./sendBackfill");
  const u = (read: number) => ({ input_tokens: 1, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: 0 });
  const BEFORE = T + 10 * 60_000;
  const parent = { _id: "conversations_p", user_id: "users_owner", team_id: "teams_t", _creationTime: T - 1000, updated_at: T + 5000 };
  const sub = { _id: "conversations_s", user_id: "users_owner", team_id: "teams_t", _creationTime: T - 500, updated_at: T + 5000, parent_conversation_id: "conversations_p" };
  const msg = (id: string, conversation_id: string, timestamp: number, usage: any, created = timestamp) =>
    ({ _id: id, conversation_id, role: "assistant", timestamp, _creationTime: created, usage, model: "claude-sonnet-5-5", content: "x" });
  const db = makeFakeDb({
    users: [{ _id: "users_owner", active_team_id: "teams_t" }],
    conversations: [parent, sub],
    messages: [
      // One turn written as two records that repeat its usage block.
      msg("messages_1", "conversations_p", T, u(100)),
      msg("messages_2", "conversations_p", T + 1, u(100)),
      msg("messages_3", "conversations_p", T + 2, u(200)),
      // Inserted after the rebuild began: live counting owns it.
      msg("messages_4", "conversations_p", T + 3, u(300), BEFORE + 1),
      msg("messages_5", "conversations_s", T + 4, u(400)),
    ],
    usage_pending: [],
    user_usage_daily: [],
  });
  const scheduled: any[] = [];
  const ctx = { db, scheduler: { async runAfter(_d: number, fn: any, args: any) { scheduled.push({ fn, args }); } } };
  await (step as any)._handler(ctx, { after: T - DAY, before: BEFORE, run: "t", kind: "usage" });
  for (const job of scheduled.filter((j) => getFunctionName(j.fn) === "usageDays:fold")) await (fold as any)._handler({ db }, job.args);
  const [day] = await fetchUserUsageDays({ db }, "users_owner" as any, undefined, 30);
  expect(day.token_hours.reduce((a, b) => a + b, 0)).toBe(111 + 211 + 411);
});

test("a usage rebuild's wipe empties both usage tables and hands the walk the moment it finished", async () => {
  const { wipe } = await import("./sendBackfill");
  const db = makeFakeDb({
    usage_pending: [{ _id: "usage_pending_1", conversation_id: "conversations_a", day_start: 0, token_hours: [], spend_hours: [] }],
    user_usage_daily: [{ _id: "user_usage_daily_1", user_id: "users_owner", day_start: 0, token_hours: [], spend_hours: [], updated_at: 0 }],
    user_send_daily: [{ _id: "user_send_daily_1" }],
  });
  const scheduled: any[] = [];
  const ctx = { db, scheduler: { async runAfter(_d: number, fn: any, args: any) { scheduled.push({ fn, args }); } } };
  const startedAt = Date.now();
  await (wipe as any)._handler(ctx, { after: 0, before: startedAt - 60_000, run: "t", kind: "usage" });
  expect(db._tables.usage_pending).toHaveLength(0);
  expect(db._tables.user_usage_daily).toHaveLength(0);
  expect(db._tables.user_send_daily).toHaveLength(1);
  expect(getFunctionName(scheduled[0].fn)).toBe("sendBackfill:step");
  expect(scheduled[0].args.before).toBeGreaterThanOrEqual(startedAt);
});
