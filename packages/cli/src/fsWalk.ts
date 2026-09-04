import * as fs from "fs";
import * as path from "path";
import { timeSyncFs } from "./slowSync.js";
import { scanPredicates } from "./workers/scanPolicy.js";
import { scanWorkerHost } from "./workers/bridge.js";
import { visitScan, scanCanFallback, ScanCancelled, yieldScanBatch } from "./workers/scanClient.js";
import type { ScanPolicy, ScanFile } from "./workers/scanTypes.js";

/**
 * A dirFilter from one rule per depth: rule[0] judges a top level dir by its
 * name, rule[1] a dir one level down, and so on; a dir deeper than the last
 * rule is refused. Each rule sees the segment it judges and the whole split
 * path, so a rule may look at the ancestors.
 */
export function dirFilterByDepth(...rules: Array<(seg: string, parts: string[]) => boolean>): (relativeDirPath: string) => boolean {
  return (relativeDirPath) => {
    const parts = relativeDirPath.split(path.sep);
    const rule = rules[parts.length - 1];
    return rule ? rule(parts[parts.length - 1], parts) : false;
  };
}

export interface WalkFile {
  cwd?: string | null;
  path: string;
  /** Path relative to the walk root. */
  rel: string;
  /** Segments in `rel`: a file directly under the root has depth 1. */
  depth: number;
  stat: Pick<fs.Stats, "mtimeMs" | "size" | "isFile">;
}

export interface WalkOptions {
  policy?: ScanPolicy;
  signal?: AbortSignal;
  excludeCodexAppServer?: boolean;
  observeCwd?: boolean;
  requireComplete?: boolean;
  /** Deepest file depth to report. A directory is entered only while a file one
   *  level deeper would still qualify. Default: unbounded. */
  maxDepth?: number;
  /** Whether to enter a directory, by its path relative to the root. Default:
   *  every directory. */
  dirFilter?: (rel: string) => boolean;
  /** Whether a file is worth a stat, by its path relative to the root. Default:
   *  every file. */
  fileFilter?: (rel: string) => boolean;
}

// How many stats / subdirectory reads are in flight at once. The libuv pool
// serves them; larger batches only queue there, smaller ones serialize the
// walk behind each syscall's latency.
const STAT_BATCH = 32;
const DIR_BATCH = 8;

/** A file the enumeration found, before any stat. */
export interface WalkEntry {
  path: string;
  rel: string;
  depth: number;
  name: string;
}

export async function walkEntryBatches(root: string, opts: WalkOptions, onBatch: (files: WalkEntry[]) => void | Promise<void>): Promise<void> {
  const apply = async (files: WalkEntry[]) => {
    for (let i = 0; i < files.length; i += 128) {
      if (opts.signal?.aborted) throw new ScanCancelled("walk stopped");
      await onBatch(files.slice(i, i + 128));
      await yieldScanBatch();
    }
  };
  if (!opts.policy || !scanWorkerHost()) return walkDirs(root, opts, apply);
  const seen = new Set<string>();
  try {
    await visitScan({ name: "walk", root, policy: opts.policy, ...(Number.isFinite(opts.maxDepth) ? { maxDepth: opts.maxDepth } : {}), stats: false, ...(opts.requireComplete ? { requireComplete: true } : {}) }, async rows => {
      const files = rows.filter((r): r is ScanFile => r.type === "file");
      for (const f of files) seen.add(f.path);
      await onBatch(files);
    }, opts.signal);
  } catch (error) {
    if (!scanCanFallback(error)) throw error;
    await walkDirs(root, opts, files => apply(files.filter(f => !seen.has(f.path))));
  }
}

function splitDir(root: string, dir: string, dirDepth: number, entries: fs.Dirent[], opts: WalkOptions) {
  const maxDepth = opts.maxDepth ?? Infinity;
  const dirFilter = opts.dirFilter ?? (() => true);
  const fileFilter = opts.fileFilter ?? (() => true);
  const depth = dirDepth + 1;
  const files: WalkEntry[] = [];
  const subdirs: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (entry.isDirectory()) {
      if (depth < maxDepth && dirFilter(rel)) subdirs.push(full);
    } else if (entry.isFile() && depth <= maxDepth && fileFilter(rel)) {
      files.push({ path: full, rel, depth, name: entry.name });
    }
  }
  return { depth, files, subdirs };
}

/**
 * Enumerate `root` through fs.promises: one `onDir` call per directory with
 * the files it holds (readdir only, no stats). The daemon's transcript tree
 * holds tens of thousands of files, and the synchronous walkers this replaces
 * pinned the event loop for as long as the disk took to answer: 36ms when
 * idle, 42s when a build was contending for it (LOOP-FREEZE 2026-09-02),
 * during which no message was delivered or echoed. Here the loop only ever
 * runs the few microseconds between one readdir result and the next request.
 *
 * Depth semantics match RecursiveWatcher: `depth` counts path segments under
 * the root, a directory at depth D is entered while D < maxDepth, and a file
 * is reported while its depth <= maxDepth. A directory's own files are handed
 * over before its subdirectories are entered.
 */
export async function walkDirs(
  root: string,
  opts: WalkOptions,
  onDir: (files: WalkEntry[]) => void | Promise<void>,
): Promise<void> {
  if (opts.policy) {
    const predicates = scanPredicates(root, opts.policy);
    opts = {...opts, dirFilter: opts.dirFilter ?? predicates.dirFilter, fileFilter: opts.fileFilter ?? predicates.fileFilter};
  }
  const walkDir = async (dir: string, dirDepth: number): Promise<void> => {
    if (opts.signal?.aborted) throw new ScanCancelled("walk stopped");
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (opts.requireComplete && !["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      return; // vanished or unreadable: nothing under it to report
    }
    const { depth, files, subdirs } = splitDir(root, dir, dirDepth, entries, opts);
    if (opts.signal?.aborted) throw new ScanCancelled("walk stopped");
    await onDir(files);
    for (let i = 0; i < subdirs.length; i += DIR_BATCH) {
      await Promise.all(subdirs.slice(i, i + DIR_BATCH).map((sub) => walkDir(sub, depth)));
    }
  };
  await walkDir(root, 0);
}

/** The synchronous twin of walkDirs, for the few callers that must answer in
 *  the same tick (a cold cache on a lookup that cannot await). readdir only:
 *  ~4ms warm over the whole transcript tree. Never stat in its callback. */
export function walkDirsSync(root: string, opts: WalkOptions, onDir: (files: WalkEntry[]) => void): void {
  const walkDir = (dir: string, dirDepth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const { depth, files, subdirs } = splitDir(root, dir, dirDepth, entries, opts);
    onDir(files);
    for (const sub of subdirs) walkDir(sub, depth);
  };
  // Every remaining synchronous tree walk comes through here, so this one
  // timer names all of them when the disk is slow.
  timeSyncFs("walkDirsSync", root, () => walkDir(root, 0));
}

/**
 * walkDirs plus a stat per file, batched, handed to `onFile` with the result.
 */
export async function walkFiles(
  root: string,
  opts: WalkOptions,
  onFile: (file: WalkFile) => void,
): Promise<void> {
  if (opts.policy && scanWorkerHost()) {
    const seen = new Map<string, string>();
    try {
      await visitScan({ name: "walk", root, policy: opts.policy, ...(Number.isFinite(opts.maxDepth) ? { maxDepth: opts.maxDepth } : {}), stats: true, ...(opts.requireComplete ? { requireComplete: true } : {}), ...(opts.observeCwd ? { observeCwd: true } : {}), ...(opts.excludeCodexAppServer ? { excludeCodexAppServer: true } : {}) }, rows => {
        for (const r of rows) {
          if (r.type !== "file" || r.mtimeMs === undefined || r.size === undefined) throw new Error("invalid file observation");
          seen.set(r.path, `${r.mtimeMs}:${r.size}`);
          onFile({ path: r.path, rel: r.rel, depth: r.depth, ...(r.cwd !== undefined ? { cwd: r.cwd } : {}), stat: { mtimeMs: r.mtimeMs, size: r.size, isFile: () => true } });
        }
      }, opts.signal);
      return;
    } catch (error) {
      if (!scanCanFallback(error)) throw error;
      const predicates = scanPredicates(root, opts.policy);
      return walkFiles(root, { ...opts, dirFilter: opts.dirFilter ?? predicates.dirFilter, fileFilter: opts.fileFilter ?? predicates.fileFilter, policy: undefined }, f => {
        if (seen.get(f.path) !== `${f.stat.mtimeMs}:${f.stat.size}`) onFile(f);
      });
    }
  }
  await walkDirs(root, opts, async (files) => {
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      await Promise.all(files.slice(i, i + STAT_BATCH).map(async (f) => {
        try {
          const stat = await fs.promises.stat(f.path);
          if (opts.signal?.aborted) return;
          if (opts.excludeCodexAppServer) {
            const { isAppServerManagedCodexSessionHead } = await import("./codexWatcher.js");
            const handle = await fs.promises.open(f.path, "r");
            let excluded: boolean;
            try { const b = Buffer.alloc(2048); const r = await handle.read(b, 0, b.length, 0); excluded = isAppServerManagedCodexSessionHead(b.subarray(0, r.bytesRead).toString("utf8")); }
            finally { await handle.close(); }
            if (excluded) return;
          }
          const cwd = opts.observeCwd ? await (await import("./workers/transcriptObservation.js")).readTranscriptCwdAsync(f.path) : undefined;
          if (opts.signal?.aborted) return;
          onFile({ path: f.path, rel: f.rel, depth: f.depth, stat, ...(cwd !== undefined ? { cwd } : {}) });
        } catch {
          // deleted between readdir and stat
        }
      }));
      await yieldScanBatch();
    }
  });
}

/** Every matching file under `root`, newest first. */
export async function listFilesByMtime(root: string, opts: WalkOptions = {}): Promise<WalkFile[]> {
  const files: WalkFile[] = [];
  await walkFiles(root, opts, (f) => files.push(f));
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return files;
}
