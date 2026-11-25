// /priorities as pure functions: each owner's order, the person's pending
// writes painted over the server's rows, and a refused write taking itself back.
// Run: bun test lib/__tests__/priorities.test.ts
import { describe, expect, test } from "bun:test";
import type { PriorityStep } from "@codecast/shared/contracts/priorities";
import {
  behindLabel, listMeta, listRows, mostActiveSessions, passDue, newSessionHref, nextPassLabel, ownerGroups, stepNeedsSession, paintRank, paintStatus, paintTier, pastBadge, rankAtDrop, stepCounts, stepSessions, writeOrRestore,
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
    rank_set_by: "pass",
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
      row("pri-3", { rank: 2 }),
      row("pri-1", { rank: 1 }),
      row("pri-9", { status: "set_aside" }),
      row("pri-7", { status: "quiet", last_active_at: 5 }),
      row("pri-8", { status: "done", done_at: 10 }),
      row("pri-4", { status: "merged" }),
      row("pri-5", { rank: 1, user_id: "ash" as any, owner: "Ashot", mine: false }),
    ];
    const groups = ownerGroups(rows);
    expect(groups.map((g) => g.owner)).toEqual(["Jason", "Ashot"]);
    expect(ids(groups[0].active)).toEqual(["pri-1", "pri-3"]);
    expect(ids(groups[0].past)).toEqual(["pri-8", "pri-7", "pri-9"]);
    expect(ids(groups[1].active)).toEqual(["pri-5"]);
  });
});

describe("the store actions' paints", () => {
  const fresh = () => [row("pri-1", { rank: 1 }), row("pri-2", { rank: 2 }), row("pri-3", { rank: 3 }), row("pri-4", { rank: 1, user_id: "ash" as any, mine: false })];

  test("a dragged rank moves the row among its owner's active ones only, and marks it the person's", () => {
    const rows = fresh();
    paintRank(rows, "pri-3", rankAtDrop(0));
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-3", "pri-1", "pri-2"]);
    expect(rows.find((r) => r.short_id === "pri-3")!.rank_set_by).toBe("person");
    expect(rows.find((r) => r.short_id === "pri-4")!.rank).toBe(1);
  });

  test("a rank past the end lands last", () => {
    const rows = fresh();
    paintRank(rows, "pri-1", 99);
    expect(ids(ownerGroups(rows)[0].active)).toEqual(["pri-2", "pri-3", "pri-1"]);
  });

  test("a step dragged across the line changes tier and the critical count follows", () => {
    const r = row("pri-1", { rank: 1, steps: [step("s1", "critical", true), step("s2", "critical"), step("s3", "polish")] });
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
  const r = row("pri-1", {
    title: "Trusted evals",
    steps: [s],
    sessions: [
      { short_id: "jx1", title: "Grader", step_key: "s1", updated_at: 5 },
      { short_id: "jx3", title: "Other", step_key: "s2", updated_at: 9 },
    ],
  });

  test("a step's sessions are those mapped to it, then those its refs name", () => {
    expect(stepSessions(r, s).map((x) => x.short_id)).toEqual(["jx1", "jx2"]);
  });

  test("once the open row's show answers, a step's sessions are every one show maps to it", () => {
    const detail = { ...r, steps: [{ ...s, sessions: [{ short_id: "jx9", title: "Older", step_key: "s1", updated_at: 1 }] }], other_sessions: [] } as any;
    expect(stepSessions(r, s, detail).map((x) => x.short_id)).toEqual(["jx9", "jx2"]);
    const bare = step("s5", "critical");
    // The list's newest few cannot say a step has no session; show can.
    expect(stepNeedsSession(r, bare, stepSessions(r, bare), undefined)).toBe(false);
    expect(stepNeedsSession(r, bare, stepSessions(r, bare, detail), detail)).toBe(true);
    expect(stepNeedsSession(r, { ...bare, done: true }, [], detail)).toBe(false);
    // Never on a teammate's priority: starting their work is theirs to do.
    expect(stepNeedsSession({ mine: false }, bare, [], detail)).toBe(false);
    expect(mostActiveSessions(r, undefined, { ...detail, sessions: [{ short_id: "jx9", title: "Older", step_key: "s1", updated_at: 99 }] }).map((x) => x.short_id)).toEqual(["jx9"]);
  });

  test("+ new session opens the composer on the priority and step, its task attached", () => {
    const href = newSessionHref(r, s);
    expect(parseComposeLink(new URLSearchParams(href.split("?")[1]))).toEqual({ draft: "Trusted evals: Step s1", task: "ct-12" });
    expect(parseComposeLink(new URLSearchParams(newSessionHref(r, step("s9", "polish")).split("?")[1]))).toEqual({ draft: "Trusted evals: Step s9" });
  });

  test("a step's strip sums its sessions' days; none without per-session counts", () => {
    const history = { days: ["2026-11-22", "2026-11-23"], lanes: [], sessions: { jx1: [1, 2], jx2: [3, 0] } };
    expect(stepCounts(history, stepSessions(r, s))).toEqual([4, 2]);
    expect(stepCounts({ days: history.days, lanes: [] }, stepSessions(r, s))).toBeUndefined();
  });

  test("most active sessions by typing, else most recently updated", () => {
    expect(mostActiveSessions(r, undefined).map((x) => x.short_id)).toEqual(["jx3", "jx1"]);
    expect(mostActiveSessions(r, { days: ["d"], lanes: [], sessions: { jx1: [7] } }).map((x) => x.short_id)).toEqual(["jx1", "jx3"]);
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
