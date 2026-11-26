import { describe, expect, test } from "bun:test";
import type { TaskRow } from "@codecast/web/components/triggerTasks";
import { closeDetail, killReview, reviewedKill } from "./sessionVerbs";

// The real clock: a Kill review reads the session at the moment it is pressed.
const NOW = Date.now();
const ID = "c".repeat(32);
const settled = { _id: ID, title: "Fix the sync", message_count: 12, agent_status: "idle", updated_at: NOW - 60 * 60_000, last_heartbeat: NOW - 1000, is_idle: true };
const trigger = (title: string, status = "scheduled"): TaskRow =>
  ({ _id: title, title, prompt: "", status, schedule_type: "recurring", originating_conversation_id: ID }) as TaskRow;

describe("the line under the menu's Close", () => {
  test("says the web tooltip's words without repeating Close", () => {
    expect(closeDetail(settled, {}, NOW)).toBe("Stops it, back on Done or Needs you");
  });

  test("counts the armed triggers from the store's roster", () => {
    const tasks = [trigger("Daily digest"), trigger("CI check"), trigger("Old one", "completed")];
    expect(closeDetail(settled, { agentTasks: Object.fromEntries(tasks.map((t) => [t._id, t])) }, NOW)).toBe("Stops it, runs its 2 triggers out of sight, back on Done or Needs you");
  });

  test("a role's own session closes without a retire question", () => {
    expect(closeDetail({ ...settled, standing_role_id: "r1" }, {}, NOW)).toBe("Stops it, back on Needs you");
  });

  test("a send this phone has not seen land is a turn starting: it is set aside", () => {
    expect(closeDetail(settled, { pendingMessages: { [ID]: [{ _id: "m1", content: "hi", timestamp: NOW - 1000 }] } }, NOW)).toBe("Hides it, back on Done or Needs you");
  });

  test("a session waiting on a permission prompt says it still waits on you", () => {
    expect(closeDetail({ ...settled, awaiting_input: true }, {}, NOW)).toBe("Hides it; it still waits on you");
  });

  test("a lead whose subagent is mid-turn is set aside, as the gesture does", () => {
    const sub = { _id: "s".repeat(32), session_id: "agent-a0a0a0737562", message_count: 3, agent_status: "working", updated_at: NOW - 1000, last_heartbeat: NOW - 500, parent_conversation_id: ID };
    expect(closeDetail(settled, { sessions: { [sub._id]: sub } }, NOW)).toBe("Hides it, back on Done or Needs you");
  });

  test("a lead with finished subagents names them; a spawned child stays up, uncounted", () => {
    const kid = (id: string, sessionId: string) => ({ _id: id, session_id: sessionId, message_count: 3, agent_status: "idle", updated_at: NOW - 60 * 60_000, last_heartbeat: NOW - 1000, is_subagent: true, parent_conversation_id: ID });
    const sessions = { a: kid("a", "agent-a0a0a031"), b: kid("b", "agent-a0a0a032"), c: kid("c", "ca19ce3d-spawned") };
    expect(closeDetail(settled, { sessions }, NOW)).toBe("Stops it and the 2 agents under it, back on Done or Needs you");
  });
});

describe("what Kill asks first", () => {
  test("nothing to cancel: no review, the kill goes behind the undo bar", () => {
    expect(killReview(settled, [trigger("Done", "completed")])).toBe(null);
  });

  test("names the triggers it cancels", () => {
    const r = killReview(settled, [trigger("Daily digest"), trigger("CI check")])!;
    expect(r.title).toBe("Kill session: Fix the sync");
    expect(r.message).toContain("Triggers: 2 triggers canceled (Daily digest, CI check)");
    expect(r.confirm).toBe("Kill it");
    expect(r.keep).toBe("Keep it");
  });

  test("names the queued messages it drops", () => {
    const message = killReview({ ...settled, has_pending: true }, [])!.message;
    expect(message).toContain("Queued: Messages dropped");
    expect(message).not.toContain("Triggers");
  });

  test("names the turn it cuts off", () => {
    const r = killReview({ ...settled, is_idle: false }, [])!;
    expect(r.message).toContain("Lost: Unfinished turns");
    expect(r.keep).toBe("Keep running");
  });

  test("names what else it cuts off: a question waiting on you, background work", () => {
    expect(killReview({ ...settled, awaiting_input: true }, [])!.message).toContain("Lost: Questions waiting on you");
    const bg = { ...settled, open_tasks_at: NOW - 1000, open_tasks: [{ id: "b1" }], last_heartbeat: NOW - 1000 };
    expect(killReview(bg as any, [])!.message).toContain("Lost: Background work");
  });
});

describe("one reviewed Kill for every phone surface (the menu, a Stashed row)", () => {
  const run = (row: typeof settled & Record<string, unknown>, tasks: TaskRow[]) => {
    const calls: string[] = [];
    let confirm: (() => void) | null = null;
    reviewedKill(row, tasks, { hold: (id) => calls.push(`hold ${id}`), ask: (r, c) => { calls.push(`ask ${r.title}`); confirm = c; } });
    return { calls, confirm: () => (confirm as (() => void) | null)?.() };
  };

  test("a set-aside session mid-turn asks first, and kills only on confirm", () => {
    const k = run({ ...settled, is_idle: false }, []);
    expect(k.calls).toEqual(["ask Kill session: Fix the sync"]);
    k.confirm();
    expect(k.calls).toEqual(["ask Kill session: Fix the sync", `hold ${ID}`]);
  });

  test("a session with nothing to lose goes straight behind the undo bar", () => {
    expect(run(settled, []).calls).toEqual([`hold ${ID}`]);
  });
});
