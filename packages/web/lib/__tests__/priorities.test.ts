// /priorities as pure functions: each owner's order, the person's pending
// writes painted over the server's rows, and a refused write taking itself back.
// Run: bun test lib/__tests__/priorities.test.ts
import { describe, expect, test } from "bun:test";
import type { PriorityStep } from "@codecast/shared/contracts/priorities";
import {
  behindLabel, listMeta, listRows, passDue, milestoneStartHref, nextPassLabel, ownerGroups, paintMove, paintStatus, paintTier, pastBadge, withLiveRanks, writeOrRestore,
  type PriorityRow,
} from "../priorities";
import { parseComposeLink } from "../composeLink";

const step = (key: string, tier: "critical" | "polish", done = false, refs: PriorityStep["refs"] = []): PriorityStep => ({ key, title: `Step ${key}`, tier, tier_set_by: "pass", refs, done });

function row(short_id: string, over: Partial<PriorityRow> = {}): PriorityRow {
  return {
    _id: `id-${short_id}` as any,
    short_id,
    title: `Title ${short_id}`,
    summary: "",
    status: "active",
    rank: null,
    person_pos: null,
    ai_rank: null,
    rank_source: "ai",
    serves: null,
    steps: [],
    counts: { critical_done: 0, critical_total: 0 },
    workspace: "team:t1",
    user_id: "me" as any,
    owner: "Jason",
    mine: true,
    first_seen_at: 0,
    last_active_at: 0,
    done_at: null,
    session_count: 0,
    sessions: [],
    ...over,
  } as PriorityRow;
}

const ids = (rows: PriorityRow[]) => rows.map((r) => r.short_id);

describe("ownerGroups", () => {
  test("the viewer's group first, active in rank order, then done, quiet and set aside", () => {
    const rows = [
      row("pri-3", { ai_rank: 2 }),
      row("pri-1", { ai_rank: 1 }),
      row("pri-9", { status: "set_aside" }),
      row("pri-7", { status: "quiet", last_active_at: 5 }),
      row("pri-8", { status: "done", done_at: 10 }),
      row("pri-4", { status: "merged" }),
      row("pri-5", { ai_rank: 1, user_id: "ash" as any, owner: "Ashot", mine: false }),
    ];
    const groups = ownerGroups(rows);
    expect(groups.map((g) => g.owner)).toEqual(["Jason", "Ashot"]);
    expect(ids(groups[0].active)).toEqual(["pri-1", "pri-3"]);
    expect(ids(groups[0].past)).toEqual(["pri-8", "pri-7", "pri-9"]);
    expect(ids(groups[1].active)).toEqual(["pri-5"]);
  });
});

describe("the store actions' paints", () => {
  const fresh = () => [row("pri-1", { ai_rank: 1 }), row("pri-2", { ai_rank: 2 }), row("pri-3", { ai_rank: 3 }), row("pri-4", { ai_rank: 1, user_id: "ash" as any, mine: false })];

  test("a drag places the row between its new neighbours, as the server's move does, among its owner's active ones only", () => {
    const rows = fresh();
    paintMove(rows, "pri-3", 1);
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-3", "pri-1", "pri-2"]);
    expect(withLiveRanks(rows).map((r) => [r.short_id, r.rank, r.person_pos, r.rank_source])).toEqual([
      ["pri-1", 2, null, "ai"], ["pri-2", 3, null, "ai"], ["pri-3", 1, 0, "person"], ["pri-4", 1, null, "ai"],
    ]);
  });

  test("past the end lands last; up and down step one place", () => {
    const rows = fresh();
    paintMove(rows, "pri-1", 99);
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-2", "pri-3", "pri-1"]);
    paintMove(rows, "pri-1", "up");
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-2", "pri-1", "pri-3"]);
    paintMove(rows, "pri-2", "down");
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-1", "pri-2", "pri-3"]);
    expect(withLiveRanks(rows).find((r) => r.short_id === "pri-2")!.rank).toBe(2);
  });

  test("a step dragged across the line changes tier and the critical count follows", () => {
    const r = row("pri-1", { ai_rank: 1, steps: [step("s1", "critical", true), step("s2", "critical"), step("s3", "polish")] });
    paintTier(r, "s2", "polish");
    expect(r.steps.map((s) => s.tier)).toEqual(["critical", "polish", "polish"]);
    expect(r.steps[1].tier_set_by).toBe("person");
    expect(r.counts).toEqual({ critical_done: 1, critical_total: 1 });
  });

  test("set aside leaves the ranking; restore comes back last", () => {
    const rows = fresh();
    paintStatus(rows, "pri-1", "set_aside");
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-2", "pri-3"]);
    expect(ids(ownerGroups(rows)[0].past)).toEqual(["pri-1"]);
    const back = [...fresh(), row("pri-6", { status: "quiet" })];
    paintStatus(back, "pri-6", "active");
    expect(ids(ownerGroups(back)[0].active)).toEqual(["pri-1", "pri-2", "pri-3", "pri-6"]);
    // Restored with the place after every ranked one, as the server writes it: no active priority is left without a place.
    expect(back.find((r) => r.short_id === "pri-6")!.ai_rank).toBe(4);
  });
});

describe("writeOrRestore", () => {
  const refused = (e: unknown) => String((e as Error)?.message).includes("Uncaught");
  async function run(error?: Error) {
    const restored: PriorityRow[][] = [];
    const errors: string[] = [];
    const before = [row("pri-3", { rank: 3 })];
    await writeOrRestore(async () => { if (error) throw error; }, before, (rows) => restored.push(rows), (m) => errors.push(m), refused);
    return { restored, errors, before };
  }

  test("a write that lands leaves its paint", async () => {
    expect(await run()).toMatchObject({ restored: [], errors: [] });
  });

  test("a refused write puts the rows back and reports the server's reason", async () => {
    const r = await run(new Error("[CONVEX M(dispatch:dispatch)] [Request ID: x] Server Error\nUncaught Error: pri-3 is Ashot's priority; only they can change it"));
    expect(r.restored).toEqual([r.before]);
    expect(r.errors).toEqual(["pri-3 is Ashot's priority; only they can change it"]);
  });

  test("a write still on its way keeps its paint", async () => {
    expect(await run(new Error("network down"))).toMatchObject({ restored: [], errors: [] });
  });
});

describe("steps", () => {
  const s = step("s1", "critical", false, [{ kind: "task", id: "ct-12" }, { kind: "session", id: "jx2" }, { kind: "pr", id: "acme/web#4" }]);
  const r = row("pri-1", { title: "Trusted evals", steps: [s] });

  test("Start opens the composer on a brief of live references, linked to the milestone and its plan", () => {
    const link = (href: string) => parseComposeLink(new URLSearchParams(href.split("?")[1]));
    const tasks: Record<string, { title: string; status: string }> = { "ct-12": { title: "Grader faults", status: "done" }, "ct-13": { title: "Seed the goals", status: "in_progress" } };
    const m = { step: step("s1", "critical", false, [{ kind: "task", id: "ct-12" }, { kind: "task", id: "ct-13" }, { kind: "task", id: "ct-14" }, { kind: "pr", id: "acme/web#4" }]), plan: { short_id: "pl-7" } };
    // A finished task is left out; one the store does not know goes by its id.
    expect(link(milestoneStartHref(r, m, (id) => tasks[id]))).toEqual({
      draft: "pri-1, milestone: Step s1\nOpen tasks:\n- ct-13 Seed the goals\n- ct-14\nPlan: pl-7\nRun `cast priorities show pri-1` for current detail.",
      task: "ct-13", priority: "pri-1", step: "s1", plan: "pl-7",
    });
    // No milestone plan: the priority's own. No task, no plan: the reference lines alone.
    expect(link(milestoneStartHref({ ...r, plan: { short_id: "pl-2" } }, { step: step("s9", "polish"), plan: null }, () => undefined))).toEqual({
      draft: "pri-1, milestone: Step s9\nPlan: pl-2\nRun `cast priorities show pri-1` for current detail.",
      priority: "pri-1", step: "s9", plan: "pl-2",
    });
    expect(link(milestoneStartHref(r, { step: step("s9", "polish") }, () => undefined))).toEqual({
      draft: "pri-1, milestone: Step s9\nRun `cast priorities show pri-1` for current detail.",
      priority: "pri-1", step: "s9",
    });
  });
});

test("finished reads won, quiet and set aside say so", () => {
  const day = new Date(2026, 10, 19, 12).getTime();
  expect(pastBadge({ status: "done", done_at: day, last_active_at: 0 })).toBe("✓ Done Nov 19");
  expect(pastBadge({ status: "quiet", done_at: null, last_active_at: day })).toBe("Quiet since Nov 19");
  expect(pastBadge({ status: "set_aside", done_at: null, last_active_at: day })).toBe("Set aside");
});

describe("the pass's timing", () => {
  test("a list answer's rows feed the store; its timing reads beside them", () => {
    const rows = [row("pri-1")];
    const answer = { priorities: rows, own_truncated: false, teammates_truncated: false, next_pass_at: 5, behind_by_ms: 7 };
    expect(listRows(answer)).toBe(rows);
    expect(listRows(null)).toBeUndefined();
    expect(listMeta(answer)).toEqual({ next_pass_at: 5, behind_by_ms: 7 });
    expect(listMeta(undefined)).toEqual({ next_pass_at: null, behind_by_ms: null });
    // A next pass that is due is a pass running now.
    expect(passDue({ next_pass_at: 5, behind_by_ms: null }, 5)).toBe(true);
    expect(passDue({ next_pass_at: 6, behind_by_ms: null }, 5)).toBe(false);
    expect(passDue({ next_pass_at: null, behind_by_ms: null }, 5)).toBe(false);
  });

  test("the header says behind only past six hours", () => {
    expect(behindLabel(undefined)).toBeNull();
    expect(behindLabel(6 * 3_600_000)).toBeNull();
    expect(behindLabel(8.5 * 3_600_000)).toBe("Behind by 8h");
  });

  test("the next pass reads as a time today, with its weekday on another day, and not once it has passed", () => {
    const now = new Date(2026, 10, 25, 10, 0).getTime();
    expect(nextPassLabel(new Date(2026, 10, 25, 15, 0).getTime(), now)).toBe("Next pass 3:00 PM");
    expect(nextPassLabel(new Date(2026, 10, 26, 1, 5).getTime(), now)).toBe("Next pass Thu 1:05 AM");
    expect(nextPassLabel(now - 1, now)).toBeNull();
    expect(nextPassLabel(null, now)).toBeNull();
  });
});
