import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { matchTaskTriggers } from "./agentTasks";

function trigger(_id: string, event_filter: any, status = "scheduled") {
  return {
    _id,
    user_id: "user_1",
    title: _id,
    prompt: "p",
    status,
    schedule_type: "event",
    event_filter,
    retry_count: 0,
    run_count: 0,
    created_at: 0,
    mode: "apply",
  };
}

function context(triggers: any[]) {
  return { db: makeFakeDb({ agent_tasks: triggers, conversations: [] }) } as any;
}

const run = (ctx: any, args: any) => (matchTaskTriggers as any)._handler(ctx, args);

describe("matchTaskTriggers", () => {
  test("a trigger bound to one pull request ignores the others", async () => {
    const ctx = context([
      trigger("bound", { event_type: "pr_check_failed", repository: "codecast-sh/codecast", pr_number: 12 }),
    ]);
    expect(await run(ctx, { event_type: "pr_check_failed", repository: "codecast-sh/codecast", pr_number: 99 })).toBe(0);
    expect(await run(ctx, { event_type: "pr_check_failed", repository: "codecast-sh/codecast", pr_number: 12 })).toBe(1);
    expect(ctx.db._tables.agent_tasks[0].run_at).toBeGreaterThan(0);
  });

  test("a trigger that names no pull request still fires for every one in the repository", async () => {
    const ctx = context([
      trigger("repo_wide", { event_type: "pr_check_failed", repository: "codecast-sh/codecast" }),
    ]);
    expect(await run(ctx, { event_type: "pr_check_failed", repository: "codecast-sh/codecast", pr_number: 99 })).toBe(1);
  });

  test("the raw GitHub shorthand keeps working", async () => {
    const ctx = context([
      trigger("legacy", { event_type: "pull_request", action: "opened", repository: "codecast-sh/codecast" }),
    ]);
    expect(await run(ctx, { event_type: "pull_request", action: "closed", repository: "codecast-sh/codecast" })).toBe(0);
    expect(await run(ctx, { event_type: "pull_request", action: "opened", repository: "codecast-sh/codecast", pr_number: 12 })).toBe(1);
  });

  test("a pull-request-bound trigger does not fire on an event with no pull request", async () => {
    const ctx = context([trigger("bound", { event_type: "push", repository: "codecast-sh/codecast", pr_number: 12 })]);
    expect(await run(ctx, { event_type: "push", repository: "codecast-sh/codecast" })).toBe(0);
  });

  test("only scheduled triggers fire", async () => {
    const ctx = context([
      trigger("paused", { event_type: "pr_approved", repository: "codecast-sh/codecast", pr_number: 12 }, "paused"),
    ]);
    expect(await run(ctx, { event_type: "pr_approved", repository: "codecast-sh/codecast", pr_number: 12 })).toBe(0);
  });
});

// ── Team scoping ──
//
// An event filter matches on strings a user chose, and "pr_approved" is a
// string every team writes. Without a team on the event, one team's PR activity
// woke another team's triggers: a private repository's CI failures started
// sessions belonging to people with no access to it.

function ownedTrigger(_id: string, user_id: string, event_filter: any) {
  return { ...trigger(_id, event_filter), user_id };
}

function teamContext(triggers: any[], memberships: any[]) {
  return { db: makeFakeDb({ agent_tasks: triggers, conversations: [], team_memberships: memberships }) } as any;
}

const TEAM_A = "team_a";
const TEAM_B = "team_b";

describe("matchTaskTriggers team scoping", () => {
  const filter = { event_type: "pr_approved", repository: "codecast-sh/codecast" };

  test("a trigger owned by someone outside the team does not fire", async () => {
    const ctx = teamContext(
      [ownedTrigger("outsider", "user_b", filter)],
      [{ _id: "m1", user_id: "user_a", team_id: TEAM_A }],
    );
    expect(await run(ctx, { ...filter, pr_number: 12, team_id: TEAM_A })).toBe(0);
    expect(ctx.db._tables.agent_tasks[0].run_at).toBeUndefined();
  });

  test("a trigger owned by a member of the team fires", async () => {
    const ctx = teamContext(
      [ownedTrigger("member", "user_a", filter)],
      [{ _id: "m1", user_id: "user_a", team_id: TEAM_A }],
    );
    expect(await run(ctx, { ...filter, pr_number: 12, team_id: TEAM_A })).toBe(1);
    expect(ctx.db._tables.agent_tasks[0].run_at).toBeGreaterThan(0);
  });

  test("the same event reaches only the owning team when both are armed", async () => {
    const ctx = teamContext(
      [ownedTrigger("in_a", "user_a", filter), ownedTrigger("in_b", "user_b", filter)],
      [
        { _id: "m1", user_id: "user_a", team_id: TEAM_A },
        { _id: "m2", user_id: "user_b", team_id: TEAM_B },
      ],
    );
    expect(await run(ctx, { ...filter, pr_number: 12, team_id: TEAM_B })).toBe(1);

    const rows = ctx.db._tables.agent_tasks;
    expect(rows.find((t: any) => t._id === "in_b").run_at).toBeGreaterThan(0);
    expect(rows.find((t: any) => t._id === "in_a").run_at).toBeUndefined();
  });

  test("an event with no team resolved keeps the old behaviour", async () => {
    // A repository with no installation resolves to no team. Refusing to fire
    // would silently break triggers that work today, so the filter stands alone.
    const ctx = teamContext([ownedTrigger("anyone", "user_b", filter)], []);
    expect(await run(ctx, { ...filter, pr_number: 12 })).toBe(1);
  });
});
