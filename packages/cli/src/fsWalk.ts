import * as fs from "fs";
import * as path from "path";

export interface WalkFile {
  path: string;
  /** Path relative to the walk root. */
  rel: string;
  /** Segments in `rel`: a file directly under the root has depth 1. */
  depth: number;
  stat: fs.Stats;
}

export interface WalkOptions {
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
  const walkDir = async (dir: string, dirDepth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // vanished or unreadable: nothing under it to report
    }
    const { depth, files, subdirs } = splitDir(root, dir, dirDepth, entries, opts);
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
  walkDir(root, 0);
}

/**
 * walkDirs plus a stat per file, batched, handed to `onFile` with the result.
 */
export async function walkFiles(
  root: string,
  opts: WalkOptions,
  onFile: (file: WalkFile) => void,
): Promise<void> {
  await walkDirs(root, opts, async (files) => {
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      await Promise.all(files.slice(i, i + STAT_BATCH).map(async (f) => {
        try {
          const stat = await fs.promises.stat(f.path);
          onFile({ path: f.path, rel: f.rel, depth: f.depth, stat });
        } catch {
          // deleted between readdir and stat
        }
      }));
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
