import { beforeEach, describe, expect, it } from "bun:test";
import { action, actionKind, afterCommit, asyncAction, mutativeMiddleware, receiptAsyncAction, sync } from "./middleware";
import { createSyncEngine } from "./syncEngine";
import { captureCells } from "./undo";
import {
  _resetUndoStacks,
  configureUndoStack,
  getUndoHistory,
  performRedo,
  performUndo,
  setUndoNotifier,
  undoGroup,
  withoutUndo,
  rekeyUndoIds,
  redoTo,
  undoEntry,
  undoTo,
} from "./undoStack";
import type { CellChange, OutboxEntry, PlatformConfig, UndoConfig, UndoEntry } from "./types";

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
  // A second copy of the same server rows (codecast's sessions and conversations).
  twins: {
    persistence: { kind: "collection", key: "twins" },
    localFirst: true,
    dispatchTable: { table: "item_rows", kind: "collection" },
  },
  // Off the patch rail: undo reaches the server through a writer.
  docs: { persistence: { kind: "collection", key: "docs" }, localFirst: true },
  marks: { persistence: { kind: "meta", key: "marks" }, localFirst: true, sync: { kind: "list", rowKey: "message_id" } },
  me: { persistence: { kind: "meta", key: "me" }, localFirst: true, sync: { kind: "singleton" } },
  pending: { persistence: { kind: "meta", key: "pending" } },
};

type Calls = {
  beforeReplay: Array<[string, string]>;
  afterReplay: Array<[string, string, number, string]>;
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
    afterReplay: (entry, dir, applied, how) => calls.afterReplay.push([entry.label, dir, applied.length, how]),
    restoreView: (_draft, field, value) => calls.restoreView.push([field, value]),
    specs: {
      rename: { label: (ctx) => `Renamed to ${ctx.args[1]}` },
      // Confirms only the direction that needs it, asked when recorded.
      retitle: { label: (ctx) => `Retitled to ${ctx.args[1]}`, confirm: (ctx) => ctx.args[1] === "secret" },
      renameBoth: { label: label("Both") },
      setTwo: { label: label("Set two") },
      defer: { label: label("Deferred") },
      deferTwin: { label: label("Deferred twin") },
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
      // An upsert whose server half never deletes the row it created: the
      // undo of a create clears the field and keeps the row.
      shelveDoc: {
        label: label("Shelved doc"),
        spell: (cells) =>
          cells.map((c) =>
            c.store === "docs" && c.field === undefined && !c.hadBefore
              ? { ...c, field: "shelf", before: undefined, after: (c.after as any)?.shelf }
              : c,
          ),
      },
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

function makeStore(opts: { undo?: UndoConfig | null; viewDeclared?: () => boolean; extra?: Record<string, any>; optionalClearFields?: ReadonlySet<string>; retryDelays?: number[] } = {}) {
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
    ...(opts.optionalClearFields ? { optionalClearFields: opts.optionalClearFields } : {}),
  };
  let state: any;
  const set = (next: any) => { state = next; };
  const get = () => state;
  const api = { setState: (partial: any) => { state = { ...state, ...partial }; } };
  const now = () => Date.now();
  const wrapped = mutativeMiddleware(
    () => ({
      items: {} as Record<string, any>,
      twins: {} as Record<string, any>,
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
      retitle: action(function (this: any, id: string, title: string) {
        this.items[id].title = title;
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
      deferTwin: action(function (this: any, id: string) {
        this.items[id].deferred_at = 5;
        this.twins[id].deferred_at = 5;
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
      shelveDoc: action(function (this: any, id: string, shelf: string) {
        if (this.docs[id]) this.docs[id].shelf = shelf;
        else this.docs[id] = { _id: id, shelf };
      }),
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
      ...(opts.extra ?? {}),
    }),
    config,
    { retryDelays: opts.retryDelays ?? [], storageWatchdogMs: 50_000 },
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

  it("asks a function confirm once at record time, so one spec confirms only one direction", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "old" });
    h.wrapped.retitle(A, "secret");
    expect(top().confirm).toBe(true);
    performUndo();
    expect(h.state.items[A].title).toBe("secret");
    expect(notices).toHaveLength(1);
    h.wrapped.retitle(A, "plain");
    expect(top().confirm).toBeUndefined();
    performUndo();
    expect(h.state.items[A].title).toBe("secret");
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
    expect(h.calls.afterReplay).toEqual([["Deferred", "undo", 2, "replay"]]);
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

  it("a writer's clears spell an unset before value the way the server stores the clear", () => {
    const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
    const base = undoConfig(calls);
    const h = makeStore({
      undo: undoConfig(calls, {
        writers: { docs: { ...base.writers!.docs!, clears: { labels: [] } } },
      }),
    });
    h.setState({ docs: { [A]: { _id: A, title: "Doc" } } });
    h.wrapped.editDoc(A, { labels: ["y"] });
    performUndo();
    // The row holds the server's spelling of the clear, the writer sends it,
    // and the lock asserts it, so the echo of the clear retires the lock.
    expect(h.state.docs[A].labels).toEqual([]);
    expect(lastDispatch(h, "saveDoc")!.args).toEqual([A, { labels: [] }]);
    expect(h.state.pending[`docs:${A}:labels`]).toMatchObject({ type: "field", value: [] });
    // Redo finds the row where the undo left it.
    expect(performRedo()).toBe(true);
    expect(h.state.docs[A].labels).toEqual(["y"]);
  });

  it("a spec's spell writes a restored value the way its inverse's server half stores it", () => {
    const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
    const base = undoConfig(calls);
    // The server's restore stamps hidden_at null on a row that never had it.
    const spell = (cells: CellChange[]) =>
      cells.map((c) => (c.field === "hidden_at" && !c.hadBefore ? { ...c, before: null, hadBefore: true } : c));
    const h = makeStore({ undo: undoConfig(calls, { specs: { ...base.specs, stash: { ...base.specs.stash!, spell } } }) });
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.stash(A);
    performUndo();
    expect(h.state.items[A].hidden_at).toBeNull();
    expect(h.state.pending[`items:${A}:hidden_at`]).toMatchObject({ type: "field", value: null });
    // The echo of the server's spelling retires the lock.
    const engine = createSyncEngine({ dbName: "t", dbVersion: 1, registry: REGISTRY, syncRegistry: { items: { isDelta: true } } });
    const draft: any = { items: { ...h.state.items }, pending: { ...h.state.pending } };
    engine.syncTable(draft, "items", [{ _id: A, title: "t", hidden_at: null }]);
    expect(Object.keys(draft.pending).filter((k) => k.startsWith(`items:${A}:`))).toEqual([]);
  });

  it("a spell that turns an added row into a field cell keeps the row, plants no exclude, and redo finds it", async () => {
    const h = makeStore();
    h.wrapped.shelveDoc(A, "top");
    expect(performUndo()).toBe(true);
    // The row stays, unshelved, and the writer sends the clear.
    expect(h.state.docs[A]).toEqual({ _id: A });
    // The undo writes back only part of what the forward sent, so it waits for that send.
    await waitFor(() => !!lastDispatch(h, "saveDoc"));
    expect(lastDispatch(h, "saveDoc")!.args).toEqual([A, { shelf: undefined }]);
    expect(h.state.pending[`docs:${A}`]?.type).not.toBe("exclude");
    expect(performRedo()).toBe(true);
    expect(h.state.docs[A].shelf).toBe("top");
    // The redone entry is a field edit of the kept row.
    expect(performUndo()).toBe(true);
    expect(h.state.docs[A]).toEqual({ _id: A });
  });

  it("a cell a spell left out is judged on redo by the value the undo left it at", () => {
    const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
    const base = undoConfig(calls);
    const spell = (cells: CellChange[]) => cells.filter((c) => c.field !== "color");
    const h = makeStore({ undo: undoConfig(calls, { specs: { ...base.specs, setTwo: { ...base.specs.setTwo!, spell } } }) });
    h.wrapped.seed(A, { title: "t", color: "red" });
    h.wrapped.setTwo(A, "x", "blue");
    expect(performUndo()).toBe(true);
    expect(h.state.items[A]).toMatchObject({ title: "t", color: "blue" });
    expect(performRedo()).toBe(true);
    expect(h.state.items[A]).toMatchObject({ title: "x", color: "blue" });
    expect(notices.at(-1)).toBe("Redid: Set two");
  });

  it("a cell a spell left out still refuses the redo once it changed after the undo", () => {
    const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
    const base = undoConfig(calls);
    const spell = (cells: CellChange[]) => cells.filter((c) => c.field !== "color");
    const h = makeStore({ undo: undoConfig(calls, { specs: { ...base.specs, setTwo: { ...base.specs.setTwo!, spell } } }) });
    h.wrapped.seed(A, { title: "t", color: "red" });
    h.wrapped.setTwo(A, "x", "blue");
    performUndo();
    h.setState({ items: { [A]: { ...h.state.items[A], color: "green" } } });
    performRedo();
    expect(h.state.items[A]).toMatchObject({ title: "t", color: "green" });
    expect(notices.at(-1)).toBe("Can't redo Set two: changed since");
  });

  it("a redo after such a spelled undo is refused once the kept row changed", () => {
    const h = makeStore();
    h.wrapped.shelveDoc(A, "top");
    performUndo();
    h.setState({ docs: { [A]: { _id: A, shelf: "other" } } });
    performRedo();
    expect(h.state.docs[A].shelf).toBe("other");
    expect(lastDispatch(h, "shelveDoc")!.args).toEqual([A, "top"]);
    expect(h.dispatched.filter((d) => d.action === "shelveDoc")).toHaveLength(1);
  });

  it("a redo over a row deleted since the undo is a conflict and recreates nothing", () => {
    const h = makeStore();
    h.setState({ docs: { [A]: { _id: A, title: "d" } } });
    h.wrapped.shelveDoc(A, "x");
    expect(performUndo()).toBe(true);
    // A push drops the row after the undo.
    const docs = { ...h.state.docs };
    delete docs[A];
    h.setState({ docs });
    performRedo();
    expect(getUndoHistory().items[0]?.status).toBe("conflict");
    expect(h.state.docs[A]).toBeUndefined();
    expect(h.state.pending[`docs:${A}`]).toBeUndefined();
    expect(h.dispatched.filter((d) => d.action === "shelveDoc")).toHaveLength(1);
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

  // The server keeps an archived row, marked, and its sync delivers it that
  // way. A tombstone predicate tells the guard that row is still gone, so the
  // undo restores it instead of calling it already undone, and a redo reads
  // it as removed.
  it("a removed row that synced back as a tombstone is still taken back", () => {
    const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
    const tombstone = (store: string, row: unknown) => store === "docs" && (row as any)?.archived_at != null;
    const h = makeStore({ undo: undoConfig(calls, { tombstone }) });
    h.setState({ docs: { [A]: { _id: A, title: "Doc", updated_at: 1 } } });
    h.wrapped.archiveDoc(A);
    h.setState({ docs: { [A]: { _id: A, title: "Doc", archived_at: 5, updated_at: 2 } } });
    expect(performUndo()).toBe(true);
    expect(top().status).toBe("undone");
    expect(h.state.docs[A]).toMatchObject({ _id: A, title: "Doc" });
    expect(h.state.docs[A].archived_at).toBeUndefined();
    expect(lastDispatch(h, "restoreDoc")!.args).toEqual([A]);

    // Archived again elsewhere: the redo finds the row removed, as it left it.
    h.setState({ docs: { [A]: { _id: A, title: "Doc", archived_at: 9, updated_at: 3 } } });
    performRedo();
    expect(notices.at(-1)).toBe("Can't redo Archived doc: changed since");
    expect(h.state.docs[A].archived_at).toBe(9);
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

  it("a partial undo of an inverse entry dispatches nothing for the skipped row", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.stashBoth(A, B);
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], hidden_at: 99 } } });
    const before = h.dispatched.length;
    performUndo();
    // The undo writes back only part of what the forward sent, so it waits for that send.
    await waitFor(() => h.dispatched.length > before && h.outbox.size === 0);
    await sleep(10);
    // Once: the drain its forward's ack starts does not send it again.
    const sent = h.dispatched.slice(before);
    expect(sent.map((d) => [d.action, d.args])).toEqual([["restore", [A]]]);
    expect(sent[0]!.patches).toEqual({ item_rows: { [A]: { hidden_at: null } } });
    expect(h.state.items[A].hidden_at).toBeUndefined();
    expect(h.state.items[B].hidden_at).toBe(99);
    expect(notices).toEqual(["Undid: Stashed two (1 changed since, left as they are)"]);
  });

  it("two stores on one server row are judged as one row", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.setState({ twins: { [A]: { _id: A, title: "a" } } });
    h.wrapped.deferTwin(A);
    // A later change reaches only one copy.
    h.setState({ items: { [A]: { ...h.state.items[A], deferred_at: 9 } } });
    const before = h.dispatched.length;
    const pendingBefore = { ...h.state.pending };
    performUndo();
    expect(h.dispatched.length).toBe(before);
    expect(h.state.items[A].deferred_at).toBe(9);
    expect(h.state.twins[A].deferred_at).toBe(5);
    expect(h.state.pending).toEqual(pendingBefore);
    expect(notices).toEqual(["Can't undo Deferred twin: changed since"]);
  });

  it("a partial undo leaves both copies of the skipped row and counts it once", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.setState({ twins: { [A]: { _id: A }, [B]: { _id: B } } });
    undoGroup("Deferred two", () => {
      h.wrapped.deferTwin(A);
      h.wrapped.deferTwin(B);
    });
    h.setState({ twins: { ...h.state.twins, [B]: { ...h.state.twins[B], deferred_at: 9 } } });
    const before = h.dispatched.length;
    performUndo();
    expect(h.state.items[A].deferred_at).toBeUndefined();
    expect(h.state.twins[A].deferred_at).toBeUndefined();
    expect(h.state.items[B].deferred_at).toBe(5);
    expect(h.state.twins[B].deferred_at).toBe(9);
    const sent = h.dispatched.slice(before).map((d) => JSON.stringify(d.patches));
    expect(sent.some((p) => p.includes(B))).toBe(false);
    expect(notices).toEqual(["Undid: Deferred two (1 changed since, left as they are)"]);
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

  it("redo after a partial undo restores only the rows the undo applied", async () => {
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
    // The undo writes back only part of what the forward sent, so it waits for that send.
    await waitFor(() => !!lastDispatch(h, "applyUndoPatches"));
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

  it("an undo refused once per pass returns to the undo stack and stays there", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.stashBoth(A, B);
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    h.respond(async (a) => {
      if (a === "restore") throw new Error("Uncaught Error: no");
      return {};
    });
    const before = h.dispatched.length;
    performUndo();
    await waitFor(() => h.dispatched.slice(before).filter((d) => d.action === "restore").length === 2 && h.outbox.size === 0);
    await waitFor(() => getUndoHistory().head === id);
    expect(items().find((i) => i.id === id)!.status).toBe("done");
    expect(h.state.items[A].hidden_at).toBe(7);
    expect(h.state.items[B].hidden_at).toBe(7);
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

  it("a rekeyed removal comes back under the server id, and a rekeyed inverse names it", async () => {
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
    // The undo writes back only part of what the forward sent, so it waits for that send.
    await waitFor(() => !!lastDispatch(h, "restore"));
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

// ---------------------------------------------------------------------------
// Regressions from the adversarial review (validation round 1, engine lens)
// ---------------------------------------------------------------------------

function withSpecs(extra: UndoConfig["specs"]): UndoConfig {
  const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
  const base = undoConfig(calls);
  return undoConfig(calls, { specs: { ...base.specs, ...extra } });
}

const OPTIONAL = new Set(["pinned_at"]);
const echoEngine = () =>
  createSyncEngine({ dbName: "t", dbVersion: 1, registry: REGISTRY, syncRegistry: { items: { isDelta: true } }, optionalClearFields: OPTIONAL });

function echo(h: ReturnType<typeof makeStore>, rows: any[]) {
  const draft: any = { items: { ...h.state.items }, pending: { ...h.state.pending } };
  echoEngine().syncTable(draft, "items", rows);
  h.setState({ items: draft.items, pending: draft.pending });
}

describe("ADV optional-clear fields", () => {
  it("ADV1 undo of an unpin survives the server echo that omits the cleared field", () => {
    const h = makeStore({
      optionalClearFields: OPTIONAL,
      extra: { unpin: action(function (this: any, id: string) { this.items[id].pinned_at = null; }) },
      undo: withSpecs({ unpin: { label: () => "Unpinned" } }),
    });
    h.wrapped.seed(A, { title: "t", pinned_at: 5 });
    h.wrapped.unpin(A);
    echo(h, [{ _id: A, title: "t" }]);
    // The sync layer counts the omitted field as the echo of the null: lock retired.
    expect(h.state.pending[`items:${A}:pinned_at`]).toBeUndefined();
    expect("pinned_at" in h.state.items[A]).toBe(false);
    performUndo();
    expect(notices).toEqual(["Undid: Unpinned"]);
    expect(h.state.items[A].pinned_at).toBe(5);
  });

  it("ADV2 redo of a pin survives the echo of the undo's null", () => {
    const h = makeStore({
      optionalClearFields: OPTIONAL,
      extra: { pinIt: action(function (this: any, id: string) { this.items[id].pinned_at = 5; }) },
      undo: withSpecs({ pinIt: { label: () => "Pinned" } }),
    });
    h.wrapped.seed(A, { title: "t", pinned_at: null });
    h.wrapped.pinIt(A);
    performUndo();
    expect(h.state.items[A].pinned_at).toBeNull();
    echo(h, [{ _id: A, title: "t" }]);
    expect(h.state.pending[`items:${A}:pinned_at`]).toBeUndefined();
    performRedo();
    expect(notices.at(-1)).toBe("Redid: Pinned");
    expect(h.state.items[A].pinned_at).toBe(5);
  });
});

describe("ADV groups and refusal", () => {
  it("ADV3 a group whose every child's undo is refused can be undone again in full", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    undoGroup("Renamed two", () => {
      h.wrapped.rename(A, "a2");
      h.wrapped.rename(B, "b2");
    });
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    h.respond(async (a) => {
      if (a === "applyUndoPatches") throw new Error("Uncaught Error: no");
      return {};
    });
    const before = h.dispatched.length;
    performUndo();
    await waitFor(() => h.dispatched.slice(before).filter((d) => d.action === "applyUndoPatches").length === 2 && h.outbox.size === 0);
    await waitFor(() => getUndoHistory().head === id);
    await sleep(20);
    expect(h.state.items[A].title).toBe("a2");
    expect(h.state.items[B].title).toBe("b2");
    const childStatuses = items().find((i) => i.id === id)!.children!.map((c) => c.status);
    h.respond(async () => ({}));
    performUndo();
    expect({ childStatuses, A: h.state.items[A].title, B: h.state.items[B].title }).toEqual({
      childStatuses: ["done", "done"],
      A: "a",
      B: "b",
    });
  });

  it("ADV4 a toggle twice inside one group undoes and redoes cleanly", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    undoGroup("Toggled twice", () => {
      h.wrapped.toggleFav(A);
      h.wrapped.toggleFav(A);
    });
    performUndo();
    expect(h.state.items[A].is_favorite).toBeUndefined();
    expect(h.state.favorites).toEqual([]);
    performRedo();
    expect(h.state.items[A].is_favorite).toBe(false);
    expect(h.state.favorites).toEqual([]);
  });
});

describe("ADV row adds", () => {
  it("ADV5 undo of a row add whose row changed since is a conflict, not a delete", () => {
    const h = makeStore();
    h.wrapped.addItem(A);
    // A later change reaches the row (a push, another window).
    h.setState({ items: { [A]: { _id: A, title: "someone" } } });
    performUndo();
    expect(h.state.items[A]).toEqual({ _id: A, title: "someone" });
    expect(notices).toEqual(["Can't undo Added: changed since"]);
  });

  it("ADV6 selective undo of an older add does not delete a row a newer entry edited", () => {
    const h = makeStore();
    h.wrapped.addItem(A);
    const addId = top().id;
    h.wrapped.rename(A, "mine");
    undoEntry(addId);
    expect(h.state.items[A]?.title).toBe("mine");
  });
});

describe("ADV stub rekey", () => {
  it("ADV7 a field whose value named a stub follows the rekey", () => {
    const h = makeStore({
      extra: { setRef: action(function (this: any, id: string, ref: string) { this.items[id].ref = ref; }) },
      undo: withSpecs({ setRef: { label: () => "Linked" } }),
    });
    h.wrapped.seed(A, { title: "t", ref: "old" });
    h.wrapped.setRef(A, "stub_9");
    // The app's rekeyExtra moves child pointers to the server id; the undo stack follows.
    h.setState({ items: { [A]: { ...h.state.items[A], ref: B } } });
    rekeyUndoIds("stub_9", B);
    performUndo();
    expect(notices).toEqual(["Undid: Linked"]);
    expect(h.state.items[A].ref).toBe("old");
  });
});

describe("ADV coalesce", () => {
  it("ADV8 a coalesced run that ends where it began leaves no entry", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a", priority: "low" });
    h.wrapped.cycle(A, "mid");
    h.wrapped.cycle(A, "low");
    const cycles = items().filter((i) => i.action === "cycle" && i.status === "done");
    expect(cycles).toHaveLength(0);
  });
});

describe("ADV sanity (expected to pass)", () => {
  it("a stale push between undo and redo does not break redo", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.rename(A, "x");
    performUndo();
    const engine = createSyncEngine({ dbName: "t", dbVersion: 1, registry: REGISTRY, syncRegistry: { items: { isDelta: true } } });
    const draft: any = { items: { ...h.state.items }, pending: { ...h.state.pending } };
    engine.syncTable(draft, "items", [{ _id: A, title: "x", updated_at: 50 }]);
    h.setState({ items: draft.items, pending: draft.pending });
    expect(h.state.items[A].title).toBe("t");
    expect(performRedo()).toBe(true);
    expect(h.state.items[A].title).toBe("x");
  });

  it("drop, undo, redo, undo round trips a row and its exclude", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.drop(A);
    performUndo();
    expect(h.state.items[A]).toMatchObject({ title: "a" });
    performRedo();
    expect(h.state.items[A]).toBeUndefined();
    expect(h.state.pending[`items:${A}`]).toMatchObject({ type: "exclude" });
    performUndo();
    expect(h.state.items[A]).toMatchObject({ title: "a" });
  });

  it("async and receipt entries undo through the replay and redo re-invokes", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    await h.wrapped.pokeAsync(A);
    performUndo();
    expect(h.state.items[A].title).toBe("t");
    performRedo();
    expect(h.state.items[A].title).toBe("async");
    expect(h.dispatched.filter((d) => d.action === "pokeAsync")).toHaveLength(2);
  });

  it("undoTo and redoTo across a group with a conflicting child", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.rename(A, "a1");
    const first = top().id;
    undoGroup("two", () => {
      h.wrapped.rename(A, "a2");
      h.wrapped.rename(B, "b2");
    });
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "other" } } });
    expect(undoTo(first)).toBe(2);
    expect(h.state.items[A].title).toBe("a");
    expect(h.state.items[B].title).toBe("other");
    expect(redoTo(getUndoHistory().redoOrder.at(-1)!)).toBe(2);
    expect(h.state.items[A].title).toBe("a2");
  });

  it("snapshot is stable across no-op refusals and rekeys", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.rename(A, "x");
    const s = getUndoHistory();
    rekeyUndoIds("nobody", B);
    expect(getUndoHistory()).toBe(s);
  });
});

describe("ADV group child already undone", () => {
  it("ADV9 a group child whose row is already back at before is not counted as changed since", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    undoGroup("Renamed two", () => {
      h.wrapped.rename(A, "a2");
      h.wrapped.rename(B, "b2");
    });
    const id = top().id;
    // Someone else put B back to exactly what it was.
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "b" } } });
    performUndo();
    const entry = items().find((i) => i.id === id)!;
    expect({ notice: notices.at(-1), childStatuses: entry.children!.map((c) => c.status) }).toEqual({
      notice: "Undid: Renamed two",
      childStatuses: ["undone", "undone"],
    });
  });

  it("ADV9b the same state in a single entry is nothing to do, not a skip", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.renameBoth(A, B, "both");
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "b" } } });
    performUndo();
    expect(notices.at(-1)).toBe("Undid: Both");
  });
});

describe("coalesce and stamps", () => {
  it("calls whose stamp did not move (one millisecond) still merge", () => {
    const h = makeStore({
      extra: {
        stampCycle: action(function (this: any, id: string, priority: string, at: number) {
          this.items[id].priority = priority;
          this.items[id].updated_at = at;
        }),
      },
      undo: withSpecs({ stampCycle: { label: (ctx) => `Priority ${ctx.args[1]}`, coalesce: true } }),
    });
    h.wrapped.seed(A, { title: "a", priority: "low", updated_at: 1 });
    h.wrapped.stampCycle(A, "mid", 10);
    h.wrapped.stampCycle(A, "high", 10);
    h.wrapped.stampCycle(A, "top", 10);
    const cycles = items().filter((i) => i.action === "stampCycle");
    expect(cycles.map((i) => i.label)).toEqual(["Priority top"]);
    performUndo();
    expect(h.state.items[A].priority).toBe("low");
  });
});

// A store that is not local-first (codecast chatChannels, savedViews): its
// cells are mirrors, and its server half is an inverse that sends the prior
// fields of the cells it is handed.
const chanExtra = {
  chans: {} as Record<string, any>,
  editChan: action(function (this: any, id: string, fields: Record<string, unknown>) {
    Object.assign(this.chans[id], fields);
  }),
};
const chanSpecs = () =>
  withSpecs({
    editChan: {
      label: () => "Edited channel",
      inverse: (ctx) => {
        const ids = [...new Set(ctx.changes.filter((c) => c.store === "chans").map((c) => c.id))];
        return ids.map((id) => {
          const fields: Record<string, unknown> = {};
          for (const c of ctx.changes) if (c.store === "chans" && c.id === id && c.field) fields[c.field] = c.before;
          return { action: "editChan", args: [id, fields], runDraft: false };
        });
      },
    },
  });

describe("mirror cells changed since", () => {
  it("an inverse is narrowed to the mirror cells the undo restores", async () => {
    const h = makeStore({ extra: chanExtra, undo: chanSpecs() });
    h.setState({ chans: { [A]: { _id: A, name: "general", topic: "old" } } });
    h.wrapped.editChan(A, { name: "renamed", topic: "new" });
    h.setState({ chans: { [A]: { ...h.state.chans[A], name: "teammate" } } });
    const before = h.dispatched.length;
    performUndo();
    // The undo writes back only part of what the forward sent, so it waits for that send.
    await waitFor(() => h.dispatched.slice(before).some((d) => d.action === "editChan"));
    const sent = h.dispatched.slice(before).filter((d) => d.action === "editChan").map((d) => d.args);
    expect({ local: h.state.chans[A], sent }).toEqual({
      local: { _id: A, name: "teammate", topic: "old" },
      sent: [[A, { topic: "old" }]],
    });
  });

  it("a mirror-only entry whose every cell changed since is a conflict, and sends nothing", () => {
    const h = makeStore({ extra: chanExtra, undo: chanSpecs() });
    h.setState({ chans: { [A]: { _id: A, name: "general" } } });
    h.wrapped.editChan(A, { name: "renamed" });
    h.setState({ chans: { [A]: { ...h.state.chans[A], name: "teammate" } } });
    const before = h.dispatched.length;
    performUndo();
    expect(h.dispatched.slice(before).filter((d) => d.action === "editChan")).toEqual([]);
    expect(notices.at(-1)).toBe("Can't undo Edited channel: changed since");
    expect(h.state.chans[A].name).toBe("teammate");
  });
});

describe("redo checks every captured cell", () => {
  it("a mirror-only entry is not redone over a change made since the undo", () => {
    const h = makeStore({ extra: chanExtra, undo: chanSpecs() });
    h.setState({ chans: { [A]: { _id: A, name: "general" } } });
    h.wrapped.editChan(A, { name: "renamed" });
    performUndo();
    expect(h.state.chans[A].name).toBe("general");
    h.setState({ chans: { [A]: { ...h.state.chans[A], name: "teammate" } } });
    performRedo();
    expect(h.state.chans[A].name).toBe("teammate");
    expect(notices.at(-1)).toContain("changed since");
  });

  it("a row that was already back at before when undone is not redone over a later change", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.renameBoth(A, B, "both");
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "b" } } });
    performUndo();
    expect(h.state.items[A].title).toBe("a");
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "b3" } } });
    performRedo();
    expect([h.state.items[A].title, h.state.items[B].title]).toEqual(["a", "b3"]);
  });

  it("a group child whose undo found it already undone is not redone over a later change", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "b" });
    undoGroup("Renamed two", () => {
      h.wrapped.rename(A, "a2");
      h.wrapped.rename(B, "b2");
    });
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "b" } } });
    performUndo();
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "b3" } } });
    performRedo();
    expect([h.state.items[A].title, h.state.items[B].title]).toEqual(["a2", "b3"]);
  });

  // The forward wrote color with the value it already held, so nothing
  // captured it; the re-invoke would still write it over a later change.
  it("a cell the forward wrote unchanged is not redone over a change made since the undo", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "old", color: "red" });
    h.wrapped.setTwo(A, "new", "red");
    performUndo();
    h.setState({ items: { ...h.state.items, [A]: { ...h.state.items[A], color: "blue" } } });
    const before = h.dispatched.length;
    expect(performRedo()).toBe(true);
    expect([h.state.items[A].title, h.state.items[A].color]).toEqual(["new", "blue"]);
    await sleep(5);
    expect(h.dispatched.slice(before).some((d) => d.action === "setTwo")).toBe(false);
  });

  // The binding announces values to sibling windows only for a replay the
  // engine wrote itself: a re-invoked action announces its own effects.
  it("tells afterReplay whether the redo re-ran the action or restored fields", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "old", color: "red" });
    h.wrapped.setTwo(A, "new", "red");
    performUndo();
    h.setState({ items: { ...h.state.items, [A]: { ...h.state.items[A], color: "blue" } } });
    performRedo();
    expect(h.calls.afterReplay.map(([, dir, , how]) => [dir, how])).toEqual([["undo", "replay"], ["redo", "replay"]]);
    performUndo();
    h.setState({ items: { ...h.state.items, [A]: { ...h.state.items[A], color: "red" } } });
    h.wrapped.rename(A, "plain");
    performUndo();
    performRedo();
    expect(h.calls.afterReplay.at(-1)?.[3]).toBe("reinvoke");
  });

  // A vetoed re-invoke has run the action body on a draft that is thrown away,
  // so the outside effects it asked for (a sibling-window broadcast, a sound)
  // must be thrown away with it.
  it("a vetoed redo runs none of the action body's commit effects", () => {
    const effects: string[] = [];
    const h = makeStore({
      undo: withSpecs({ setTwoLoud: { label: () => "Set two loud" } }),
      extra: {
        setTwoLoud: action(function (this: any, id: string, title: string, color: string) {
          this.items[id].title = title;
          this.items[id].color = color;
          afterCommit(() => effects.push(`${id}:${title}`));
        }),
      },
    });
    h.wrapped.seed(A, { title: "old", color: "red" });
    h.wrapped.setTwoLoud(A, "new", "red");
    expect(effects).toEqual([`${A}:new`]);
    performUndo();
    h.setState({ items: { ...h.state.items, [A]: { ...h.state.items[A], color: "blue" } } });
    performRedo();
    expect([h.state.items[A].title, h.state.items[A].color]).toEqual(["new", "blue"]);
    expect(effects).toEqual([`${A}:new`]);
  });

  it("an effect asked for outside any action runs at once", () => {
    const effects: number[] = [];
    afterCommit(() => effects.push(1));
    expect(effects).toEqual([1]);
  });

  it("a row the forward wrote unchanged is not redone over a change made since the undo", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.seed(B, { title: "done" });
    h.wrapped.renameBoth(A, B, "done");
    performUndo();
    h.setState({ items: { ...h.state.items, [B]: { ...h.state.items[B], title: "teammate" } } });
    performRedo();
    expect([h.state.items[A].title, h.state.items[B].title]).toEqual(["done", "teammate"]);
  });

  it("a cell the forward wrote unchanged that nobody touched lets the redo re-invoke", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "old", color: "red" });
    h.wrapped.setTwo(A, "new", "red");
    performUndo();
    const before = h.dispatched.length;
    performRedo();
    expect([h.state.items[A].title, h.state.items[A].color]).toEqual(["new", "red"]);
    await sleep(5);
    expect(h.dispatched.slice(before).map((d) => d.action)).toContain("setTwo");
  });

  it("a clean redo still re-invokes the action", () => {
    const h = makeStore({ extra: chanExtra, undo: chanSpecs() });
    h.setState({ chans: { [A]: { _id: A, name: "general" } } });
    h.wrapped.editChan(A, { name: "renamed" });
    performUndo();
    performRedo();
    expect(h.state.chans[A].name).toBe("renamed");
  });
});

describe("row adds and server-assigned fields", () => {
  it("the echo of an add with the server's own created_at can still be undone", () => {
    const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
    const extra = {
      addStamped: action(function (this: any, id: string) {
        this.items[id] = { _id: id, title: "new", created_at: 1000 };
      }),
    };
    const h = makeStore({
      extra,
      undo: undoConfig(calls, { serverAssignedFields: new Set(["created_at"]), specs: { addStamped: { label: () => "Added" } } }),
    });
    h.wrapped.addStamped(A);
    h.setState({ items: { ...h.state.items, [A]: { _id: A, title: "new", created_at: 1037 } } });
    performUndo();
    expect(h.state.items[A]).toBeUndefined();
  });

  it("without the field declared, the same echo reads as changed since", () => {
    const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
    const extra = {
      addStamped: action(function (this: any, id: string) {
        this.items[id] = { _id: id, title: "new", created_at: 1000 };
      }),
    };
    const h = makeStore({ extra, undo: undoConfig(calls, { specs: { addStamped: { label: () => "Added" } } }) });
    h.wrapped.addStamped(A);
    h.setState({ items: { ...h.state.items, [A]: { _id: A, title: "new", created_at: 1037 } } });
    performUndo();
    expect(h.state.items[A]).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Regressions from the adversarial review (validation round 4)
// ---------------------------------------------------------------------------

const refuse = (h: ReturnType<typeof makeStore>, name: string) =>
  h.respond(async (a) => {
    if (a === name) throw new Error("Uncaught Error: no");
    return {};
  });

describe("a throwing spec", () => {
  it("costs the history its entry, never the forward write its dispatch", async () => {
    const h = makeStore({
      undo: withSpecs({ rename: { label: (ctx: any) => ctx.before.items[ctx.args[0]].missing.title } }),
    });
    h.wrapped.seed(A, { title: "t" });
    await waitFor(() => h.outbox.size === 0);
    expect(() => h.wrapped.rename(A, "x")).not.toThrow();
    await waitFor(() => h.outbox.size === 0);
    expect(h.state.items[A].title).toBe("x");
    expect(h.dispatched.filter((d) => d.action === "rename")).toHaveLength(1);
    expect(items().some((i) => i.action === "rename")).toBe(false);
  });

  it("a throwing inverse on redo still dispatches the redo and leaves the entry whole", async () => {
    let calls = 0;
    const h = makeStore({
      undo: withSpecs({
        stash: {
          label: () => "Stashed",
          inverse: (ctx) => {
            calls += 1;
            if (calls > 1) throw new Error("spec bug");
            return [{ action: "restore", args: [ctx.args[0]], runDraft: false }];
          },
        },
      }),
    });
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.stash(A);
    const id = top().id;
    performUndo();
    expect(h.state.items[A].hidden_at).toBeUndefined();
    expect(performRedo()).toBe(true);
    await waitFor(() => h.outbox.size === 0);
    expect(h.state.items[A].hidden_at).toBe(7);
    expect(h.dispatched.filter((d) => d.action === "stash")).toHaveLength(2);
    expect(items().find((i) => i.id === id)!.status).toBe("done");
  });
});

describe("a refused undo of a whole-row removal", () => {
  it("takes the re-added row back out and puts the drop's exclude back (patch rail)", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.drop(A);
    const id = top().id;
    const exclude = h.state.pending[`items:${A}`];
    expect(exclude).toMatchObject({ type: "exclude" });
    await waitFor(() => h.outbox.size === 0);
    refuse(h, "applyUndoPatches");
    performUndo();
    expect(h.state.items[A]).toBeDefined();
    await waitFor(() => getUndoHistory().head === id);
    expect(items().find((i) => i.id === id)!.status).toBe("done");
    expect(h.state.items[A]).toBeUndefined();
    expect(h.state.pending[`items:${A}`]).toEqual(exclude);
  });

  it("does the same through a writer's restoreRow", async () => {
    const h = makeStore();
    h.setState({ docs: { [A]: { _id: A, title: "d" } } });
    h.wrapped.archiveDoc(A);
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    refuse(h, "restoreDoc");
    performUndo();
    expect(h.state.docs[A]).toBeDefined();
    await waitFor(() => getUndoHistory().head === id);
    expect(h.state.docs[A]).toBeUndefined();
    expect(h.state.pending[`docs:${A}`]).toMatchObject({ type: "exclude" });
  });

  it("a refused add of a collection row takes the row back out", async () => {
    const h = makeStore();
    refuse(h, "addItem");
    h.wrapped.addItem(A);
    expect(h.state.items[A]).toBeDefined();
    await waitFor(() => h.state.items[A] === undefined);
    expect(h.state.pending[`items:${A}`]).toBeUndefined();
  });
});

describe("a refused undo replay after a new gesture dropped its entry", () => {
  const holdThenRefuse = (h: ReturnType<typeof makeStore>) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.respond(async (a) => {
      if (a === "applyUndoPatches") {
        await gate;
        throw new Error("Uncaught Error: no");
      }
      return {};
    });
    return () => release();
  };

  it("puts the entry back on the undo stack", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.seed(B, { title: "b" });
    h.wrapped.rename(A, "x");
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    const release = holdThenRefuse(h);
    performUndo();
    expect(h.state.items[A].title).toBe("t");
    h.wrapped.rename(B, "y");
    expect(items().find((i) => i.id === id)!.status).toBe("dropped");
    release();
    await waitFor(() => h.state.items[A].title === "x");
    const entry = items().find((i) => i.id === id)!;
    expect(entry.status).toBe("done");
    expect(entry.droppedBy).toBeUndefined();
    expect(getUndoHistory().undoOrder).toContain(id);
  });

  it("does the same for a group", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.seed(B, { title: "b" });
    undoGroup("one", () => h.wrapped.rename(A, "x"));
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    const release = holdThenRefuse(h);
    performUndo();
    h.wrapped.rename(B, "y");
    release();
    await waitFor(() => h.state.items[A].title === "x");
    const entry = items().find((i) => i.id === id)!;
    expect(entry.status).toBe("done");
    expect(entry.children!.map((c) => c.status)).toEqual(["done"]);
    expect(getUndoHistory().undoOrder).toContain(id);
  });
});

describe("a coalesced run with one call refused", () => {
  it("stays undoable when an earlier call is refused and a later one lands", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t", priority: "low" });
    await waitFor(() => h.outbox.size === 0);
    let n = 0;
    h.respond(async (a) => {
      if (a === "cycle" && n++ === 0) throw new Error("Uncaught Error: no");
      return {};
    });
    h.wrapped.cycle(A, "mid");
    h.wrapped.cycle(A, "high");
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    expect(h.state.items[A].priority).toBe("high");
    const entry = items().find((i) => i.id === id)!;
    expect(entry.status).toBe("done");
    expect(entry.label).toBe("Priority high");
    performUndo();
    expect(h.state.items[A].priority).toBe("low");
  });

  it("ends at the last call that stood when the newest call is refused", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t", priority: "low" });
    await waitFor(() => h.outbox.size === 0);
    let n = 0;
    h.respond(async (a) => {
      if (a === "cycle" && n++ === 1) throw new Error("Uncaught Error: no");
      return {};
    });
    h.wrapped.cycle(A, "mid");
    h.wrapped.cycle(A, "high");
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    expect(h.state.items[A].priority).toBe("mid");
    const entry = items().find((i) => i.id === id)!;
    expect(entry.status).toBe("done");
    expect(entry.label).toBe("Priority mid");
    expect(entry.changes!.find((c) => c.field === "priority")).toMatchObject({ before: "low", after: "mid" });
    performUndo();
    expect(h.state.items[A].priority).toBe("low");
  });

  it("is refused when every call is", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t", priority: "low" });
    await waitFor(() => h.outbox.size === 0);
    refuse(h, "cycle");
    h.wrapped.cycle(A, "mid");
    h.wrapped.cycle(A, "high");
    const id = top().id;
    await waitFor(() => h.outbox.size === 0);
    expect(items().find((i) => i.id === id)!.status).toBe("refused");
  });
});

describe("a coalesced run on a stub row that is rekeyed", () => {
  // The server row supersedes the stub mid-run (codecast types a new task's
  // title while its client_key rekey lands).
  function rekeyStub(h: ReturnType<typeof makeStore>, stub: string) {
    const engine = createSyncEngine({
      dbName: "t",
      dbVersion: 1,
      registry: REGISTRY,
      syncRegistry: { items: { isDelta: true, altKey: "client_id" } },
    });
    const draft: any = {
      items: { ...h.state.items, [stub]: { ...h.state.items[stub], client_id: stub } },
      pending: { ...h.state.pending },
    };
    engine.syncTable(draft, "items", [{ ...h.state.items[stub], _id: A, client_id: stub }]);
    h.setState({ items: draft.items, pending: draft.pending });
  }

  it("merges a later call under the server id into one cell and undoes to the origin", async () => {
    const h = makeStore();
    h.wrapped.seed("stub-9", { title: "t", priority: "low" });
    await waitFor(() => h.outbox.size === 0);
    h.wrapped.cycle("stub-9", "mid");
    h.wrapped.cycle("stub-9", "high");
    await waitFor(() => h.outbox.size === 0);
    rekeyStub(h, "stub-9");
    h.wrapped.cycle(A, "urgent");
    const cells = top().changes!.filter((c) => c.field === "priority").map((c) => [c.id, c.before, c.after]);
    expect(cells).toEqual([[A, "low", "urgent"]]);
    performUndo();
    expect(h.state.items[A].priority).toBe("low");
    expect(notices.at(-1)).toBe("Undid: Priority urgent");
  });

  it("a refusal after the rekey rebuilds the entry under the server id", async () => {
    const h = makeStore();
    h.wrapped.seed("stub_c", { title: "t", priority: "low" });
    await waitFor(() => h.outbox.size === 0);
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    h.respond(async (a) => {
      if (a !== "cycle") return {};
      if (n++ === 1) {
        await gate;
        throw new Error("Uncaught Error: no");
      }
      return {};
    });
    h.wrapped.cycle("stub_c", "mid");
    h.wrapped.cycle("stub_c", "high");
    const id = top().id;
    await waitFor(() => n === 2);
    rekeyStub(h, "stub_c");
    release();
    await waitFor(() => h.outbox.size === 0);
    const entry = items().find((i) => i.id === id)!;
    expect(entry.status).toBe("done");
    expect(entry.args).toEqual([A, "mid"]);
    expect(entry.changes!.every((c) => c.id === A)).toBe(true);
  });
});

describe("a group holding a confirm child", () => {
  it("is not taken back by a blind press", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    undoGroup("bulk", () => h.wrapped.retitle(A, "secret"));
    expect(top().confirm).toBe(true);
    performUndo();
    expect(h.state.items[A].title).toBe("secret");
    expect(notices.at(-1)).toBe("Undo bulk from its toast or the history");
  });
});

describe("the history ring", () => {
  it("never evicts an entry a stack still holds", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "t" });
    configureUndoStack({ historyLimit: 4 });
    try {
      h.wrapped.rename(A, "1");
      const first = top().id;
      for (let i = 0; i < 4; i++) h.wrapped.orgMove(A);
      const snap = getUndoHistory();
      expect(snap.head).toBe(first);
      expect(snap.items.some((x) => x.id === first)).toBe(true);
      expect(snap.items).toHaveLength(4);
    } finally {
      configureUndoStack({ historyLimit: 200 });
    }
  });
});

describe("a group whose every child is already back", () => {
  it("is a conflict whose children keep their status", () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    undoGroup("g", () => h.wrapped.rename(A, "x"));
    const id = top().id;
    h.setState({ items: { ...h.state.items, [A]: { ...h.state.items[A], title: "a" } } });
    performUndo();
    const entry = items().find((i) => i.id === id)!;
    expect(entry.status).toBe("conflict");
    expect(entry.children!.map((c) => c.status)).toEqual(["done"]);
  });
});

describe("dispatch order", () => {
  it("a forward write whose first attempt fails after its undo went out is not retried", async () => {
    const h = makeStore({ retryDelays: [5] });
    h.wrapped.seed(A, { title: "t" });
    await waitFor(() => h.outbox.size === 0);
    const arrived: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    h.respond(async (a) => {
      if (a === "rename" && calls++ === 0) {
        await gate;
        throw new Error("Server Error");
      }
      arrived.push(a);
      return {};
    });
    h.wrapped.rename(A, "x");
    performUndo();
    // The undo goes out at once, behind the rename's first attempt.
    expect(h.dispatched.map((d) => d.action).slice(-2)).toEqual(["rename", "applyUndoPatches"]);
    release();
    await waitFor(() => h.outbox.size === 0);
    await sleep(20);
    expect(arrived).toEqual(["applyUndoPatches"]);
    expect(h.state.items[A].title).toBe("t");
  });

  it("an undo never overtakes a forward write that is retrying", async () => {
    const h = makeStore({ retryDelays: [20] });
    h.wrapped.seed(A, { title: "t" });
    await waitFor(() => h.outbox.size === 0);
    const arrived: string[] = [];
    let failed = false;
    h.respond(async (a) => {
      if (a === "rename" && !failed) {
        failed = true;
        throw new Error("Server Error");
      }
      arrived.push(a);
      return {};
    });
    h.wrapped.rename(A, "x");
    await sleep(2);
    performUndo();
    await waitFor(() => h.outbox.size === 0);
    expect(arrived).toEqual(["rename", "applyUndoPatches"]);
  });

  it("an undo parks behind a forward write the retries left parked, and the drain sends both in order", async () => {
    const h = makeStore({ retryDelays: [5] });
    h.wrapped.seed(A, { title: "t" });
    await waitFor(() => h.outbox.size === 0);
    const arrived: string[] = [];
    let down = true;
    h.respond(async (a) => {
      if (down && a === "rename") throw new Error("Server Error");
      arrived.push(a);
      return {};
    });
    h.wrapped.rename(A, "x");
    // The rename's retries run out and it parks; then the undo.
    await sleep(40);
    performUndo();
    await sleep(40);
    expect(arrived).toEqual([]);
    expect([...h.outbox.values()].map((o) => o.action)).toEqual(["rename", "applyUndoPatches"]);
    down = false;
    h.wrapped._drainOutbox();
    await waitFor(() => h.outbox.size === 0);
    expect(arrived).toEqual(["rename", "applyUndoPatches"]);
  });
});

describe("a live write behind a parked one", () => {
  // Not an undo concern alone: any later write of a cell a parked row also
  // wrote must reach the server after it, or the drain lands the stale value last.
  it("is held behind the parked row, so the drain delivers both in call order", async () => {
    const h = makeStore({ retryDelays: [5] });
    h.wrapped.seed(A, { title: "t0" });
    await waitFor(() => h.outbox.size === 0);
    const server = { title: "t0", arrived: [] as string[] };
    let down = true;
    h.respond(async (a) => {
      const d = h.dispatched[h.dispatched.length - 1]!;
      if (down) throw new Error("Server Error");
      const title = d.patches?.item_rows?.[A]?.title;
      server.arrived.push(`${a}:${title}`);
      if (title !== undefined) server.title = title;
      return {};
    });
    h.wrapped.rename(A, "x");
    // Its retries run out and it parks.
    await sleep(40);
    down = false;
    h.wrapped.rename(A, "fresh");
    await waitFor(() => h.outbox.size === 0);
    await sleep(20);
    expect(server.arrived).toEqual(["rename:x", "rename:fresh"]);
    expect(server.title).toBe("fresh");
    expect(h.state.items[A].title).toBe("fresh");
  });

  it("is not held behind a parked row of another field", async () => {
    const h = makeStore({ retryDelays: [5] });
    h.wrapped.seed(A, { title: "t0", priority: "low" });
    await waitFor(() => h.outbox.size === 0);
    const arrived: string[] = [];
    h.respond(async (a) => {
      if (a === "rename") throw new Error("Server Error");
      arrived.push(a);
      return {};
    });
    h.wrapped.rename(A, "x");
    await sleep(40);
    h.wrapped.cycle(A, "high");
    await waitFor(() => arrived.includes("cycle"));
  });
});

// A server that applies what it receives, in arrival order, to one title.
function titleServer(h: ReturnType<typeof makeStore>, fails: (action: string, title: string, attempt: number) => boolean) {
  const server = { title: "t", arrived: [] as string[] };
  const attempts = new Map<string, number>();
  h.respond(async (a) => {
    const d = h.dispatched[h.dispatched.length - 1]!;
    const title = a === "retitle" ? String(d.args[1]) : String(JSON.stringify(d.patches).match(/"title":"(\w*)"/)?.[1]);
    const key = `${a}:${title}`;
    const n = attempts.get(key) ?? 0;
    attempts.set(key, n + 1);
    if (fails(a, title, n)) throw new Error("Server Error");
    server.arrived.push(key);
    server.title = title;
    return {};
  });
  return server;
}

describe("a walk of several steps reaches the server in order", () => {
  const seeded = async (retryMs = 30) => {
    const h = makeStore({ retryDelays: [retryMs] });
    h.wrapped.seed(A, { title: "t" });
    await waitFor(() => h.outbox.size === 0);
    return h;
  };

  it("two presses over two edits of one cell, the newer forward retrying, end at the origin", async () => {
    const h = await seeded();
    const server = titleServer(h, (a, title, n) => a === "retitle" && title === "y" && n === 0);
    h.wrapped.retitle(A, "x");
    h.wrapped.retitle(A, "y");
    await sleep(2);
    performUndo();
    performUndo();
    await waitFor(() => h.outbox.size === 0);
    await sleep(40);
    expect(h.state.items[A].title).toBe("t");
    expect(server.title).toBe("t");
  });

  it("undoTo the oldest, the newer replay failing once, ends at the origin", async () => {
    const h = await seeded();
    const server = titleServer(h, (a, title, n) => a === "applyUndoPatches" && title === "x" && n === 0);
    h.wrapped.retitle(A, "x");
    h.wrapped.retitle(A, "y");
    await waitFor(() => h.outbox.size === 0);
    const oldest = items()[1]!.id;
    expect(undoTo(oldest)).toBe(2);
    await waitFor(() => h.outbox.size === 0);
    await sleep(40);
    expect(h.state.items[A].title).toBe("t");
    expect(server.title).toBe("t");
  });

  it("a group of two edits of one cell, undone in one press, ends at the origin", async () => {
    const h = await seeded();
    const server = titleServer(h, (a, title, n) => a === "applyUndoPatches" && title === "x" && n === 0);
    undoGroup("Two", () => {
      h.wrapped.retitle(A, "x");
      h.wrapped.retitle(A, "y");
    });
    await waitFor(() => h.outbox.size === 0);
    performUndo();
    await waitFor(() => h.outbox.size === 0);
    await sleep(40);
    expect(h.state.items[A].title).toBe("t");
    expect(server.title).toBe("t");
  });

  it("redoTo the newest, the older redo failing once, ends at the newest", async () => {
    const h = await seeded();
    let redoing = false;
    const server = titleServer(h, (a, title, n) => redoing && a === "retitle" && title === "x" && n === 1);
    h.wrapped.retitle(A, "x");
    h.wrapped.retitle(A, "y");
    await waitFor(() => h.outbox.size === 0);
    const newest = items()[0]!.id;
    performUndo();
    performUndo();
    await waitFor(() => h.outbox.size === 0);
    redoing = true;
    expect(redoTo(newest)).toBe(2);
    await waitFor(() => h.outbox.size === 0);
    await sleep(40);
    expect(h.state.items[A].title).toBe("y");
    expect(server.title).toBe("y");
  });

  it("an undo does not cut off a later write of another field on the same row", async () => {
    const h = await seeded(5);
    const arrived: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    h.respond(async (a) => {
      if (a === "cycle" && calls++ === 0) {
        await gate;
        throw new Error("Server Error");
      }
      arrived.push(a);
      return {};
    });
    h.wrapped.retitle(A, "x");
    const retitled = items()[0]!.id;
    h.wrapped.cycle(A, "high");
    // A selective undo of the retitle, while the priority write is on its
    // first attempt: the undo reverses nothing that write sent.
    expect(undoEntry(retitled)).toBe(true);
    release();
    await waitFor(() => h.outbox.size === 0);
    await sleep(20);
    expect(arrived).toContain("cycle");
    expect(h.state.items[A].priority).toBe("high");
  });
});

// A step that goes out as several passes: the next step of a walk follows
// every one of them, not only the last dispatched.
describe("a walk step of several passes reaches the server in order", () => {
  const D1 = "d1".padEnd(32, "1");
  const D2 = "d2".padEnd(32, "2");
  const extra = {
    retitleDocs: action(function (this: any, ids: string[], title: string) {
      for (const id of ids) this.docs[id].title = title;
    }),
    retitleWithDoc: action(function (this: any, id: string, doc: string, title: string) {
      this.items[id].title = title;
      this.docs[doc].title = title;
    }),
    retitleInv: action(function (this: any, id: string, title: string) {
      this.items[id].title = title;
    }),
    retitleTwo: action(function (this: any, a: string, b: string, title: string) {
      this.items[a].title = title;
      this.items[b].title = title;
    }),
  };
  const specs: UndoConfig["specs"] = {
    retitleDocs: { label: () => "Retitled docs" },
    retitleWithDoc: { label: () => "Retitled with doc" },
    retitleTwo: {
      label: () => "Retitled two",
      inverse: (ctx) =>
        ctx.changes
          .filter((c) => c.store === "items" && c.field === "title")
          .map((c) => ({ action: "retitleInv", args: [c.id, c.before], runDraft: false })),
    },
  };

  // A server holding each row's title, applying writes in arrival order.
  // `fails` sees each attempt's key, and whether it is the first write since the walk began.
  const rowServer = (h: ReturnType<typeof makeStore>, fails: (key: string, attempt: number) => boolean) => {
    const rows = new Map<string, string>();
    const attempts = new Map<string, number>();
    h.respond(async (a) => {
      const d = h.dispatched[h.dispatched.length - 1]!;
      const writes: Array<[string, string]> = [];
      if (a === "retitle" || a === "retitleInv") writes.push([d.args[0], String(d.args[1])]);
      else if (a === "saveDoc" || a === "editDoc") writes.push([d.args[0], String(d.args[1].title)]);
      else if (a === "retitleDocs") for (const id of d.args[0]) writes.push([id, String(d.args[1])]);
      else if (a === "retitleTwo") writes.push([d.args[0], String(d.args[2])], [d.args[1], String(d.args[2])]);
      else if (a === "retitleWithDoc") writes.push([d.args[0], String(d.args[2])], [d.args[1], String(d.args[2])]);
      else if (a === "applyUndoPatches")
        for (const [id, row] of Object.entries<any>(d.patches?.item_rows ?? {}))
          if (row?.title !== undefined) writes.push([id, String(row.title)]);
      const key = `${a}[${writes.map(([id, t]) => `${id.slice(0, 2)}=${t}`).join(",")}]`;
      const n = attempts.get(key) ?? 0;
      attempts.set(key, n + 1);
      if (fails(key, n)) throw new Error("Server Error");
      for (const [id, t] of writes) rows.set(id, t);
      return {};
    });
    return rows;
  };

  const seeded = async () => {
    const h = makeStore({ retryDelays: [30], extra, undo: withSpecs(specs) });
    h.wrapped.seed(A, { title: "t" });
    h.wrapped.seed(B, { title: "t" });
    h.setState({ docs: { [D1]: { _id: D1, title: "d" }, [D2]: { _id: D2, title: "d" } } });
    await waitFor(() => h.outbox.size === 0);
    return h;
  };
  // Arms a failure of the first write the walk sends, once.
  const firstFails = () => {
    let armed = false;
    let failed: string | null = null;
    return {
      arm: () => { armed = true; },
      first: (key: string) => {
        if (!armed) return false;
        if (failed === null) failed = key;
        return key === failed;
      },
    };
  };
  const settle = async (h: ReturnType<typeof makeStore>) => {
    await waitFor(() => h.outbox.size === 0);
    await sleep(60);
    await waitFor(() => h.outbox.size === 0);
  };

  it("a writer undo over two rows, its first pass failing once", async () => {
    const h = await seeded();
    const { arm, first } = firstFails();
    const rows = rowServer(h, (key, n) => first(key) && n === 0);
    h.wrapped.retitleDocs([D1, D2], "x");
    h.wrapped.retitleDocs([D1, D2], "y");
    await waitFor(() => h.outbox.size === 0);
    arm();
    expect(undoTo(items()[1]!.id)).toBe(2);
    await settle(h);
    for (const id of [D1, D2]) {
      expect(h.state.docs[id].title).toBe("d");
      expect(rows.get(id)).toBe("d");
    }
  });

  it("a writer undo over two rows, then a second press", async () => {
    const h = await seeded();
    const { arm, first } = firstFails();
    const rows = rowServer(h, (key, n) => first(key) && n === 0);
    h.wrapped.retitleDocs([D1, D2], "x");
    h.wrapped.retitleDocs([D1, D2], "y");
    await waitFor(() => h.outbox.size === 0);
    arm();
    performUndo();
    performUndo();
    await settle(h);
    for (const id of [D1, D2]) {
      expect(h.state.docs[id].title).toBe("d");
      expect(rows.get(id)).toBe("d");
    }
  });

  it("a patch rail pass plus a writer pass, the patch pass failing once", async () => {
    const h = await seeded();
    const { arm, first } = firstFails();
    const rows = rowServer(h, (key, n) => first(key) && n === 0);
    h.wrapped.retitle(A, "x");
    h.wrapped.retitleWithDoc(A, D1, "y");
    await waitFor(() => h.outbox.size === 0);
    arm();
    expect(undoTo(items()[1]!.id)).toBe(2);
    await settle(h);
    expect(h.state.items[A].title).toBe("t");
    expect(rows.get(A)).toBe("t");
  });

  it("an inverse of one invocation per row, its first pass failing once", async () => {
    const h = await seeded();
    const { arm, first } = firstFails();
    const rows = rowServer(h, (key, n) => first(key) && n === 0);
    h.wrapped.retitleTwo(A, B, "x");
    h.wrapped.retitleTwo(A, B, "y");
    await waitFor(() => h.outbox.size === 0);
    arm();
    expect(undoTo(items()[1]!.id)).toBe(2);
    await settle(h);
    for (const id of [A, B]) {
      expect(h.state.items[id].title).toBe("t");
      expect(rows.get(id)).toBe("t");
    }
  });
});

// ---------------------------------------------------------------------------
// Regressions from validation round 8
// ---------------------------------------------------------------------------

describe("a walk whose every replay of one cell is refused", () => {
  it("leaves the server's value on screen with no lock, and the stack in history order", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.retitle(A, "b");
    h.wrapped.retitle(A, "c");
    await waitFor(() => h.outbox.size === 0);
    echo(h, [{ _id: A, title: "c" }]);
    expect(h.state.pending[`items:${A}:title`]).toBeUndefined();
    const [e2, e1] = [items()[0]!.id, items()[1]!.id];
    refuse(h, "applyUndoPatches");
    expect(undoTo(e1)).toBe(2);
    await waitFor(() => h.outbox.size === 0);
    await sleep(10);
    expect({
      title: h.state.items[A].title,
      lock: h.state.pending[`items:${A}:title`],
      undoOrder: getUndoHistory().undoOrder,
    }).toEqual({ title: "c", lock: undefined, undoOrder: [e2, e1] });
  });

  it("two forward edits of one cell, both refused, leave no lock behind", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    await waitFor(() => h.outbox.size === 0);
    echo(h, [{ _id: A, title: "a" }]);
    refuse(h, "retitle");
    h.wrapped.retitle(A, "b");
    h.wrapped.retitle(A, "c");
    await waitFor(() => h.dispatched.filter((d) => d.action === "retitle").length === 2 && h.outbox.size === 0);
    await sleep(10);
    expect({ title: h.state.items[A].title, lock: h.state.pending[`items:${A}:title`] }).toEqual({ title: "a", lock: undefined });
  });
});

describe("a mirror row the server's push replaced", () => {
  it("is taken back by membership, and the redo still lands", () => {
    const extra = {
      favFat: action(function (this: any, id: string) {
        const on = !this.items[id].is_favorite;
        this.items[id].is_favorite = on;
        if (on) this.favorites.push({ ...this.items[id], local_only: 1 });
        else this.favorites = this.favorites.filter((f: any) => f._id !== id);
      }),
    };
    const h = makeStore({ extra, undo: withSpecs({ favFat: { label: () => "Favorite" } }) });
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.favFat(A);
    // The favorites push replaces the locally built row with its own shape.
    h.setState({ favorites: [{ _id: A, is_favorite: true }] });
    performUndo();
    expect({ fav: !!h.state.items[A].is_favorite, list: h.state.favorites }).toEqual({ fav: false, list: [] });
    performRedo();
    expect({ fav: h.state.items[A].is_favorite, ids: h.state.favorites.map((f: any) => f._id), status: top().status }).toEqual({
      fav: true,
      ids: [A],
      status: "done",
    });
  });
});

describe("a redo that re-mints a stamp", () => {
  const pinStore = () => {
    let clock = 100;
    const extra = {
      pin: action(function (this: any, id: string) {
        this.items[id].pinned_stamp = ++clock;
      }),
      unpin: action(function (this: any, id: string) {
        this.items[id].pinned_stamp = null;
      }),
    };
    const h = makeStore({ extra, undo: withSpecs({ pin: { label: () => "Pinned" }, unpin: { label: () => "Unpinned" } }) });
    h.wrapped.seed(A, { title: "a", pinned_stamp: null });
    return h;
  };

  it("a redoTo walk over pin and unpin ends unpinned", () => {
    const h = pinStore();
    h.wrapped.pin(A);
    h.wrapped.unpin(A);
    const [unpinId, pinId] = [items()[0]!.id, items()[1]!.id];
    expect(undoTo(pinId)).toBe(2);
    expect(redoTo(unpinId)).toBe(2);
    expect({ stamp: h.state.items[A].pinned_stamp, statuses: items().map((i) => i.status) }).toEqual({ stamp: null, statuses: ["done", "done"] });
  });

  it("a group of pin then unpin redoes as a whole", () => {
    const h = pinStore();
    undoGroup("Pin and unpin", () => {
      h.wrapped.pin(A);
      h.wrapped.unpin(A);
    });
    performUndo();
    performRedo();
    expect({ stamp: h.state.items[A].pinned_stamp, children: top().children!.map((c) => c.status) }).toEqual({ stamp: null, children: ["done", "done"] });
  });

  it("pin, unpin, undo twice, redo twice ends unpinned with both entries done", () => {
    let clock = 100;
    const extra = {
      pin: action(function (this: any, id: string) {
        this.items[id].pinned_stamp = ++clock;
      }),
      unpin: action(function (this: any, id: string) {
        this.items[id].pinned_stamp = null;
      }),
    };
    const h = makeStore({ extra, undo: withSpecs({ pin: { label: () => "Pinned" }, unpin: { label: () => "Unpinned" } }) });
    h.wrapped.seed(A, { title: "a", pinned_stamp: null });
    h.wrapped.pin(A);
    h.wrapped.unpin(A);
    performUndo();
    performUndo();
    expect(h.state.items[A].pinned_stamp).toBe(null);
    performRedo();
    expect(h.state.items[A].pinned_stamp).toBe(102);
    performRedo();
    expect({ stamp: h.state.items[A].pinned_stamp, statuses: items().map((i) => i.status), last: notices.at(-1) }).toEqual({
      stamp: null,
      statuses: ["done", "done"],
      last: "Redid: Unpinned",
    });
  });
});

// An undo walk replays its steps in one synchronous loop, so its writes share
// a millisecond and a toggled cell repeats values. Refusals of two of those
// replays must neither spin forever nor take the landed replay's lock.
describe("a walk whose same-millisecond replays are partly refused", () => {
  it("terminates and leaves the value the server holds", async () => {
    const h = makeStore();
    h.wrapped.seed(A, { title: "a" });
    h.wrapped.retitle(A, "x");
    const first = top().id;
    await new Promise((r) => setTimeout(r, 3));
    h.wrapped.retitle(A, "a");
    await new Promise((r) => setTimeout(r, 3));
    h.wrapped.retitle(A, "x");
    await waitFor(() => h.outbox.size === 0);
    let n = 0;
    h.respond(async (a) => {
      if (a !== "applyUndoPatches") return {};
      n += 1;
      if (n >= 2) throw new Error("Uncaught Error: no");
      return {};
    });
    const real = Date.now;
    const t = real() + 1000;
    Date.now = () => t;
    try {
      undoTo(first);
    } finally {
      Date.now = real;
    }
    await waitFor(() => n === 3 && h.outbox.size === 0);
    await new Promise((r) => setTimeout(r, 10));
    // Only the first replay (x -> a) landed.
    expect(h.state.items[A].title).toBe("a");
    expect(h.state.pending[`items:${A}:title`]?.value ?? "a").toBe("a");
  });
});

// A refused write's rollback must respect what the server said while its lock
// hid the field: a displaced lock whose own value was echoed meanwhile is not
// brought back (no echo would ever clear it again), and a newer server value
// it hid wins over the value from before the write.
describe("a refused write's rollback after the server spoke under its lock", () => {
  type Gate = { promise: Promise<any>; resolve: (v?: any) => void; reject: (e: Error) => void };
  const gate = (): Gate => {
    let resolve!: Gate["resolve"];
    let reject!: Gate["reject"];
    const promise = new Promise<any>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const settled = async (h: ReturnType<typeof makeStore>, title: string) => {
    h.wrapped.seed(A, { title });
    await waitFor(() => h.outbox.size === 0);
    echo(h, [{ _id: A, title }]);
    expect(h.state.pending[`items:${A}:title`]).toBeUndefined();
  };

  it("an undo refused after the forward's echo does not bring the forward's lock back", async () => {
    const h = makeStore();
    await settled(h, "t");
    const forward = gate();
    const undo = gate();
    let undoSent = false;
    h.respond((a) => {
      if (a === "retitle") return forward.promise;
      if (a === "applyUndoPatches") { undoSent = true; return undo.promise; }
      return Promise.resolve({});
    });
    h.wrapped.retitle(A, "x");
    performUndo();
    expect(h.state.items[A].title).toBe("t");
    forward.resolve({});
    await waitFor(() => undoSent);
    echo(h, [{ _id: A, title: "x" }]);
    expect(h.state.items[A].title).toBe("t");
    undo.reject(new Error("Uncaught Error: no"));
    await waitFor(() => h.outbox.size === 0);
    await sleep(10);
    expect(h.state.items[A].title).toBe("x");
    expect(h.state.pending[`items:${A}:title`]).toBeUndefined();
    echo(h, [{ _id: A, title: "teammate" }]);
    expect(h.state.items[A].title).toBe("teammate");
  });

  it("two edits with the second refused after the first's echo leave no lock", async () => {
    const h = makeStore();
    await settled(h, "t");
    const second = gate();
    let n = 0;
    h.respond((a) => {
      if (a !== "retitle") return Promise.resolve({});
      n += 1;
      return n === 1 ? Promise.resolve({}) : second.promise;
    });
    h.wrapped.retitle(A, "x");
    h.wrapped.retitle(A, "y");
    await waitFor(() => n === 2);
    echo(h, [{ _id: A, title: "x" }]);
    expect(h.state.items[A].title).toBe("y");
    second.reject(new Error("Uncaught Error: no"));
    await waitFor(() => h.outbox.size === 0);
    await sleep(10);
    expect(h.state.items[A].title).toBe("x");
    expect(h.state.pending[`items:${A}:title`]).toBeUndefined();
    echo(h, [{ _id: A, title: "teammate" }]);
    expect(h.state.items[A].title).toBe("teammate");
  });

  it("a teammate's value hidden by a refused undo is what the row shows", async () => {
    const h = makeStore();
    await settled(h, "t");
    h.wrapped.retitle(A, "x");
    await waitFor(() => h.outbox.size === 0);
    echo(h, [{ _id: A, title: "x" }]);
    expect(h.state.pending[`items:${A}:title`]).toBeUndefined();
    const undo = gate();
    let undoSent = false;
    h.respond((a) => {
      if (a === "applyUndoPatches") { undoSent = true; return undo.promise; }
      return Promise.resolve({});
    });
    performUndo();
    await waitFor(() => undoSent);
    echo(h, [{ _id: A, title: "teammate" }]);
    expect(h.state.items[A].title).toBe("t");
    undo.reject(new Error("Uncaught Error: no"));
    await waitFor(() => h.outbox.size === 0);
    await sleep(10);
    expect(h.state.items[A].title).toBe("teammate");
    expect(h.state.pending[`items:${A}:title`]).toBeUndefined();
  });
});

// A step goes out at once only past the sends it wholly writes back. A send
// it merely follows (another field, another store's copy of the row, another
// row's pass) is waited for, so a transient failure of that send is retried
// rather than dropped as overtaken.
describe("a step overtakes only the sends it wholly reverses", () => {
  // A server holding every item row, applying each send's grouped row patches
  // in arrival order. `fails` sees the action, its rows, and the attempt.
  const rowsServer = (h: ReturnType<typeof makeStore>, fails: (action: string, rows: Record<string, any>, attempt: number) => boolean) => {
    const rows = new Map<string, Record<string, unknown>>();
    const attempts = new Map<string, number>();
    h.respond(async (a) => {
      const d = h.dispatched[h.dispatched.length - 1]!;
      const patch: Record<string, any> = d.patches?.item_rows ?? {};
      const key = `${a}:${JSON.stringify(d.args)}:${JSON.stringify(patch)}`;
      const n = attempts.get(key) ?? 0;
      attempts.set(key, n + 1);
      if (fails(a, patch, n)) throw new Error("Server Error");
      for (const [id, row] of Object.entries(patch)) rows.set(id, { ...rows.get(id), ...row });
      return {};
    });
    return rows;
  };
  const seeded = async (rows: Record<string, Record<string, unknown>>) => {
    const h = makeStore({ retryDelays: [30] });
    for (const [id, row] of Object.entries(rows)) h.wrapped.seed(id, row);
    await waitFor(() => h.outbox.size === 0);
    return h;
  };
  const settle = async (h: ReturnType<typeof makeStore>) => {
    await waitFor(() => h.outbox.size === 0);
    await sleep(60);
  };

  it("undoTo a favorite over a later rename: the rename's undo failing once still lands", async () => {
    const h = await seeded({ [A]: { title: "old" } });
    h.wrapped.toggleFav(A);
    const fav = top().id;
    h.wrapped.rename(A, "new");
    await settle(h);
    const server = rowsServer(h, (a, rows, n) => a === "applyUndoPatches" && rows[A]?.title === "old" && n === 0);
    server.set(A, { title: "new", is_favorite: true });
    expect(undoTo(fav)).toBe(2);
    await settle(h);
    expect(h.state.items[A].title).toBe("old");
    expect(server.get(A)?.title).toBe("old");
  });

  it("undoing a favorite does not drop a rename of the same row still on its first attempt", async () => {
    const h = await seeded({ [A]: { title: "old" } });
    const server = rowsServer(h, (a, _rows, n) => a === "rename" && n === 0);
    server.set(A, { title: "old" });
    h.wrapped.rename(A, "new");
    h.wrapped.toggleFav(A);
    performUndo();
    await settle(h);
    expect(h.state.items[A].title).toBe("new");
    expect(server.get(A)?.title).toBe("new");
    expect(items().find((i) => i.label === "Renamed to new")?.status).toBe("done");
  });

  it("undoing one field of a send that wrote two keeps the other field's undo", async () => {
    const h = await seeded({ [A]: { title: "t0", color: "c0" } });
    h.wrapped.rename(A, "r");
    const renamed = top().id;
    h.wrapped.setTwo(A, "s", "blue");
    await settle(h);
    const server = rowsServer(h, (a, rows, n) => a === "applyUndoPatches" && rows[A]?.color === "c0" && n === 0);
    server.set(A, { title: "s", color: "blue" });
    expect(undoTo(renamed)).toBe(2);
    await settle(h);
    expect(h.state.items[A]).toMatchObject({ title: "t0", color: "c0" });
    expect(server.get(A)).toMatchObject({ title: "t0", color: "c0" });
  });

  it("a step on one row does not drop a pass of the step before it for another row", async () => {
    // Hides both rows again, one restore per row on the way back.
    const extra = {
      hideBoth: action(function (this: any, a: string, b: string) {
        this.items[a].hidden_at = 9;
        this.items[b].hidden_at = 9;
      }),
    };
    const specs: UndoConfig["specs"] = {
      hideBoth: {
        label: () => "Hid two",
        inverse: (ctx) =>
          ctx.changes
            .filter((c) => c.store === "items" && c.field === "hidden_at")
            .map((c) => ({ action: "restore", args: [c.id], runDraft: false })),
      },
    };
    const h = makeStore({ retryDelays: [30], extra, undo: withSpecs(specs) });
    h.wrapped.seed(A, { title: "a", hidden_at: null });
    h.wrapped.seed(B, { title: "b", hidden_at: null });
    h.wrapped.stash(A);
    const stashed = top().id;
    h.wrapped.hideBoth(A, B);
    await settle(h);
    const server = rowsServer(h, (a, rows, n) => a === "restore" && B in rows && n === 0);
    server.set(A, { hidden_at: 9 });
    server.set(B, { hidden_at: 9 });
    expect(undoTo(stashed)).toBe(2);
    await settle(h);
    expect(h.state.items[B].hidden_at).toBeNull();
    expect(server.get(B)?.hidden_at).toBeNull();
    expect(h.state.items[A].hidden_at).toBeNull();
    expect(server.get(A)?.hidden_at).toBeNull();
  });
});

describe("an account boundary", () => {
  it("clearing the store's runtime bindings forgets the history, so nothing replays under the next account", () => {
    const h = makeStore();
    h.setState({ docs: { [A]: { _id: A, title: "Account A secret plan" } } });
    h.wrapped.archiveDoc(A);
    expect(items()).toHaveLength(1);
    h.wrapped._clearRuntimeBindings();
    h.setState({ docs: {} });
    const sent: string[] = [];
    h.wrapped._setDispatch(async (a: string) => {
      sent.push(a);
      return {};
    });
    expect(items()).toEqual([]);
    expect(performUndo()).toBe(false);
    expect(performRedo()).toBe(false);
    expect(h.state.docs[A]).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe("external entries inside a group", () => {
  it("one gesture over several rows the record owns is one history row, named by the group", () => {
    const h = makeStore();
    undoGroup("Skipped a proposal", () => {
      for (let i = 0; i < 3; i++) h.wrapped.orgMove(A);
    });
    expect(items().map((i) => [i.label, i.status])).toEqual([["Skipped a proposal", "external"]]);
  });

  it("a group holding one keeps its own label", () => {
    const h = makeStore();
    undoGroup(() => "unused", () => h.wrapped.orgMove(A));
    expect(items().map((i) => i.label)).toEqual(["Moved in org"]);
  });
});

// A send held behind the sends it follows (an undo replay waiting on an
// earlier one) is still ahead of every later write of the same cell: the
// server must see the user's next edit after it, never before.
describe("a held send orders later writes of its cells", () => {
  // Applies each request's patches when it arrives (one client's mutations
  // run in send order) and answers only once released.
  const arrivalServer = (h: ReturnType<typeof makeStore>) => {
    const rows = new Map<string, Record<string, unknown>>();
    let held = false;
    const gates: Array<() => void> = [];
    h.respond(async () => {
      const d = h.dispatched[h.dispatched.length - 1]!;
      for (const [id, row] of Object.entries<any>(d.patches?.item_rows ?? {}))
        rows.set(id, { ...rows.get(id), ...row });
      if (held) await new Promise<void>((r) => gates.push(r));
      return {};
    });
    return {
      rows,
      hold: () => { held = true; },
      release: () => { held = false; for (const g of gates.splice(0)) g(); },
    };
  };

  it("a forward edit after two undos lands after the held older replay", async () => {
    const h = makeStore();
    const server = arrivalServer(h);
    h.wrapped.seed(A, { title: "a0", color: "c0" });
    await waitFor(() => h.outbox.size === 0);
    h.wrapped.retitle(A, "t1");
    h.wrapped.setTwo(A, "x", "red");
    await waitFor(() => h.outbox.size === 0);
    server.hold();
    performUndo();
    performUndo();
    h.wrapped.retitle(A, "mine");
    for (let i = 0; i < 5; i++) { await sleep(5); server.release(); }
    await waitFor(() => h.outbox.size === 0);
    await sleep(20);
    server.release();
    await waitFor(() => h.outbox.size === 0);
    expect(h.state.items[A].title).toBe("mine");
    expect(server.rows.get(A)?.title).toBe("mine");
  });

  // The class's other holder: a forward write retrying after a transient
  // failure is followed, not overtaken, by a later write of its cell.
  it("a later write waits for an earlier one that is retrying", async () => {
    const h = makeStore({ retryDelays: [30] });
    const rows = new Map<string, unknown>();
    let failNext = false;
    h.respond(async () => {
      const d = h.dispatched[h.dispatched.length - 1]!;
      if (failNext) { failNext = false; throw new Error("Server Error"); }
      for (const [id, row] of Object.entries<any>(d.patches?.item_rows ?? {}))
        if (row?.title !== undefined) rows.set(id, row.title);
      return {};
    });
    h.wrapped.seed(A, { title: "a0" });
    await waitFor(() => h.outbox.size === 0);
    failNext = true;
    h.wrapped.retitle(A, "first");
    await sleep(5);
    h.wrapped.retitle(A, "second");
    await waitFor(() => h.outbox.size === 0);
    await sleep(60);
    expect(h.state.items[A].title).toBe("second");
    expect(rows.get(A)).toBe("second");
  });
});
