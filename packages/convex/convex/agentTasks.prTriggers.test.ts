import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { matchTaskTriggers, nextArmingAfterRun } from "./agentTasks";
import { PENDING_EVENTS_CAP } from "@codecast/shared/contracts/ingest";

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

function mappedContext(triggers: any[], memberships: any[], mappings: any[]) {
  const teams = [TEAM_A, TEAM_B].map((_id) => ({ _id, name: _id }));
  return { db: makeFakeDb({ agent_tasks: triggers, conversations: [], team_memberships: memberships, directory_team_mappings: mappings, teams }) } as any;
}

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

describe("matchTaskTriggers repository case", () => {
  test("a filter typed with capitals matches the canonical repository the webhook sends", async () => {
    const ctx = context([
      trigger("typed", { event_type: "pr_check_failed", repository: "Codecast-SH/Codecast" }),
    ]);
    expect(await run(ctx, { event_type: "pr_check_failed", repository: "codecast-sh/codecast", pr_number: 1 })).toBe(1);
    expect(await run(ctx, { event_type: "pr_check_failed", repository: "codecast-sh/other", pr_number: 1 })).toBe(0);
  });
});

// ── Ingestion events (external-data.md X4) ──
//
// A source narrows the ingestion names the way a repository narrows the pull
// request ones, and an event from a personal workspace has no team, so the
// workspace key is what keeps one person's product errors from waking another
// person's "any new error" trigger.

describe("matchTaskTriggers source filter", () => {
  test("a trigger that names a source fires only for it, in any spelling", async () => {
    const ctx = context([trigger("union_only", { event_type: "error_new", source: " Union " })]);
    expect(await run(ctx, { event_type: "error_new", source: "web" })).toBe(0);
    expect(await run(ctx, { event_type: "error_new" })).toBe(0);
    expect(await run(ctx, { event_type: "error_new", source: "union" })).toBe(1);
  });

  test("a trigger with no source fires for every source", async () => {
    const ctx = context([trigger("any", { event_type: "check_failed" })]);
    expect(await run(ctx, { event_type: "check_failed", source: "union" })).toBe(1);
    expect(await run(ctx, { event_type: "check_failed", source: "web" })).toBe(1);
  });

  test("a firing reads only the triggers armed on its name", async () => {
    const ctx = context([
      trigger("errors", { event_type: "error_new" }),
      trigger("jobs", { event_type: "job_failed" }),
    ]);
    expect(await run(ctx, { event_type: "job_failed", source: "union" })).toBe(1);
    const rows = ctx.db._tables.agent_tasks;
    expect(rows.find((t: any) => t._id === "jobs").run_at).toBeGreaterThan(0);
    expect(rows.find((t: any) => t._id === "errors").run_at).toBeUndefined();
  });
});

describe("matchTaskTriggers workspace scoping", () => {
  const filter = { event_type: "error_new" };

  test("a personal workspace event wakes only its owner", async () => {
    const ctx = teamContext([ownedTrigger("mine", "user_a", filter), ownedTrigger("theirs", "user_b", filter)], []);
    expect(await run(ctx, { ...filter, workspace: "user:user_a" })).toBe(1);
    const rows = ctx.db._tables.agent_tasks;
    expect(rows.find((t: any) => t._id === "mine").run_at).toBeGreaterThan(0);
    expect(rows.find((t: any) => t._id === "theirs").run_at).toBeUndefined();
  });

  test("a team workspace event wakes members only", async () => {
    const ctx = mappedContext(
      [{ ...ownedTrigger("member", "user_a", filter), project_path: "/src/a" }, { ...ownedTrigger("outsider", "user_b", filter), project_path: "/src/a" }],
      [{ _id: "m1", user_id: "user_a", team_id: TEAM_A }],
      [{ _id: "d1", user_id: "user_a", team_id: TEAM_A, path_prefix: "/src/a", auto_share: true }],
    );
    expect(await run(ctx, { ...filter, workspace: `team:${TEAM_A}` })).toBe(1);
    expect(ctx.db._tables.agent_tasks.find((t: any) => t._id === "member").run_at).toBeGreaterThan(0);
  });

  test("an owner in two teams is woken only by the team its trigger runs in", async () => {
    // Team B's error titles must not land in a run team A's members can read.
    const ctx = mappedContext(
      [
        { ...ownedTrigger("in_a", "user_a", filter), project_path: "/src/a" },
        { ...ownedTrigger("in_b", "user_a", filter), project_path: "/src/b" },
        ownedTrigger("personal", "user_a", filter),
      ],
      [{ _id: "m1", user_id: "user_a", team_id: TEAM_A }, { _id: "m2", user_id: "user_a", team_id: TEAM_B }],
      [
        { _id: "d1", user_id: "user_a", team_id: TEAM_A, path_prefix: "/src/a", auto_share: true },
        { _id: "d2", user_id: "user_a", team_id: TEAM_B, path_prefix: "/src/b", auto_share: true },
      ],
    );
    expect(await run(ctx, { ...filter, workspace: `team:${TEAM_B}`, event_ref: { title: "B's error" } })).toBe(1);
    const rows = ctx.db._tables.agent_tasks;
    expect(rows.find((t: any) => t._id === "in_b").pending_events).toHaveLength(1);
    expect(rows.find((t: any) => t._id === "in_a").pending_events).toBeUndefined();
    expect(rows.find((t: any) => t._id === "personal").pending_events).toBeUndefined();
    expect(await run(ctx, { ...filter, workspace: "user:user_a", event_ref: { title: "mine" } })).toBe(1);
    expect(rows.find((t: any) => t._id === "personal").pending_events).toHaveLength(1);
  });

  test("an unknown key variant wakes nobody", async () => {
    const ctx = teamContext([ownedTrigger("mine", "user_a", filter)], []);
    expect(await run(ctx, { ...filter, workspace: "restricted:x" })).toBe(0);
  });
});

describe("matchTaskTriggers pending events", () => {
  test("each firing is appended, so a run woken twice knows about both", async () => {
    const ctx = context([trigger("t", { event_type: "error_new" })]);
    await run(ctx, { event_type: "error_new", event_ref: { group_short_id: "eg-1", title: "TypeError: x" } });
    await run(ctx, { event_type: "error_new", event_ref: { group_short_id: "eg-2", title: "RangeError", url: "https://x" } });
    const pending = ctx.db._tables.agent_tasks[0].pending_events;
    expect(pending.map((e: any) => e.group_short_id)).toEqual(["eg-1", "eg-2"]);
    expect(pending[1]).toMatchObject({ event_type: "error_new", title: "RangeError", url: "https://x" });
    expect(pending[1].at).toBeGreaterThan(0);
  });

  test("the list is capped, keeping the newest", async () => {
    const ctx = context([trigger("t", { event_type: "error_new" })]);
    for (let i = 0; i < PENDING_EVENTS_CAP + 5; i++) {
      await run(ctx, { event_type: "error_new", event_ref: { group_short_id: `eg-${i}`, title: "e" } });
    }
    const pending = ctx.db._tables.agent_tasks[0].pending_events;
    expect(pending).toHaveLength(PENDING_EVENTS_CAP);
    expect(pending.at(-1).group_short_id).toBe(`eg-${PENDING_EVENTS_CAP + 4}`);
    expect(pending[0].group_short_id).toBe("eg-5");
  });

  test("an event that fires during a run is held for the run after, not lost", async () => {
    const ctx = context([trigger("t", { event_type: "error_new" }, "running")]);
    (ctx.db._tables.agent_tasks[0] as any).pending_events = [{ event_type: "error_new", title: "seen", at: 1 }];
    expect(await run(ctx, { event_type: "error_new", event_ref: { group_short_id: "eg-9", title: "late" } })).toBe(1);
    const row = ctx.db._tables.agent_tasks[0];
    expect(row.run_at).toBeUndefined();
    expect(row.pending_events.map((e: any) => [e.title, !!e.after_claim])).toEqual([["seen", false], ["late", true]]);
    // Completion keeps only the late one and is due again at once.
    expect(nextArmingAfterRun(row, 500)).toEqual({ status: "scheduled", run_at: 500, pending_events: [row.pending_events[1]] });
    expect(nextArmingAfterRun({ ...row, pending_events: [row.pending_events[0]] }, 500)).toMatchObject({ status: "scheduled", run_at: undefined, pending_events: undefined });
  });

  test("a running trigger is not read for a firing with no event", async () => {
    const ctx = context([trigger("t", { event_type: "pr_merged" }, "running")]);
    expect(await run(ctx, { event_type: "pr_merged" })).toBe(0);
  });

  test("a firing with no event ref leaves pending events alone", async () => {
    const ctx = context([trigger("t", { event_type: "pr_merged" })]);
    await run(ctx, { event_type: "pr_merged" });
    expect(ctx.db._tables.agent_tasks[0].pending_events).toBeUndefined();
  });
});
