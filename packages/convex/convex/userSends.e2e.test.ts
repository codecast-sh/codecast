import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { dayStartUtc, maybeRecordUserSend, scheduleUserSend } from "./lib/userSend";
import { makeFakeDb } from "./testDb";
import { record } from "./userSends";

test("transcript sends do not read or write the shared daily counter", async () => {
  const db = makeFakeDb({ user_send_daily: [] });
  const scheduled: Array<{ fn: any; args: any }> = [];
  const ctx = {
    db: { ...db, query() { throw new Error("shared counter read inside transcript transaction"); } },
    scheduler: { async runAfter(_delay: number, fn: any, args: any) { scheduled.push({ fn, args }); } },
  };
  const conversation = { user_id: "users_owner", team_id: "teams_team" } as any;
  const timestamp = 1_754_000_000_000;
  await Promise.all(Array.from({ length: 20 }, () => scheduleUserSend(ctx, conversation, { role: "user", content: "fix the build" }, timestamp)));
  expect(db._tables.user_send_daily).toHaveLength(0);
  expect(scheduled).toHaveLength(20);
  for (const job of scheduled) {
    expect(getFunctionName(job.fn)).toBe("userSends:record");
    await (record as any)._handler({ db }, job.args);
  }
  expect(db._tables.user_send_daily).toHaveLength(1);
  expect(db._tables.user_send_daily[0]).toMatchObject({ user_id: "users_owner", team_id: "teams_team", day_start: dayStartUtc(timestamp), total: 20 });
  expect(db._tables.user_send_daily[0].hours.reduce((a: number, b: number) => a + b, 0)).toBe(20);
});

test("deferred counting preserves sender and team attribution and excludes machine turns", async () => {
  const db = makeFakeDb({ users: [{ _id: "users_owner", active_team_id: "teams_active" }], user_send_daily: [] });
  const scheduled: any[] = [];
  const ctx = { db, scheduler: { async runAfter(_delay: number, _fn: any, args: any) { scheduled.push(args); } } };
  const conversation = { user_id: "users_owner" } as any;
  expect(await scheduleUserSend(ctx, conversation, { role: "assistant", content: "hello" }, 1)).toBe(false);
  expect(await scheduleUserSend(ctx, conversation, { role: "user", content: '<session-message from="jx12345">hello</session-message>' }, 1)).toBe(false);
  expect(await scheduleUserSend(ctx, conversation, { role: "user", content: "hello", from_user_id: "users_sender" as any }, 1)).toBe(true);
  expect(scheduled).toEqual([{ user_id: "users_sender", team_id: "teams_active", timestamp: 1 }]);
  await (record as any)._handler({ db }, scheduled[0]);
  expect(db._tables.user_send_daily[0]).toMatchObject({ user_id: "users_sender", team_id: "teams_active", total: 1 });
});

test("historical backfills still increment their counters in the same transaction", async () => {
  const db = makeFakeDb({ user_send_daily: [] });
  const conversation = { user_id: "users_owner", team_id: "teams_team" } as any;
  expect(await maybeRecordUserSend({ db }, conversation, { role: "user", content: "hello" }, 1)).toBe(true);
  expect(db._tables.user_send_daily[0].total).toBe(1);
});
