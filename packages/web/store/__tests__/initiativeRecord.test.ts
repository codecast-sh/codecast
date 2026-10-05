// The intent record on the real store (store/initiativeRecord.ts and the
// slice's recordInitiativeEntry; initiatives-projects-role-page.md I5): what
// an op paints in the tick of the gesture, the op the side effect is handed
// (the whole entry, so the server stores what the page shows), and the ops an
// undo sends to put one entry back by key.
// Run: bun test store/__tests__/initiativeRecord.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, undoEntry } from "@platform/engine";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore } from "../inboxStore";
import { asStoredEntry, recordOpsBetween, settleRecordOp } from "../initiativeRecord";

const ID = "i".repeat(32);
const ME = "u".repeat(32);
const row = (extra: Partial<InitiativeRow> = {}): InitiativeRow => ({
  _id: ID, short_id: "in-1", title: "Grow", status: "active", project_ids: [], health: "none",
  workspace: `user:${ME}`, user_id: ME, created_at: 1, updated_at: 1, ...extra,
});

const s = () => useInboxStore.getState() as any;
const goal = () => s().initiatives[ID] as InitiativeRow;
let sent: Array<{ action: string; args: any[]; result: any }> = [];
const owner = {};

beforeAll(() => {
  s()._setDispatch(async (action: string, args: any[], _patches: unknown, result: any) => { sent.push({ action, args, result }); return null; }, { owner });
});
afterAll(() => s()._clearDispatch(owner));
beforeEach(() => {
  _resetUndoStacks();
  sent = [];
  useInboxStore.setState({ pending: {}, currentUser: { _id: ME, name: "Ashot", github_username: "Ashot" }, initiatives: { [ID]: row() } } as any);
});

describe("settleRecordOp", () => {
  const who = { by: "@ashot", now: 1_000 };

  it("keys a new milestone by its words and numbers a clash", () => {
    const first = settleRecordOp([], { list: "milestones", action: "add", entry: { title: "  Private beta open ", date: 5 } }, who)!;
    expect(first.next).toEqual([{ date: 5, key: "private_beta_open", title: "Private beta open" }]);
    expect(first.op).toEqual({ list: "milestones", action: "add", entry: first.next[0] });
    const second = settleRecordOp(first.next, { list: "milestones", action: "add", entry: { title: "Private beta open" } }, who)!;
    expect(second.next[1].key).toBe("private_beta_open_2");
  });

  it("signs a question with who asked and when, fields in the server's order", () => {
    const { next } = settleRecordOp([], { list: "questions", action: "add", entry: { text: "Per seat?" } }, who)!;
    expect(JSON.stringify(next[0])).toBe('{"at":1000,"by":"@ashot","key":"per_seat","text":"Per seat?"}');
  });

  it("reads a typed source: an address with words, or words alone as a note", () => {
    const task = settleRecordOp([], { list: "sources", action: "add", entry: { text: "ct-12 said so", by: "Sam" } }, who)!;
    expect(task.next).toEqual([{ by: "Sam", kind: "task", quote: "said so", ref: "ct-12" }]);
    const note = settleRecordOp(task.next, { list: "sources", action: "add", entry: { text: "our goal is ten brokers" } }, who)!;
    expect(note.next[1]).toEqual({ kind: "note", quote: "our goal is ten brokers" });
    // The same address twice, and no words at all, move nothing.
    expect(settleRecordOp(task.next, { list: "sources", action: "add", entry: { text: "ct-12" } }, who)).toBeNull();
    expect(settleRecordOp([], { list: "sources", action: "add", entry: { text: "   " } }, who)).toBeNull();
  });

  it("a decision typed with where it was decided stores the source read", () => {
    const { next } = settleRecordOp([], { list: "decisions", action: "add", entry: { text: "Ship to brokers first", source: { text: "jx7c6zk:142" } } }, who)!;
    expect(next[0].source).toEqual({ kind: "session", ref: "jx7c6zk:142" });
  });

  it("close reaches a milestone and answers a question, dated", () => {
    const reached = settleRecordOp([{ key: "a", title: "A" }], { list: "milestones", action: "close", key: "a" }, who)!;
    expect(reached.next).toEqual([{ done_at: 1_000, key: "a", title: "A" }]);
    expect(reached.op).toEqual({ list: "milestones", action: "close", key: "a", at: 1_000 });
    const answered = settleRecordOp([{ at: 1, key: "q", text: "Q?" }], { list: "questions", action: "close", key: "q", answer: " Yes " }, who)!;
    expect(answered.next).toEqual([{ answer: "Yes", answered_at: 1_000, at: 1, key: "q", text: "Q?" }]);
    expect(answered.op).toEqual({ list: "questions", action: "close", key: "q", at: 1_000, answer: "Yes" });
    expect(settleRecordOp([{ at: 1, key: "d", text: "D" }], { list: "decisions", action: "close", key: "d" }, who)).toBeNull();
  });

  it("an edit clears a field with null; a key that names nothing, a full list and no words move nothing", () => {
    const reopened = settleRecordOp([{ done_at: 9, key: "a", title: "A" }], { list: "milestones", action: "edit", key: "a", entry: { done_at: null } }, who)!;
    expect(reopened.next).toEqual([{ key: "a", title: "A" }]);
    expect(settleRecordOp([], { list: "milestones", action: "remove", key: "nope" }, who)).toBeNull();
    expect(settleRecordOp([], { list: "milestones", action: "add", entry: { title: " " } }, who)).toBeNull();
    const full = Array.from({ length: 12 }, (_, i) => ({ key: `m${i}`, title: `M${i}` }));
    expect(settleRecordOp(full, { list: "milestones", action: "add", entry: { title: "One more" } }, who)).toBeNull();
  });
});

describe("recordOpsBetween", () => {
  it("names each entry's way back by key: remove what was added, add back what is gone, edit what changed", () => {
    const was = [{ key: "a", title: "A" }, { key: "b", title: "B" }];
    const now = [{ done_at: 5, key: "a", title: "A" }, { key: "c", title: "C" }];
    expect(recordOpsBetween("milestones", now, was)).toEqual([
      { list: "milestones", action: "remove", key: "c" },
      { list: "milestones", action: "edit", key: "a", entry: { done_at: null, key: "a", title: "A" } },
      { list: "milestones", action: "add", entry: { key: "b", title: "B" } },
    ]);
    expect(recordOpsBetween("sources", [{ kind: "task", ref: "ct-1" }], undefined)).toEqual([{ list: "sources", action: "remove", key: "task:ct-1" }]);
  });
});

describe("recordInitiativeEntry", () => {
  it("paints the entry in the tick and hands the side effect the op that carries it whole", () => {
    s().recordInitiativeEntry(ID, { list: "questions", action: "add", entry: { text: "Do we price per seat?" } });
    const q = goal().questions![0];
    expect(q).toMatchObject({ by: "@ashot", key: "do_we_price_per_seat", text: "Do we price per seat?" });
    expect(goal().updated_at).toBeGreaterThan(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].action).toBe("recordInitiativeEntry");
    expect(sent[0].result).toEqual({ list: "questions", action: "add", entry: structuredClone(q) });
  });

  it("the lock on the list holds against a stale push and retires on the server's echo", () => {
    const locks = () => Object.keys(s().pending).filter((k) => k.startsWith(`initiatives:${ID}:`) && !k.endsWith(":updated_at"));
    s().recordInitiativeEntry(ID, { list: "decisions", action: "add", entry: { text: "Ship to brokers first", source: { text: "ct-12" } } });
    const painted = structuredClone(goal().decisions);
    s().syncTable("initiatives", [row({ updated_at: 2 })]);
    expect(goal().decisions).toEqual(painted);
    expect(locks()).toEqual([`initiatives:${ID}:decisions`]);
    // The server hands an object's fields back sorted by name.
    const echoed = painted!.map((d: any) => Object.fromEntries(Object.entries({ ...d, source: Object.fromEntries(Object.entries(d.source).sort(([a], [b]) => (a < b ? -1 : 1))) }).sort(([a], [b]) => (a < b ? -1 : 1))));
    s().syncTable("initiatives", [row({ updated_at: 3, decisions: echoed as any })]);
    expect(locks()).toEqual([]);
  });

  it("removing the last entry leaves the list absent, as the server stores it", () => {
    useInboxStore.setState({ initiatives: { [ID]: row({ sources: [{ kind: "task", ref: "ct-1" }] }) } } as any);
    s().recordInitiativeEntry(ID, { list: "sources", action: "remove", key: "task:ct-1" });
    expect(goal().sources).toBeUndefined();
  });

  it("why and done when ride updateInitiative, and a clear leaves the field absent", () => {
    s().updateInitiative(ID, { why: "Because", done_when: "Ten teams pay" });
    expect(goal()).toMatchObject({ why: "Because", done_when: "Ten teams pay" });
    s().updateInitiative(ID, { why: null });
    expect(goal().why).toBeUndefined();
  });
});

describe("undo of a record edit", () => {
  /** Run the gesture, then its undo; return what the undo dispatched. */
  function undoOf(gesture: () => void): Array<[string, any[]]> {
    gesture();
    const entry = getUndoHistory().items[0];
    expect(entry?.status).toBe("done");
    sent = [];
    expect(undoEntry(entry!.id)).toBe(true);
    return sent.map((c) => [c.action, c.args]);
  }

  it("a milestone reached goes back by an edit that clears its date, never by replacing the list", () => {
    useInboxStore.setState({ initiatives: { [ID]: row({ milestones: [{ key: "a", title: "A" }, { key: "b", title: "B" }] }) } } as any);
    const calls = undoOf(() => s().recordInitiativeEntry(ID, { list: "milestones", action: "close", key: "a" }));
    expect(getUndoHistory().items[0]?.label).toBe("Reached a milestone of “Grow”");
    expect(calls).toEqual([["recordInitiativeEntry", [ID, { list: "milestones", action: "edit", key: "a", entry: { done_at: null, key: "a", title: "A" } }]]]);
    expect(goal().milestones).toEqual([{ key: "a", title: "A" }, { key: "b", title: "B" }]);
  });

  it("an added decision is removed, and a removed source is added back whole", () => {
    const added = undoOf(() => s().recordInitiativeEntry(ID, { list: "decisions", action: "add", entry: { text: "Ship to brokers first" } }));
    expect(added).toEqual([["recordInitiativeEntry", [ID, { list: "decisions", action: "remove", key: "ship_to_brokers_first" }]]]);
    expect(goal().decisions).toBeUndefined();

    const source = { by: "Sam", kind: "task", quote: "said so", ref: "ct-12" };
    useInboxStore.setState({ initiatives: { [ID]: row({ sources: [source as any] }) } } as any);
    _resetUndoStacks();
    const removed = undoOf(() => s().recordInitiativeEntry(ID, { list: "sources", action: "remove", key: "task:ct-12" }));
    expect(removed).toEqual([["recordInitiativeEntry", [ID, { list: "sources", action: "add", entry: source }]]]);
    expect(goal().sources).toEqual([source as any]);
  });

  it("why goes back through updateInitiative, cleared with null when there was none", () => {
    expect(undoOf(() => s().updateInitiative(ID, { why: "Because" }))).toEqual([["updateInitiative", [ID, { why: null }]]]);
  });
});

describe("asStoredEntry", () => {
  it("drops cleared fields and sorts the rest, a source inside it too", () => {
    expect(JSON.stringify(asStoredEntry({ text: "T", key: "k", by: undefined, source: { ref: "ct-1", kind: "task", quote: "" }, at: 1 }))).toBe('{"at":1,"key":"k","source":{"kind":"task","ref":"ct-1"},"text":"T"}');
  });
});
