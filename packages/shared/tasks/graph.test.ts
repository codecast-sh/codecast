import { describe, expect, test } from "bun:test";
import {
  blockersHoldingBack,
  waitTone,
  waitStateWord,
  isWaitId,
  newWaitId,
  notReadyLabel,
  waitClause,
  waitLine,
  waitLineParts,
  blockerEntriesOf,
  blockerLabel,
  blockerWaitingLabel,
  blockerRefs,
  isCleared,
  dependencyLoopChecker,
  findStoredWaitTime,
  formatWaitTime,
  isReady,
  isUnblocked,
  parseBlockerRef,
  prWords,
  readinessOf,
  sameWaitTarget,
  statusLookup,
  taskBlockerEntries,
  topoLayers,
  topologicalOrder,
  waitFailedCause,
  waitFailedWord,
  waitLabel,
  failedWaitAdvice,
  waitMetLabel,
  waitMetNote,
  waitRemoveRef,
  waitingOnLabel,
  type DepNode,
  type TaskWait,
} from "./index";

const statuses: Record<string, string> = { "ct-1": "done", "ct-2": "dropped", "ct-3": "open", "ct-4": "in_progress" };
// Every ref was looked up, so one with no row is confirmed missing (null).
const statusOf = (id: string) => (id in statuses ? { status: statuses[id] } : null);

const wait = (over: Partial<TaskWait> & Pick<TaskWait, "kind">): TaskWait =>
  ({ id: "w1", state: "waiting", created_at: 0, ...(over as any) }) as TaskWait;
const prWait = (state: TaskWait["state"] = "waiting") =>
  wait({ kind: "pr_merged", repository: "codecast-sh/codecast", pr_number: 42, state });

describe("blockersHoldingBack", () => {
  test("closed task blockers drop out; open ones stay in blocked_by order", () => {
    expect(blockersHoldingBack({ blocked_by: ["ct-4", "ct-1", "ct-3", "ct-2"] }, statusOf)).toEqual([
      { kind: "task", ref: "ct-4", status: "in_progress" },
      { kind: "task", ref: "ct-3", status: "open" },
    ]);
  });

  test("an id that resolves to nothing is reported missing and holds nothing back", () => {
    expect(blockerEntriesOf({ blocked_by: ["ct-99"] }, statusOf)).toEqual([{ kind: "task", ref: "ct-99", missing: true }]);
    expect(blockersHoldingBack({ blocked_by: ["ct-99"] }, statusOf)).toEqual([]);
  });

  test("waits follow task blockers; met waits drop out, failed ones stay", () => {
    const failed = { ...prWait("failed"), id: "w2" };
    const out = blockersHoldingBack({ blocked_by: ["ct-3"], waits: [prWait("met"), failed] }, statusOf);
    expect(out.map((b) => (b.kind === "task" ? b.ref : b.id))).toEqual(["ct-3", "w2"]);
  });

  test("duplicate refs count once", () => {
    expect(blockersHoldingBack({ blocked_by: ["ct-3", "ct-3"] }, statusOf)).toHaveLength(1);
  });

  test("statusLookup resolves a blocker named by _id, so an open one blocks, named by its short id", () => {
    const lookup = statusLookup([{ short_id: "ct-5", _id: "ida", status: "open" }, { short_id: "ct-6", _id: "idb", status: "done" }]);
    expect(blockersHoldingBack({ blocked_by: ["ida", "idb"] }, lookup)).toEqual([{ kind: "task", ref: "ct-5", status: "open" }]);
    expect(isUnblocked({ blocked_by: ["ida"] }, lookup)).toBe(false);
    expect(isReady({ status: "open", blocked_by: ["ida"] }, { statusOf: lookup, parentStatusOf: () => null, viewer: null })).toBe(false);
    expect(isUnblocked({ blocked_by: ["idb", "ct-6"] }, lookup)).toBe(true);
  });

  test("a blocker named by both its short id and its _id is listed once", () => {
    const lookup = statusLookup([{ short_id: "ct-5", _id: "x", status: "open" }]);
    expect(blockersHoldingBack({ blocked_by: ["ct-5", "x"] }, lookup)).toEqual([{ kind: "task", ref: "ct-5", status: "open" }]);
    expect(blockersHoldingBack({ blocked_by: ["x", "ct-5"] }, lookup)).toEqual([{ kind: "task", ref: "ct-5", status: "open" }]);
  });

  test("a blocker the caller never looked up blocks as unknown, never reads as cleared", () => {
    // A page that dropped an open blocker (another project, filtered out).
    const page = [{ short_id: "ct-1", status: "open", blocked_by: ["ct-50"] }];
    const lookup = statusLookup(page);
    expect(blockersHoldingBack(page[0], lookup)).toEqual([{ kind: "task", ref: "ct-50", status: "unknown" }]);
    expect(isReady(page[0], { statusOf: lookup, parentStatusOf: () => null, viewer: null })).toBe(false);
    expect(blockerLabel(blockersHoldingBack(page[0], lookup)[0])).toBe("ct-50 (status unknown)");
    // A plain StatusOf that answers undefined fails safe the same way.
    expect(isUnblocked({ blocked_by: ["ct-50"] }, () => undefined)).toBe(false);
  });

  test("blockerRefs lists what to look up; statusLookup then settles each one", () => {
    const page = [
      { short_id: "ct-1", _id: "id1", status: "open", blocked_by: ["ct-2", "ct-50", "id1"] },
      { short_id: "ct-2", status: "done", blocked_by: ["ct-50", "ct-60"] },
    ];
    const refs = blockerRefs(page);
    expect(refs).toEqual({ shortIds: ["ct-50", "ct-60"], ids: [] });
    // ct-50 found done in the database, ct-60 looked up and gone.
    const lookup = statusLookup([...page, { short_id: "ct-50", status: "done" }], refs.shortIds);
    expect(blockerEntriesOf(page[1], lookup).filter((b) => !isCleared(b))).toEqual([{ kind: "task", ref: "ct-60", missing: true }]);
    expect(isUnblocked(page[1], lookup)).toBe(true);
  });

  test("an _id blocker outside the page is looked up by _id, never read as missing by a short id search", () => {
    const page = [{ short_id: "ct-1", status: "open", blocked_by: ["k57abc", "ct-5"] }];
    const refs = blockerRefs(page);
    expect(refs).toEqual({ shortIds: ["ct-5"], ids: ["k57abc"] });
    // Only the short id was searched: the _id stays unknown and blocks.
    const shortOnly = statusLookup([...page, { short_id: "ct-5", _id: "k57ct5", status: "done" }], refs.shortIds);
    expect(blockersHoldingBack(page[0], shortOnly)).toEqual([{ kind: "task", ref: "k57abc", status: "unknown" }]);
    // Both searched: the _id resolves to its open task and prints as its short id.
    const both = statusLookup([...page, { short_id: "ct-5", status: "done" }, { short_id: "ct-7", _id: "k57abc", status: "open" }], [...refs.shortIds, ...refs.ids]);
    expect(blockersHoldingBack(page[0], both)).toEqual([{ kind: "task", ref: "ct-7", status: "open" }]);
    // Both searched and the _id is gone: missing, so it no longer blocks.
    expect(isUnblocked(page[0], statusLookup([...page, { short_id: "ct-5", status: "done" }], [...refs.shortIds, ...refs.ids]))).toBe(true);
  });

  test("a blocker absent from the caller's page still resolves through statusOf", () => {
    // The old list filter looked blockers up in a page that had already
    // dropped done tasks, so a finished blocker read as blocking.
    expect(isUnblocked({ blocked_by: ["ct-1"] }, statusOf)).toBe(true);
  });
});

describe("blockerEntriesOf", () => {
  test("lists every entry in blocked_by order, cleared ones marked rather than dropped", () => {
    const met = prWait("met");
    const failed = { ...prWait("failed"), id: "w2" };
    const task = { blocked_by: ["ct-1", "ct-3", "ct-99", "ct-2", "ct-3"], waits: [met, failed] };
    const all = blockerEntriesOf(task, statusOf);
    expect(all).toEqual([
      { kind: "task", ref: "ct-1", status: "done" },
      { kind: "task", ref: "ct-3", status: "open" },
      { kind: "task", ref: "ct-99", missing: true },
      { kind: "task", ref: "ct-2", status: "dropped" },
      met,
      failed,
    ]);
    expect(all.map(isCleared)).toEqual([true, false, false, true, true, false]);
    expect(blockersHoldingBack(task, statusOf)).toEqual(all.filter((b) => !isCleared(b) && !("missing" in b)));
  });

  test("a blocker never looked up is not cleared", () => {
    const [b] = blockerEntriesOf({ blocked_by: ["ct-50"] }, statusLookup([]));
    expect(b).toEqual({ kind: "task", ref: "ct-50", status: "unknown" });
    expect(isCleared(b)).toBe(false);
  });

  test("taskBlockerEntries carries every form a blocker is stored under, so removal takes them all", () => {
    const lookup = statusLookup([{ short_id: "ct-5", _id: "x", status: "open" }]);
    expect(taskBlockerEntries({ blocked_by: ["x", "ct-9", "ct-5", "x"] }, lookup)).toEqual([
      { blocker: { kind: "task", ref: "ct-5", status: "open" }, raws: ["x", "ct-5"] },
      { blocker: { kind: "task", ref: "ct-9", status: "unknown" }, raws: ["ct-9"] },
    ]);
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

describe("waitTone", () => {
  test("waiting is live until the task is worked or closed", () => {
    expect(waitTone("waiting", "open")).toBe("waiting");
    expect(waitTone("waiting", "in_progress")).toBe("dim");
    expect(waitTone("waiting", "in_review")).toBe("dim");
    expect(waitTone("waiting", "done")).toBe("dim");
  });
  test("failed is live while the task is open at all", () => {
    expect(waitTone("failed", "in_progress")).toBe("failed");
    expect(waitTone("failed", "dropped")).toBe("dim");
  });
  test("met keeps its tone", () => expect(waitTone("met", "done")).toBe("met"));
});

describe("readiness", () => {
  const parents: Record<string, string | null> = { p_active: "in_progress", p_review: "in_review", p_open: "open", p_gone: null };
  const opts = { statusOf, parentStatusOf: (id: string) => parents[id], viewer: "u1" };

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

  test("a parent nobody looked up is unknown, not orphaned", () => {
    expect(readinessOf({ status: "open", parent_id: "p_unloaded" }, opts)).toEqual({ ready: false, reason: "parent_unknown" });
    expect(isReady({ status: "open", parent_id: "p_unloaded" }, { ...opts, includeSubtasks: true })).toBe(true);
  });

  test("an ephemeral task is ready only for its owner", () => {
    const mine = { status: "open", ephemeral: true, user_id: "u1" };
    expect(isReady(mine, opts)).toBe(true);
    expect(readinessOf(mine, { ...opts, viewer: "u2" })).toEqual({ ready: false, reason: "ephemeral" });
    expect(isReady(mine, { ...opts, viewer: null })).toBe(false);
    expect(isReady({ ...mine, ephemeral: false }, { ...opts, viewer: null })).toBe(true);
    // A row with no owner is no one's, whatever the viewer string says.
    expect(isReady({ status: "open", ephemeral: true }, { ...opts, viewer: "undefined" })).toBe(false);
  });

  test("an ephemeral task a session filed is that session's, not its person's other sessions'", () => {
    const filed = { status: "open", ephemeral: true, user_id: "u1", created_from_conversation: "c1" };
    expect(isReady(filed, { ...opts, viewerSession: "c1" })).toBe(true);
    expect(readinessOf(filed, { ...opts, viewerSession: "c2" })).toEqual({ ready: false, reason: "ephemeral" });
    expect(isReady(filed, opts)).toBe(false);
    // One filed at a terminal is the person's, and no session's.
    expect(isReady({ ...filed, created_from_conversation: undefined }, { ...opts, viewerSession: "c1" })).toBe(false);
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
    expect(p("ct-012")).toEqual({ ok: true, kind: "task", ref: "ct-12" });
  });

  test("numbers start at 1", () => {
    for (const s of ["ct-0", "sd-00", "#0", "codecast-sh/codecast#0", "#0:checks"]) {
      const r = p(s);
      expect(r.ok ? "ok" : r.error).toContain("numbers start at 1");
    }
  });

  test("decisions", () => {
    expect(p("sd-412")).toEqual({ ok: true, kind: "decision", decision: "sd-412" });
    expect(p("SD-3")).toEqual({ ok: true, kind: "decision", decision: "sd-3" });
    expect(p("sd-007")).toEqual({ ok: true, kind: "decision", decision: "sd-7" });
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
    expect(p("https://github.com/codecast-sh/codecast/pull/42/checks")).toEqual({ ok: true, kind: "pr_checks_green", repository: "codecast-sh/codecast", pr_number: 42 });
  });

  test("durations are relative to now", () => {
    expect(p("30m")).toEqual({ ok: true, kind: "time", at: now + 30 * 60_000 });
    expect(p("2h")).toEqual({ ok: true, kind: "time", at: now + 2 * 3_600_000 });
    expect(p("3d")).toEqual({ ok: true, kind: "time", at: now + 3 * 86_400_000 });
    expect(p("1w")).toEqual({ ok: true, kind: "time", at: now + 7 * 86_400_000 });
  });

  test("ISO dates are local midnight, datetimes local unless zoned", () => {
    expect(p("2026-10-14")).toEqual({ ok: true, kind: "time", at: new Date(2026, 9, 14).getTime() });
    expect(p("2026-10-14T09:00")).toEqual({ ok: true, kind: "time", at: new Date(2026, 9, 14, 9, 0).getTime() });
    expect(p("2026-10-14 09:00")).toEqual({ ok: true, kind: "time", at: new Date(2026, 9, 14, 9, 0).getTime() });
    expect(p("2026-10-14T09:00:00Z")).toEqual({ ok: true, kind: "time", at: Date.UTC(2026, 9, 14, 9) });
    expect(p("2026-10-14T09:00+02:00")).toEqual({ ok: true, kind: "time", at: Date.UTC(2026, 9, 14, 7) });
    expect(p("2026-10-14T09:00-0430")).toEqual({ ok: true, kind: "time", at: Date.UTC(2026, 9, 14, 13, 30) });
    expect(p("2026-10-14T09:00:30.5")).toEqual({ ok: true, kind: "time", at: new Date(2026, 9, 14, 9, 0, 30, 500).getTime() });
  });

  test("a zoneless time is wall time in the zone given, wherever it is parsed", () => {
    const now = Date.UTC(2026, 9, 8, 12);
    const at = (s: string, timeZone: string) => {
      const r = parseBlockerRef(s, { now, timeZone });
      return r.ok && r.kind === "time" ? r.at : r.ok ? r.kind : r.error;
    };
    expect(at("2026-10-14T09:00", "UTC")).toBe(Date.UTC(2026, 9, 14, 9));
    expect(at("2026-10-14T09:00", "America/New_York")).toBe(Date.UTC(2026, 9, 14, 13));
    expect(at("2026-10-14", "Asia/Tokyo")).toBe(Date.UTC(2026, 9, 13, 15));
    // Across a daylight saving change: New York is UTC-5 in December.
    expect(at("2026-12-14T09:00", "America/New_York")).toBe(Date.UTC(2026, 11, 14, 14));
    // Days the zone's clocks change, either side of the jump.
    expect(at("2026-11-01T09:00", "America/New_York")).toBe(Date.UTC(2026, 10, 1, 14));
    expect(at("2027-03-14T09:00", "America/New_York")).toBe(Date.UTC(2027, 2, 14, 13));
    // A zone in the text wins over the option.
    expect(at("2026-10-14T09:00Z", "Asia/Tokyo")).toBe(Date.UTC(2026, 9, 14, 9));
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
    expect(err("2026-02-30T09:00")).toContain("is not a blocker");
    expect(err("2026-10-14T24:00")).toContain("is not a blocker");
    expect(err("2026-10-14T09:60")).toContain("is not a blocker");
    expect(err("2026-10-14Z")).toContain("is not a blocker");
    expect(err("2026-10-14T09:00+99:99")).toContain("is not a blocker");
    expect(err("2026-10-14T09:00+15:00")).toContain("is not a blocker");
    expect(err("2026-10-14T09:00+05:60")).toContain("is not a blocker");
    expect(err("42")).toContain("ambiguous: write #42 for a pull request or ct-42 for a task");
    expect(err("90:checks")).toContain("ambiguous");
    expect(err("2026/10/14")).toContain("is not a blocker");
    expect(err("2026-01-01")).toContain("in the past");
    // Removing a met time wait may name a time already past.
    expect(parseBlockerRef("2026-01-01T09:00Z", { now, allowPast: true })).toEqual({ ok: true, kind: "time", at: Date.UTC(2026, 0, 1, 9) });
    expect(err("tomorrowish")).toContain("is not a blocker");
    expect(err("30x")).toContain("is not a blocker");
    expect(err("0m")).toContain("is not a blocker");
    // Only text with no blocker's shape is flagged, so a surface can show the forms instead.
    expect(p("tomorrowish")).toMatchObject({ ok: false, unrecognized: true });
    expect(p("2026-01-01")).not.toHaveProperty("unrecognized");
  });

  test("an unknown time zone is an error, not a throw", () => {
    const r = parseBlockerRef("2026-10-14T09:00", { now, timeZone: "Not/AZone" });
    expect(r).toEqual({ ok: false, error: 'Unknown time zone "Not/AZone"' });
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

  test("a PR outside the reader's repository is named in full", () => {
    const other = { ...pr, repository: "codecast-sh/issue-sync-test", pr_number: 6 };
    expect(waitLabel(pr, prWords("Codecast-SH/codecast"))).toBe("PR #42 merges");
    expect(waitLabel(other, prWords("codecast-sh/codecast"))).toBe("PR codecast-sh/issue-sync-test#6 merges");
    expect(waitMetLabel(other, prWords(null))).toBe("PR codecast-sh/issue-sync-test#6 merged");
  });

  test("timeline phrasing for a wait being set", () => {
    expect(waitingOnLabel(pr)).toBe("Waiting on PR #42");
    expect(waitingOnLabel({ ...pr, kind: "pr_checks_green" })).toBe("Waiting on green checks for PR #42");
    expect(waitingOnLabel({ kind: "decision", decision: "sd-412" })).toBe("Waiting on sd-412");
    expect(waitingOnLabel({ kind: "time", at: new Date(2026, 9, 15, 9, 0).getTime() }, { now })).toBe("Waiting until Oct 15 09:00");
    expect(waitingOnLabel(pr, { lower: true })).toBe("waiting on PR #42");
  });

  test("the same phrase for anything holding a task", () => {
    expect(blockerWaitingLabel({ kind: "task", ref: "ct-12", status: "open" })).toBe("Waiting on ct-12");
    expect(blockerWaitingLabel({ kind: "task", ref: "ct-9", missing: true }, { lower: true })).toBe("waiting on ct-9 (not found)");
    expect(blockerWaitingLabel(wait({ ...pr, state: "failed", note: "closed without merging" }))).toBe("Waiting on PR #42 (failed: closed without merging)");
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

  test("withDay names the day of a past or same-day time", () => {
    expect(formatWaitTime(new Date(2026, 9, 8, 4, 13).getTime(), { now, withDay: true })).toBe("Thu 04:13");
    expect(formatWaitTime(new Date(2026, 9, 6, 4, 13).getTime(), { now, withDay: true })).toBe("Tue 04:13");
    expect(formatWaitTime(new Date(2026, 8, 20, 4, 13).getTime(), { now, withDay: true })).toBe("Sep 20 04:13");
  });

  test("a stored UTC time is found again inside its line", () => {
    const at = Date.UTC(2026, 9, 11, 9, 26);
    const line = `until ${formatWaitTime(at, { absolute: true, timeZone: "UTC" })}`;
    expect(line).toBe("until Oct 11, 2026 09:26 UTC");
    expect(findStoredWaitTime(line)).toEqual({ at, start: 6, end: line.length });
    expect(findStoredWaitTime("on PR #42")).toBeNull();
  });

  test("the runtime's zone needs no Intl, so Hermes prints what the tests see", () => {
    const real = Intl.DateTimeFormat;
    (Intl as any).DateTimeFormat = () => { throw new Error("Intl reached"); };
    try {
      expect(waitLabel({ kind: "time", at: new Date(2026, 9, 9, 0, 5).getTime() }, { now })).toBe("until Fri 00:05");
      expect(formatWaitTime(new Date(2027, 0, 4, 9, 0).getTime(), { now })).toBe("Jan 4, 2027 09:00");
    } finally {
      (Intl as any).DateTimeFormat = real;
    }
  });

  test("an explicit zone moves the clock", () => {
    expect(formatWaitTime(Date.UTC(2026, 9, 8, 22, 0), { now: Date.UTC(2026, 9, 8, 12), timeZone: "UTC" })).toBe("22:00");
    expect(formatWaitTime(Date.UTC(2026, 9, 8, 22, 0), { now: Date.UTC(2026, 9, 8, 12), timeZone: "Asia/Tokyo" })).toBe("Fri 07:00");
  });

  test("an unknown zone renders in the runtime's", () => {
    const at = new Date(2026, 9, 8, 17, 30).getTime();
    expect(formatWaitTime(at, { now, timeZone: "Not/AZone" })).toBe(formatWaitTime(at, { now }));
  });

  test("stored text names the full date and zone, whenever it is written", () => {
    const at = Date.UTC(2026, 9, 14, 9, 0);
    const at9 = { kind: "time", at } as const;
    // Written as it settles (the same day) or a week ahead, it reads the same.
    for (const when of [at, at - 7 * 86_400_000]) {
      expect(waitMetLabel(at9, { now: when, timeZone: "UTC", absolute: true })).toBe("Oct 14, 2026 09:00 UTC passed");
      expect(waitingOnLabel(at9, { now: when, timeZone: "UTC", absolute: true })).toBe("Waiting until Oct 14, 2026 09:00 UTC");
    }
    expect(formatWaitTime(at, { timeZone: "America/Los_Angeles", absolute: true })).toBe("Oct 14, 2026 02:00 PDT");
  });

  test("blockerLabel covers every entry", () => {
    expect(blockerLabel({ kind: "task", ref: "ct-3", status: "open" })).toBe("ct-3");
    expect(blockerLabel({ kind: "task", ref: "ct-9", missing: true })).toBe("ct-9 (not found)");
    expect(blockerLabel(prWait())).toBe("PR #42 merges");
    expect(blockerLabel({ ...prWait("failed"), note: "closed without merging" })).toBe("PR #42 merges (failed: closed without merging)");
  });
});

describe("loops", () => {
  // ct-5 blocks ct-7 blocks ct-9; ct-6 is unrelated.
  const nodes: DepNode[] = [
    { short_id: "ct-5" },
    { short_id: "ct-7", blocked_by: ["ct-5"] },
    { short_id: "ct-9", blocked_by: ["ct-7"] },
    { short_id: "ct-6" },
  ];

  test("the loop error names the chain in waits-on order, with the hint", () => {
    const check = dependencyLoopChecker(nodes);
    expect(check("ct-5", "ct-9")).toBe("ct-9 already waits on ct-5 (ct-9 → ct-7 → ct-5, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ct-9 needs ct-5, that edge already exists.");
    expect(check("ct-9", "ct-5")).toBeNull();
    expect(check("ct-6", "ct-5")).toBeNull();
    expect(check("ct-6", "ct-6")).toBe("ct-6 cannot wait on itself.");
  });

  test("shortest chain wins", () => {
    const withShortcut = [...nodes.slice(0, 2), { short_id: "ct-9", blocked_by: ["ct-7", "ct-5"] }];
    expect(dependencyLoopChecker(withShortcut)("ct-5", "ct-9")).toBe("ct-9 already waits on ct-5 (ct-9 → ct-5, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ct-9 needs ct-5, that edge already exists.");
  });

  test("an existing cycle does not hang the search", () => {
    const cyclic = [{ short_id: "a", blocked_by: ["b"] }, { short_id: "b", blocked_by: ["a"] }, { short_id: "c" }];
    const check = dependencyLoopChecker(cyclic);
    expect(check("a", "c")).toBeNull();
    expect(check("a", "b")).toBe("b already waits on a (b → a, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if b needs a, that edge already exists.");
  });

  test("blocked_by may name a blocker by _id", () => {
    const mixed = [{ short_id: "ct-1", _id: "doc1" }, { short_id: "ct-2", blocked_by: ["doc1"] }];
    expect(dependencyLoopChecker(mixed)("ct-1", "ct-2")).toBe("ct-2 already waits on ct-1 (ct-2 → ct-1, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ct-2 needs ct-1, that edge already exists.");
  });

  test("the endpoints may be _ids too, and the error names short ids", () => {
    const mixed = [{ short_id: "ct-1", _id: "a" }, { short_id: "ct-2", _id: "b", blocked_by: ["a"] }];
    expect(dependencyLoopChecker(mixed)("a", "b")).toBe("ct-2 already waits on ct-1 (ct-2 → ct-1, each waiting on the next); this edge would close a loop. Blocked by names what a task needs: if ct-2 needs ct-1, that edge already exists.");
    expect(dependencyLoopChecker(mixed)("a", "ct-1")).toBe("ct-1 cannot wait on itself.");
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
    // d only waits behind the cycle, so it is not reported as one.
    expect(cycles).toEqual([["a", "c", "b"]]);
  });

  test("a walk that enters a cycle part way reports the cycle alone", () => {
    const nodes = [
      { short_id: "d", blocked_by: ["c"] },
      { short_id: "a", blocked_by: ["c"] },
      { short_id: "b", blocked_by: ["a"] },
      { short_id: "c", blocked_by: ["b"] },
      { short_id: "p", blocked_by: ["q"] },
      { short_id: "q", blocked_by: ["p"] },
    ];
    expect(topologicalOrder(nodes).cycles).toEqual([["c", "b", "a"], ["p", "q"]]);
  });

  test("a cycle named through _id refs is reported whole", () => {
    const nodes = [{ short_id: "x", _id: "idx", blocked_by: ["idy"] }, { short_id: "y", _id: "idy", blocked_by: ["idx"] }];
    expect(topologicalOrder(nodes)).toEqual({ sorted: [], cycles: [["x", "y"]] });
  });

  test("duplicate blocked_by entries count one edge", () => {
    const { layers } = topoLayers([{ short_id: "a" }, { short_id: "b", blocked_by: ["a", "a"] }]);
    expect(layers.map((l) => l.map((t) => t.short_id))).toEqual([["a"], ["b"]]);
  });
});

describe("sameWaitTarget", () => {
  test("one PR in any spelling, a bare number in any repository, one decision, one moment", () => {
    const pr = { kind: "pr_merged", repository: "Acme/App", pr_number: 42 } as const;
    expect(sameWaitTarget(pr, { ...pr, repository: "acme/app" })).toBe(true);
    expect(sameWaitTarget(pr, { ...pr, repository: "" })).toBe(true);
    expect(sameWaitTarget(pr, { ...pr, repository: "acme/other" })).toBe(false);
    expect(sameWaitTarget(pr, { ...pr, kind: "pr_checks_green" })).toBe(false);
    expect(sameWaitTarget({ kind: "decision", decision: "SD-4" }, { kind: "decision", decision: "sd-4" })).toBe(true);
    expect(sameWaitTarget({ kind: "time", at: 0 }, { kind: "time", at: 59_000 })).toBe(true);
    expect(sameWaitTarget({ kind: "time", at: 0 }, { kind: "time", at: 61_000 })).toBe(false);
  });
});

describe("wait words and ids", () => {
  const pr = { kind: "pr_checks_green" as const, repository: "acme/api", pr_number: 42 };
  test("one clause, and the history line it is read back from", () => {
    expect(waitClause(pr)).toBe("on green checks for PR #42");
    expect(waitClause({ kind: "decision", decision: "sd-4" })).toBe("on sd-4");
    const waiting = { ...pr, id: "w1", state: "waiting" as const, created_at: 0 };
    expect(waitLineParts(waitLine(waiting))).toEqual({ state: "waiting", clause: "on green checks for PR #42" });
    const failed = waitLine({ ...waiting, state: "failed", note: "merged before its checks went green" });
    expect(failed).toBe("Wait on green checks for PR #42 failed: merged before its checks went green");
    expect(waitLineParts(failed)).toEqual({ state: "failed", clause: "on green checks for PR #42", note: "merged before its checks went green" });
    // A line stored before the clause was kept still reads as failed.
    expect(waitLineParts("PR #6 merges (failed: closed without merging)")).toEqual({ state: "failed" });
    expect(waitLine({ kind: "decision", decision: "sd-4", id: "w2", state: "met", note: "answered: Ship it", created_at: 0, settled_at: 5 })).toBe("sd-4 answered: Ship it");
    // Met the moment it was set: the clause stays, so the timeline can say what it waited on.
    const atOnce = waitLine({ kind: "pr_merged", repository: "acme/api", pr_number: 51, id: "w3", state: "met", note: "already merged", created_at: 7, settled_at: 7 });
    expect(atOnce).toBe("Wait on PR #51, already merged");
    expect(waitLineParts(atOnce)).toEqual({ state: "met", clause: "on PR #51", note: "already merged" });
  });

  test("a met wait's note and its read-back share one wording", () => {
    expect(waitMetNote("pr_merged")).toBe("merged");
    expect(waitMetNote("pr_checks_green", { atOnce: true })).toBe("already green");
    expect(waitMetNote("decision", { atOnce: true, answer: "Ship it" })).toBe("already answered: Ship it");
    for (const kind of ["pr_merged", "pr_checks_green", "decision"] as const) {
      const note = waitMetNote(kind, { atOnce: true });
      const target = kind === "decision" ? { kind, decision: "sd-4" } : { kind, repository: "acme/api", pr_number: 51 };
      const line = waitLine({ ...target, id: "w3", state: "met", note, created_at: 7, settled_at: 7 } as TaskWait);
      expect(waitLineParts(line)).toMatchObject({ state: "met", note });
      // No note stored: the line still reads as met at once.
      expect(waitLineParts(waitLine({ ...target, id: "w3", state: "met", created_at: 7, settled_at: 7 } as TaskWait)).note).toBe(note);
    }
  });

  test("a failed wait says what ended it, once, and how to remove it", () => {
    const closed: TaskWait = { kind: "pr_merged", repository: "acme/api", pr_number: 6, id: "w1", state: "failed", note: waitFailedWord("pr_merged"), created_at: 0 };
    expect(waitFailedCause(closed, { fullRef: true })).toBe("PR acme/api#6 closed without merging");
    expect(waitFailedCause({ kind: "decision", decision: "sd-4", id: "w2", state: "failed", created_at: 0 })).toBe("sd-4 will not be answered");
    expect(waitFailedWord("pr_checks_green", "merged")).toBe("merged before its checks went green");
    expect(waitRemoveRef(closed)).toBe("acme/api#6");
    expect(waitRemoveRef({ ...closed, kind: "pr_checks_green" })).toBe("acme/api#6:checks");
    expect(waitRemoveRef({ kind: "time", at: 1, id: "wabc", state: "waiting", created_at: 0 })).toBe("wabc");
    expect(failedWaitAdvice("ct-1", [closed])).toBe("remove it (cast task dep ct-1 --remove-blocked-by acme/api#6) or replace it (add the new wait with cast task dep ct-1 --blocked-by; a wait on the same target takes the failed one's place), or change the approach, and say on the task what you decided.");
  });

  test("a minted id has the shape the CLI reads back", () => {
    expect(isWaitId(newWaitId(Date.UTC(2026, 9, 8)))).toBe(true);
    expect(isWaitId("ct-12")).toBe(false);
  });

  test("blockersHoldingBack leaves out cleared and missing blockers; notReadyLabel names them", () => {
    const task = { status: "open", blocked_by: ["ct-1", "ct-2", "ct-3"] };
    const statusOf = (r: string) => (r === "ct-1" ? { status: "done" } : r === "ct-2" ? null : { status: "open" });
    expect(blockersHoldingBack(task, statusOf)).toEqual([{ kind: "task", ref: "ct-3", status: "open" }]);
    const verdict = readinessOf(task, { statusOf, parentStatusOf: () => null, viewer: null });
    expect(verdict.ready ? "" : notReadyLabel(task, verdict)).toBe("blocked by ct-3");
  });
});

describe("waitStateWord", () => {
  const checks = { id: "w1", kind: "pr_checks_green", repository: "o/r", pr_number: 4, state: "waiting", created_at: 0 } as TaskWait;
  test("a waiting checks wait says what its PR's checks are doing, when known", () => {
    expect(waitStateWord(checks)).toBe("checks to go green");
    expect(waitStateWord(checks, { checks: "failure" })).toBe("checks failing");
    expect(waitStateWord(checks, { checks: "pending" })).toBe("checks running");
    expect(waitStateWord(checks, { checks: "failure", closed: true })).toBe("");
    expect(waitStateWord({ ...checks, state: "met" }, { checks: "failure" })).toBe("checks green");
  });
});
