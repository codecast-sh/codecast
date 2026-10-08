import { describe, expect, test } from "bun:test";
import {
  blockerLabel,
  blockersOf,
  dependencyLoopError,
  findPath,
  formatWaitTime,
  isReady,
  isUnblocked,
  parseBlockerRef,
  readinessOf,
  topoLayers,
  topologicalOrder,
  waitLabel,
  waitMetLabel,
  type DepNode,
  type TaskWait,
} from "./index";

const statuses: Record<string, string> = { "ct-1": "done", "ct-2": "dropped", "ct-3": "open", "ct-4": "in_progress" };
const statusOf = (id: string) => statuses[id];

const wait = (over: Partial<TaskWait> & Pick<TaskWait, "kind">): TaskWait =>
  ({ id: "w1", state: "waiting", created_at: 0, ...(over as any) }) as TaskWait;
const prWait = (state: TaskWait["state"] = "waiting") =>
  wait({ kind: "pr_merged", repository: "codecast-sh/codecast", pr_number: 42, state });

describe("blockersOf", () => {
  test("closed task blockers drop out; open ones stay in blocked_by order", () => {
    expect(blockersOf({ blocked_by: ["ct-4", "ct-1", "ct-3", "ct-2"] }, statusOf)).toEqual([
      { kind: "task", ref: "ct-4", status: "in_progress" },
      { kind: "task", ref: "ct-3", status: "open" },
    ]);
  });

  test("an id that resolves to nothing is reported missing", () => {
    expect(blockersOf({ blocked_by: ["ct-99"] }, statusOf)).toEqual([{ kind: "task", ref: "ct-99", missing: true }]);
  });

  test("waits follow task blockers; met waits drop out, failed ones stay", () => {
    const failed = { ...prWait("failed"), id: "w2" };
    const out = blockersOf({ blocked_by: ["ct-3"], waits: [prWait("met"), failed] }, statusOf);
    expect(out.map((b) => (b.kind === "task" ? b.ref : b.id))).toEqual(["ct-3", "w2"]);
  });

  test("duplicate refs count once", () => {
    expect(blockersOf({ blocked_by: ["ct-3", "ct-3"] }, statusOf)).toHaveLength(1);
  });

  test("a blocker absent from the caller's page still resolves through statusOf", () => {
    // The old list filter looked blockers up in a page that had already
    // dropped done tasks, so a finished blocker read as blocking.
    expect(isUnblocked({ blocked_by: ["ct-1"] }, statusOf)).toBe(true);
  });
});

describe("isUnblocked", () => {
  test("no blockers", () => expect(isUnblocked({}, statusOf)).toBe(true));
  test("missing ids do not block", () => expect(isUnblocked({ blocked_by: ["ct-99", "ct-1"] }, statusOf)).toBe(true));
  test("an open task blocks", () => expect(isUnblocked({ blocked_by: ["ct-3"] }, statusOf)).toBe(false));
  test("a waiting wait blocks", () => expect(isUnblocked({ waits: [prWait()] }, statusOf)).toBe(false));
  test("a failed wait keeps blocking", () => expect(isUnblocked({ waits: [prWait("failed")] }, statusOf)).toBe(false));
  test("a met wait does not", () => expect(isUnblocked({ waits: [prWait("met")] }, statusOf)).toBe(true));
});

describe("readiness", () => {
  const parents: Record<string, string> = { p_active: "in_progress", p_review: "in_review", p_open: "open" };
  const opts = { statusOf, parentStatusOf: (id: string) => parents[id] };

  test("open and unblocked is ready", () => expect(isReady({ status: "open" }, opts)).toBe(true));

  test("only open counts", () => {
    for (const status of ["backlog", "in_progress", "in_review", "done", "dropped", undefined]) {
      expect(readinessOf({ status }, opts)).toEqual({ ready: false, reason: "status" });
    }
  });

  test("triage must be active or unset", () => {
    expect(isReady({ status: "open", triage_status: "active" }, opts)).toBe(true);
    expect(readinessOf({ status: "open", triage_status: "suggested" }, opts)).toEqual({ ready: false, reason: "triage" });
    expect(isReady({ status: "open", triage_status: "dismissed" }, opts)).toBe(false);
  });

  test("superseded is not ready", () => {
    expect(readinessOf({ status: "open", superseded_by: "ct-3" }, opts)).toEqual({ ready: false, reason: "superseded" });
  });

  test("a subtask of a parent being worked waits unless subtasks are asked for", () => {
    expect(readinessOf({ status: "open", parent_id: "p_active" }, opts)).toEqual({ ready: false, reason: "parent_active" });
    expect(isReady({ status: "open", parent_id: "p_review" }, opts)).toBe(false);
    expect(isReady({ status: "open", parent_id: "p_active" }, { ...opts, includeSubtasks: true })).toBe(true);
  });

  test("an orphaned subtask stays ready", () => {
    expect(isReady({ status: "open", parent_id: "p_open" }, opts)).toBe(true);
    expect(isReady({ status: "open", parent_id: "p_gone" }, opts)).toBe(true);
  });

  test("blocked carries the blockers that hold it, not the missing ones", () => {
    const r = readinessOf({ status: "open", blocked_by: ["ct-3", "ct-99"], waits: [prWait()] }, opts);
    expect(r.ready).toBe(false);
    if (r.ready) return;
    expect(r.reason).toBe("blocked");
    expect(r.blockers!.map((b) => (b.kind === "task" ? b.ref : b.kind))).toEqual(["ct-3", "pr_merged"]);
  });
});

describe("parseBlockerRef", () => {
  const now = new Date(2026, 9, 8, 12, 0).getTime();
  const p = (s: string) => parseBlockerRef(s, now);

  test("tasks", () => {
    expect(p("ct-123")).toEqual({ ok: true, kind: "task", ref: "ct-123" });
    expect(p(" CT-7 ")).toEqual({ ok: true, kind: "task", ref: "ct-7" });
  });

  test("decisions", () => {
    expect(p("sd-412")).toEqual({ ok: true, kind: "decision", decision: "sd-412" });
    expect(p("SD-3")).toEqual({ ok: true, kind: "decision", decision: "sd-3" });
  });

  test("a bare #42 leaves the repository to the caller", () => {
    expect(p("#42")).toEqual({ ok: true, kind: "pr_merged", pr_number: 42 });
    expect(p("#42:checks")).toEqual({ ok: true, kind: "pr_checks_green", pr_number: 42 });
  });

  test("owner/repo#n is normalized", () => {
    expect(p("Codecast-SH/Codecast#42")).toEqual({ ok: true, kind: "pr_merged", repository: "codecast-sh/codecast", pr_number: 42 });
    expect(p("codecast-sh/codecast#42:ci")).toEqual({ ok: true, kind: "pr_checks_green", repository: "codecast-sh/codecast", pr_number: 42 });
    expect(p("codecast-sh/codecast#42:CHECKS").ok).toBe(true);
  });

  test("PR URLs, GitHub and codecast", () => {
    expect(p("https://github.com/codecast-sh/codecast/pull/42/files")).toEqual({ ok: true, kind: "pr_merged", repository: "codecast-sh/codecast", pr_number: 42 });
    expect(p("https://github.com/codecast-sh/codecast/pull/42:checks")).toEqual({ ok: true, kind: "pr_checks_green", repository: "codecast-sh/codecast", pr_number: 42 });
    expect(p("https://codecast.sh/pr/codecast-sh/codecast/9")).toEqual({ ok: true, kind: "pr_merged", repository: "codecast-sh/codecast", pr_number: 9 });
  });

  test("durations are relative to now", () => {
    expect(p("30m")).toEqual({ ok: true, kind: "time", at: now + 30 * 60_000 });
    expect(p("2h")).toEqual({ ok: true, kind: "time", at: now + 2 * 3_600_000 });
    expect(p("3d")).toEqual({ ok: true, kind: "time", at: now + 3 * 86_400_000 });
  });

  test("ISO dates are local midnight, datetimes local unless zoned", () => {
    expect(p("2026-10-14")).toEqual({ ok: true, kind: "time", at: new Date(2026, 9, 14).getTime() });
    expect(p("2026-10-14T09:00")).toEqual({ ok: true, kind: "time", at: new Date(2026, 9, 14, 9, 0).getTime() });
    expect(p("2026-10-14 09:00")).toEqual({ ok: true, kind: "time", at: new Date(2026, 9, 14, 9, 0).getTime() });
    expect(p("2026-10-14T09:00:00Z")).toEqual({ ok: true, kind: "time", at: Date.UTC(2026, 9, 14, 9) });
    expect(p("2026-10-14T09:00+02:00")).toEqual({ ok: true, kind: "time", at: Date.UTC(2026, 9, 14, 7) });
  });

  test("bad input says what is wrong", () => {
    const err = (s: string) => {
      const r = p(s);
      if (r.ok) throw new Error(`expected an error for ${s}`);
      return r.error;
    };
    expect(err("")).toContain("Empty blocker");
    expect(err("codecast-sh/codecast")).toContain("no pull request");
    expect(err("ct-12:checks")).toContain(":checks follows a pull request");
    expect(err("2026-02-30")).toContain("is not a blocker");
    expect(err("2026-01-01")).toContain("in the past");
    expect(err("tomorrowish")).toContain("is not a blocker");
    expect(err("30x")).toContain("is not a blocker");
    expect(err("0m")).toContain("is not a blocker");
  });
});

describe("words", () => {
  const now = new Date(2026, 9, 8, 12, 0).getTime(); // Thu Oct 8 2026, local
  const pr = { kind: "pr_merged", repository: "codecast-sh/codecast", pr_number: 42 } as const;

  test("each kind reads as its condition", () => {
    expect(waitLabel(pr)).toBe("PR #42 merges");
    expect(waitLabel(pr, { fullRef: true })).toBe("PR codecast-sh/codecast#42 merges");
    expect(waitLabel({ ...pr, kind: "pr_checks_green" })).toBe("checks green on #42");
    expect(waitLabel({ kind: "decision", decision: "sd-412" })).toBe("sd-412 answered");
    expect(waitLabel({ kind: "time", at: new Date(2026, 9, 9, 9, 0).getTime() }, { now })).toBe("until Fri 09:00");
  });

  test("met phrasing for Unblocked comments", () => {
    expect(waitMetLabel(pr)).toBe("PR #42 merged");
    expect(waitMetLabel({ kind: "decision", decision: "sd-4" })).toBe("sd-4 answered");
    expect(waitMetLabel({ kind: "time", at: new Date(2026, 9, 8, 17, 30).getTime() }, { now })).toBe("17:30 passed");
  });

  test("time: today, this week, later, another year", () => {
    expect(formatWaitTime(new Date(2026, 9, 8, 17, 30).getTime(), { now })).toBe("17:30");
    expect(formatWaitTime(new Date(2026, 9, 13, 9, 0).getTime(), { now })).toBe("Tue 09:00");
    expect(formatWaitTime(new Date(2026, 9, 20, 9, 0).getTime(), { now })).toBe("Oct 20 09:00");
    expect(formatWaitTime(new Date(2027, 0, 4, 9, 0).getTime(), { now })).toBe("Jan 4, 2027 09:00");
  });

  test("an explicit zone moves the clock", () => {
    expect(formatWaitTime(Date.UTC(2026, 9, 8, 22, 0), { now: Date.UTC(2026, 9, 8, 12), timeZone: "UTC" })).toBe("22:00");
    expect(formatWaitTime(Date.UTC(2026, 9, 8, 22, 0), { now: Date.UTC(2026, 9, 8, 12), timeZone: "Asia/Tokyo" })).toBe("Fri 07:00");
  });

  test("blockerLabel covers every entry", () => {
    expect(blockerLabel({ kind: "task", ref: "ct-3", status: "open" })).toBe("ct-3");
    expect(blockerLabel({ kind: "task", ref: "ct-9", missing: true })).toBe("ct-9 (not found)");
    expect(blockerLabel(prWait())).toBe("PR #42 merges");
    expect(blockerLabel({ ...prWait("failed"), note: "closed without merging" })).toBe("PR #42 merges (failed: closed without merging)");
  });
});

describe("findPath and loops", () => {
  // ct-5 blocks ct-7 blocks ct-9; ct-6 is unrelated.
  const nodes: DepNode[] = [
    { short_id: "ct-5" },
    { short_id: "ct-7", blocked_by: ["ct-5"] },
    { short_id: "ct-9", blocked_by: ["ct-7"] },
    { short_id: "ct-6" },
  ];

  test("follows blocks edges and returns the chain", () => {
    expect(findPath(nodes, "ct-5", "ct-9")).toEqual(["ct-5", "ct-7", "ct-9"]);
    expect(findPath(nodes, "ct-9", "ct-5")).toBeNull();
    expect(findPath(nodes, "ct-5", "ct-6")).toBeNull();
  });

  test("shortest chain wins", () => {
    const withShortcut = [...nodes.slice(0, 2), { short_id: "ct-9", blocked_by: ["ct-7", "ct-5"] }];
    expect(findPath(withShortcut, "ct-5", "ct-9")).toEqual(["ct-5", "ct-9"]);
  });

  test("the loop error names the path", () => {
    expect(dependencyLoopError(nodes, "ct-5", "ct-9")).toBe(
      "ct-9 already waits on ct-5 (ct-5 → ct-7 → ct-9); this edge would close a loop.",
    );
    expect(dependencyLoopError(nodes, "ct-9", "ct-5")).toBeNull();
    expect(dependencyLoopError(nodes, "ct-6", "ct-5")).toBeNull();
    expect(dependencyLoopError(nodes, "ct-6", "ct-6")).toBe("ct-6 cannot wait on itself.");
  });

  test("an existing cycle does not hang the search", () => {
    const cyclic = [{ short_id: "a", blocked_by: ["b"] }, { short_id: "b", blocked_by: ["a"] }, { short_id: "c" }];
    expect(findPath(cyclic, "a", "c")).toBeNull();
    expect(findPath(cyclic, "a", "b")).toEqual(["a", "b"]);
  });

  test("blocked_by may name a blocker by _id", () => {
    const mixed = [{ short_id: "ct-1", _id: "doc1" }, { short_id: "ct-2", blocked_by: ["doc1"] }];
    expect(findPath(mixed, "ct-1", "ct-2")).toEqual(["ct-1", "ct-2"]);
  });
});

describe("topological order", () => {
  test("layers keep input order and place dependents after blockers", () => {
    const nodes = [
      { short_id: "d", blocked_by: ["b", "c"] },
      { short_id: "b", blocked_by: ["a"] },
      { short_id: "a" },
      { short_id: "c", blocked_by: ["a", "zz"] }, // zz is outside the set
      { short_id: "e" },
    ];
    const { layers, cyclic } = topoLayers(nodes);
    expect(layers.map((l) => l.map((t) => t.short_id))).toEqual([["a", "e"], ["b", "c"], ["d"]]);
    expect(cyclic).toEqual([]);
    expect(topologicalOrder(nodes)).toEqual({ sorted: ["a", "e", "b", "c", "d"], cycles: [] });
  });

  test("a cycle and what sits behind it come back unplaced", () => {
    const nodes = [
      { short_id: "a", blocked_by: ["c"] },
      { short_id: "b", blocked_by: ["a"] },
      { short_id: "c", blocked_by: ["b"] },
      { short_id: "d", blocked_by: ["c"] },
      { short_id: "x" },
    ];
    const { layers, cyclic } = topoLayers(nodes);
    expect(layers.map((l) => l.map((t) => t.short_id))).toEqual([["x"]]);
    expect(cyclic.map((t) => t.short_id)).toEqual(["a", "b", "c", "d"]);
    const { sorted, cycles } = topologicalOrder(nodes);
    expect(sorted).toEqual(["x"]);
    expect(cycles[0]).toEqual(["a", "c", "b"]);
  });

  test("duplicate blocked_by entries count one edge", () => {
    const { layers } = topoLayers([{ short_id: "a" }, { short_id: "b", blocked_by: ["a", "a"] }]);
    expect(layers.map((l) => l.map((t) => t.short_id))).toEqual([["a"], ["b"]]);
  });
});
