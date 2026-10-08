// The expectations writes (line-map.md LX3, LX5; the-line-model.md LM5): a
// person's edit paints exactly what the server will do with it
// (personEditApplies), and Apply on a proposal whose card is in the queue
// answers that card on the decision rail, so both surfaces settle as one.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";

const s = () => useInboxStore.getState() as any;
const PID = "p".repeat(32);
const ME = "u".repeat(32);
const CARD = "d".repeat(32);
const QUOTE = { kind: "call", ref: "cl-96:718", quote: "a call card's facts should hold true", when: "2026-09-30" };

const row = (over: Record<string, unknown> = {}) => ({
  _id: PID,
  project: { id: PID, title: "Callers & Call Management" },
  current_version: 1,
  doc: { project: { id: PID, title: "Callers" }, version: 1, prefix: "callers-call", next_n: 2, how: "auto", summary: "Seed", applied_at: 1,
    items: [{ id: "ex-callers-call-1", text: "A call card's facts are true.", part: "Calls", status: "active", citations: [QUOTE], added_in: 1, changed_in: 1 }] },
  versions: [],
  proposals: [],
  cursor: null,
  you_answer: false,
  ...over,
});

let calls: Array<[string, unknown[]]> = [];
const owner = {};
beforeAll(() => s()._setDispatch(async (action: string, args: unknown[]) => { calls.push([action, args]); return null; }, { owner }));
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  calls = [];
  useInboxStore.setState({ currentUser: { _id: ME, name: "Cam" }, projectExpectations: { [PID]: row() }, sessionDecisions: {}, pending: {} } as any);
});
const doc = () => s().projectExpectations[PID].doc;

describe("editExpectations", () => {
  it("a line in the person's own words lands as the next version, cited as them, and rides dispatch", () => {
    s().editExpectations(PID, { op: "add", part: "Calls", text: "Callbacks happen only when the contact asked for one." });
    expect(doc().version).toBe(2);
    expect(doc().items[1]).toMatchObject({ id: "ex-callers-call-2", status: "active", citations: [{ kind: "person", ref: ME }] });
    expect(calls[0]).toEqual(["editExpectations", [PID, { op: "add", part: "Calls", text: "Callbacks happen only when the contact asked for one." }]]);
  });

  it("a teammate's retirement paints as an open proposal; the project's person's retires the line", () => {
    s().editExpectations(PID, { op: "retire", id: "ex-callers-call-1", reason: "We show estimates now" });
    expect(doc().version).toBe(1);
    expect(s().projectExpectations[PID].proposals[0]).toMatchObject({ status: "open", short_id: "", ops: [{ op: "retire", id: "ex-callers-call-1" }] });

    useInboxStore.setState({ projectExpectations: { [PID]: row({ you_answer: true }) } } as any);
    s().editExpectations(PID, { op: "retire", id: "ex-callers-call-1", reason: "We show estimates now" });
    expect(doc()).toMatchObject({ version: 2, items: [{ status: "retired", retired_reason: "We show estimates now" }] });
  });
});

describe("editExpectations: changing a line", () => {
  it("the project's person's change paints the next version at once; settling a question clears it", () => {
    useInboxStore.setState({ projectExpectations: { [PID]: row({ you_answer: true, doc: { ...row().doc, items: [{ ...row().doc.items[0], note: "Every caller?" }] } }) } } as any);
    s().editExpectations(PID, { op: "edit", id: "ex-callers-call-1", note: "", why: "Every caller, ruled on the call" });
    expect(doc().version).toBe(2);
    expect(doc().items[0].note).toBeUndefined();
    expect(doc().items[0].citations.at(-1)).toMatchObject({ kind: "person", ref: ME, quote: "Every caller, ruled on the call" });
    expect(calls[0]).toEqual(["editExpectations", [PID, { op: "edit", id: "ex-callers-call-1", note: "", why: "Every caller, ruled on the call" }]]);
  });

  it("a teammate's change paints as an open proposal summarized in their words", () => {
    s().editExpectations(PID, { op: "edit", id: "ex-callers-call-1", text: "A card's facts are true for brokers." });
    expect(doc().version).toBe(1);
    expect(s().projectExpectations[PID].proposals[0]).toMatchObject({ status: "open", summary: "You changed ex-callers-call-1: A card's facts are true for brokers.", ops: [{ op: "edit", text: "A card's facts are true for brokers." }] });
  });
});

describe("resolveExpectationProposal", () => {
  const open = { short_id: "xp-2", status: "open", summary: "Retire", changes: 1, base_version: 1, created_at: 1, card_id: CARD, ops: [{ op: "retire", id: "ex-callers-call-1", reason: "ruled out", citations: [QUOTE] }] };

  it("Apply lands the change and answers the card the queue holds, as the queue would", () => {
    useInboxStore.setState({
      projectExpectations: { [PID]: row({ proposals: [open] }) },
      sessionDecisions: { [CARD]: { _id: CARD, status: "pending", silent: true, conversation_id: "c1", question: "Apply?", options: [{ label: "Apply" }, { label: "Drop" }] } },
    } as any);
    s().resolveExpectationProposal(PID, "xp-2", "apply");
    expect(s().projectExpectations[PID].proposals[0]).toMatchObject({ status: "applied", applied_version: 2 });
    expect(doc().items[0].status).toBe("retired");
    expect(s().sessionDecisions[CARD]).toMatchObject({ status: "answered", answer_index: 0 });
    expect(calls[0]).toEqual(["resolveExpectationProposal", [PID, "xp-2", "apply"]]);
  });

  it("Drop closes it and leaves the document as it was", () => {
    useInboxStore.setState({ projectExpectations: { [PID]: row({ proposals: [{ ...open, card_id: undefined }] }) } } as any);
    s().resolveExpectationProposal(PID, "xp-2", "drop");
    expect(s().projectExpectations[PID].proposals[0].status).toBe("dropped");
    expect(doc().version).toBe(1);
  });
});
