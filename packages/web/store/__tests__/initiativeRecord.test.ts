// The intent record on the real store (store/initiativeRecord.ts and the
// slice's recordInitiativeEntry; initiatives-projects-role-page.md I5): what
// an op paints in the tick of the gesture, the op the side effect is handed
// (the whole entry, so the server stores what the page shows), what the
// server's echo leaves behind (the server's list and no lock), and the ops an
// undo sends to put one entry back by key. The reducer's own rules are pinned
// beside it (shared/contracts/initiativeRecord.test.ts).
// Run: bun test store/__tests__/initiativeRecord.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { _resetUndoStacks, getUndoHistory, undoEntry } from "@platform/engine";
import { applyRecordOp, type InitiativeRecordOp, type InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore } from "../inboxStore";
import { recordOpsBetween, settleRecordOp } from "../initiativeRecord";

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

/** Every lock held on the goal, its stamp included. */
const locks = () => Object.keys(s().pending).filter((k) => k.startsWith(`initiatives:${ID}:`));
/** The server's half: the op the side effect was handed, applied by the same reducer on another clock and another signer. */
const serverApplies = (list: readonly any[] | undefined, op: InitiativeRecordOp): any[] => {
  const out = applyRecordOp(list, op, { now: 9_999_999, by: "@server" });
  if ("error" in out) throw new Error(out.error);
  return out.next;
};

describe("settleRecordOp", () => {
  const who = { by: "@ashot", now: 1_000 };

  it("hands back the list and the op that carries the whole entry", () => {
    const first = settleRecordOp([], { list: "milestones", action: "add", entry: { title: "  Private beta open ", date: 5 } }, who)!;
    expect(first.next).toEqual([{ date: 5, key: "private_beta_open", title: "Private beta open" }]);
    expect(first.op).toEqual({ list: "milestones", action: "add", entry: first.next[0] });
  });

  it("is null for an op that moves nothing or cannot be applied", () => {
    expect(settleRecordOp([], { list: "milestones", action: "remove", key: "nope" }, who)).toBeNull();
    expect(settleRecordOp([], { list: "milestones", action: "add", entry: { title: " " } }, who)).toBeNull();
    expect(settleRecordOp([{ kind: "task", ref: "ct-12" }], { list: "sources", action: "add", entry: { text: "ct-12" } }, who)).toBeNull();
  });
});

describe("recordOpsBetween", () => {
  it("names each entry's way back by key: remove what was added, add back what is gone, edit what changed", () => {
    const was = [{ key: "a", title: "A" }, { key: "b", title: "B" }];
    const now = [{ done_at: 5, key: "a", title: "A" }, { key: "c", title: "C" }];
    expect(recordOpsBetween("milestones", now, was)).toEqual([
      { list: "milestones", action: "remove", key: "c" },
      { list: "milestones", action: "edit", key: "a", entry: { done_at: null, key: "a", title: "A" } },
      { list: "milestones", action: "add", entry: { key: "b", title: "B" }, index: 1 },
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

  it("signs by the server's rule: the @handle the roster reads back as the viewer, else their name", () => {
    s().recordInitiativeEntry(ID, { list: "questions", action: "add", entry: { text: "One?" } });
    expect(goal().questions![0].by).toBe("@ashot");
    // Two people the roster cannot tell apart by handle sign by name, as the server would.
    useInboxStore.setState({ currentUser: { _id: ME, name: "Sam A", email: "sam@x.ai" }, teamMembers: [{ _id: ME, name: "Sam A", email: "sam@x.ai" }, { _id: "other", name: "Sam B", email: "sam@y.ai" }], initiatives: { [ID]: row({ team_id: "teams_t" }) } } as any);
    s().recordInitiativeEntry(ID, { list: "questions", action: "add", entry: { text: "Two?" } });
    expect(goal().questions![0].by).toBe("Sam A");
    // No name and no handle the roster reads back: the email, never an unsigned entry.
    useInboxStore.setState({ currentUser: { _id: ME, email: "first.last@x.ai" }, teamMembers: [], initiatives: { [ID]: row() } } as any);
    s().recordInitiativeEntry(ID, { list: "questions", action: "add", entry: { text: "Three?" } });
    expect(goal().questions![0].by).toBe("first.last@x.ai");
  });

  it("paints what the server will store: a long paste is cut to the limit on the page too", () => {
    s().recordInitiativeEntry(ID, { list: "decisions", action: "add", entry: { text: `  ${"x".repeat(1400)}  `, source: { text: "ct-12" } } });
    const painted = structuredClone(goal().decisions!);
    expect(painted[0].text).toHaveLength(1000);
    expect(serverApplies(undefined, sent[0].result)).toEqual(painted);
  });
});

describe("the server's echo", () => {
  const d1 = { at: 1, key: "first", text: "First" };
  const theirs = { at: 2, by: "@growth", key: "theirs", text: "Theirs" };

  it("lands whole and leaves no lock, with an entry a teammate added that this device had not seen", () => {
    useInboxStore.setState({ initiatives: { [ID]: row({ decisions: [d1] }) } } as any);
    s().recordInitiativeEntry(ID, { list: "decisions", action: "add", entry: { text: "Mine" } });
    expect(goal().decisions!.map((d) => d.key)).toEqual(["first", "mine"]);
    // The server held the teammate's decision first, and adds this one by key.
    const stored = serverApplies([d1, theirs], sent[0].result);
    s().syncTable("initiatives", [row({ updated_at: 50, decisions: stored })]);
    expect(goal().decisions!.map((d) => d.key)).toEqual(["first", "theirs", "mine"]);
    expect(goal().updated_at).toBe(50);
    expect(locks()).toEqual([]);
    // Nothing masks a later push of that list.
    s().syncTable("initiatives", [row({ updated_at: 60, decisions: [...stored, { at: 3, key: "later", text: "Later" }] })]);
    expect(goal().decisions).toHaveLength(4);
  });

  it("no edit of a goal leaves a lock on its stamp", () => {
    s().updateInitiative(ID, { why: "Because" });
    s().syncTable("initiatives", [row({ updated_at: 70, why: "Because" })]);
    expect(goal().updated_at).toBe(70);
    expect(locks()).toEqual([]);
  });

  it("a renamed metric keeps its number and its trend in the tick, and the echo leaves no lock", () => {
    const reported = { value: "412", observed_at: 5, source: "https://x.ai/dash" };
    const before = row({ metrics: [{ key: "wat", name: "WAT", target: "1000" }], scoreboard: { wat: reported }, score_history: { wat: [reported] } });
    useInboxStore.setState({ initiatives: { [ID]: before } } as any);
    const metrics = [{ key: "weekly_active_teams", name: "Weekly active teams", target: "1000" }];
    s().updateInitiative(ID, { metrics });
    expect(goal().scoreboard).toEqual({ weekly_active_teams: reported });
    expect(goal().score_history).toEqual({ weekly_active_teams: [reported] });
    s().syncTable("initiatives", [row({ updated_at: 90, metrics, scoreboard: { weekly_active_teams: reported }, score_history: { weekly_active_teams: [reported] } })]);
    expect(locks()).toEqual([]);
    // An edit of a target moves no reported value.
    const calm = structuredClone(goal().scoreboard);
    s().updateInitiative(ID, { metrics: [{ ...metrics[0], target: "2000" }] });
    expect(goal().scoreboard).toEqual(calm);
  });

  it("a different entry under a key this device already used is kept, under the key the server gave it", () => {
    s().recordInitiativeEntry(ID, { list: "questions", action: "add", entry: { text: "Кто владеет запуском?" } });
    expect(goal().questions![0].key).toBe("entry");
    // A teammate's question slugged to the same key and reached the server first.
    const stored = serverApplies([{ at: 1, key: "entry", text: "Сколько стоит место?" }], sent[0].result);
    expect(stored.map((q) => [q.key, q.text])).toEqual([["entry", "Сколько стоит место?"], ["entry_2", "Кто владеет запуском?"]]);
    s().syncTable("initiatives", [row({ updated_at: 80, questions: stored })]);
    expect(goal().questions).toEqual(stored);
    expect(locks()).toEqual([]);
  });
});

describe("recordInitiativeEntry clears", () => {
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
    expect(removed).toEqual([["recordInitiativeEntry", [ID, { list: "sources", action: "add", entry: source, index: 0 }]]]);
    expect(goal().sources).toEqual([source as any]);
  });

  it("a removed entry goes back where it sat, on the page and on the server, and the echo leaves no lock", () => {
    const [a, b, c] = ["A", "B", "C"].map((text, i) => ({ at: i + 1, key: text.toLowerCase(), text }));
    useInboxStore.setState({ initiatives: { [ID]: row({ decisions: [a, b, c] }) } } as any);
    s().recordInitiativeEntry(ID, { list: "decisions", action: "remove", key: "a" });
    let stored = serverApplies([a, b, c], sent[0].result);
    expect(stored).toEqual([b, c]);
    s().syncTable("initiatives", [row({ updated_at: 20, decisions: stored })]);
    const entry = getUndoHistory().items[0];
    sent = [];
    expect(undoEntry(entry!.id)).toBe(true);
    expect(goal().decisions).toEqual([a, b, c]);
    // Nobody signed A, so the op says so and the undo does not sign it.
    expect(sent.map((c) => c.args[1])).toEqual([{ list: "decisions", action: "add", entry: { ...a, by: null }, index: 0 }]);
    for (const call of sent) stored = serverApplies(stored, call.result ?? call.args[1]);
    expect(stored).toEqual([a, b, c]);
    s().syncTable("initiatives", [row({ updated_at: 30, decisions: stored })]);
    expect(goal().decisions).toEqual([a, b, c]);
    expect(locks()).toEqual([]);
  });

  it("why goes back through updateInitiative, cleared with null when there was none", () => {
    expect(undoOf(() => s().updateInitiative(ID, { why: "Because" }))).toEqual([["updateInitiative", [ID, { why: null }]]]);
  });
});
