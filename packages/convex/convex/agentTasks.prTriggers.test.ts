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
