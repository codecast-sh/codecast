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

/**
 * Walk `root` through fs.promises and hand every matching file, with its stat,
 * to `onFile`. The daemon's transcript tree holds tens of thousands of files,
 * and the synchronous walkers this replaces pinned the event loop for as long
 * as the disk took to answer: 36ms when idle, 42s when a build was contending
 * for it (LOOP-FREEZE 2026-09-02), during which no message was delivered or
 * echoed. Here the loop only ever runs the few microseconds between one
 * readdir or stat result and the next request.
 *
 * Depth semantics match RecursiveWatcher: `depth` counts path segments under
 * the root, a directory at depth D is entered while D < maxDepth, and a file
 * is reported while its depth <= maxDepth.
 */
export async function walkFiles(
  root: string,
  opts: WalkOptions,
  onFile: (file: WalkFile) => void,
): Promise<void> {
  const maxDepth = opts.maxDepth ?? Infinity;
  const dirFilter = opts.dirFilter ?? (() => true);
  const fileFilter = opts.fileFilter ?? (() => true);

  const walkDir = async (dir: string, dirDepth: number): Promise<void> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // vanished or unreadable: nothing under it to report
    }
    const depth = dirDepth + 1;
    const files: Array<{ full: string; rel: string }> = [];
    const subdirs: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        if (depth < maxDepth && dirFilter(rel)) subdirs.push(full);
      } else if (entry.isFile() && depth <= maxDepth && fileFilter(rel)) {
        files.push({ full, rel });
      }
    }
    for (let i = 0; i < files.length; i += STAT_BATCH) {
      await Promise.all(files.slice(i, i + STAT_BATCH).map(async ({ full, rel }) => {
        try {
          const stat = await fs.promises.stat(full);
          onFile({ path: full, rel, depth, stat });
        } catch {
          // deleted between readdir and stat
        }
      }));
    }
    for (let i = 0; i < subdirs.length; i += DIR_BATCH) {
      await Promise.all(subdirs.slice(i, i + DIR_BATCH).map((sub) => walkDir(sub, depth)));
    }
  };

  await walkDir(root, 0);
}

/** Every matching file under `root`, newest first. */
export async function listFilesByMtime(root: string, opts: WalkOptions = {}): Promise<WalkFile[]> {
  const files: WalkFile[] = [];
  await walkFiles(root, opts, (f) => files.push(f));
  files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return files;
}
