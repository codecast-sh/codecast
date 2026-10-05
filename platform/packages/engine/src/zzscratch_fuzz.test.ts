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

// ---------------- scratch fuzz ----------------
const strip = (s: any) => {
  const clean = (v: any): any => {
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      const o: any = {};
      for (const k of Object.keys(v).sort()) {
        if (k === "updated_at") continue;
        if (v[k] === undefined) continue;
        o[k] = clean(v[k]);
      }
      return o;
    }
    return v;
  };
  return JSON.stringify(clean({ items: s.items, marks: s.marks, me: s.me, favorites: s.favorites, notes: s.notes }));
};

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

describe("fuzz linear keyboard", () => {
  for (let seed = 1; seed <= 300; seed++) {
    it(`seed ${seed}`, async () => {
      const h = makeStore();
      const r = rng(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      const ids = [A, B];
      h.wrapped.seed(A, { title: "a0", color: "c0" });
      h.wrapped.seed(B, { title: "b0", color: "c0" });
      _resetUndoStacks();
      const before = new Map<string, string>();
      const after = new Map<string, string>();
      const log: string[] = [];
      for (let step = 0; step < 40; step++) {
        const roll = r();
        const s0 = strip(h.state);
        if (roll < 0.55) {
          const prevTop = getUndoHistory().head;
          const prevLen = getUndoHistory().items.length;
          const live = ids.filter((id) => h.state.items[id]);
          const op = pick(["rename", "setTwo", "drop", "add", "fav", "stash", "mark", "status", "cycle", "both", "group", "note"]);
          let desc = op;
          if (op === "rename" && live.length) { const id = pick(live); const t = pick(["x", "y", "z"]); desc += ` ${id[0]} ${t}`; h.wrapped.rename(id, t); }
          else if (op === "setTwo" && live.length) { const id = pick(live); desc += ` ${id[0]}`; h.wrapped.setTwo(id, pick(["p", "q"]), pick(["red", "blue"])); }
          else if (op === "drop" && live.length) { const id = pick(live); desc += ` ${id[0]}`; h.wrapped.drop(id); }
          else if (op === "add") { const gone = ids.filter((id) => !h.state.items[id]); if (gone.length) { const id = pick(gone); desc += ` ${id[0]}`; h.wrapped.addItem(id); } }
          else if (op === "fav" && live.filter((id) => !!h.state.items[id].is_favorite === h.state.favorites.some((f: any) => f._id === id)).length) { const id = pick(live.filter((id) => !!h.state.items[id].is_favorite === h.state.favorites.some((f: any) => f._id === id))); desc += ` ${id[0]}`; h.wrapped.toggleFav(id); }
          else if (op === "stash" && live.length) { const id = pick(live); desc += ` ${id[0]}`; h.wrapped.stash(id); }
          else if (op === "mark") { const m = pick(["m1", "m2", "m3"]); desc += ` ${m}`; h.wrapped.toggleMark(m); }
          else if (op === "status") { const st = pick(["online", "away", "busy"]); desc += ` ${st}`; h.wrapped.setStatus(st); }
          else if (op === "cycle" && live.length) { const id = pick(live); const p = pick(["lo", "mid", "hi"]); desc += ` ${id[0]} ${p}`; h.wrapped.cycle(id, p); }
          else if (op === "both" && live.length === 2) { const t = pick(["u", "v"]); desc += ` ${t}`; h.wrapped.renameBoth(A, B, t); }
          else if (op === "group" && live.length) {
            const id = pick(live);
            desc += ` ${id[0]}`;
            undoGroup("G", () => { h.wrapped.rename(id, pick(["g1", "g2"])); h.wrapped.setTwo(id, pick(["p", "q"]), pick(["red", "blue"])); });
          }
          else if (op === "note" && live.length) { const id = pick(live); desc += ` ${id[0]}`; h.wrapped.note(id, pick(["n1", "n2"])); }
          else continue;
          const hist = getUndoHistory();
          const head = hist.head;
          if (head) {
            if (!before.has(head)) before.set(head, s0);
            after.set(head, strip(h.state));
          } else if (head === prevTop && hist.items.length < prevLen) {
            // coalesced back to origin: entry removed
          }
          log.push(`${desc} -> head ${head}`);
        } else if (roll < 0.8) {
          const head = getUndoHistory().head;
          if (!head) continue;
          const ok = performUndo();
          const item = getUndoHistory().items.find((i) => i.id === head)!;
          log.push(`undo ${head} ${item.status} notices=${notices.slice(-1)}`);
          if (item.status === "undone") {
            if (strip(h.state) !== before.get(head)) {
              throw new Error(`seed ${seed}: undo mismatch\n${log.join("\n")}\nexp ${before.get(head)}\ngot ${strip(h.state)}`);
            }
          } else {
            throw new Error(`seed ${seed}: undo not undone (${item.status}) ok=${ok}\n${log.join("\n")}\n${notices.join("\n")}`);
          }
        } else {
          const redo = getUndoHistory().redoOrder[0];
          if (!redo) continue;
          performRedo();
          const item = getUndoHistory().items.find((i) => i.id === redo)!;
          log.push(`redo ${redo} ${item.status}`);
          if (item.status !== "done") throw new Error(`seed ${seed}: redo failed ${item.status}\n${log.join("\n")}\n${notices.join("\n")}`);
          if (strip(h.state) !== after.get(redo)) {
            throw new Error(`seed ${seed}: redo mismatch\n${log.join("\n")}\nexp ${after.get(redo)}\ngot ${strip(h.state)}`);
          }
        }
        await sleep(0);
      }
    });
  }
});

describe("fuzz server convergence", () => {
  const N = Number(process.env.FUZZ_N ?? 150);
  for (let seed = 1; seed <= N; seed++) {
    it(`conv seed ${seed}`, async () => {
      const h = makeStore({ retryDelays: [4, 4, 4, 4, 4, 4] });
      const r = rng(seed * 7919);
      const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      h.wrapped.seed(A, { title: "a0", color: "c0", priority: "p0" });
      h.wrapped.seed(B, { title: "b0", color: "c0", priority: "p0" });
      await waitFor(() => h.outbox.size === 0);
      _resetUndoStacks();
      const server = new Map<string, Record<string, unknown>>([
        [A, { title: "a0", color: "c0", priority: "p0" }],
        [B, { title: "b0", color: "c0", priority: "p0" }],
      ]);
      const attempts = new Map<any, number>();
      const log: string[] = [];
      h.respond(async (a) => {
        const d = h.dispatched[h.dispatched.length - 1]!;
        const n = attempts.get(d.args) ?? 0;
        const fail = n < 3 && r() < 0.25;
        const patch: Record<string, any> = d.patches?.item_rows ?? {};
        log.push(`  srv ${a} ${JSON.stringify(patch)} ${fail ? "FAIL" : "ok"}`);
        if (!fail) for (const [id, row] of Object.entries(patch)) server.set(id, { ...server.get(id), ...row });
        await sleep(Math.floor(r() * 6));
        if (fail) { attempts.set(d.args, n + 1); throw new Error("Server Error"); }
        return {};
      });
      for (let step = 0; step < 30; step++) {
        const roll = r();
        if (roll < 0.5) {
          const op = pick(["rename", "setTwo", "cycle", "both", "group", "retitle"]);
          const id = pick([A, B]);
          if (op === "rename") h.wrapped.rename(id, pick(["x", "y", "z"]));
          else if (op === "retitle") h.wrapped.retitle(id, pick(["x", "y", "z"]));
          else if (op === "setTwo") h.wrapped.setTwo(id, pick(["p", "q"]), pick(["red", "blue"]));
          else if (op === "cycle") h.wrapped.cycle(id, pick(["lo", "mid", "hi"]));
          else if (op === "both") h.wrapped.renameBoth(A, B, pick(["u", "v"]));
          else undoGroup("G", () => { h.wrapped.rename(id, pick(["g1", "g2"])); h.wrapped.cycle(id === A ? B : A, pick(["lo", "hi"])); });
          log.push(`${op} ${id[0]} -> ${JSON.stringify(h.state.items[id])}`);
        } else if (roll < 0.65) { performUndo(); log.push(`undo -> ${notices.slice(-1)}`); }
        else if (roll < 0.75) { performRedo(); log.push(`redo -> ${notices.slice(-1)}`); }
        else if (roll < 0.83) { const u = getUndoHistory().undoOrder; if (u.length) { const t = pick([...u]); undoTo(t); log.push(`undoTo -> ${notices.slice(-1)}`); } }
        else if (roll < 0.9) { const u = getUndoHistory().redoOrder; if (u.length) { const t = pick([...u]); redoTo(t); log.push(`redoTo -> ${notices.slice(-1)}`); } }
        else { const u = getUndoHistory().undoOrder; if (u.length) { const t = pick([...u]); undoEntry(t); log.push(`undoEntry -> ${notices.slice(-1)}`); } }
        await sleep(Math.floor(r() * 5));
      }
      await waitFor(() => h.outbox.size === 0, 5000);
      await sleep(80);
      await waitFor(() => h.outbox.size === 0, 5000);
      for (const id of [A, B]) {
        const loc = h.state.items[id];
        const srv = server.get(id)!;
        for (const f of ["title", "color", "priority"]) {
          if (loc[f] !== srv[f]) {
            throw new Error(`seed ${seed}: ${id[0]}.${f} local=${loc[f]} server=${srv[f]}\n${log.join("\n")}`);
          }
        }
      }
    });
  }
});
