import { beforeEach, describe, expect, it } from "bun:test";
import { action, actionKind, asyncAction, mutativeMiddleware, receiptAsyncAction, sync } from "./middleware";
import { createSyncEngine } from "./syncEngine";
import { captureCells } from "./undo";
import {
  _resetUndoStacks,
  getUndoHistory,
  performRedo,
  performUndo,
  setUndoNotifier,
  undoGroup,
  withoutUndo,
  rekeyUndoIds,
} from "./undoStack";
import type { OutboxEntry, PlatformConfig, UndoConfig, UndoEntry } from "./types";

// The generic undo, end to end through the middleware: an action with a spec
// records the cells it changed, undo replays the before values through the
// same pipeline every action uses, redo re-invokes the action.

const A = "a".repeat(32);
const B = "b".repeat(32);
const SNOOZE = 1_800_000_000_000;

const REGISTRY: PlatformConfig["registry"] = {
  items: {
    persistence: { kind: "collection", key: "items" },
    localFirst: true,
    dispatchTable: { table: "item_rows", kind: "collection" },
    unprotectedFields: ["comments"],
  },
  // Off the patch rail: undo reaches the server through a writer.
  docs: { persistence: { kind: "collection", key: "docs" }, localFirst: true },
  marks: { persistence: { kind: "meta", key: "marks" }, localFirst: true, sync: { kind: "list", rowKey: "message_id" } },
  me: { persistence: { kind: "meta", key: "me" }, localFirst: true, sync: { kind: "singleton" } },
  pending: { persistence: { kind: "meta", key: "pending" } },
};

type Calls = {
  beforeReplay: Array<[string, string]>;
  afterReplay: Array<[string, string, number]>;
  restoreView: Array<[string, unknown]>;
};

function undoConfig(calls: Calls, over: Partial<UndoConfig> = {}): UndoConfig {
  const label = (text: string) => () => text;
  return {
    replayAction: "applyUndoPatches",
    stampFields: new Set(["updated_at"]),
    ignoreKeys: new Set(["layout"]),
    writers: {
      docs: {
        fields: (id, fields) => [{ action: "saveDoc", args: [id, fields] }],
        restoreRow: (id) => [{ action: "restoreDoc", args: [id] }],
      },
    },
    beforeReplay: (entry, dir) => calls.beforeReplay.push([entry.label, dir]),
    afterReplay: (entry, dir, applied) => calls.afterReplay.push([entry.label, dir, applied.length]),
    restoreView: (_draft, field, value) => calls.restoreView.push([field, value]),
    specs: {
      rename: { label: (ctx) => `Renamed to ${ctx.args[1]}` },
      renameBoth: { label: label("Both") },
      setTwo: { label: label("Set two") },
      defer: { label: label("Deferred") },
      addItem: { label: label("Added") },
      drop: { label: label("Dropped") },
      toggleMark: { label: label("Marked") },
      setStatus: { label: label("Status") },
      toggleFav: { label: label("Favorite") },
      favBoth: { label: label("Favorited two") },
      // One restore per row the changes name, so a partial undo narrows it.
      stashBoth: {
        label: label("Stashed two"),
        inverse: (ctx) =>
          [...new Set(ctx.changes.filter((c) => c.store === "items").map((c) => c.id))].map((id) => ({
            action: "restore",
            args: [id],
            runDraft: false,
          })),
      },
      // The same gesture with its ids read from the args: it cannot narrow.
      stashPair: {
        label: label("Stashed pair"),
        inverse: (ctx) => [
          { action: "restore", args: [ctx.args[0]], runDraft: false },
          { action: "restore", args: [ctx.args[1]], runDraft: false },
        ],
      },
      note: { label: label("Note") },
      setComments: { label: label("Comments") },
      open: { label: label("Opened"), restoreView: true },
      openNoRestore: { label: label("Opened") },
      setLayout: { label: label("Layout") },
      editDoc: { label: label("Edited doc"), ignoreFields: ["content"] },
      archiveDoc: { label: label("Archived doc"), toast: true },
      stash: {
        label: label("Stashed"),
        inverse: (ctx) => [{ action: "restore", args: [ctx.args[0]], runDraft: false }],
      },
      cycle: { label: (ctx) => `Priority ${ctx.args[1]}`, coalesce: true },
      quiet: { label: () => null },
      localOnly: { label: label("Local") },
      orgMove: { label: label("Moved in org"), external: "org" },
      pokeAsync: { label: label("Async") },
      createThing: { label: label("Created") },
      handPlant: { label: label("Hand planted") },
      ...over.specs,
    },
    ...over,
  };
}

function makeStore(opts: { undo?: UndoConfig | null; viewDeclared?: () => boolean } = {}) {
  const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
  const config: PlatformConfig = {
    dbName: "test",
    dbVersion: 1,
    registry: REGISTRY,
    syncRegistry: {},
    viewGuard: {
      fields: ["currentId"],
      audit: (changes) => (opts.viewDeclared?.() ?? true ? [] : changes.map((c) => c.field)),
    },
    ...(opts.undo === null ? {} : { undo: opts.undo ?? undoConfig(calls) }),
  };
  let state: any;
  const set = (next: any) => { state = next; };
  const get = () => state;
  const api = { setState: (partial: any) => { state = { ...state, ...partial }; } };
  const now = () => Date.now();
  const wrapped = mutativeMiddleware(
    () => ({
      items: {} as Record<string, any>,
      docs: {} as Record<string, any>,
      notes: {} as Record<string, any>,
      favorites: [] as any[],
      marks: [{ _id: "s1", message_id: "m1" }] as any[],
      me: { _id: "u", status: "online" } as any,
      layout: { width: 1 } as any,
      currentId: null as string | null,
      pending: {} as Record<string, any>,
      applyUndoPatches: action(function () {}),
      renameBoth: action(function (this: any, a: string, b: string, title: string) {
        this.items[a].title = title;
        this.items[b].title = title;
      }),
      seed: action(function (this: any, id: string, row: any) {
        this.items[id] = { _id: id, ...row };
      }),
      rename: action(function (this: any, id: string, title: string) {
        this.items[id].title = title;
        this.items[id].updated_at = now();
      }),
      setTwo: action(function (this: any, id: string, title: string, color: string) {
        this.items[id].title = title;
        this.items[id].color = color;
      }),
      defer: action(function (this: any, id: string) {
        this.items[id].deferred_at = 5;
        this.items[id].snoozed_until = null;
      }),
      addItem: action(function (this: any, id: string) {
        this.items[id] = { _id: id, title: "new" };
      }),
      drop: action(function (this: any, id: string) {
        delete this.items[id];
      }),
      toggleMark: action(function (this: any, messageId: string) {
        const i = this.marks.findIndex((m: any) => m.message_id === messageId);
        if (i === -1) this.marks.unshift({ _id: `temp_${messageId}`, message_id: messageId });
        else this.marks.splice(i, 1);
      }),
      setStatus: action(function (this: any, status: string) {
        this.me.status = status;
      }),
      toggleFav: action(function (this: any, id: string) {
        const on = !this.items[id].is_favorite;
        this.items[id].is_favorite = on;
        if (on) this.favorites.push({ _id: id });
        else this.favorites = this.favorites.filter((f: any) => f._id !== id);
      }),
      favBoth: action(function (this: any, a: string, b: string) {
        for (const id of [a, b]) {
          this.items[id].is_favorite = true;
          this.favorites.push({ _id: id });
        }
      }),
      stashBoth: action(function (this: any, a: string, b: string) {
        this.items[a].hidden_at = 7;
        this.items[b].hidden_at = 7;
      }),
      stashPair: action(function (this: any, a: string, b: string) {
        this.items[a].hidden_at = 7;
        this.items[b].hidden_at = 7;
      }),
      note: action(function (this: any, id: string, text: string) {
        this.notes[id] = text;
      }),
      setComments: action(function (this: any, id: string, comments: string[]) {
        this.items[id].comments = comments;
        this.items[id].title = "commented";
      }),
      open: action(function (this: any, id: string) {
        this.currentId = id;
        this.items[id].seen = true;
      }),
      openNoRestore: action(function (this: any, id: string) {
        this.currentId = id;
        this.items[id].seen = true;
      }),
      setLayout: action(function (this: any, width: number) {
        this.layout.width = width;
      }),
      editDoc: action(function (this: any, id: string, fields: Record<string, unknown>) {
        Object.assign(this.docs[id], fields);
      }),
      saveDoc: action(function (this: any, _id: string, _fields: Record<string, unknown>) {}),
      archiveDoc: action(function (this: any, id: string) {
        delete this.docs[id];
      }),
      restoreDoc: action(function (this: any, _id: string) {}),
      stash: action(function (this: any, id: string) {
        this.items[id].hidden_at = 7;
      }),
      restore: action(function (this: any, id: string) {
        this.items[id].hidden_at = null;
        this.items[id].restoredByDraft = true;
      }),
      cycle: action(function (this: any, id: string, priority: string) {
        this.items[id].priority = priority;
      }),
      quiet: action(function (this: any, id: string) {
        this.items[id].title = "quiet";
      }),
      localOnly: sync(function (this: any, id: string) {
        this.items[id].title = "local";
      }),
      orgMove: action(function (this: any, _id: string) {}),
      pokeAsync: asyncAction(function (this: any, id: string) {
        this.items[id].title = "async";
      }),
      createThing: receiptAsyncAction(function (this: any, id: string) {
        this.items[id] = { _id: id, title: "created" };
        return { stubId: id };
      }),
      handPlant: action(function (this: any, id: string) {
        this.items[id].title = "planted";
        this.pending[`notes:${id}`] = { type: "exclude", ts: 42 };
      }),
    }),
    config,
    { retryDelays: [], storageWatchdogMs: 50_000 },
  )(set, get, api);
  state = wrapped;

  const outbox = new Map<string, OutboxEntry>();
  wrapped._setOutbox(
    async (entry: OutboxEntry) => { outbox.set(entry.id, entry); },
    async (id: string) => { outbox.delete(id); },
    async () => [...outbox.values()].sort((a, b) => a.ts - b.ts),
  );
  const idb: string[][] = [];
  wrapped._setIDBWrite((patches: any[]) => { idb.push(patches.map((p) => String(p.path[0]))); });
  const tee: string[] = [];
  wrapped._setActionTee((name: string) => { tee.push(name); });

  const dispatched: Array<{ action: string; args: any; patches: any; result: any }> = [];
  let respond: (action: string) => Promise<any> = async () => ({});
  wrapped._setDispatch(async (a: string, args: any, patches: any, result: any) => {
    dispatched.push({ action: a, args, patches, result });
    return respond(a);
  });

  return {
    wrapped,
    calls,
    dispatched,
    outbox,
    idb,
    tee,
    get state() { return state; },
    setState(partial: Record<string, any>) { state = { ...state, ...partial }; },
    respond(fn: (action: string) => Promise<any>) { respond = fn; },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(2);
  }
}

const items = () => getUndoHistory().items;
const top = () => items()[0]!;
const lastDispatch = (h: ReturnType<typeof makeStore>, name: string) =>
  [...h.dispatched].reverse().find((d) => d.action === name);

let notices: string[] = [];
let toasts: Array<[string, string]> = [];

beforeEach(() => {
  _resetUndoStacks();
  notices = [];
  toasts = [];
  setUndoNotifier({
    notify: (m) => notices.push(m),
    notifyWithUndo: (label, id) => toasts.push([label, id]),
  });
});

describe("capture", () => {
  it("records depth-3 field cells with both sides, classified protected", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "old", color: "red" });
    h.wrapped.setTwo(A, "new", "blue");
    expect(top().label).toBe("Set two");
    expect(top().changes!.map((c) => [c.store, c.id, c.field, c.before, c.after, c.kind])).toEqual([
      ["items", A, "title", "old", "new", "protected"],
      ["items", A, "color", "red", "blue", "protected"],
    ]);
    expect(top().objects).toEqual([{ store: "items", id: A }]);
    expect(top().outboxIds).toHaveLength(1);
    expect(top().mode).toBe("generic");
  });

  it("records a row add and a row remove as whole-row cells", () => {
    const h = makeStore();
    h.wrapped.addItem(A);
    expect(top().changes).toEqual([
      expect.objectContaining({ store: "items", id: A, hadBefore: false, hadAfter: true }),
    ]);
    h.wrapped.drop(A);
    expect(top().changes).toEqual([
      expect.objectContaining({ store: "items", id: A, before: { _id: A, title: "new" }, hadBefore: true, hadAfter: false }),
    ]);
    expect(top().changes!.every((c) => c.field === undefined)).toBe(true);
  });

  it("names list rows by rowKey and singleton fields by the empty id", () => {
    const h = makeStore();
    h.wrapped.toggleMark("m2");
    expect(top().changes).toEqual([
      expect.objectContaining({ store: "marks", id: "m2", shape: "list", hadBefore: false, hadAfter: true }),
    ]);
    h.wrapped.setStatus("away");
    expect(top().changes).toEqual([
      expect.objectContaining({ store: "me", id: "", field: "status", before: "online", after: "away", shape: "singleton", kind: "protected" }),
    ]);
  });

  it("classifies non-local-first keys as mirror and view-guard fields as view", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.toggleFav(A);
    const kinds = Object.fromEntries(top().changes!.map((c) => [c.store, c.kind]));
    expect(kinds).toEqual({ items: "protected", favorites: "mirror" });
    h.wrapped.note(A, "hello");
    expect(top().changes![0]).toMatchObject({ store: "notes", id: A, kind: "mirror" });
    h.wrapped.open(A);
    expect(top().changes!.find((c) => c.store === "currentId")).toMatchObject({ kind: "view", before: null, after: A });
  });

  it("an unprotected field is a mirror cell", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t", comments: [] });
    h.wrapped.setComments(A, ["c1"]);
    const comments = top().changes!.find((c) => c.field === "comments");
    expect(comments?.kind).toBe("mirror");
  });

  it("never captures ignoreKeys or the spec's ignoreFields", () => {
    const h = makeStore();
    const before = items().length;
    h.wrapped.setLayout(5);
    expect(items().length).toBe(before);
    h.setState({ docs: { [A]: { _id: A, title: "t", content: "x" } } });
    h.wrapped.editDoc(A, { content: "typed" });
    expect(items().length).toBe(before);
    h.wrapped.editDoc(A, { content: "more", title: "T2" });
    expect(top().changes!.map((c) => c.field)).toEqual(["title"]);
  });

  it("records nothing for a no-op call or a null label", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "same" });
    h.wrapped.rename(A, "same");
    // updated_at alone is a stamp, never a change worth an entry.
    expect(items().some((i) => i.action === "rename")).toBe(false);
    h.wrapped.quiet(A);
    expect(items().some((i) => i.action === "quiet")).toBe(false);
  });

  it("withoutUndo and sync() never record", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    withoutUndo(() => h.wrapped.rename(A, "silent"));
    h.wrapped.localOnly(A);
    expect(items().map((i) => i.action)).not.toContain("rename");
    expect(items().map((i) => i.action)).not.toContain("localOnly");
  });

  it("captures asyncAction and receipt actions", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    await h.wrapped.pokeAsync(A);
    expect(top().action).toBe("pokeAsync");
    h.respond(async (a) => (a === "createThing" ? { commandId: lastDispatch(h, "createThing")!.result.commandId, status: "acknowledged" } : {}));
    await h.wrapped.createThing(B);
    expect(top().action).toBe("createThing");
  });

  it("records planted pending entries, including ones the draft wrote by hand", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.handPlant(A);
    expect(Object.keys(top().planted!).sort()).toEqual([`items:${A}:title`, `notes:${A}`]);
  });

  it("an external spec records a display-only history item, never on the stack", () => {
    const h = makeStore();
    h.wrapped.orgMove("x");
    expect(top()).toMatchObject({ status: "external", external: "org", label: "Moved in org" });
    expect(getUndoHistory().head).toBeNull();
    expect(performUndo()).toBe(false);
  });

  it("with no undo config nothing is captured", () => {
    const h = makeStore({ undo: null });
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.rename(A, "x");
    expect(items()).toEqual([]);
  });

  it("captureCells diffs a whole-row replace field by field", () => {
    const prev = { items: { [A]: { _id: A, a: 1, b: 2 } } };
    const next = { items: { [A]: { _id: A, a: 1, b: 3 } } };
    const cells = captureCells(
      [{ op: "replace", path: ["items", A], value: next.items[A] }],
      prev,
      next,
      {
        declaredKind: () => undefined,
        rowKeyOf: () => "_id",
        isProtected: (k) => k === "items",
        isUnprotectedField: () => false,
        viewFields: new Set(),
      },
    );
    expect(cells).toEqual([expect.objectContaining({ field: "b", before: 2, after: 3, kind: "protected" })]);
  });

  it("the wrapped store function carries its creator's kind", () => {
    const h = makeStore();
    expect(actionKind(h.state.rename)).toBe("action");
    expect(actionKind(h.state.pokeAsync)).toBe("asyncAction");
    expect(actionKind(h.state.createThing)).toBe("receipt");
    expect(actionKind(h.state.localOnly)).toBe("sync");
    expect(actionKind(h.state.items)).toBeNull();
  });
});

describe("replay mechanics", () => {
  it("a patch replay restores locally, re-locks, drops the planted locks and dispatches the prior values", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t", snoozed_until: SNOOZE });
    h.wrapped.defer(A);
    const forwardLock = h.state.pending[`items:${A}:deferred_at`];
    expect(forwardLock).toMatchObject({ type: "field", value: 5 });
    expect(performUndo()).toBe(true);

    const row = h.state.items[A];
    expect(row.snoozed_until).toBe(SNOOZE);
    expect("deferred_at" in row).toBe(false);
    // The forward's lock is gone, and fresh locks hold the restored values.
    expect(h.state.pending[`items:${A}:deferred_at`]).not.toBe(forwardLock);
    expect(h.state.pending[`items:${A}:deferred_at`]).toMatchObject({ type: "field", value: undefined });
    expect(h.state.pending[`items:${A}:snoozed_until`]).toMatchObject({ type: "field", value: SNOOZE });

    const replay = lastDispatch(h, "applyUndoPatches")!;
    expect(replay.args).toEqual([]);
    expect(replay.patches).toEqual({ item_rows: { [A]: { deferred_at: null, snoozed_until: SNOOZE } } });
    expect(h.calls.beforeReplay).toEqual([["Deferred", "undo"]]);
    expect(h.calls.afterReplay).toEqual([["Deferred", "undo", 2]]);
    expect(notices).toEqual(["Undid: Deferred"]);
  });

  it("a deferSession-shaped undo restores the snooze and leaves no forward lock behind", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t", snoozed_until: SNOOZE });
    h.wrapped.defer(A);
    const forwardKeys = Object.entries(h.state.pending).filter(([k]) => k.startsWith(`items:${A}:`));
    performUndo();
    for (const [key, lock] of forwardKeys) expect(h.state.pending[key]).not.toBe(lock);
    // A push still carrying the forward value cannot re-apply it: the lock
    // now asserts the restored value.
    const engine = createSyncEngine({ dbName: "t", dbVersion: 1, registry: REGISTRY, syncRegistry: { items: { isDelta: true } } });
    const draft: any = { items: { ...h.state.items }, pending: { ...h.state.pending } };
    engine.syncTable(draft, "items", [{ _id: A, title: "t", deferred_at: 5, snoozed_until: null, updated_at: 2 }]);
    expect(draft.items[A].snoozed_until).toBe(SNOOZE);
    // The echo of the restored values retires every lock.
    engine.syncTable(draft, "items", [{ _id: A, title: "t", snoozed_until: SNOOZE, updated_at: 3 }]);
    expect(Object.keys(draft.pending).filter((k) => k.startsWith(`items:${A}:`))).toEqual([]);
  });

  it("deletes a hand-planted pending entry the forward wrote", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.handPlant(A);
    performUndo();
    expect(h.state.pending[`notes:${A}`]).toBeUndefined();
    expect(h.state.items[A].title).toBe("t");
  });

  it("a writer invocation runs the target draft plus the overlay and dispatches the target", () => {
    const h = makeStore();
    h.setState({ docs: { [A]: { _id: A, title: "Doc", labels: ["x"] } } });
    h.wrapped.editDoc(A, { title: "Renamed", labels: ["y"] });
    performUndo();
    expect(h.state.docs[A]).toMatchObject({ title: "Doc", labels: ["x"] });
    const save = lastDispatch(h, "saveDoc")!;
    expect(save.args).toEqual([A, { title: "Doc", labels: ["x"] }]);
    expect(lastDispatch(h, "applyUndoPatches")).toBeUndefined();
  });

  it("a removed row comes back through the writer's restoreRow, and its exclude goes", () => {
    const h = makeStore();
    h.setState({ docs: { [A]: { _id: A, title: "Doc", updated_at: 1 } } });
    h.wrapped.archiveDoc(A);
    expect(h.state.pending[`docs:${A}`]).toMatchObject({ type: "exclude" });
    expect(toasts).toEqual([["Archived doc", top().id]]);
    performUndo();
    expect(h.state.docs[A]).toMatchObject({ _id: A, title: "Doc" });
    // Restamped, never compared.
    expect(h.state.docs[A].updated_at).toBeGreaterThan(1);
    expect(h.state.pending[`docs:${A}`]).toMatchObject({ type: "include" });
    expect(lastDispatch(h, "restoreDoc")!.args).toEqual([A]);
  });

  it("an inverse with runDraft false dispatches the inverse without running its draft", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t", hidden_at: null });
    h.wrapped.stash(A);
    performUndo();
    expect(h.state.items[A].hidden_at).toBeNull();
    expect(h.state.items[A].restoredByDraft).toBeUndefined();
    const restore = lastDispatch(h, "restore")!;
    expect(restore.args).toEqual([A]);
    // The overlay rides the inverse's own grouped patches.
    expect(restore.patches).toEqual({ item_rows: { [A]: { hidden_at: null } } });
  });

  it("stamp fields are restamped and never compared", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t", updated_at: 1 });
    h.wrapped.rename(A, "x");
    // A server push bumps the stamp; the undo still applies.
    h.setState({ items: { [A]: { ...h.state.items[A], updated_at: 999 } } });
    performUndo();
    expect(h.state.items[A].title).toBe("t");
    expect(h.state.items[A].updated_at).toBeGreaterThan(999);
  });

  it("restores the view only when the spec asks and the view has not moved", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.open(A);
    performUndo();
    expect(h.state.currentId).toBeNull();
    expect(h.calls.restoreView).toEqual([["currentId", null]]);

    h.wrapped.openNoRestore(A);
    performUndo();
    expect(h.state.currentId).toBe(A);
  });

  it("the replay goes through the tee and IndexedDB write-through", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.rename(A, "x");
    h.tee.length = 0;
    h.idb.length = 0;
    performUndo();
    expect(h.tee).toEqual(["applyUndoPatches"]);
    expect(h.idb.flat()).toContain("items");
    expect(h.idb.flat()).toContain("pending");
  });

  it("restores a list row and a singleton field", () => {
    const h = makeStore();
    h.wrapped.toggleMark("m1");
    expect(h.state.marks).toEqual([]);
    performUndo();
    expect(h.state.marks.map((m: any) => m.message_id)).toEqual(["m1"]);
    h.wrapped.setStatus("away");
    performUndo();
    expect(h.state.me.status).toBe("online");
  });

  it("restores a mirror list it changed", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.toggleFav(A);
    expect(h.state.favorites).toEqual([{ _id: A }]);
    performUndo();
    expect(h.state.favorites).toEqual([]);
    expect(h.state.items[A].is_favorite).toBeUndefined();
  });
});

describe("conflicts and partial undo", () => {
  it("a row whose other cell changed since is left untouched", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "old", color: "red" });
    h.wrapped.setTwo(A, "new", "blue");
    h.setState({ items: { [A]: { ...h.state.items[A], color: "green" } } });
    expect(performUndo()).toBe(true);
    expect(h.state.items[A]).toMatchObject({ title: "new", color: "green" });
    expect(notices).toEqual(["Can't undo Set two: changed since"]);
    expect(top().status).toBe("conflict");
    expect(getUndoHistory().head).not.toBe(top().id);
  });

  it("partial across rows: rows nobody touched are undone, the rest reported", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    undoGroup("Renamed two", () => {
      h.wrapped.rename(A, "a2");
      h.wrapped.rename(B, "b2");
    });
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "someone" } } });
    let stepped: UndoEntry | null = null;
    setUndoNotifier({ notify: (m) => notices.push(m), onHistoryStep: (_k, _s, e) => { stepped = e; } });
    performUndo();
    expect(h.state.items[A].title).toBe("a");
    expect(h.state.items[B].title).toBe("someone");
    expect(stepped!.skipped).toEqual([{ store: "items", id: B }]);
  });

  it("partial within one entry over two rows counts applied and skipped", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.renameBoth(A, B, "both");
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "someone" } } });
    const id = top().id;
    performUndo();
    const outcome = items().find((i) => i.id === id)!;
    expect(h.state.items[A].title).toBe("a");
    expect(h.state.items[B].title).toBe("someone");
    expect(outcome.status).toBe("undone");
    expect(outcome.skipped).toEqual([{ store: "items", id: B }]);
    expect(notices).toEqual(["Undid: Both (1 changed since, left as they are)"]);
  });

  it("an all-conflict entry stops the press and leaves the stack; the next press continues", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.rename(A, "a2");
    h.wrapped.rename(B, "b2");
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "other" } } });
    expect(performUndo()).toBe(true);
    expect(h.state.items[A].title).toBe("a2");
    expect(performUndo()).toBe(true);
    expect(h.state.items[A].title).toBe("a");
  });

  it("an entry whose every row conflicts is a conflict even when a mirror could be restored", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.toggleFav(A);
    h.setState({ items: { [A]: { ...h.state.items[A], is_favorite: "remote" } } });
    const id = top().id;
    performUndo();
    expect(h.state.items[A].is_favorite).toBe("remote");
    expect(h.state.favorites).toEqual([{ _id: A }]);
    expect(items().find((i) => i.id === id)!.status).toBe("conflict");
    expect(notices).toEqual(["Can't undo Favorite: changed since"]);
  });

  it("a partial undo leaves the mirror cells of the rows it skipped", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.favBoth(A, B);
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], is_favorite: "remote" } } });
    performUndo();
    expect(h.state.items[A].is_favorite).toBeUndefined();
    expect(h.state.favorites).toEqual([{ _id: B }]);
  });

  it("a partial undo of an inverse entry dispatches nothing for the skipped row", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.stashBoth(A, B);
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], hidden_at: 99 } } });
    const before = h.dispatched.length;
    performUndo();
    const sent = h.dispatched.slice(before);
    expect(sent.map((d) => [d.action, d.args])).toEqual([["restore", [A]]]);
    expect(sent[0]!.patches).toEqual({ item_rows: { [A]: { hidden_at: null } } });
    expect(h.state.items[A].hidden_at).toBeUndefined();
    expect(h.state.items[B].hidden_at).toBe(99);
    expect(notices).toEqual(["Undid: Stashed two (1 changed since, left as they are)"]);
  });

  it("an inverse that still names a skipped row refuses the undo whole", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.stashPair(A, B);
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], hidden_at: 99 } } });
    const id = top().id;
    const before = h.dispatched.length;
    performUndo();
    expect(h.dispatched.slice(before)).toEqual([]);
    expect(h.state.items[A].hidden_at).toBe(7);
    expect(h.state.items[B].hidden_at).toBe(99);
    expect(items().find((i) => i.id === id)!.status).toBe("conflict");
    expect(notices).toEqual(["Can't undo Stashed pair: changed since"]);
  });

  it("a gone row is a conflict, a re-added row counts as already undone", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.rename(A, "a2");
    h.setState({ items: {} });
    performUndo();
    expect(notices).toEqual(["Can't undo Renamed to a2: changed since"]);
  });
});

describe("redo and groups", () => {
  it("redo re-invokes the action and refreshes the entry's cells", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.rename(A, "x");
    const id = top().id;
    const firstOutbox = top().outboxIds![0];
    performUndo();
    expect(performRedo()).toBe(true);
    expect(h.state.items[A].title).toBe("x");
    expect(lastDispatch(h, "rename")!.args).toEqual([A, "x"]);
    const entry = items().find((i) => i.id === id)!;
    expect(entry.status).toBe("done");
    expect(entry.outboxIds![0]).not.toBe(firstOutbox);
    expect(getUndoHistory().head).toBe(id);
    expect(h.calls.beforeReplay.map(([, d]) => d)).toEqual(["undo", "redo"]);
    performUndo();
    expect(h.state.items[A].title).toBe("t");
  });

  it("a toggle redo lands on the original value", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.toggleFav(A);
    performUndo();
    expect(h.state.items[A].is_favorite).toBeUndefined();
    performRedo();
    expect(h.state.items[A].is_favorite).toBe(true);
    expect(h.state.favorites).toEqual([{ _id: A }]);
  });

  it("redo refuses when a cell moved since the undo", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.rename(A, "x");
    performUndo();
    h.setState({ items: { [A]: { ...h.state.items[A], title: "someone" } } });
    performRedo();
    expect(h.state.items[A].title).toBe("someone");
    expect(notices.at(-1)).toBe("Can't redo Renamed to x: changed since");
  });

  it("redo after a partial undo restores only the rows the undo applied", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.renameBoth(A, B, "both");
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "someone" } } });
    performUndo();
    const renames = h.dispatched.filter((d) => d.action === "renameBoth").length;
    expect(performRedo()).toBe(true);
    expect(h.state.items[A].title).toBe("both");
    expect(h.state.items[B].title).toBe("someone");
    // The applied cells went back on the undo's route; the action never re-ran.
    expect(h.dispatched.filter((d) => d.action === "renameBoth")).toHaveLength(renames);
    expect(lastDispatch(h, "applyUndoPatches")!.patches).toBeTruthy();
    expect(h.state.pending[`items:${A}:title`]).toMatchObject({ value: "both" });
    expect(notices.at(-1)).toBe("Redid: Both (1 changed since, left as they are)");
    // And it undoes again, partially, as before.
    performUndo();
    expect(h.state.items[A].title).toBe("a");
    expect(h.state.items[B].title).toBe("someone");
  });

  it("redo after a partial undo of an inverse spec is refused", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.stashBoth(A, B);
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], hidden_at: 99 } } });
    performUndo();
    expect(h.state.items[A].hidden_at).toBeUndefined();
    performRedo();
    expect(h.state.items[A].hidden_at).toBeUndefined();
    expect(h.state.items[B].hidden_at).toBe(99);
    expect(notices.at(-1)).toBe("Can't redo Stashed two: changed since");
  });

  it("undoGroup folds captures into one entry, undone in reverse and redone forward", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a", priority: "low" });
    undoGroup((entries) => `Changed ${entries.length}`, () => {
      h.wrapped.cycle(A, "mid");
      undoGroup("inner", () => h.wrapped.cycle(A, "high"));
    });
    expect(items().filter((i) => i.status === "done")).toHaveLength(1);
    expect(top()).toMatchObject({ label: "Changed 2" });
    expect(top().children).toHaveLength(2);
    performUndo();
    // Reverse order: the second child restores "mid", then the first "low".
    expect(h.state.items[A].priority).toBe("low");
    performRedo();
    expect(h.state.items[A].priority).toBe("high");
  });

  it("coalesces rapid repeats of a coalescing action over the same cells", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a", priority: "low" });
    h.wrapped.cycle(A, "mid");
    h.wrapped.cycle(A, "high");
    h.wrapped.cycle(A, "urgent");
    const done = items().filter((i) => i.action === "cycle");
    expect(done).toHaveLength(1);
    expect(done[0]!.changes![0]).toMatchObject({ before: "low", after: "urgent" });
    expect(done[0]!.args).toEqual([A, "urgent"]);
    performUndo();
    expect(h.state.items[A].priority).toBe("low");
    expect(h.state.pending[`items:${A}:priority`]).toMatchObject({ value: "low" });
  });

  it("does not coalesce across another recorded entry or a different cell set", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a", priority: "low" });
    h.wrapped.seed(B, { title: "b", priority: "low" });
    h.wrapped.cycle(A, "mid");
    h.wrapped.rename(A, "x");
    h.wrapped.cycle(A, "high");
    h.wrapped.cycle(B, "high");
    expect(items().filter((i) => i.action === "cycle")).toHaveLength(3);
  });
});

describe("refusal and rekey", () => {
  it("a refused forward dispatch removes its entry from the stack", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    await waitFor(() => h.outbox.size === 0);
    h.respond(async (a) => {
      if (a === "rename") throw new Error("Uncaught Error: not yours");
      return {};
    });
    h.wrapped.rename(A, "x");
    const id = top().id;
    await waitFor(() => items().find((i) => i.id === id)?.status === "refused");
    expect(getUndoHistory().head).not.toBe(id);
    expect(h.state.items[A].title).toBe("t");
  });

  it("a refused undo dispatch rolls back and the entry returns to the undo stack", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.rename(A, "x");
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    h.respond(async (a) => {
      if (a === "applyUndoPatches") throw new Error("Uncaught Error: no");
      return {};
    });
    performUndo();
    expect(h.state.items[A].title).toBe("t");
    await waitFor(() => getUndoHistory().head === id);
    expect(items().find((i) => i.id === id)!.status).toBe("done");
    expect(h.state.items[A].title).toBe("x");
  });

  it("a refused partial redo dispatch rolls back and the entry returns to the redo stack", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.renameBoth(A, B, "both");
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "someone" } } });
    const id = top().id;
    performUndo();
    await waitFor(() => h.outbox.size === 0);
    h.respond(async (a) => {
      if (a === "applyUndoPatches") throw new Error("Uncaught Error: no");
      return {};
    });
    performRedo();
    expect(h.state.items[A].title).toBe("both");
    await waitFor(() => items().find((i) => i.id === id)!.status === "undone");
    expect(h.state.items[A].title).toBe("a");
    expect(getUndoHistory().head).not.toBe(id);
  });

  it("a rekeyed removal comes back under the server id, and a rekeyed inverse names it", () => {
    const h = makeStore();
    h.wrapped.seed("stub_1", { title: "a" });
    h.wrapped.drop("stub_1");
    rekeyUndoIds("stub_1", A);
    performUndo();
    expect(h.state.items).toEqual({ [A]: { _id: A, title: "a" } });

    h.wrapped.seed("stub_2", { title: "b" });
    h.wrapped.stash("stub_2");
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items["stub_2"], _id: B } } });
    rekeyUndoIds("stub_2", B);
    performUndo();
    expect(lastDispatch(h, "restore")!.args).toEqual([B]);
    expect(h.state.items[B].hidden_at).toBeUndefined();
  });

  it("a stub rekey rewrites ids in live entries", () => {
    const h = makeStore();
    h.wrapped.addItem("stub-1");
    h.wrapped.rename("stub-1", "typed");
    const engine = createSyncEngine({
      dbName: "t",
      dbVersion: 1,
      registry: REGISTRY,
      syncRegistry: { items: { isDelta: true, altKey: "client_id" } },
    });
    const draft: any = {
      items: { "stub-1": { ...h.state.items["stub-1"], client_id: "stub-1" } },
      pending: { ...h.state.pending },
    };
    engine.syncTable(draft, "items", [{ _id: A, client_id: "stub-1", title: "typed", updated_at: 2 }]);
    const renamed = items().find((i) => i.action === "rename")!;
    expect(renamed.changes![0]!.id).toBe(A);
    expect(renamed.objects).toEqual([{ store: "items", id: A }]);
    expect(renamed.args).toEqual([A, "typed"]);
    expect(Object.keys(renamed.planted!)).toContain(`items:${A}:title`);
    // Idempotent for an id nobody names.
    rekeyUndoIds("nobody", B);
  });
});
