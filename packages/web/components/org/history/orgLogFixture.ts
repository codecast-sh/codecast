// A typed record for the History surfaces (docs/architecture/org-staffing.md
// S21): the DEV preview and the mount tests paint from it. Every row is the
// contract's own shape (shared/contracts/orgChange.ts), so a sentence here is
// the sentence the live page writes. The ids match orgFixture.ts where a row
// names a role of the fixture tree.
import type { OrgLogEntry, OrgLogKind, OrgLogRow, OrgUndoPreview } from "@codecast/shared/contracts/orgChange";

const HOUR = 3_600_000;
const ME = { user_id: "fixture-user-ashot", name: "Ashot Petrosian" };
const SAM = { user_id: "fixture-user-sam", name: "Sam Rivera" };

function row(batch: string, seq: number, at: number, kind: OrgLogKind, subject: OrgLogRow["subject"], fields: Partial<Pick<OrgLogRow, "before" | "after" | "effects" | "labels" | "role_ids" | "inverse" | "skipped" | "undoes">> = {}): OrgLogRow {
  return { _id: `${batch}-r${seq}`, batch, seq, kind, subject, before: {}, after: {}, effects: {}, labels: {}, role_ids: subject.type === "role" ? [subject.id] : [], at, ...fields };
}

const CLOSED: [string, string, "plan" | "task"][] = [
  ["pl-412", "Move billing to usage pricing", "plan"],
  ["pl-398", "Onboarding checklist", "plan"],
  ["ct-5120", "Send the first invoice from the new ledger", "task"],
  ["ct-5098", "Remove the old pricing table", "task"],
  ["ct-5077", "Write the migration note for support", "task"],
  ["ct-5031", "Turn off the legacy webhook", "task"],
];

/** The record and its rows at `now`, newest first. */
export function orgLogFixture(now: number): { entries: OrgLogEntry[]; rows: Record<string, OrgLogRow[]>; previews: Record<string, OrgUndoPreview> } {
  const entry = (batch: string, seq: number, at: number, e: Pick<OrgLogEntry, "door" | "gesture" | "actor" | "row_count" | "kinds" | "lead"> & Partial<OrgLogEntry>): OrgLogEntry =>
    ({ _id: batch, batch, workspace: "team:fixture-team", team_id: "fixture-team", seq, at, role_ids: e.lead?.role_ids ?? [], may_undo: true, ...e });

  // An ask accepted from a proposal: 100 records behind one sentence.
  const tAsk = now - 0.4 * HOUR;
  const askRows = Array.from({ length: 100 }, (_, i) => {
    const [short, title, type] = CLOSED[i % CLOSED.length];
    const shortId = i < CLOSED.length ? short : `${type === "plan" ? "pl" : "ct"}-${4000 + i}`;
    return row("b-ask", 200 + i, tAsk, type === "plan" ? "plan_status" : "task_status", { type, id: `fx-${shortId}`, short_id: shortId, label: title }, { before: { status: type === "plan" ? "active" : "open" }, after: { status: "done" } });
  });

  // One Settings save: a daily limit.
  const tBudget = now - 2.2 * HOUR;
  const budget = row("b-budget", 199, tBudget, "budget", { type: "role", id: "fixture-role-growth", short_id: "or-2", label: "growth" }, { before: { caps: { tokens_per_day: 400_000 } }, after: { caps: { tokens_per_day: 800_000, wakes_per_day: 12 } } });

  // One drag on the chart.
  const tMove = now - 5 * HOUR;
  const move = row("b-move", 198, tMove, "move", { type: "role", id: "fixture-role-docs", short_id: "or-5", label: "docs" }, { before: { reports_to: { kind: "user", user_id: ME.user_id } }, after: { reports_to: { kind: "role", role_id: "fixture-role-growth" } }, labels: { "fixture-role-growth": "@growth", [ME.user_id]: ME.name }, role_ids: ["fixture-role-docs", "fixture-role-growth"] });

  // A hire that took over sessions, taken back an hour later.
  const tHire = now - 27 * HOUR;
  const hire = row("b-hire", 190, tHire, "role", { type: "role", id: "fixture-role-platform", short_id: "or-7", label: "platform" }, {
    before: { status: null },
    after: { status: "active", name: "Platform Lead", handle: "platform", reports_to: { kind: "user", user_id: ME.user_id }, scope: { project_ids: ["fx-p-platform"], plan_ids: [] } },
    labels: { [ME.user_id]: "you", "fx-p-platform": "Platform" },
    effects: {
      takeover: { role_id: "fixture-role-platform", handle: "platform", sessions: Array.from({ length: 7 }, (_, i) => ({ conversation_id: `fx-c-${i}`, short_id: `jx7fx0${i}`, before: { owner_user_ids: [ME.user_id] } })), kept_in_front: ["fx-c-0"], over_cap: 0, told: { sessions: 5, deferred: 2 } },
      routines_started: [{ agent_task_id: "fx-at-1", title: "Weekly platform review" }],
    },
  });
  const tUndo = now - 26 * HOUR;
  const unhire = row("b-undo-hire", 196, tUndo, "retire", hire.subject, { before: hire.after, after: { status: "retired" }, effects: hire.effects, labels: hire.labels, inverse: true, undoes: hire._id });

  // A lead named on a project page, by a teammate: not the viewer's to undo.
  const tLead = now - 4 * 24 * HOUR;
  const lead = row("b-lead", 150, tLead, "lead", { type: "project", id: "fx-p-billing", label: "Billing" }, { before: { owner_role_id: null }, after: { owner_role_id: "fixture-role-growth" }, labels: { "fixture-role-growth": "@growth" }, role_ids: ["fixture-role-growth"], effects: { scope_gained: { role_id: "fixture-role-growth", handle: "growth", project_ids: ["fx-p-billing"], plan_ids: [] } } });
  lead.labels["fx-p-billing"] = "Billing";

  const entries: OrgLogEntry[] = [
    entry("b-ask", 299, tAsk, { door: "proposal", gesture: "accept_ask", actor: { ...ME, proposal: { short_id: "op-7", title: "First review" }, ask: { index: 0, title: "Close the plans and tasks the work has already passed" } }, row_count: 100, kinds: { plan_status: 34, task_status: 66 }, lead: askRows[0] }),
    entry("b-budget", 199, tBudget, { door: "settings", gesture: "save", actor: ME, row_count: 1, kinds: { budget: 1 }, lead: budget }),
    entry("b-move", 198, tMove, { door: "chart", gesture: "drag", actor: ME, row_count: 1, kinds: { move: 1 }, lead: move, role_ids: move.role_ids }),
    entry("b-undo-hire", 196, tUndo, { door: "history", gesture: "undo", actor: ME, row_count: 1, kinds: { retire: 1 }, lead: unhire, undoes: "b-hire", undoes_lead: hire }),
    entry("b-hire", 190, tHire, { door: "proposal", gesture: "accept_change", actor: { ...ME, proposal: { short_id: "op-6" } }, row_count: 1, kinds: { role: 1 }, lead: hire, undone_by: { batch: "b-undo-hire", ...ME, at: tUndo } }),
    entry("b-lead", 150, tLead, { door: "project_page", gesture: "save", actor: SAM, row_count: 1, kinds: { lead: 1 }, lead, role_ids: lead.role_ids, may_undo: false }),
  ];

  const inverse = (r: OrgLogRow, fields: Partial<OrgLogRow> = {}): OrgLogRow => ({ ...r, _id: `${r._id}-inv`, before: r.after, after: r.before, inverse: true, undoes: r._id, ...fields });
  const previews: Record<string, OrgUndoPreview> = {
    // The four parts at once: what goes back, what changed since and stays,
    // the later entry that goes with it, and what cannot be taken back.
    "b-ask": {
      batch: "b-ask",
      will_change: askRows.slice(3).map((r) => inverse(r)),
      left_alone: askRows.slice(0, 3).map((r) => ({ row: inverse(r, { skipped: "its status changed after this" }), changed_by: { batch: "b-later", name: SAM.name, at: now - 0.1 * HOUR } })),
      depends: [],
      cannot_take_back: [],
    },
    "b-budget": { batch: "b-budget", will_change: [inverse(budget)], left_alone: [], depends: [], cannot_take_back: [{ kind: "wake_ran", count: 3 }] },
    "b-move": { batch: "b-move", will_change: [inverse(move)], left_alone: [], depends: [], cannot_take_back: [] },
    // A redo of the hire: the hire applied again.
    "b-hire": { batch: "b-hire", will_change: [{ ...hire, _id: "b-hire-redo" }], left_alone: [], depends: [], cannot_take_back: [] },
  };
  // The move depends on nothing, but the budget's role later moved: the hire
  // fixture shows a dependent entry when it is undone from a fresh record.
  previews["b-hire-fresh"] = { batch: "b-hire", will_change: [unhire], left_alone: [], depends: [entries[1]], cannot_take_back: [{ kind: "message_sent", count: 2 }, { kind: "session_worked", count: 5 }] };

  return { entries, rows: { "b-ask": askRows, "b-budget": [budget], "b-move": [move], "b-hire": [hire], "b-undo-hire": [unhire], "b-lead": [lead] }, previews };
}
