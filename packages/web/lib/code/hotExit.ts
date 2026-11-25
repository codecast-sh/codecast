// Hot exit: an unsaved buffer survives a reload, a crash or a closed tab.
//
// Code is saved explicitly (design doc: autosave would hand half-typed code to
// watchers and agents reading the disk), so the editor holds the unsaved text
// somewhere else: IndexedDB, written a second after typing stops and on an
// idle callback, never on the keystroke itself. Each record keeps the text the
// buffer was editing ON TOP OF as well, so a restore after disk moved can
// three-way merge instead of asking which whole file wins.
//
// The base changes only at a save, so it is written once per base version, in
// a table of its own; a typing pause writes the buffer's text and nothing else.
//
// Its own small database rather than a table in the app cache: these rows are
// the person's unsaved work, outliving every cache reset and schema bump.

import Dexie, { type Table } from "dexie";

export interface HotExitRecord {
  key: string;
  vaultId: string;
  path: string;
  /** The buffer's text, as file bytes. */
  mine: string;
  /** Disk's text at `baseEtag`, the version `mine` was written over. */
  base: string;
  baseEtag: string;
  savedAt: number;
}

/** What a pause hands the writer: the base is built only if it is not stored yet. */
export type HotExitDraft = Omit<HotExitRecord, "base"> & { base: () => string };

type MineRow = Omit<HotExitRecord, "base">;
interface BaseRow {
  key: string;
  baseEtag: string;
  base: string;
}

class HotExitDB extends Dexie {
  buffers!: Table<MineRow, string>;
  bases!: Table<BaseRow, string>;
  constructor(deps?: { indexedDB: unknown; IDBKeyRange: unknown }) {
    super("codecast-code-hot-exit", deps as never);
    this.version(1).stores({ buffers: "key, vaultId" });
    this.version(2).stores({ buffers: "key, vaultId", bases: "key" });
  }
}

/** Which base version each key has stored, so a pause skips writing it again. */
const storedBase = new Map<string, string>();

let db: HotExitDB | null = null;
const database = () => (db ??= new HotExitDB());

/** Tests: a fresh database on the given IndexedDB implementation. */
export function _useHotExitDbForTests(deps: { indexedDB: unknown; IDBKeyRange: unknown }): void {
  db?.close();
  db = new HotExitDB(deps);
  storedBase.clear();
}

export async function loadHotExit(key: string): Promise<HotExitRecord | undefined> {
  try {
    const d = database();
    const [mine, base] = await d.transaction("r", d.buffers, d.bases, () =>
      Promise.all([d.buffers.get(key), d.bases.get(key)]),
    );
    if (!mine || base?.baseEtag !== mine.baseEtag) return undefined;
    storedBase.set(key, base.baseEtag);
    return { ...mine, base: base.base };
  } catch {
    return undefined; // private mode or a blocked open: nothing to restore
  }
}

export async function clearHotExit(key: string): Promise<void> {
  cancelPending(key);
  storedBase.delete(key);
  try {
    const d = database();
    await d.transaction("rw", d.buffers, d.bases, () => Promise.all([d.buffers.delete(key), d.bases.delete(key)]));
  } catch {}
}

const DEBOUNCE_MS = 1000;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; build: () => HotExitDraft | null }>();

function cancelPending(key: string): void {
  const p = pending.get(key);
  if (p) clearTimeout(p.timer);
  pending.delete(key);
}

async function write(key: string): Promise<void> {
  const p = pending.get(key);
  pending.delete(key);
  const draft = p?.build();
  if (!draft) return;
  const { base, ...mine } = draft;
  const newBase = storedBase.get(key) !== mine.baseEtag ? base() : null;
  try {
    const d = database();
    // One transaction: a crash never leaves text without the base it sits on.
    await d.transaction("rw", d.buffers, d.bases, async () => {
      await d.buffers.put(mine);
      if (newBase !== null) await d.bases.put({ key, baseEtag: mine.baseEtag, base: newBase });
    });
    if (newBase !== null) storedBase.set(key, mine.baseEtag);
  } catch {}
}

const idle = (fn: () => void) =>
  typeof requestIdleCallback === "function" ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 0);

/**
 * Hold this buffer's text once typing pauses for `delayMs`. `build` runs then,
 * not now, so the keystroke that calls this pays for one timer reset and
 * nothing else. `build` returning null (the buffer went clean) writes nothing.
 */
export function scheduleHotExit(key: string, build: () => HotExitDraft | null, delayMs = DEBOUNCE_MS): void {
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  pending.set(key, { build, timer: setTimeout(() => idle(() => void write(key)), delayMs) });
}

/** Write every pending record now (the page is going away). */
export function flushHotExit(): Promise<void> {
  const keys = [...pending.keys()];
  for (const k of keys) clearTimeout(pending.get(k)!.timer);
  return Promise.all(keys.map(write)).then(() => {});
}
