// `cast priorities`: what each verb posts, and how a priority prints.
import { describe, expect, test } from "bun:test";
import { useCliHarness } from "./externalDataCli.testHarness.js";
import { clearWorkspaceCache } from "./resolveWorkspace.js";
import { formatHistory, formatPriorityDetail, formatPriorityLines, priorityId } from "./prioritiesCommand.js";
import type { PriorityRow } from "@codecast/shared/contracts/priorities";

const NOW = Date.UTC(2026, 10, 24, 18);
const HOUR = 3_600_000;

const row = (over: Partial<PriorityRow>): PriorityRow => ({
  _id: "p1", short_id: "pri-1", title: "Trusted evals", summary: "", status: "active", rank: 1, person_pos: null, ai_rank: 1, rank_source: "ai", serves: null, steps: [],
  counts: { critical_done: 3, critical_total: 6 }, workspace: "team:t1", user_id: "u1", owner: "Ada", owner_image: null, mine: true,
  first_seen_at: NOW - 30 * 24 * HOUR, last_active_at: NOW - 2 * HOUR, done_at: null, session_count: 0, session_count_more: false, sessions: [],
  status_set_by: "pass", correction_pending: false,
  ...over,
});

const FIXTURE: PriorityRow[] = [
  row({}),
  row({ short_id: "pri-4", title: "Priorities in Codecast", rank: 2, counts: { critical_done: 1, critical_total: 5 }, last_active_at: NOW - 20 * 60_000 }),
  row({ short_id: "pri-12", title: "Caller tools for the Delta desk that Charlie asked for last week", rank: null, status: "quiet", counts: { critical_done: 0, critical_total: 2 }, last_active_at: NOW - 9 * 24 * HOUR }),
  row({ short_id: "pri-7", title: "Deploy gate", rank: null, status: "done", done_at: Date.UTC(2026, 10, 19, 18), counts: { critical_done: 4, critical_total: 4 }, last_active_at: NOW - 5 * 24 * HOUR }),
  row({ short_id: "pri-9", title: "Eval loop", rank: 1, mine: false, owner: "Bea", counts: { critical_done: 2, critical_total: 3 }, last_active_at: NOW - 26 * HOUR }),
];

describe("output", () => {
  test("ls: one aligned line per priority: rank, id, title, critical path, status, last active", () => {
    const lines = formatPriorityLines(FIXTURE, NOW);
    expect(lines).toEqual([
      " #1  pri-1   Trusted evals                                     critical 3/6   active           2h ago",
      " #2  pri-4   Priorities in Codecast                            critical 1/5   active           20m ago",
      "  -  pri-12  Caller tools for the Delta desk that Charlie as…  critical 0/2   quiet            9d ago",
      "  -  pri-7   Deploy gate                                       critical 4/4   ✓ done Nov 19    5d ago",
      " #1  pri-9   Eval loop                                         critical 2/3   active           1d ago   · Bea",
    ]);
  });

  test("show: the rank says who placed it", () => {
    const detail = (over: Partial<PriorityRow>) => formatPriorityDetail({ ...row(over), steps: [], other_sessions: [], corrections: [] }, NOW)[1];
    expect(detail({ rank: 3, rank_source: "person", person_pos: 2.5 })).toBe("active · #3 (you placed it) · critical 3/6 · last active 2h ago");
    expect(detail({ rank: 2 })).toBe("active · #2 (ranked by AI) · critical 3/6 · last active 2h ago");
    expect(detail({ rank: 2, rank_source: null, mine: false, owner: "Bea" })).toContain("active · #2 · critical 3/6");
  });

  test("show: steps under Critical path and Polish, done ones ticked, with their refs and sessions", () => {
    const detail = formatPriorityDetail({
      ...row({ summary: "Grader faults are the last blocker.", serves: "in-5", session_count: 50, session_count_more: true }),
      steps: [
        { key: "s1", title: "Judge window", tier: "critical", tier_set_by: "pass", refs: [{ kind: "task", id: "ct-12" }], done: true, sessions: [{ short_id: "jx7abc1", title: "", step_key: "s1", updated_at: NOW }] },
        { key: "s2", title: "Grader faults under 10%", tier: "critical", tier_set_by: "person", refs: [{ kind: "pr", id: "acme/web#4" }], done: false, sessions: [] },
        { key: "s3", title: "Docs", title_set_by: "person", tier: "polish", tier_set_by: "pass", refs: [], done: false, sessions: [] },
      ],
      other_sessions: [{ short_id: "jx7zzz9", title: "", step_key: null, updated_at: NOW }],
      corrections: [{ _id: "c1", step_key: "s2", text: "The grader shipped already", status: "pending", created_at: NOW }],
    }, NOW);
    expect(detail).toEqual([
      "pri-1  Trusted evals",
      "active · #1 (ranked by AI) · critical 3/6 · serves in-5 · 50+ sessions · last active 2h ago",
      "Grader faults are the last blocker.",
      "",
      "Critical path",
      "  ✓ s1  Judge window  ct-12 · jx7abc1",
      "    s2  Grader faults under 10%  (yours)  acme/web#4",
      "",
      "Polish",
      "    s3  Docs  (yours)",
      "",
      "Other sessions  jx7zzz9",
      "",
      "Corrections",
      "  pending  s2  The grader shipped already  c1",
    ]);
  });

  test("history: a sparkline and a total per lane", () => {
    const lines = formatHistory({ days: ["2026-11-22", "2026-11-23", "2026-11-24"], lanes: [
      { key: "pri-1", short_id: "pri-1", title: "Trusted evals", status: "active", counts: [0, 2, 4], total: 6 },
      { key: "unassigned", short_id: null, title: "Unassigned", status: null, counts: [1, 0, 0], total: 1 },
    ] });
    expect(lines[1]).toContain("pri-1  Trusted evals");
    expect(lines[1]).toContain("6 typed");
    expect(lines[2]).toContain("Unassigned");
    expect(formatHistory({ days: ["2026-11-24"], lanes: [] })).toEqual(["Nothing typed in the last 1 days."]);
  });

  test("history: a teammate's lane names its owner, a cut read marks its total", () => {
    expect(formatHistory({ days: ["2026-11-23", "2026-11-24"], lanes: [
      { key: "pri-1", short_id: "pri-1", title: "Trusted evals", status: "active", counts: [3, 1], total: 4, truncated: true },
      { key: "pri-9", short_id: "pri-9", title: "Eval loop", status: "active", counts: [0, 2], total: 2, owner: "Bea" },
    ] })).toEqual([
      "                           11-23 → 11-24",
      "pri-1  Trusted evals       █▃  4+ typed",
      "pri-9  Eval loop      Bea  ▁█  2 typed",
    ]);
  });

  test("ids: pri-N in any case, or a bare number", () => {
    expect(priorityId("PRI-3")).toBe("pri-3");
    expect(priorityId("3")).toBe("pri-3");
  });
});

describe("cast priorities on the wire", () => {
  const h = useCliHarness("priorities", async () => (await import("./prioritiesCommand.js")).registerPrioritiesCommand);
  const roster = { teams: [{ _id: "t1", name: "Acme" }], active_team_id: "t1" };

  test("bare `cast priorities` lists the active team's active priorities; --all and --json widen and reshape", async () => {
    clearWorkspaceCache();
    h.answer = (p) => (p === "/cli/teams" ? roster : { priorities: FIXTURE.slice(0, 2) });
    await h.run();
    expect(h.calls.filter((c) => c.path !== "/cli/teams")).toEqual([{ path: "/cli/priorities/list", body: { status: "active", team_id: "t1" } }]);
    expect(h.out()).toContain("pri-4  Priorities in Codecast");
    h.calls.length = 0;
    h.logs.length = 0;
    await h.run("ls", "--all", "--json", "--team", "personal");
    expect(h.calls.filter((c) => c.path !== "/cli/teams")).toEqual([{ path: "/cli/priorities/list", body: { all: true, personal: true } }]);
    expect(JSON.parse(h.out()).map((r: any) => r.short_id)).toEqual(["pri-1", "pri-4"]);
  });

  test("before any pass it says when the first runs; a pass far behind says so above the list", async () => {
    clearWorkspaceCache();
    const now = Date.now();
    h.answer = (p) => (p === "/cli/teams" ? roster : { priorities: [], own_truncated: false, teammates_truncated: false, behind_by_ms: null, next_pass_at: now + 2 * HOUR + 60_000 });
    await h.run();
    expect(h.logs).toEqual(["No priorities yet — the first pass runs in 2h."]);
    h.logs.length = 0;
    h.answer = (p) => (p === "/cli/teams" ? roster : { priorities: FIXTURE.slice(0, 1), own_truncated: false, teammates_truncated: false, behind_by_ms: 8 * HOUR + 5 * 60_000, next_pass_at: now });
    await h.run();
    expect(h.logs[0]).toBe("Behind by 8h: the pass has not caught up with your newest work.");
    h.logs.length = 0;
    h.answer = (p) => (p === "/cli/teams" ? roster : { priorities: [], own_truncated: false, teammates_truncated: false, behind_by_ms: HOUR, next_pass_at: now });
    await h.run();
    expect(h.logs).toEqual(["No active priorities. cast priorities ls --all shows the rest."]);
  });

  test("the person's controls post what they name", async () => {
    clearWorkspaceCache();
    h.answer = (p, body) => (p === "/cli/teams" ? roster : p === "/cli/priorities/run" ? { scheduled: ["team:t1"], note: "A pass is running." } : row({ short_id: body.short_id, rank: body.to ?? 1 }));
    await h.run("rank", "pri-3", "2");
    await h.run("milestone", "tier", "3/S2", "--polish");
    await h.run("set-aside", "pri-3");
    await h.run("restore", "pri-3");
    await h.run("run");
    expect(h.calls.filter((c) => c.path !== "/cli/teams")).toEqual([
      { path: "/cli/priorities/move", body: { short_id: "pri-3", to: 2 } },
      { path: "/cli/priorities/step", body: { short_id: "pri-3", step_key: "s2", tier: "polish" } },
      { path: "/cli/priorities/set-aside", body: { short_id: "pri-3" } },
      { path: "/cli/priorities/restore", body: { short_id: "pri-3" } },
      { path: "/cli/priorities/run", body: { team_id: "t1" } },
    ]);
    expect(h.logs).toEqual(["ok pri-3 now #2", "ok pri-3/s2 -> polish", "ok pri-3 set aside", "ok pri-3 active", "A pass is running."]);
    h.logs.length = 0;
    await h.run("set-aside", "pri-3", "--json");
    expect(JSON.parse(h.out())).toMatchObject({ short_id: "pri-3", session_count: 0 });
  });

  test("overrides and corrections post what they name, milestones as pri-N/sK", async () => {
    clearWorkspaceCache();
    h.answer = (p, body) => (p === "/cli/priorities/correct" ? { _id: "c1", step_key: body.step_key ?? null, text: body.text, status: "pending", created_at: NOW } : p === "/cli/priorities/correction-delete" ? { deleted: "c1" } : row({ short_id: p === "/cli/priorities/merge" ? body.into : body.short_id ?? "pri-3" }));
    await h.run("milestone", "done", "pri-3/s1");
    await h.run("milestone", "undone", "pri-3/s1");
    await h.run("milestone", "rename", "pri-3/s2", "Judge", "window", "live");
    await h.run("milestone", "drop", "pri-3/s3");
    await h.run("rename", "3", "Grader", "in", "prod");
    await h.run("done", "pri-3");
    await h.run("merge", "pri-3", "--into", "4");
    await h.run("session", "move", "jx7abc1", "pri-3/s2");
    await h.run("session", "move", "jx7abc2", "pri-3");
    await h.run("session", "not-this", "jx7abc1");
    await h.run("correct", "pri-3/s2", "the", "grader", "already", "shipped");
    await h.run("correction", "delete", "c1");
    expect(h.calls).toEqual([
      { path: "/cli/priorities/milestone", body: { short_id: "pri-3", step_key: "s1", done: true } },
      { path: "/cli/priorities/milestone", body: { short_id: "pri-3", step_key: "s1", done: false } },
      { path: "/cli/priorities/milestone", body: { short_id: "pri-3", step_key: "s2", title: "Judge window live" } },
      { path: "/cli/priorities/milestone", body: { short_id: "pri-3", step_key: "s3", drop: true } },
      { path: "/cli/priorities/rename", body: { short_id: "pri-3", title: "Grader in prod" } },
      { path: "/cli/priorities/done", body: { short_id: "pri-3" } },
      { path: "/cli/priorities/merge", body: { short_id: "pri-3", into: "pri-4" } },
      { path: "/cli/priorities/session-move", body: { session: "jx7abc1", short_id: "pri-3", step_key: "s2" } },
      { path: "/cli/priorities/session-move", body: { session: "jx7abc2", short_id: "pri-3" } },
      { path: "/cli/priorities/session-not-this", body: { session: "jx7abc1" } },
      { path: "/cli/priorities/correct", body: { short_id: "pri-3", step_key: "s2", text: "the grader already shipped" } },
      { path: "/cli/priorities/correction-delete", body: { correction_id: "c1" } },
    ]);
    expect(h.logs).toEqual([
      "ok pri-3/s1 done", "ok pri-3/s1 not done", "ok pri-3/s2 renamed", "ok pri-3/s3 dropped", "ok pri-3 renamed", "ok pri-3 done", "ok pri-3 merged into pri-4",
      "ok jx7abc1 -> pri-3/s2", "ok jx7abc2 -> pri-3", "ok jx7abc1 is not part of pri-3",
      "ok correction c1 on pri-3/s2: the next pass reads it", "ok correction c1 deleted",
    ]);
  });

  test("a milestone verb needs pri-N/sK; nothing is posted otherwise", async () => {
    await expect(h.run("milestone", "done", "pri-3")).rejects.toThrow(/exit 1/);
    await expect(h.run("milestone", "drop", "pri-3/s1/x")).rejects.toThrow(/exit 1/);
    await expect(h.run("correct", "ct-3", "wrong")).rejects.toThrow(/exit 1/);
    expect(h.calls).toHaveLength(0);
  });

  test("a step needs exactly one tier, and a rank a whole number; nothing is posted otherwise", async () => {
    await expect(h.run("milestone", "tier", "pri-3/s2")).rejects.toThrow(/exit 1/);
    await expect(h.run("rank", "pri-3", "first")).rejects.toThrow(/exit 1/);
    await expect(h.run("show", "ct-3")).rejects.toThrow(/exit 1/);
    expect(h.calls).toHaveLength(0);
  });

  test("history sends the days and the local clock's offset", async () => {
    clearWorkspaceCache();
    h.answer = (p) => (p === "/cli/teams" ? roster : { days: ["2026-11-24"], lanes: [] });
    await h.run("history", "--days", "7");
    expect(h.calls.at(-1)).toEqual({ path: "/cli/priorities/history", body: { days: 7, tz_offset_minutes: new Date().getTimezoneOffset(), team_id: "t1" } });
  });
});
