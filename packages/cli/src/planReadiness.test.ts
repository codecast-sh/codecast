import { describe, expect, test } from "bun:test";
import { openBlockerLabels } from "@codecast/shared/tasks";
import { parkedNote, planReadiness, stuckAdvice, stuckNote } from "./planReadiness";

const t = (short_id: string, over: Record<string, unknown> = {}) => ({ _id: `id_${short_id}`, short_id, status: "open", ...over });
const ids = (rows: { short_id: string }[]) => rows.map((r) => r.short_id);

describe("planReadiness", () => {
  test("a finished or dropped blocker clears, an open one holds, an _id ref resolves", () => {
    const r = planReadiness([
      t("ct-1", { status: "done" }),
      t("ct-2", { status: "dropped" }),
      t("ct-3", { blocked_by: ["ct-1", "id_ct-2"] }),
      t("ct-4", { blocked_by: ["ct-3"] }),
    ]);
    expect(ids(r.ready)).toEqual(["ct-3"]);
    expect(ids(r.blocked)).toEqual(["ct-4"]);
  });

  test("backlog is not started (open) but never ready (TG1), not blocked either, and listed as parked", () => {
    const r = planReadiness([t("ct-1", { status: "backlog" }), t("ct-2")]);
    expect(ids(r.open)).toEqual(["ct-1", "ct-2"]);
    expect(ids(r.ready)).toEqual(["ct-2"]);
    expect(ids(r.blocked)).toEqual([]);
    expect(ids(r.parked)).toEqual(["ct-1"]);
  });

  test("a blocker outside the plan that nobody looked up blocks", () => {
    const r = planReadiness([t("ct-2", { blocked_by: ["ct-99"] })]);
    expect(ids(r.blocked)).toEqual(["ct-2"]);
  });

  test("blockers outside the plan resolve from graph_outside: done clears, open holds, not found is missing", () => {
    const outside = {
      tasks: [{ _id: "id_ct-90", short_id: "ct-90", status: "done" }, { _id: "id_ct-91", short_id: "ct-91", status: "open" }],
      searched: ["ct-90", "ct-91", "ct-404"],
    };
    const r = planReadiness([
      t("ct-1", { blocked_by: ["ct-90"] }),
      t("ct-2", { blocked_by: ["ct-91"] }),
      t("ct-3", { blocked_by: ["ct-404"] }),
    ], outside);
    expect(ids(r.ready)).toEqual(["ct-1", "ct-3"]);
    expect(ids(r.blocked)).toEqual(["ct-2"]);
  });

  test("a parent being worked holds its subtasks, in the plan or outside it; one not looked up holds them too", () => {
    const outside = {
      tasks: [{ _id: "id_ct-80", short_id: "ct-80", status: "in_review" }, { _id: "id_ct-81", short_id: "ct-81", status: "open" }],
      searched: ["id_ct-80", "id_ct-81", "id_gone"],
    };
    const tasks = [
      t("ct-1", { status: "in_progress" }),
      t("ct-2", { parent_id: "id_ct-1" }),
      t("ct-3", { parent_id: "id_ct-80" }),
      t("ct-4", { parent_id: "id_ct-81" }),
      t("ct-5", { parent_id: "id_gone" }),
    ];
    expect(ids(planReadiness(tasks, outside).ready)).toEqual(["ct-4", "ct-5"]);
    expect(ids(planReadiness(tasks).ready)).toEqual([]);
  });

  // Autopilot stalls only when nothing is waiting: these move by themselves.
  test("waiting holds the subtasks of a parent being worked and the tasks whose every blocker can still clear, never backlog", () => {
    const pr = { kind: "pr_merged", repository: "o/r", pr_number: 42, id: "w1", state: "waiting", created_at: 1 };
    const r = planReadiness<any>([
      t("ct-1", { status: "in_progress" }),
      t("ct-2", { parent_id: "id_ct-1" }),
      t("ct-4", { blocked_by: ["ct-1"], waits: [pr] }),
      t("ct-5", { status: "backlog" }),
      t("ct-6"),
      t("ct-7", { blocked_by: ["ct-6"] }),
      t("ct-8", { blocked_by: ["ct-7"] }),
    ]);
    expect(ids(r.waiting)).toEqual(["ct-2", "ct-4", "ct-7", "ct-8"]);
    expect(ids(r.stuck)).toEqual([]);
    expect(ids(r.blocked)).toEqual(["ct-4", "ct-7", "ct-8"]);
  });

  // Nothing releases these, so autopilot stalls and says why rather than idling.
  test("stuck holds a failed wait, an unread blocker or parent, a backlog blocker, and what waits behind them", () => {
    const failed = { kind: "pr_merged", repository: "o/r", pr_number: 6, id: "w2", state: "failed", note: "closed without merging", created_at: 1 };
    const r = planReadiness<any>([
      t("ct-1", { status: "in_progress" }),
      t("ct-2", { blocked_by: ["ct-1"], waits: [failed] }),
      t("ct-3", { blocked_by: ["ct-99"] }),
      t("ct-4", { parent_id: "id_ct-70" }),
      t("ct-5", { status: "backlog" }),
      t("ct-6", { blocked_by: ["ct-5"] }),
      t("ct-7", { blocked_by: ["ct-3"] }),
    ]);
    expect(ids(r.waiting)).toEqual([]);
    expect(ids(r.stuck)).toEqual(["ct-2", "ct-3", "ct-4", "ct-6", "ct-7"]);
    // A failed wait leads the list it is in (`blockerBand`): it needs a
    // re-plan, and an agent reading one line reads that one.
    expect(stuckNote(r)).toBe("ct-2: blocked by PR #6 to merge (failed: closed without merging), ct-1; ct-3: blocked by ct-99 (status unknown); ct-4: its parent could not be read; ct-6: blocked by ct-5; ct-7: blocked by ct-3");
    // Every stuck cause names a next action, the unreadable parent included:
    // it is the one an agent is least likely to diagnose, and it carries no
    // blocker to act on.
    expect(stuckAdvice(r)).toEqual([
      "ct-2: remove it (cast task dep ct-2 --remove-blocked-by o/r#6) or replace it (add the new wait with cast task dep ct-2 --blocked-by; a wait on the same target takes the failed one's place), or change the approach, and say on the task what you decided.",
      "ct-3: a blocker this workspace cannot read; cast task show ct-3 names it",
      "ct-4: its parent is in another workspace or could not be read; cast task show ct-4 names it, and cast task update ct-4 --parent '' lifts it to the top level",
    ]);
  });

  // A time wait whose moment went by unsettled is the trap a failed one is:
  // nothing is going to clear it, so the plan must not file it under "will
  // become ready without anyone touching them" and go quiet about it
  // (isStalledTimeWait, the same predicate the holding session's compaction
  // block judges it by).
  test("a time wait whose settle never landed is stuck, not waiting, and says the wake is not coming", () => {
    const now = 1_760_000_000_000;
    const late = { kind: "time", at: now - 5 * 60 * 60_000, id: "w9", state: "waiting", created_at: 1 };
    const soon = { kind: "time", at: now + 60 * 60_000, id: "w8", state: "waiting", created_at: 1 };
    const r = planReadiness<any>([t("ct-1", { waits: [late] }), t("ct-2", { blocked_by: ["ct-1"] }), t("ct-3", { waits: [soon] })], null, { now });
    expect(ids(r.stuck)).toEqual(["ct-1", "ct-2"]);
    expect(ids(r.waiting)).toEqual(["ct-3"]);
    expect(stuckAdvice(r, { now })[0]).toBe(
      "ct-1: a wait whose moment has gone by was never settled, so no wake is coming: remove it (cast task dep ct-1 --remove-blocked-by w9) and, if the work still has to wait, add the new wait with cast task dep ct-1 --blocked-by, or change the approach, and say on the task what you decided.",
    );
    // Two stalled waits on one task: the diagnosis agrees in number with the
    // remedy after it (`stalledWaitDiagnosis`), the same sentence the task
    // page and the parking pin show.
    const two = planReadiness<any>([t("ct-1", { waits: [late, { ...late, id: "w7" }] })], null, { now });
    expect(stuckAdvice(two, { now })[0]).toStartWith("ct-1: waits whose moments have gone by were never settled, so no wake is coming: remove them (");
    // A moment still ahead, or one only minutes past, is a settle on its way.
    expect(ids(planReadiness<any>([t("ct-1", { waits: [late] })], null, { now: late.at + 60_000 }).waiting)).toEqual(["ct-1"]);
  });

  // Planned by viewer null, an ephemeral step is its owner's to run (TG9).
  test("an ephemeral step is never ready to orchestrate, and is reported with the backlog", () => {
    const r = planReadiness([t("ct-1", { ephemeral: true, user_id: "u1" }), t("ct-2", { status: "backlog" }), t("ct-3", { blocked_by: ["ct-1"] })]);
    expect(ids(r.ready)).toEqual([]);
    expect(ids(r.ephemeral)).toEqual(["ct-1"]);
    expect(ids(r.waiting)).toEqual(["ct-3"]);
    expect(parkedNote(r)).toBe("1 in backlog: move to open to schedule; 1 ephemeral: left to the session that filed it, not spawned for");
  });

  // A surface that reports to a caller passes `plans.get`'s graph_viewer, so
  // it agrees with `cast task ready --plan`, which hands the filing session
  // its own ephemeral step (the finding this test holds).
  test("with the asking session named, its own ephemeral step is ready; another session's is not", () => {
    const mine = t("ct-1", { ephemeral: true, user_id: "u1", created_from_conversation: "conv1" });
    const theirs = t("ct-2", { ephemeral: true, user_id: "u1", created_from_conversation: "conv2" });
    const r = planReadiness([mine, theirs], null, { viewer: { viewer: "u1", viewerSession: "conv1" } });
    expect(ids(r.ready)).toEqual(["ct-1"]);
    expect(ids(r.ephemeral)).toEqual(["ct-2"]);
    expect(parkedNote(r)).toBe("1 ephemeral: left to the session that filed it, not spawned for");
    // A person at a terminal (no session) owns only what they filed themselves.
    const person = planReadiness([mine, t("ct-3", { ephemeral: true, user_id: "u1" })], null, { viewer: { viewer: "u1" } });
    expect(ids(person.ready)).toEqual(["ct-3"]);
    // No viewer: nobody owns anything, which is what a spawn surface asks.
    expect(ids(planReadiness([mine, theirs]).ready)).toEqual([]);
  });
});

describe("openBlockerLabels", () => {
  test("names only what still holds the task, waits included, never a finished blocker", () => {
    const pr42 = { kind: "pr_merged", repository: "o/r", pr_number: 42, id: "w1", state: "waiting", created_at: 1 };
    const tasks = [t("ct-1", { status: "done" }), t("ct-2"), t("ct-3", { blocked_by: ["ct-1", "ct-2"], waits: [pr42] })];
    const { statusOf } = planReadiness<any>(tasks);
    expect(openBlockerLabels(tasks[2] as any, statusOf)).toEqual(["ct-2", "PR #42 to merge"]);
  });
});
