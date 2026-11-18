/**
 * Data sync: keeps the folders a person's repos declare ([host] data in
 * .codecast/workspace.toml) the same on every machine they use, through the
 * index in convex/dataSync.ts.
 *
 * One pass, under a lock: read every change other machines committed since the
 * last pass and apply it, then send what changed here. The state file holds,
 * per file, the version this machine and the index last agreed on (the base).
 * A file that changed on one side only takes that side's version. A file that
 * changed on both takes the newer write, and the other version is kept in
 * ~/.codecast/data-sync/conflicts, never lost. A file being written right now
 * (modified in the last two seconds, or a `*.tmp`) waits for the next pass.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_SYNC_MAX_FILE_BYTES, DATA_SYNC_PAGE, dataRelProblem } from "@codecast/shared/contracts/dataSync";

export interface RemoteRow {
  folder: string;
  rel: string;
  sha256: string;
  size: number;
  mtime: number;
  deleted: boolean;
  seq: number;
  device_id: string | null;
  url: string | null;
}

export interface CommitChange {
  folder: string;
  rel: string;
  sha256: string;
  size: number;
  mtime: number;
  deleted: boolean;
  storage_id?: string;
}

/** What the engine needs from the server; convexApi.ts is the real one, tests pass an in-memory one. */
export interface DataSyncApi {
  declareFolders(folders: Array<{ path: string; declared_by?: string }>): Promise<void>;
  folders(): Promise<Array<{ path: string; declared_by: string | null; bytes: number; files: number }>>;
  changes(since: number): Promise<{ rows: RemoteRow[]; more: boolean }>;
  knownContents(shas: string[]): Promise<string[]>;
  upload(bytes: Buffer): Promise<string>;
  commit(changes: CommitChange[]): Promise<{ seqs: number[] }>;
  download(url: string): Promise<Buffer>;
}

/** A file as this machine last agreed on it with the index: its content and the stats that prove it has not changed since. */
interface BaseEntry { sha: string; size: number; mtimeMs: number; ctimeMs?: number; ino?: number }
interface SyncState { cursor: number; folders: Record<string, { files: Record<string, BaseEntry> }> }

export interface SyncOptions {
  home: string;
  /** Where the state, the lock and kept conflicts live (~/.codecast/data-sync). */
  stateDir: string;
  api: DataSyncApi;
  now?: () => number;
  log?: (line: string) => void;
}

export interface SyncReport {
  folders: string[];
  pulled: number;
  pushed: number;
  deletedHere: number;
  conflicts: string[];
  skipped: string[];
}

/** A write younger than this may still be in progress. */
const SETTLE_MS = 2_000;
const IN_FLIGHT = /(?:\.tmp|\.partial|~)$/;

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** Transfers in flight at once. */
const PARALLEL = 8;

/** Runs `fn` over `items`, at most `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

function readState(file: string): SyncState {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8")) as SyncState;
    if (typeof s.cursor === "number" && s.folders) return s;
  } catch { /* a first pass, or a damaged file: start over, which only re-reads */ }
  return { cursor: 0, folders: {} };
}

function writeState(file: string, state: SyncState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

/** This machine's copy of one file now: null when it is absent. */
function localFile(abs: string, base: BaseEntry | undefined): BaseEntry | null {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (!st.isFile()) return null;
  const stats = { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino };
  // Unchanged stats mean unchanged bytes, so the base's sha stands without a read. Size and mtime
  // alone miss a same-size edit within the same millisecond; any write or rename moves ctime or the inode.
  if (base && base.size === st.size && base.mtimeMs === st.mtimeMs && base.ctimeMs === st.ctimeMs && base.ino === st.ino) return { ...base };
  return { sha: sha256(fs.readFileSync(abs)), ...stats };
}

/** The stats of a file this pass just wrote, as its base. */
function statsOf(abs: string): Omit<BaseEntry, "sha"> {
  const st = fs.statSync(abs);
  return { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino };
}

/** Every regular file under `root`, by its path inside it. Links are not followed: what syncs is the folder's own files. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, prefix: string) => {
    let names: fs.Dirent[];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (d.name === ".git" || d.name === ".DS_Store") continue;
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (d.isDirectory()) visit(path.join(dir, d.name), rel);
      else if (d.isFile()) out.push(rel);
    }
  };
  visit(root, "");
  return out.sort();
}

/** Removes the folders a deletion emptied, up to (not including) the synced folder itself. */
function removeEmptyParents(dir: string, root: string): void {
  for (let d = dir; d.startsWith(`${root}/`); d = path.dirname(d)) {
    try { fs.rmdirSync(d); } catch { return; }
  }
}

function writeAtomic(abs: string, bytes: Buffer, mtime: number): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.cast-data-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, bytes, { mode: 0o644 });
    fs.utimesSync(tmp, new Date(mtime), new Date(mtime));
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    // A folder a tool made read-only (a captured snapshot) still takes the version another machine wrote.
    if ((err as NodeJS.ErrnoException).code !== "EACCES") throw err;
    fs.chmodSync(path.dirname(abs), 0o755);
    writeAtomic(abs, bytes, mtime);
  }
}

export async function syncOnce(o: SyncOptions): Promise<SyncReport> {
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const stateFile = path.join(o.stateDir, "state.json");
  const state = readState(stateFile);
  const report: SyncReport = { folders: [], pulled: 0, pushed: 0, deletedHere: 0, conflicts: [], skipped: [] };
  const folders = (await o.api.folders()).map((f) => f.path);
  report.folders = folders;
  const declared = new Set(folders);
  const filesOf = (folder: string) => (state.folders[folder] ??= { files: {} }).files;
  const abs = (folder: string, rel: string) => path.join(o.home, folder, rel);

  const keepAside = (folder: string, rel: string, bytes: Buffer, from: string) => {
    const dest = path.join(o.stateDir, "conflicts", folder, `${rel}.${from}.${new Date(now()).toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
    report.conflicts.push(`${folder}/${rel}`);
    log(`both machines changed ${folder}/${rel}; the older copy is in ${dest}`);
  };
  const fetchVerified = async (row: RemoteRow): Promise<Buffer> => {
    if (!row.url) throw new Error(`${row.folder}/${row.rel} has no stored content`);
    const bytes = await o.api.download(row.url);
    if (sha256(bytes) !== row.sha256) throw new Error(`${row.folder}/${row.rel}: downloaded bytes do not match sha256 ${row.sha256.slice(0, 12)}`);
    return bytes;
  };

  // 1. What other machines wrote.
  for (;;) {
    const page = await o.api.changes(state.cursor);
    // The index keeps one row per file, so the rows of a page touch distinct files and can be applied side by side.
    await pool(page.rows.filter((row) => declared.has(row.folder) && !dataRelProblem(row.rel)), PARALLEL, async (row) => {
      {
        const files = filesOf(row.folder);
        const base = files[row.rel];
        const target = abs(row.folder, row.rel);
        const local = localFile(target, base);
        const agreed = row.deleted ? local === null : local?.sha === row.sha256;
        // The row changed the file only if it differs from the version both sides last agreed on;
        // otherwise it is this machine's own commit coming back, and a local edit since goes out below.
        const remoteChanged = row.deleted ? base !== undefined : row.sha256 !== base?.sha;
        if (agreed) {
          if (row.deleted) delete files[row.rel];
          else files[row.rel] = local!;
        } else if (remoteChanged) {
          const changedHere = base ? local === null || local.sha !== base.sha : local !== null;
          const remoteWins = !changedHere || row.mtime >= (local?.mtimeMs ?? 0);
          if (remoteWins) {
            if (changedHere && local) keepAside(row.folder, row.rel, fs.readFileSync(target), "this-machine");
            if (row.deleted) {
              fs.rmSync(target, { force: true });
              removeEmptyParents(path.dirname(target), path.join(o.home, row.folder));
              delete files[row.rel];
              report.deletedHere++;
            } else {
              const bytes = await fetchVerified(row);
              writeAtomic(target, bytes, row.mtime);
              files[row.rel] = { sha: row.sha256, ...statsOf(target) };
              report.pulled++;
            }
          } else if (!row.deleted) {
            // This machine's newer write stands and goes out below; the other version is kept.
            keepAside(row.folder, row.rel, await fetchVerified(row), row.device_id ?? "other-machine");
          }
        }
      }
    });
    for (const row of page.rows) state.cursor = Math.max(state.cursor, row.seq);
    writeState(stateFile, state);
    if (!page.more) break;
  }

  // 2. What this machine wrote.
  const pending: Array<CommitChange & { bytes?: Buffer; base?: BaseEntry }> = [];
  for (const folder of folders) {
    const files = filesOf(folder);
    const root = path.join(o.home, folder);
    const present = new Set<string>();
    for (const rel of walk(root)) {
      present.add(rel);
      if (IN_FLIGHT.test(rel) || dataRelProblem(rel)) continue;
      const st = fs.lstatSync(path.join(root, rel));
      if (now() - st.mtimeMs < SETTLE_MS) continue;
      if (st.size > DATA_SYNC_MAX_FILE_BYTES) { report.skipped.push(`${folder}/${rel} (over ${DATA_SYNC_MAX_FILE_BYTES / 2 ** 20} MiB)`); continue; }
      const base = files[rel];
      const local = localFile(path.join(root, rel), base);
      if (!local || local.sha === base?.sha) {
        if (local && base) files[rel] = local;
        continue;
      }
      // The bytes sent are the bytes hashed: a write between two reads would otherwise claim a sha the upload does not have.
      const bytes = fs.readFileSync(path.join(root, rel));
      const sent = { ...local, sha: sha256(bytes), size: bytes.length };
      pending.push({ folder, rel, sha256: sent.sha, size: sent.size, mtime: Math.round(local.mtimeMs), deleted: false, bytes, base: sent });
    }
    for (const rel of Object.keys(files)) {
      if (!present.has(rel)) pending.push({ folder, rel, sha256: files[rel]!.sha, size: 0, mtime: now(), deleted: true });
    }
  }
  for (let i = 0; i < pending.length; i += DATA_SYNC_PAGE) {
    const batch = pending.slice(i, i + DATA_SYNC_PAGE);
    const known = new Set(await o.api.knownContents(batch.filter((c) => !c.deleted).map((c) => c.sha256)));
    const uploaded = new Map<string, string>();
    const toSend = [...new Map(batch.filter((c) => !c.deleted && !known.has(c.sha256)).map((c) => [c.sha256, c] as const)).values()];
    await pool(toSend, PARALLEL, async (c) => { uploaded.set(c.sha256, await o.api.upload(c.bytes!)); });
    await o.api.commit(batch.map(({ bytes: _b, base: _base, ...c }) => ({ ...c, ...(uploaded.has(c.sha256) && !c.deleted ? { storage_id: uploaded.get(c.sha256) } : {}) })));
    for (const c of batch) {
      const files = filesOf(c.folder);
      if (c.deleted) delete files[c.rel];
      else files[c.rel] = c.base!;
      report.pushed++;
    }
    writeState(stateFile, state);
  }
  writeState(stateFile, state);
  return report;
}
