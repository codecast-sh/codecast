// Undo and redo on the org record (docs/architecture/org-staffing.md S21), as
// the store sees them: the entry is marked in the tick of the gesture, a list
// push that predates the mutation cannot take the mark off, the server's own
// stamp settles the journal, and a refusal puts the record back.
// Run: bun test store/__tests__/orgSlice.undo.test.ts
import { describe, expect, it } from "bun:test";
import { create as mutate } from "mutative";
import { applyOrgUndoIntent, createOrgSlice, dropRejectedOrgIntent, pruneOrgIntents, ORG_INTENT_TTL_MS, type OrgIntent, type OrgSliceData } from "../orgSlice";
import { ORG_FIXTURE } from "../../components/org/orgFixture";
import { orgLogFixture } from "../../components/org/history/orgLogFixture";

const NOW = Date.UTC(2026, 8, 20, 18);
const log = () => Object.fromEntries(orgLogFixture(NOW).entries.map((e) => [e._id, e]));
const data = (): OrgSliceData => ({ orgTree: JSON.parse(JSON.stringify(ORG_FIXTURE)), orgTreeServer: null, orgIntents: [], orgHealth: null, orgProposals: {}, orgProposalChanges: {}, orgLog: log(), orgLogRows: {}, orgFocusChangeId: null, orgIntentNotice: null });
const me = ORG_FIXTURE.people.find((p) => p.is_me)!;

function run(st: OrgSliceData, name: keyof ReturnType<typeof createOrgSlice>, ...args: any[]): OrgSliceData {
  const slice = createOrgSlice();
  return mutate(st, (draft) => { (slice[name] as any).call(draft, ...args); });
}
type Undo = Extract<OrgIntent, { kind: "undoChange" }>;

describe("undo on the org record", () => {
  it("marks the entry, and the later entries that go with it, at once under the person's name", () => {
    const st = run(data(), "undoOrgChange", "b-budget", { with: ["b-move"], line: "Growth may use more" });
    expect(st.orgLog["b-budget"].undone_by).toMatchObject({ batch: "", user_id: me.user_id, name: me.name });
    expect(st.orgLog["b-move"].undone_by?.batch).toBe("");
    expect(st.orgLog["b-ask"].undone_by).toBeUndefined();
    const intent = st.orgIntents[0] as Undo;
    expect([intent.kind, intent.batch, intent.with, intent.redo]).toEqual(["undoChange", "b-budget", ["b-move"], false]);
    // Pressing it again while the first is in flight adds nothing.
    expect(run(st, "undoOrgChange", "b-budget").orgIntents).toHaveLength(1);
  });

  it("a list push that predates the mutation is marked again, and the server's named batch settles the journal", () => {
    const st = run(data(), "undoOrgChange", "b-budget");
    const stale = log();
    applyOrgUndoIntent(stale, st.orgIntents[0] as Undo);
    expect(stale["b-budget"].undone_by?.batch).toBe("");
    const echoed = mutate(st, (d) => { d.orgLog["b-budget"].undone_by = { batch: "b-undo-budget", user_id: me.user_id, name: me.name, at: NOW }; pruneOrgIntents(d); });
    expect(echoed.orgIntents).toEqual([]);
    expect(echoed.orgLog["b-budget"].undone_by?.batch).toBe("b-undo-budget");
  });

  it("settles on a page that holds no tree", () => {
    const st = mutate(run(data(), "undoOrgChange", "b-budget"), (d) => { d.orgTree = null; d.orgLog["b-budget"].undone_by = { batch: "b-x", user_id: "u", name: "n", at: NOW }; pruneOrgIntents(d); });
    expect(st.orgIntents).toEqual([]);
  });

  it("a refusal puts the record back and tells the person in one line", () => {
    let st = run(data(), "undoOrgChange", "b-budget", { with: ["b-move"], line: "Growth may use more" });
    const reverted: string[] = [];
    const notices = dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: (id) => reverted.push(id) }, "undoOrgChange", ["b-budget", { with: ["b-move"] }]);
    expect(reverted).toEqual([st.orgIntents[0].id]);
    expect(notices).toEqual(['Taking back "Growth may use more" was refused; the record is as it was.']);
    st = run(st, "revertOrgIntent", reverted[0]);
    expect(st.orgLog["b-budget"].undone_by).toBeUndefined();
    expect(st.orgLog["b-move"].undone_by).toBeUndefined();
    expect(st.orgIntents).toEqual([]);
  });

  it("an undo nobody echoed ages out, goes back, and leaves a notice; a stamp the server wrote is never taken off", () => {
    const pressed = run(data(), "undoOrgChange", "b-budget", { line: "L" });
    const aged = mutate(pressed, (d) => { pruneOrgIntents(d, Date.now() + ORG_INTENT_TTL_MS + 1); });
    expect(aged.orgLog["b-budget"].undone_by).toBeUndefined();
    expect(aged.orgIntentNotice?.text).toMatch(/did not reach the server/);
    const stamped = mutate(pressed, (d) => { d.orgLog["b-budget"].undone_by!.batch = "b-real"; });
    expect(run(stamped, "revertOrgIntent", stamped.orgIntents[0].id).orgLog["b-budget"].undone_by?.batch).toBe("b-real");
  });

  it("redo takes the strike off at once, and a refusal puts the same strike back", () => {
    const was = data().orgLog["b-hire"].undone_by!;
    let st = run(data(), "redoOrgChange", "b-hire", { line: "Add @platform" });
    expect(st.orgLog["b-hire"].undone_by).toBeUndefined();
    // Redo of an entry that stands does nothing.
    expect(run(data(), "redoOrgChange", "b-budget").orgIntents).toEqual([]);
    const notices = dropRejectedOrgIntent({ orgIntents: st.orgIntents, dropOrgIntent: () => {}, revertOrgIntent: () => {} }, "redoOrgChange", ["b-hire"]);
    expect(notices).toEqual(['Applying "Add @platform" again was refused; the record is as it was.']);
    st = run(st, "revertOrgIntent", st.orgIntents[0].id);
    expect(st.orgLog["b-hire"].undone_by).toEqual(was);
  });
});
