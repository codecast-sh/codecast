import { describe, expect, test } from "bun:test";
import { ORG_CHARTER_MAX, applyCharterEdits, orgCharterEditError, orgRecordGroups, orgRecordRedundancyErrors, recordGroupTotalsLine, type OrgRecordAct } from "@codecast/shared/contracts/orgProposal";
import { askNames } from "./staffingAsks";
import {
  ESCALATIONS_CHARTER, ESCALATIONS_CHARTER_EDITS, ESCALATIONS_CHARTER_SENTENCES, ORG_CHARTER_EDIT_FIXTURE_PROPOSAL, ORG_LONG_CHARTER_FIXTURE_PROPOSAL,
  ORG_RECORDS_FIXTURE_PROJECTS, ORG_RECORDS_FIXTURE_PROPOSAL, ORG_RECORDS_FIXTURE_PROPOSAL_BARE, ORG_RECORDS_FIXTURE_PROPOSAL_SENT, ORG_RECORDS_FIXTURE_TREE,
  RECORD_REASONS, RECORD_TASK_PHRASES,
} from "./orgRecordsFixture";

// The fixture world the record and charter cards are built and tested on.
// The groups and totals are read through the shared helpers the card uses,
// so the table here is what the card will say.
const names = askNames(ORG_RECORDS_FIXTURE_TREE);
const sentences = (text: string) => text.split(/(?<=[.!?])\s+(?=[A-Z])/);
const groupsOf = (p: { changes: { seq: number; change: any; status?: string }[] }) => orgRecordGroups(p.changes, names);

describe("the record proposal (op-901)", () => {
  test("reads as six groups, by project then plan, the loose tasks last", () => {
    const groups = groupsOf(ORG_RECORDS_FIXTURE_PROPOSAL);
    expect(groups.map((g) => [g.kind, g.title ?? g.ref, g.seqs.length, recordGroupTotalsLine(g)])).toEqual([
      ["project", "Matching Engine & Funnel", 20, "1 plan done, 2 plans abandoned, 14 tasks done and 3 tasks reopened"],
      ["project", "Callers & Call Management", 18, "2 plans done, 1 plan abandoned, 12 tasks done, 1 task dropped and 2 tasks reopened"],
      ["project", "Infrastructure", 9, "1 plan done, 6 tasks done and 2 tasks reopened"],
      ["plan", "Counterparty pitches", 6, "1 plan done and 5 tasks done"],
      ["plan", "Networks", 5, "1 plan reopened and 4 tasks reopened"],
      ["loose", undefined, 6, "2 tasks done, 3 tasks reopened and 1 task to the backlog"],
    ]);
    expect(ORG_RECORDS_FIXTURE_PROPOSAL.changes.map((c) => c.seq)).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    expect(groups.flatMap((g) => g.seqs).sort((a, b) => a - b)).toEqual(ORG_RECORDS_FIXTURE_PROPOSAL.changes.map((c) => c.seq));
    expect(orgRecordRedundancyErrors(ORG_RECORDS_FIXTURE_PROPOSAL.changes)).toEqual([]);
    expect(ORG_RECORDS_FIXTURE_PROPOSAL.asks?.[0].seqs).toHaveLength(64);
  });

  test("the totals sum to 64: 44 done, 15 reopened, 3 abandoned, 1 dropped, 1 to the backlog", () => {
    const sum: Partial<Record<OrgRecordAct, number>> = {};
    for (const g of groupsOf(ORG_RECORDS_FIXTURE_PROPOSAL)) for (const t of g.totals) sum[t.act] = (sum[t.act] ?? 0) + t.count;
    expect(sum).toEqual({ done: 44, reopened: 15, abandoned: 3, dropped: 1, backlog: 1 });
  });

  test("every row carries a title and a reason; three phrases run past 180 characters and the 220-character reason sits in the first group", () => {
    for (const c of ORG_RECORDS_FIXTURE_PROPOSAL.changes) {
      expect(c.change.kind === "plan_status" || c.change.kind === "task_status").toBe(true);
      if (c.change.kind === "plan_status" || c.change.kind === "task_status") { expect(c.change.title).toBeTruthy(); expect(c.change.reason).toBeTruthy(); }
    }
    expect(RECORD_TASK_PHRASES).toHaveLength(12);
    expect(RECORD_TASK_PHRASES.filter((p) => p.length > 180)).toHaveLength(3);
    const long = RECORD_REASONS.done.find((r) => r.length === 220)!;
    expect(long).toBeTruthy();
    const first = groupsOf(ORG_RECORDS_FIXTURE_PROPOSAL)[0];
    expect(ORG_RECORDS_FIXTURE_PROPOSAL.changes.some((c) => first.seqs.includes(c.seq) && (c.change as any).reason === long)).toBe(true);
  });

  test("the bare twin is the same 64 with no plan or project filed on any row", () => {
    const bare = ORG_RECORDS_FIXTURE_PROPOSAL_BARE;
    expect(bare.changes.map((c) => [c.seq, c.change.kind, (c.change as any).status])).toEqual(ORG_RECORDS_FIXTURE_PROPOSAL.changes.map((c) => [c.seq, c.change.kind, (c.change as any).status]));
    for (const c of bare.changes) {
      expect((c.change as any).project).toBeUndefined();
      if (c.change.kind === "task_status") expect(c.change.plan).toBeUndefined();
    }
    // A plan close always names its plan, so none is loose: the nine fold into one plans group; the tasks are loose.
    const groups = groupsOf(bare);
    expect(groups.filter((g) => g.kind === "project")).toHaveLength(0);
    expect(groups.find((g) => g.kind === "loose")?.seqs).toHaveLength(55);
  });

  test("the sent twin: the first group applied, the second part way, the third rejected, two of the plan's rows failed, the rest waiting", () => {
    const by = new Map(groupsOf(ORG_RECORDS_FIXTURE_PROPOSAL).map((g) => [g.title ?? g.key, g.seqs]));
    const rows = new Map(ORG_RECORDS_FIXTURE_PROPOSAL_SENT.changes.map((c) => [c.seq, c]));
    const statuses = (title: string) => by.get(title)!.map((seq) => rows.get(seq)!.status);
    expect(statuses("Matching Engine & Funnel").every((s) => s === "applied")).toBe(true);
    expect(statuses("Callers & Call Management")).toEqual([...Array(10).fill("applied"), ...Array(8).fill("accepted")]);
    expect(statuses("Infrastructure").every((s) => s === "skipped")).toBe(true);
    expect(by.get("Infrastructure")!.every((seq) => rows.get(seq)!.reply?.verdict === "reject" && rows.get(seq)!.reply?.text === "Not yet")).toBe(true);
    expect(statuses("Counterparty pitches")).toEqual(["failed", "failed", "proposed", "proposed", "proposed", "proposed"]);
    expect(by.get("Counterparty pitches")!.slice(0, 2).map((seq) => rows.get(seq)!.applied_note)).toEqual(["pl-911 is already done", "pl-911 is already done"]);
    expect(statuses("Networks").every((s) => s === "proposed")).toBe(true);
    expect(statuses("loose").every((s) => s === "proposed")).toBe(true);
  });
});

describe("the charter proposals", () => {
  test("@escalations has a seven-sentence, 620-character charter, and op-902's edits apply to it", () => {
    expect(ESCALATIONS_CHARTER_SENTENCES).toHaveLength(7);
    expect(ESCALATIONS_CHARTER).toHaveLength(620);
    expect(ORG_RECORDS_FIXTURE_TREE.roles.find((r) => r.handle === "escalations")?.charter).toBe(ESCALATIONS_CHARTER);
    expect(ESCALATIONS_CHARTER_EDITS.map((e) => e.op)).toEqual(["replace", "add", "remove"]);
    for (const e of ESCALATIONS_CHARTER_EDITS) expect(orgCharterEditError(e)).toBeNull();
    const applied = applyCharterEdits(ESCALATIONS_CHARTER, ESCALATIONS_CHARTER_EDITS);
    expect(applied.error).toBeUndefined();
    expect(applied.charter).not.toContain(ESCALATIONS_CHARTER_SENTENCES[1]);
    expect(applied.charter).not.toContain(ESCALATIONS_CHARTER_SENTENCES[5]);
    expect(applied.charter).toContain(ESCALATIONS_CHARTER_SENTENCES[3]);
    const added = ESCALATIONS_CHARTER_EDITS[1];
    if (added.op === "add") expect(applied.charter).toContain(added.line);
  });

  test("op-902: the edit's two-edit before, and a goal that grows from two sentences to three", () => {
    const [edit, meta] = ORG_CHARTER_EDIT_FIXTURE_PROPOSAL.changes;
    expect(ORG_CHARTER_EDIT_FIXTURE_PROPOSAL.short_id).toBe("op-902");
    expect(edit.change.kind).toBe("charter_edit");
    expect(edit.revision?.kind).toBe("amended");
    expect(edit.revision?.before?.kind === "charter_edit" && edit.revision.before.edits).toHaveLength(2);
    if (meta.change.kind !== "project_meta") throw new Error("second change is the project goal");
    expect(meta.change.project).toBe("pr-901");
    const live = ORG_RECORDS_FIXTURE_PROJECTS.find((p) => p.short_id === "pr-901")!.goal!;
    expect(sentences(live)).toHaveLength(2);
    expect(sentences(meta.change.goal!)).toHaveLength(3);
  });

  test("op-903: a 190-character project, a 1449-character charter with steps, an e.g. and a URL, and an 874-character before", () => {
    const [project, role] = ORG_LONG_CHARTER_FIXTURE_PROPOSAL.changes;
    if (project.change.kind !== "projects" || project.change.changes[0].op !== "create") throw new Error("first change creates the project");
    expect(project.change.changes[0].description).toHaveLength(190);
    if (role.change.kind !== "role") throw new Error("second change is the role");
    expect(role.change.charter).toHaveLength(1449);
    expect(role.change.charter!.length).toBeGreaterThan(ORG_CHARTER_MAX);
    expect(role.change.charter).toMatch(/1\. .* 2\. .* 3\. .* 4\. .* 5\. /);
    expect(role.change.charter).toContain("e.g.");
    expect(role.change.charter).toMatch(/https:\/\/\S+/);
    expect(role.change.scope?.projects).toEqual([project.change.changes[0].title]);
    expect(role.change.reports_to).toBe("Cam");
    expect(role.revision?.kind).toBe("amended");
    const before = role.revision?.before;
    if (before?.kind !== "role") throw new Error("the before is a role");
    expect(before.charter).toHaveLength(874);
    expect({ ...before, charter: undefined }).toEqual({ ...role.change, charter: undefined });
  });
});
