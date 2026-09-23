import { describe, expect, test } from "bun:test";
import { changeLine, takeoverPhrase } from "./orgProposal";
import {
  dependentBatches,
  invertRow,
  leftAloneLine,
  mergeFact,
  movedFields,
  ORG_INVERSE_KIND,
  orgLogEffectLines,
  orgLogEntryLine,
  orgLogLine,
  orgLogRowChange,
  rowChangedSomething,
  rowRoleIds,
  undoVerdict,
  type OrgLogKind,
  type OrgLogRow,
  type OrgOpenRow,
} from "./orgChange";

const LABELS = { r1: "@growth", r2: "@ops", u1: "Ashot", p1: "Website", p2: "Billing", pl1: "pl-7", s1: "jx7abcd", s2: "jx7efgh" };
let seq = 0;
const row = (kind: OrgLogKind, over: Partial<OrgLogRow> = {}): OrgLogRow => ({
  _id: `row${++seq}`, batch: "b1", seq, kind,
  subject: { type: "role", id: "r1", short_id: "or-1", label: "@growth" },
  before: {}, after: {}, effects: {}, labels: LABELS, role_ids: ["r1"], at: 1,
  ...over,
});
const open = (over: Partial<OrgOpenRow> = {}): OrgOpenRow => ({ kind: "lead", before: {}, after: {}, effects: {}, labels: {}, ...over });

describe("mergeFact: one gesture is one row", () => {
  test("a lead that widens a scope and takes over two sessions is one row with both effects", () => {
    const project = { type: "project" as const, id: "p1", label: "Website" };
    const role = { type: "role" as const, id: "r1", label: "@growth" };
    let r = open({ subject: project });
    r = mergeFact(r, { kind: "lead", subject: project, before: { owner_role_id: null }, after: { owner_role_id: "r1" }, labels: { r1: "@growth" } });
    r = mergeFact(r, { kind: "scope", subject: role, before: { scope: { project_ids: ["p2"], plan_ids: [] } }, after: { scope: { project_ids: ["p2", "p1"], plan_ids: [] } } });
    for (const id of ["s1", "s2"]) {
      r = mergeFact(r, { kind: "session", subject: { type: "session", id, short_id: LABELS[id as "s1"], label: LABELS[id as "s1"] }, before: { parent: { owner_user_ids: ["u1"] } }, after: { parent: { owner_user_ids: ["u1"], org_role_id: "r1" } }, labels: { r1: "@growth" } });
    }
    r = mergeFact(r, { kind: "session", subject: role, effects: { takeover: { role_id: "r1", handle: "growth", sessions: [], kept_in_front: ["jx7abcd"], over_cap: 3, told: { sessions: 2 } } } });
    expect(r.before).toEqual({ owner_role_id: null });
    expect(r.after).toEqual({ owner_role_id: "r1" });
    expect(r.effects.scope_gained).toEqual({ role_id: "r1", handle: "growth", project_ids: ["p1"], plan_ids: [] });
    expect(r.effects.takeover?.sessions.map((s) => s.short_id)).toEqual(["jx7abcd", "jx7efgh"]);
    expect(r.effects.takeover?.sessions[0].before).toEqual({ owner_user_ids: ["u1"] });
    expect(r.effects.takeover?.kept_in_front).toEqual(["jx7abcd"]);
    expect(r.effects.takeover?.over_cap).toBe(3);
    // The sentence the proposal page writes reads the same arrays.
    expect(takeoverPhrase("growth", r.effects.takeover, true)).toContain("2 sessions now report to @growth");
  });

  test("a hire opens with no subject and takes the created role; the first before of a field stands", () => {
    const role = { type: "role" as const, id: "r1", label: "@growth" };
    let r = open({ kind: "role" });
    r = mergeFact(r, { kind: "role", subject: role, before: { status: null }, after: { status: "active", name: "Growth", handle: "growth" } });
    r = mergeFact(r, { kind: "budget", subject: role, before: { caps: { hands_per_day: 3 } }, after: { caps: { hands_per_day: 5 } } });
    r = mergeFact(r, { kind: "budget", subject: role, before: { caps: { hands_per_day: 5 } }, after: { caps: { hands_per_day: 8 } } });
    expect(r.subject).toEqual(role);
    expect(r.before.caps).toEqual({ hands_per_day: 3 });
    expect(r.after.caps).toEqual({ hands_per_day: 8 });
  });

  test("lists of effects grow across nested cores", () => {
    const role = { type: "role" as const, id: "r1", label: "@growth" };
    let r = open({ kind: "retire", subject: role });
    r = mergeFact(r, { kind: "retire", subject: role, effects: { tasks_handed: [{ task_id: "t1", short_id: "ct-1", from: "role:r1", to: "u1" }] } });
    r = mergeFact(r, { kind: "retire", subject: role, effects: { tasks_handed: [{ task_id: "t2", short_id: "ct-2", from: "role:r1", to: "u1" }] } });
    expect(r.effects.tasks_handed?.map((t) => t.short_id)).toEqual(["ct-1", "ct-2"]);
  });

  test("a save that moved nothing writes nothing", () => {
    const m = movedFields({ name: "Growth", trust: "decide", avatar: undefined as any }, { name: "Growth", trust: "direct", avatar: null });
    expect(m).toEqual({ before: { trust: "decide" }, after: { trust: "direct" } });
    expect(rowChangedSomething({ ...movedFields({ name: "a" }, { name: "a" }), effects: {} })).toBe(false);
    expect(rowChangedSomething({ before: {}, after: {}, effects: { seat: { conversation_id: "s1", short_id: "jx7abcd" } } })).toBe(true);
  });

  test("rowRoleIds names every role the row touches", () => {
    expect(rowRoleIds({ subject: { type: "session", id: "s1", label: "jx7abcd" }, before: { parent: { owner_user_ids: ["u1"], org_role_id: "r2" } }, after: { parent: { owner_user_ids: ["u1"], org_role_id: "r1" } }, effects: {} }).sort()).toEqual(["r1", "r2"]);
    expect(rowRoleIds({ subject: { type: "project", id: "p1", label: "Website" }, before: {}, after: { owner_role_id: "r1" }, effects: { children_moved: [{ role_id: "r3", handle: "x", before: { kind: "role", role_id: "r2" } }] } }).sort()).toEqual(["r1", "r2", "r3"]);
  });
});

describe("the sentence is rendered from the row, by the proposal page's writers", () => {
  test("every proposal kind reaches changeLine", () => {
    const hire = row("role", { before: { status: null }, after: { status: "active", name: "Head of Growth", handle: "growth", reports_to: { kind: "user", user_id: "u1" }, scope: { project_ids: ["p1"], plan_ids: ["pl1"] } } });
    expect(orgLogLine(hire)).toBe(changeLine({ kind: "role", name: "Head of Growth", handle: "growth", reports_to: "Ashot", scope: { projects: ["Website"], plans: ["pl-7"] } }));
    expect(orgLogLine(row("retire", { before: { status: "active" }, after: { status: "retired" } }))).toBe("Retire @growth; its sessions go back to their owners");
    expect(orgLogLine(row("scope", { before: { scope: { project_ids: ["p2"], plan_ids: [] } }, after: { scope: { project_ids: ["p1"], plan_ids: [] } } }))).toBe("@growth also looks after Website and stops looking after Billing");
    expect(orgLogLine(row("move", { before: { reports_to: { kind: "user", user_id: "u1" } }, after: { reports_to: { kind: "role", role_id: "r2" } } }))).toBe("Move @growth under @ops");
    // The switch (org-staffing.md S23.1): history says what the person did, and decide reads as on.
    expect(orgLogLine(row("trust", { before: { trust: "understand" }, after: { trust: "decide" } }))).toBe("Turned on starting work on its own for @growth");
    expect(orgLogLine(row("budget", { after: { caps: { hands_per_day: 4 } } }))).toBe(changeLine({ kind: "budget", handle: "growth", caps: { hands_per_day: 4 } }));
    expect(orgLogLine(row("routine", { after: { routine: { agent_task_id: "a1", title: "Weekly review", every: "7d" } } }))).toBe(changeLine({ kind: "routine", handle: "growth", title: "Weekly review", prompt: "", every: "7d" }));
    expect(orgLogLine(row("plan_status", { subject: { type: "plan", id: "pl1", short_id: "pl-7", label: "Launch" }, before: { status: "active" }, after: { status: "done" } }))).toBe("Mark done: Launch (pl-7)");
    // A subject with no title reads by its id, and a project's title is its ref: never said twice.
    expect(orgLogLine(row("task_status", { subject: { type: "task", id: "t1", short_id: "ct-3", label: "ct-3" }, before: { status: "open" }, after: { status: "done" } }))).toBe("Mark task ct-3 done");
    expect(orgLogLine(row("project_status", { subject: { type: "project", id: "p1", label: "Website" }, before: { status: "active" }, after: { status: "paused" } }))).toBe("Mark project Website paused");
    expect(orgLogLine(row("file", { subject: { type: "plan", id: "pl1", short_id: "pl-7", label: "Launch" }, before: { project_id: null }, after: { project_id: "p1" } }))).toBe("Put plan pl-7 under the project Website");
    expect(orgLogLine(row("projects", { subject: { type: "project", id: "p1", label: "Website" }, after: { projects: [{ op: "create", project_id: "p1", title: "Website" }] } }))).toBe("Create the project Website");
  });

  test("the kinds the proposal vocabulary lacks have their own sentence, and orgLogRowChange says null", () => {
    const moved = row("session", { subject: { type: "session", id: "s1", short_id: "jx7abcd", label: "jx7abcd" }, before: { parent: { owner_user_ids: ["u1"] } }, after: { parent: { owner_user_ids: ["u1"], org_role_id: "r1" } } });
    expect(orgLogRowChange(moved)).toBeNull();
    expect(orgLogLine(moved)).toBe("Session jx7abcd now reports to @growth");
    expect(orgLogLine(invertRow(moved))).toBe("Session jx7abcd now reports to Ashot");
    const lead = row("lead", { subject: { type: "project", id: "p1", label: "Website" }, before: { owner_role_id: null }, after: { owner_role_id: "r1" } });
    expect(orgLogLine(lead)).toBe("@growth now leads the project Website");
    expect(orgLogLine(invertRow(lead))).toBe("The project Website has no lead");
    expect(orgLogLine(row("initiative_owner", { subject: { type: "initiative", id: "i1", short_id: "in-1", label: "Reach 1k teams" }, after: { owner: { kind: "role", role_id: "r1" } } }))).toBe("@growth now owns the initiative Reach 1k teams");
    expect(orgLogLine(row("role_edit", { before: { name: "Growth", avatar: "a" }, after: { name: "Head of Growth", avatar: "b" } }))).toBe("Change the name and face of @growth");
  });

  test("a kind this build does not know still reads as a sentence", () => {
    expect(orgLogLine(row("rename" as any))).toBe('A change this version of codecast cannot show yet ("rename")');
  });

  test("effects read forward on a row and backward on its inverse", () => {
    const hire = row("role", { after: { status: "active", name: "Growth", handle: "growth" }, effects: { takeover: { role_id: "r1", handle: "growth", sessions: [{ conversation_id: "s1", short_id: "jx7abcd", before: { owner_user_ids: ["u1"] } }], kept_in_front: [], over_cap: 0 }, routines_started: [{ agent_task_id: "a1", title: "Weekly" }] } });
    expect(orgLogEffectLines(hire)).toEqual(["1 session now reports to @growth and leaves your needs input", "1 routine started"]);
    expect(orgLogEffectLines(invertRow(hire))).toEqual(["1 session goes back to where it was", "1 routine stopped"]);
  });
});

describe("the way back", () => {
  test("every kind has an inverse kind, and inverting twice gives the kind back", () => {
    for (const [kind, inverse] of Object.entries(ORG_INVERSE_KIND) as Array<[OrgLogKind, OrgLogKind]>) {
      expect(ORG_INVERSE_KIND[inverse]).toBeDefined();
      // A hire's inverse is a retire, whose inverse brings the same role back: a restore, never a second hire.
      if (kind !== "role") expect(ORG_INVERSE_KIND[inverse]).toBe(kind);
    }
    expect(ORG_INVERSE_KIND[ORG_INVERSE_KIND.role]).toBe("restore");
  });

  test("an inverse swaps before and after, points at its row, and inverts back to it", () => {
    const r = row("trust", { before: { trust: "understand" }, after: { trust: "decide" }, undone_by: "x" });
    const inv = invertRow(r);
    expect(inv).toMatchObject({ kind: "trust", before: { trust: "decide" }, after: { trust: "understand" }, undoes: r._id, inverse: true });
    expect(inv.undone_by).toBeUndefined();
    expect(orgLogLine(inv)).toBe("Turned off starting work on its own for @growth");
    const twice = invertRow(inv);
    expect({ kind: twice.kind, before: twice.before, after: twice.after, inverse: twice.inverse }).toEqual({ kind: r.kind, before: r.before, after: r.after, inverse: false });
    expect(orgLogLine(invertRow(row("role", { after: { status: "active", name: "Growth", handle: "growth" } })))).toBe("Retire @growth; its sessions go back to their owners");
    expect(orgLogLine(invertRow(row("retire", { before: { status: "active" }, after: { status: "retired" } })))).toBe("Bring back @growth, with its area of work, its limits and its routines");
  });

  test("undo never overwrites a later decision", () => {
    const r = row("trust", { before: { trust: "understand" }, after: { trust: "decide" } });
    expect(undoVerdict(r, { trust: "decide" })).toEqual({ apply: true });
    expect(undoVerdict(r, { trust: "direct" })).toEqual({ apply: false, reason: "its trust changed after this" });
    expect(undoVerdict(r, null)).toEqual({ apply: false, reason: "it no longer exists" });
    // Key order and an absent field against null are the same reading.
    const scope = row("scope", { after: { scope: { project_ids: ["p1"], plan_ids: [] }, charter: null } });
    expect(undoVerdict(scope, { scope: { plan_ids: [], project_ids: ["p1"] } })).toEqual({ apply: true });
    expect(leftAloneLine(3, 100)).toBe("3 of 100 records were changed after this and stay as they are");
    expect(leftAloneLine(1, 1)).toBe("1 of 1 record was changed after this and stays as it is");
    expect(leftAloneLine(0, 5)).toBe("");
  });

  test("a later entry that touches what this one made is offered with it, and so is what THAT one made", () => {
    const hire = { batch: "b1", rows: [row("role", { batch: "b1", after: { status: "active", name: "Growth", handle: "growth" } })] };
    const lead = { batch: "b2", undone: false, rows: [row("lead", { batch: "b2", subject: { type: "project", id: "p1", label: "Website" }, after: { owner_role_id: "r1" }, role_ids: ["r1"] })] };
    const owner = { batch: "b3", undone: false, rows: [row("initiative_owner", { batch: "b3", subject: { type: "initiative", id: "i1", label: "Reach 1k" }, after: { owner: { kind: "role", role_id: "r1" } }, role_ids: ["r1"] })] };
    const unrelated = { batch: "b4", undone: false, rows: [row("trust", { batch: "b4", subject: { type: "role", id: "r2", label: "@ops" }, after: { trust: "decide" }, role_ids: ["r2"] })] };
    const alreadyUndone = { batch: "b5", undone: true, rows: [row("trust", { batch: "b5", after: { trust: "decide" } })] };
    const itsOwnUndo = { batch: "b6", undone: false, undoes: "b1", rows: [row("retire", { batch: "b6" })] };
    const deps = dependentBatches(hire, [lead, owner, unrelated, alreadyUndone, itsOwnUndo]);
    expect(deps.map((d) => d.batch)).toEqual(["b2", "b3"]);
    expect(deps[0].reason).toBe("@growth now leads the project Website: it needs what this entry made");
    // A change to fields of a role that already stood depends on nothing.
    expect(dependentBatches({ batch: "b4", rows: unrelated.rows }, [lead, owner])).toEqual([]);
    // A project this entry created, then filed into by a later one.
    const created = { batch: "b7", rows: [row("projects", { batch: "b7", subject: { type: "project", id: "p9", label: "New" }, after: { projects: [{ op: "create", project_id: "p9", title: "New" }] }, role_ids: [] })] };
    const filed = { batch: "b8", undone: false, rows: [row("file", { batch: "b8", subject: { type: "plan", id: "pl1", short_id: "pl-7", label: "Launch" }, after: { project_id: "p9" }, role_ids: [] })] };
    expect(dependentBatches(created, [filed]).map((d) => d.batch)).toEqual(["b8"]);
  });
});

describe("an entry reads as one sentence with the count of rows inside", () => {
  const lead = row("plan_status", { subject: { type: "plan", id: "pl1", short_id: "pl-7", label: "Launch" }, after: { status: "done" } });
  const actor = { user_id: "u1", name: "Ashot" };
  test("an accepted ask names the ask", () => {
    expect(orgLogEntryLine({ gesture: "accept_ask", actor: { ...actor, ask: { index: 0, title: "Close the plans and tasks the work has already passed" } }, row_count: 100, lead }))
      .toBe('Accepted "Close the plans and tasks the work has already passed": 100 records');
  });
  test("an undo names the original hire rather than the retirement it performed", () => {
    const hire = row("role", { after: { status: "active", name: "Growth", handle: "growth" } });
    expect(orgLogEntryLine({ gesture: "undo", actor, row_count: 1, lead: invertRow(hire), undoes_lead: hire })).toBe(`Undid "${orgLogLine(hire)}"`);
    expect(orgLogEntryLine({ gesture: "undo", actor, row_count: 1, lead: invertRow(hire) })).toBe("Undid a change");
  });
  test("one row is its own sentence; undo and redo say so", () => {
    expect(orgLogEntryLine({ gesture: "save", actor, row_count: 1, lead })).toBe("Mark done: Launch (pl-7)");
    expect(orgLogEntryLine({ gesture: "save", actor, row_count: 3, lead })).toBe("Mark done: Launch (pl-7), and 2 more changes");
    expect(orgLogEntryLine({ gesture: "undo", actor, row_count: 1, lead: invertRow(lead), undoes_lead: lead })).toBe('Undid "Mark done: Launch (pl-7)"');
    expect(orgLogEntryLine({ gesture: "redo", actor, row_count: 2, lead })).toBe('Applied again "Mark done: Launch (pl-7)": 2 records');
  });
});
