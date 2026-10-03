import { expect, test } from "bun:test";
import { getFunctionName } from "convex/server";
import { dayStartUtc, maybeRecordUserSend, scheduleUserSend } from "./lib/userSend";
import { makeFakeDb } from "./testDb";
import { record } from "./userSends";

test("transcript sends do not read or write the shared daily counter", async () => {
  const conversation = { _id: "conversations_a", user_id: "users_owner", team_id: "teams_team" } as any;
  const db = makeFakeDb({ conversations: [conversation], user_send_daily: [] });
  const scheduled: Array<{ fn: any; args: any }> = [];
  const ctx = {
    db: { ...db, query() { throw new Error("shared counter read inside transcript transaction"); } },
    scheduler: { async runAfter(_delay: number, fn: any, args: any) { scheduled.push({ fn, args }); } },
  };
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
  const conversation = { _id: "conversations_a", user_id: "users_owner" } as any;
  const db = makeFakeDb({ users: [{ _id: "users_owner", active_team_id: "teams_active" }], conversations: [conversation], user_send_daily: [] });
  const scheduled: any[] = [];
  const ctx = { db, scheduler: { async runAfter(_delay: number, _fn: any, args: any) { scheduled.push(args); } } };
  expect(await scheduleUserSend(ctx, conversation, { role: "assistant", content: "hello" }, 1)).toBe(false);
  expect(await scheduleUserSend(ctx, conversation, { role: "user", content: '<session-message from="jx12345">hello</session-message>' }, 1)).toBe(false);
  expect(await scheduleUserSend(ctx, conversation, { role: "user", content: "Backend B (ct-51438) review fixes: all five of mine fixed." }, 1)).toBe(false);
  expect(await scheduleUserSend(ctx, conversation, { role: "user", content: "hello", from_user_id: "users_sender" as any }, 1)).toBe(true);
  expect(scheduled).toEqual([{ conversation_id: "conversations_a", user_id: "users_sender", words: 1, by_person: false, timestamp: 1 }]);
  await (record as any)._handler({ db }, scheduled[0]);
  expect(db._tables.user_send_daily[0]).toMatchObject({ user_id: "users_sender", team_id: "teams_active", total: 1 });
});

test("historical backfills still increment their counters in the same transaction", async () => {
  const db = makeFakeDb({ user_send_daily: [] });
  const conversation = { user_id: "users_owner", team_id: "teams_team" } as any;
  expect(await maybeRecordUserSend({ db }, conversation, { role: "user", content: "hello" }, 1)).toBe(true);
  expect(db._tables.user_send_daily[0].total).toBe(1);
});

// Sessions a program starts carry its prompts as user turns. The opening
// prompts of a day of headless review runs read as 2.6 million typed words.
test("in a session a program launched, only a message a person queued counts", async () => {
  const launched = [
    { _id: "conversations_spawned", user_id: "users_owner", team_id: "teams_team", spawned_by_conversation_id: "conversations_lead" },
    { _id: "conversations_workflow", user_id: "users_owner", team_id: "teams_team", workflow_run_id: "workflow_runs_a" },
    { _id: "conversations_trigger", user_id: "users_owner", team_id: "teams_team", agent_task_id: "agent_tasks_a" },
    { _id: "conversations_headless", user_id: "users_owner", team_id: "teams_team", cli_flags: "--print" },
    { _id: "conversations_sub", user_id: "users_owner", team_id: "teams_team", parent_conversation_id: "conversations_lead" },
  ] as any[];
  const db = makeFakeDb({ user_send_daily: [] });
  for (const c of launched) {
    expect(await maybeRecordUserSend({ db }, c, { role: "user", content: "You are reviewing a broker agent's response" }, 1)).toBe(false);
    expect(await maybeRecordUserSend({ db }, c, { role: "user", content: "review the auth half", queued: "program" }, 1)).toBe(false);
  }
  expect(db._tables.user_send_daily).toHaveLength(0);
  expect(await maybeRecordUserSend({ db }, launched[0], { role: "user", content: "also check the tests", queued: "person" }, 1)).toBe(true);
  expect(db._tables.user_send_daily[0]).toMatchObject({ total: 1, words: 4 });
});

test("a message a program queued into a person's own session is not a send", async () => {
  const db = makeFakeDb({ user_send_daily: [] });
  const conversation = { _id: "conversations_a", user_id: "users_owner", team_id: "teams_team" } as any;
  expect(await maybeRecordUserSend({ db }, conversation, { role: "user", content: "pick up where the last run stopped", queued: "program" }, 1)).toBe(false);
  expect(await maybeRecordUserSend({ db }, conversation, { role: "user", content: "pick up where the last run stopped" }, 1)).toBe(true);
});

test("the launch link is read when the send is recorded, after it has landed", async () => {
  const conversation = { _id: "conversations_a", user_id: "users_owner", team_id: "teams_team" } as any;
  const db = makeFakeDb({ conversations: [conversation], user_send_daily: [] });
  const scheduled: Array<{ delay: number; args: any }> = [];
  const ctx = { db, scheduler: { async runAfter(delay: number, _fn: any, args: any) { scheduled.push({ delay, args }); } } };
  expect(await scheduleUserSend(ctx, conversation, { role: "user", content: "build the effort dial" }, 1)).toBe(true);
  expect(scheduled[0].delay).toBeGreaterThanOrEqual(60_000);
  await db.patch("conversations_a", { spawned_by_conversation_id: "conversations_lead" });
  await (record as any)._handler({ db }, scheduled[0].args);
  expect(db._tables.user_send_daily).toHaveLength(0);
});
