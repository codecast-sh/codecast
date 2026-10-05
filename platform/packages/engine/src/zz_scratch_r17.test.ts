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

function withSpecs(extra: UndoConfig["specs"]): UndoConfig {
  const calls: Calls = { beforeReplay: [], afterReplay: [], restoreView: [] };
  const base = undoConfig(calls);
  return undoConfig(calls, { specs: { ...base.specs, ...extra } });
}

type Gate = { action: string; args: any; resolve: (v: any) => void; reject: (e: any) => void };

describe("R17 engine", () => {
  it("ignoreFields: an undo overtakes a forward that also wrote an ignored field, and a transient failure drops it", async () => {
    const h = makeStore({ retryDelays: [5] });
    h.setState({ docs: { [A]: { _id: A, title: "t", content: "c" } } });
    const gates: Gate[] = [];
    h.respond(() => new Promise((resolve, reject) => gates.push({ action: "", args: null, resolve, reject })));
    h.wrapped.editDoc(A, { title: "T2", content: "c2" });
    expect(top().changes!.map((c) => c.field)).toEqual(["title"]);
    performUndo();
    await waitFor(() => gates.length >= 2);
    console.log("dispatched", h.dispatched.map((d) => [d.action, JSON.stringify(d.args)]));
    // forward first attempt fails transiently (timeout), undo lands
    gates[1]!.resolve({});
    gates[0]!.reject(new Error("Your request timed out"));
    await sleep(50);
    console.log("dispatched after", h.dispatched.map((d) => [d.action, JSON.stringify(d.args)]));
    console.log("outbox", [...h.outbox.values()].map((e) => e.action));
    console.log("local doc", h.state.docs[A], "pending", JSON.stringify(h.state.pending));
    const editDocSends = h.dispatched.filter((d) => d.action === "editDoc").length;
    expect(editDocSends).toBe(1);
    expect(h.outbox.size).toBe(0);
  });

  it("rekey: a row-add cell whose row names a stub in a field does not follow the rekey", async () => {
    const h = makeStore({
      undo: withSpecs({ link: { label: () => "Linked" } }),
      extra: {
        link: action(function (this: any, id: string, parent: string) {
          this.items[id] = { _id: id, parent_id: parent, title: "child" };
        }),
      },
    });
    h.wrapped.seed("stub-p", { title: "parent" });
    h.wrapped.link(B, "stub-p");
    await waitFor(() => h.outbox.size === 0);
    const engine = createSyncEngine({
      dbName: "t",
      dbVersion: 1,
      registry: REGISTRY,
      syncRegistry: { items: { isDelta: true, altKey: "client_id" } },
      rekeyExtra: (draft: any, o: string, n: string) => {
        for (const r of Object.values(draft.items) as any[]) if (r.parent_id === o) r.parent_id = n;
      },
    } as any);
    const draft: any = {
      items: structuredClone({ ...h.state.items, "stub-p": { ...h.state.items["stub-p"], client_id: "stub-p" } }),
      pending: { ...h.state.pending },
    };
    engine.syncTable(draft, "items", [{ _id: A, client_id: "stub-p", title: "parent" }]);
    h.setState({ items: draft.items, pending: draft.pending });
    expect(h.state.items[B].parent_id).toBe(A);
    performUndo();
    console.log("notices", notices, "B row", h.state.items[B]);
    expect(h.state.items[B]).toBeUndefined();
  });
});

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const FIELDS = ["title", "color", "priority", "hidden_at", "deferred_at"];

async function fuzzOnce(seed: number, opts: { refuse: boolean; steps: number; noUndo?: boolean }) {
  _resetUndoStacks();
  const r = rng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]!;
  const h = makeStore({
    retryDelays: [2, 4],
    undo: withSpecs({ paint: { label: () => "Painted" } }),
    extra: { paint: action(function (this: any, id: string, color: string) { this.items[id].color = color; }) },
  });
  const server: Record<string, Record<string, any>> = {};
  const log: string[] = [];
  let phase: "chaos" | "calm" = "calm";
  h.respond(async () => ({}));
  // Replace dispatch with a server model.
  let chain: Promise<unknown> = Promise.resolve();
  h.wrapped._setDispatch((a: string, args: any, patches: any) => {
    const run = chain.then(() => serve(a, args, patches));
    chain = run.catch(() => {});
    return run;
  });
  const serve = async (a: string, args: any, patches: any) => {
    const roll = r();
    const delay = phase === "chaos" ? Math.floor(r() * 6) : 0;
    await sleep(delay);
    if (phase === "chaos" && roll < 0.2) {
      log.push(`fail-transient ${a} ${JSON.stringify(patches?.item_rows ?? {})}`);
      throw new Error("Your request timed out");
    }
    if (phase === "chaos" && opts.refuse && roll < 0.25) {
      log.push(`refuse ${a} ${JSON.stringify(patches?.item_rows ?? {})}`);
      throw new Error("Uncaught Error: nope");
    }
    for (const [row, fields] of Object.entries((patches?.item_rows ?? {}) as Record<string, any>)) {
      server[row] ??= {};
      for (const [f, v] of Object.entries(fields as Record<string, any>)) {
        if (v === null) delete server[row]![f];
        else server[row]![f] = v;
      }
    }
    log.push(`land ${a} ${JSON.stringify(patches?.item_rows ?? {})}`);
    return {};
  };
  // Seed rows on both sides.
  for (const id of [A, B]) {
    h.wrapped.seed(id, { title: "t0", color: "c0", priority: "p0" });
    server[id] = { _id: id, title: "t0", color: "c0", priority: "p0" };
  }
  await sleep(20);
  phase = "chaos";
  log.length = 0;
  const ops: string[] = [];
  for (let i = 0; i < opts.steps; i++) {
    const k = r();
    const id = pick([A, B]);
    const n = Math.floor(r() * 5);
    if (k < 0.12) { ops.push(`rename ${id.slice(0, 1)} t${n}`); h.wrapped.rename(id, `t${n}`); }
    else if (k < 0.22) { ops.push(`paint ${id.slice(0, 1)} c${n}`); h.wrapped.paint(id, `c${n}`); }
    else if (k < 0.34) { ops.push(`cycle ${id.slice(0, 1)} p${n}`); h.wrapped.cycle(id, `p${n}`); }
    else if (k < 0.40) { ops.push(`stash ${id.slice(0, 1)}`); h.wrapped.stash(id); }
    else if (k < 0.44) { ops.push(`cycle ${id.slice(0, 1)} q${n}`); h.wrapped.cycle(id, `q${n}`); }
    else if (k < 0.48) {
      ops.push(`group`);
      undoGroup("grp", () => { h.wrapped.rename(A, `g${n}`); h.wrapped.paint(B, `gc${n}`); });
    }
    else if (opts.noUndo) { ops.push(`rename ${id.slice(0, 1)} u${n}`); h.wrapped.rename(id, `u${n}`); }
    else if (k < 0.68) { ops.push("undo"); performUndo(); }
    else if (k < 0.84) { ops.push("redo"); performRedo(); }
    else if (k < 0.90) {
      const s = getUndoHistory();
      if (s.undoOrder.length) { const t = pick([...s.undoOrder]); ops.push(`undoTo ${s.undoOrder.indexOf(t)}`); undoTo(t); }
    } else if (k < 0.95) {
      const s = getUndoHistory();
      if (s.redoOrder.length) { const t = pick([...s.redoOrder]); ops.push(`redoTo ${s.redoOrder.indexOf(t)}`); redoTo(t); }
    } else {
      const s = getUndoHistory();
      if (s.undoOrder.length) { const t = pick([...s.undoOrder]); ops.push(`undoEntry ${s.undoOrder.indexOf(t)}`); undoEntry(t); }
    }
    if (r() < 0.5) await sleep(Math.floor(r() * 8));
    if (!h.state.items[A] || !h.state.items[B]) {
      return { diffs: ["ROW GONE"], ops, log, outbox: h.outbox.size, notices: [...notices], pending: JSON.stringify(h.state.pending), items: JSON.stringify(h.state.items), hist: JSON.stringify(getUndoHistory().items.map((i) => [i.label, i.status, i.changes?.map((c) => [c.id.slice(0,1), c.field, c.hadBefore, c.hadAfter])])) } as any;
    }
  }
  // Let chaos sends finish (retries), then calm and drain.
  await sleep(120);
  phase = "calm";
  for (let i = 0; i < 20 && h.outbox.size > 0; i++) {
    h.wrapped._drainOutbox();
    await sleep(20);
  }
  await sleep(30);
  const diffs: string[] = [];
  for (const id of [A, B]) {
    for (const f of FIELDS) {
      const l = h.state.items[id]?.[f];
      const s = server[id]?.[f];
      if ((l ?? null) !== (s ?? null)) diffs.push(`${id.slice(0, 1)}.${f}: local=${l} server=${s}`);
    }
  }
  return { diffs, ops, log, outbox: h.outbox.size, notices: [...notices] };
}

describe("R17 fuzz", () => {
  it("control: forward only", async () => {
    let bad = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const res = await fuzzOnce(seed, { refuse: false, steps: 14, noUndo: true });
      if (res.diffs.length || res.outbox) bad++;
    }
    console.log("control bad", bad);
  }, 600000);
  it("local converges to the server after quiescence (transient failures only)", async () => {
    const bad: any[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      notices = [];
      const res = await fuzzOnce(seed, { refuse: false, steps: 14 });
      if (res.diffs.length || res.outbox) bad.push({ seed, ...res });
    }
    console.log("bad seeds", bad.length, bad.map((b) => b.seed).join(","));
    require("fs").writeFileSync("/tmp/r17_bad.json", JSON.stringify(bad, null, 1));
    expect(bad.length).toBe(0);
  }, 600000);
});
describe("R17 fuzz refusals", () => {
  it("converges with permanent refusals", async () => {
    const bad: any[] = [];
    let ctl = 0;
    for (let seed = 1; seed <= 200; seed++) {
      if (process.env.ONLY && String(seed) !== process.env.ONLY) continue;
      const c = await fuzzOnce(seed, { refuse: true, steps: 14, noUndo: true });
      if (c.diffs.length || c.outbox) ctl++;
      notices = [];
      const res = await fuzzOnce(seed, { refuse: true, steps: 14 });
      if (res.diffs.length || res.outbox) bad.push({ seed, ...res });
    }
    console.log("refusal control bad", ctl, "bad seeds", bad.length, bad.map((b) => b.seed).join(","));
    require("fs").writeFileSync("/tmp/r17_bad_refuse.json", JSON.stringify(bad, null, 1));
  }, 900000);
});
