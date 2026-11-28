// Vim's mapping timeout, which codemirror-vim lacks.
//
// The engine runs a key the moment it fully matches a command, so with
// `let mapleader = " "` the Space motion fires before `<Space>w` can, and
// `ys`, `cs`, `ds` never get past the `y`, `c`, `d` operators. Vim instead
// holds a key that starts a longer mapping until the mapping completes, a
// non-matching key arrives, or 'timeoutlen' passes. This layer wraps
// Vim.handleKey to do the same for every map installed through it, then
// hands the engine the whole left side as one key, which its matcher takes
// as an exact match (it joins its key buffer into one string).
//
// It also lends plugins the next keypresses (surround's target character).

import { Vim } from "@replit/codemirror-vim";
import { splitEngineKeys } from "./keys";
import { asVimCM, type VimCM, type VimState } from "./engine";
import type { VimMapContext } from "./types";

type CM = VimCM;

export interface LayerMap {
  lhs: string;
  /** The left side as engine keys: `<C-p>` is one key, never `<` and more. */
  keys: string[];
  context: VimMapContext;
  nowait: boolean;
}

/** A plugin reading keys: return true when it has what it needs. */
export type KeyReader = { key(key: string): boolean; cancel?(): void };

interface Pending {
  keys: string[];
  timer: ReturnType<typeof setTimeout> | null;
  reader: KeyReader | null;
}

const maps: LayerMap[] = [];
/** Told when held keys run or drop without a keypress (the timeout). */
const heldListeners = new Set<(cm: CM) => void>();

/** Hear held keys settle off a keypress. Returns the unsubscribe. */
export function onHeldKeysSettled(cb: (cm: CM) => void): () => void {
  heldListeners.add(cb);
  return () => heldListeners.delete(cb);
}

const settled = (cm: CM) => heldListeners.forEach((cb) => cb(cm));
const pending = new WeakMap<object, Pending>();
let timeoutMs: number | null = 1000;

/** 'timeoutlen', or null for 'notimeout' (wait until the next key). */
export function setMapTimeout(ms: number | null): void {
  timeoutMs = ms;
}

export function getMapTimeout(): number | null {
  return timeoutMs;
}

export function addMap(lhs: string, rhs: string, context: VimMapContext, opts: { noremap?: boolean; nowait?: boolean } = {}): LayerMap {
  const ctx = context as string;
  if (opts.noremap) Vim.noremap(lhs, rhs, ctx);
  else Vim.map(lhs, rhs, ctx);
  const entry: LayerMap = { lhs, keys: splitEngineKeys(lhs), context, nowait: !!opts.nowait };
  maps.push(entry);
  return entry;
}

export function removeMap(entry: LayerMap): void {
  const i = maps.lastIndexOf(entry);
  if (i < 0) return;
  maps.splice(i, 1);
  // The engine removes the newest match, which is ours as long as maps come
  // off in reverse order of going on.
  Vim.unmap(entry.lhs, entry.context as string);
}

export function readKeys(cm: CM, reader: KeyReader): void {
  stateOf(cm).reader = reader;
}

function stateOf(cm: CM): Pending {
  let st = pending.get(cm);
  if (!st) {
    st = { keys: [], timer: null, reader: null };
    pending.set(cm, st);
  }
  return st;
}

function contextOf(vim: VimState): VimMapContext {
  if (vim.insertMode) return "insert";
  if (vim.inputState?.operator) return "operatorPending";
  return vim.visualMode ? "visual" : "normal";
}

const applies = (m: LayerMap, ctx: VimMapContext) => m.context === ctx || (m.context === undefined && ctx !== "insert");

function lookup(seq: string[], ctx: VimMapContext): { exact?: LayerMap; longer: boolean } {
  let exact: LayerMap | undefined;
  let longer = false;
  for (let i = maps.length - 1; i >= 0; i--) {
    const m = maps[i];
    if (!applies(m, ctx) || m.keys.length < seq.length || !seq.every((k, j) => m.keys[j] === k)) continue;
    if (m.keys.length === seq.length) exact ??= m;
    else longer = true;
  }
  return { exact, longer };
}

/** Keys that always take one more (`<C-w>`): held until it comes, then
 *  handed to the engine together as one key. The engine alone would run the
 *  first as a whole command and the second as another. */
const prefixKeys = new Set<string>();

export function holdPrefixKey(key: string): void {
  prefixKeys.add(key);
}

let original: typeof Vim.handleKey | null = null;

function engine(cm: CM, key: string, origin: string): boolean | undefined {
  return original!.call(Vim, cm, key, origin);
}

/** Run held keys: the longest prefix that is a mapping, then the rest again. */
function flush(cm: CM, keys: string[], origin: string): void {
  if (keys.length === 0) return;
  const vim = cm.state.vim;
  // The editor went away (closed, or its state swapped) while keys were held.
  if (!vim || !cm.cm6?.dom.isConnected) return;
  const ctx = contextOf(vim);
  let take = 1;
  for (let n = keys.length; n > 1; n--) {
    if (lookup(keys.slice(0, n), ctx).exact) {
      take = n;
      break;
    }
  }
  engine(cm, keys.slice(0, take).join(""), origin);
  for (const k of keys.slice(take)) handle(cm, k, origin);
}

function handle(cm: CM, key: string, origin: string): boolean | undefined {
  const st = stateOf(cm);
  if (st.reader) {
    const reader = st.reader;
    if (key === "<Esc>" || key === "<C-c>") {
      st.reader = null;
      reader.cancel?.();
    } else if (reader.key(key)) {
      if (st.reader === reader) st.reader = null;
    }
    return true;
  }

  const vim = cm.state.vim;
  const idle = !st.keys.length;
  // Maps start a command: not inside insert mode (the engine handles insert
  // maps with its own timeout) and not in the middle of `g`, `"a`, `f`...
  if (idle && (!vim || vim.insertMode || (vim.inputState?.keyBuffer ?? []).some((k) => !/^\d$/.test(k)))) {
    return engine(cm, key, origin);
  }
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;

  if (key === "<Esc>" && !idle) {
    st.keys = [];
    return engine(cm, key, origin);
  }

  const seq = [...st.keys, key];
  const ctx = contextOf(vim!);
  const { exact, longer } = lookup(seq, ctx);
  const prefixed = ctx === "normal" && prefixKeys.has(seq[0]);
  if ((longer || (prefixed && seq.length === 1)) && !exact?.nowait) {
    st.keys = seq;
    // A prefix waits for its key however long it takes, as vim's <C-w> does.
    if (timeoutMs !== null && !(prefixed && seq.length === 1)) {
      st.timer = setTimeout(() => {
        st.timer = null;
        const held = st.keys;
        st.keys = [];
        flush(cm, held, origin);
        settled(cm);
      }, timeoutMs);
    }
    return true;
  }
  st.keys = [];
  if (exact || seq.length === 1 || (prefixed && seq.length === 2)) return engine(cm, seq.join(""), origin);
  flush(cm, seq, origin);
  return true;
}

/** Wrap Vim.handleKey once. Keys a map or a macro replays go straight to the
 *  engine: they are already resolved. */
export function installKeyLayer(): void {
  if (original) return;
  original = Vim.handleKey;
  Vim.handleKey = function (cm, key, origin) {
    if (origin === "mapping" || origin === "macro") return engine(asVimCM(cm), key, origin);
    return handle(asVimCM(cm), key, origin ?? "user");
  };
}

/** Run whatever keys are held now, as if 'timeoutlen' passed. */
export function flushPendingKeys(cm: CM): void {
  const st = stateOf(cm);
  if (st.timer) clearTimeout(st.timer);
  st.timer = null;
  const held = st.keys;
  st.keys = [];
  flush(cm, held, "user");
  settled(cm);
}

/** Forget held keys and a plugin's key reader, for an editor going away. */
export function dropPendingKeys(cm: CM): void {
  const st = pending.get(cm);
  if (!st) return;
  if (st.timer) clearTimeout(st.timer);
  pending.delete(cm);
}

export function hasPendingKeys(cm: CM): boolean {
  return stateOf(cm).keys.length > 0;
}
