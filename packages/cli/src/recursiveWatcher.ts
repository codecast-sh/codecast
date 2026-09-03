import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";
import { walkFiles, type WalkFile } from "./fsWalk.js";

type WatcherCallback = (filePath: string, eventType: "add" | "change") => void;

const supportsRecursiveWatch = process.platform === "darwin" || process.platform === "win32";

// Floor between two safety-net rescans of the tree (native path). The rescan
// exists only to catch files whose change bun's coalescing dropped, so it may
// lag by this much; the per-file probe is what carries live latency. One walk
// of ~/.claude/projects (3.6k dirs, 18k files) costs ~80ms of pool-thread time
// warm, so this cadence is a few percent of one core while sessions stream.
const DEFAULT_RESCAN_INTERVAL_MS = 2_000;

/** Whether `relDir` and every ancestor of it pass `dirFilter`. */
export function dirAllowedUnder(dirFilter: (relativeDirPath: string) => boolean, relDir: string): boolean {
  if (!relDir || relDir === ".") return true;
  let prefix = "";
  for (const seg of relDir.split(path.sep)) {
    prefix = prefix ? `${prefix}${path.sep}${seg}` : seg;
    if (!dirFilter(prefix)) return false;
  }
  return true;
}

/**
 * The chokidar `ignored` predicate for a dirFilter. chokidar asks it for
 * files as well as directories, and for a file it asks BEFORE it has a stat.
 * A dirFilter only knows directories, so a path is judged by the directory
 * it sits in unless chokidar says it is a directory itself. Feeding a file
 * path straight into the dirFilter refused every transcript (a claude
 * `<slug>/<uuid>.jsonl` is not a session dir), so on Linux the watchers
 * saw only directory events and ingest fell back to the watchdog sweep.
 */
export function chokidarIgnored(
  watchPath: string,
  dirFilter: (relativeDirPath: string) => boolean,
): (target: string, stats?: fs.Stats) => boolean {
  return (target, stats) => {
    const rel = path.relative(watchPath, target);
    if (!rel || rel.startsWith("..")) return false;
    return !dirAllowedUnder(dirFilter, stats?.isDirectory() ? rel : path.dirname(rel));
  };
}

export class RecursiveWatcher extends EventEmitter {
  private fsWatcher: fs.FSWatcher | null = null;
  private chokidarWatcher: ChokidarWatcher | null = null;
  // Per-file probe timers (native path): a burst of appends to one transcript
  // coalesces into a single stat.
  private probeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private rescanTimer: ReturnType<typeof setTimeout> | null = null;
  private rescanRunning = false;
  private rescanRequested = false;
  private lastRescanEndedAt = 0;
  // Last-seen mtimeMs per filter-matching file, so a probe or rescan emits only
  // files that are new or actually changed — not every file it walks past.
  private knownMtime = new Map<string, number>();
  // Bumped by every stop(): async work still in flight from the previous
  // start() checks it and drops its results instead of writing into a fresh
  // watcher's state.
  private generation = 0;
  private primed: Promise<void> = Promise.resolve();
  private isPrimed = false;
  private watchPath: string;
  private filter: (relativePath: string) => boolean;
  private dirFilter: (relativeDirPath: string) => boolean;
  private callback: WatcherCallback;
  private onExisting: ((files: WalkFile[]) => void) | null;
  private maxDepth: number;
  private debounceMs: number;
  private rescanIntervalMs: number;

  constructor(opts: {
    path: string;
    filter: (relativePath: string) => boolean;
    /**
     * Whether to descend into a directory. `filter` only ever sees FILES, so
     * without this the walk recurses through every directory under the root and
     * merely discards what it finds — on a code repository that means walking
     * node_modules on priming and again on every rescan, forever.
     *
     * Defaults to descending everywhere, so callers that don't set it behave
     * exactly as before.
     */
    dirFilter?: (relativeDirPath: string) => boolean;
    callback: WatcherCallback;
    /**
     * Receives every filter-matching file the priming walk found, with stats.
     * Callers that used to walk the tree themselves on start (to emit recent
     * files, sorted) can take them from this one walk instead of running a
     * second one over the same tens of thousands of files. Native path only.
     */
    onExisting?: (files: WalkFile[]) => void;
    maxDepth?: number;
    debounceMs?: number;
    rescanIntervalMs?: number;
  }) {
    super();
    this.watchPath = opts.path;
    this.filter = opts.filter;
    this.dirFilter = opts.dirFilter ?? (() => true);
    this.callback = opts.callback;
    this.onExisting = opts.onExisting ?? null;
    this.maxDepth = opts.maxDepth ?? Infinity;
    this.debounceMs = opts.debounceMs ?? 100;
    this.rescanIntervalMs = opts.rescanIntervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
  }

  start(): void {
    if (this.fsWatcher || this.chokidarWatcher) return;

    if (!fs.existsSync(this.watchPath)) {
      fs.mkdirSync(this.watchPath, { recursive: true });
    }

    if (supportsRecursiveWatch) {
      this.startFsWatch();
    } else {
      this.startChokidar();
    }
  }

  /** Resolves once the priming walk has recorded every existing file (native
   *  path); immediately on the chokidar path. */
  whenPrimed(): Promise<void> {
    return this.primed;
  }

  // Every ancestor of `relDir` must pass dirFilter — the native watch cannot be
  // pruned, so events from rejected subtrees still arrive and must be ignored
  // the same way the walk ignores them. Mirrors chokidar's `ignored` below.
  private isDirAllowed(relDir: string): boolean {
    return dirAllowedUnder(this.dirFilter, relDir);
  }

  private startFsWatch(): void {
    const gen = ++this.generation;
    this.isPrimed = false;

    // Open the watch BEFORE priming, so nothing written during the walk is
    // missed; the probe path below is correct for an unprimed file (it emits).
    this.fsWatcher = fs.watch(this.watchPath, { recursive: true }, (_eventType, filename) => {
      this.onNativeEvent(filename == null ? null : String(filename));
    });

    this.fsWatcher.on("error", (err: Error) => {
      this.emit("error", err);
    });

    // Prime known mtimes so pre-existing files don't flood as "add" on the first
    // rescan, and so a later append to one of them reads as "change" (mirrors
    // chokidar's ignoreInitial). Async: the tree can hold tens of thousands of
    // files, and this also runs on every wake-from-sleep restart.
    const existing: WalkFile[] = [];
    this.primed = this.walkTree(gen, false, this.onExisting ? (f) => existing.push(f) : undefined)
      .then(() => {
        if (gen !== this.generation) return;
        this.isPrimed = true;
        // Priming IS a walk: pace the first rescan from it.
        this.lastRescanEndedAt = Date.now();
        this.onExisting?.(existing);
        this.emit("ready");
      });
  }

  // One native event. Bun's fs.watch coalesces a same-tick burst of filesystem
  // events into a SINGLE callback carrying only the first event's filename
  // (verified on bun 1.3.14/macOS: four synchronous writes surfaced one
  // callback). So the named file gets a direct probe — one stat, the hot path
  // for a session appending to its transcript — and every event also requests
  // a throttled rescan of the whole tree, which is what recovers the siblings
  // the coalescing dropped, wherever in the tree they sit.
  //
  // Before this the rescan was the ONLY path, ran 100ms after every event, and
  // walked the named file's entire subtree synchronously. Under ~/.claude/
  // projects that is one project's 1700 directories per append, per session —
  // several full walks a second on the main thread, and a 42s freeze whenever
  // the disk was busy.
  private onNativeEvent(filename: string | null): void {
    if (filename) {
      const full = path.join(this.watchPath, filename);
      const rel = path.relative(this.watchPath, full);
      const depth = rel.split(path.sep).length;
      if (depth <= this.maxDepth && this.filter(rel) && this.isDirAllowed(path.dirname(rel))) {
        this.scheduleProbe(full);
      } else {
        // A directory appearing (a new project or session subdir) is rare and
        // structural: whatever landed inside it in the same burst has no event
        // of its own, so don't make it wait out the throttle.
        const gen = this.generation;
        fs.promises.stat(full)
          .then((st) => { if (gen === this.generation && st.isDirectory()) this.requestRescan(true); })
          .catch(() => {});
      }
    }
    this.requestRescan();
  }

  private scheduleProbe(full: string): void {
    const existing = this.probeTimers.get(full);
    if (existing) clearTimeout(existing);
    const gen = this.generation;
    this.probeTimers.set(full, setTimeout(() => {
      this.probeTimers.delete(full);
      void this.probe(gen, full);
    }, this.debounceMs));
  }

  private async probe(gen: number, full: string): Promise<void> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(full);
    } catch {
      return; // deleted before the probe ran
    }
    if (gen !== this.generation || !stat.isFile()) return;
    // While priming is still walking, the walk may stat this file AFTER the
    // write that raised the event and record the new mtime first; the event is
    // the only evidence of that change, so an unprimed probe always emits.
    this.noteMtime(full, stat.mtimeMs, true, !this.isPrimed);
  }

  private noteMtime(full: string, mtime: number, emit: boolean, force = false): void {
    const prev = this.knownMtime.get(full);
    if (prev !== undefined && mtime <= prev && !force) return;
    if (prev === undefined || mtime > prev) this.knownMtime.set(full, mtime);
    if (emit) this.callback(full, prev === undefined ? "add" : "change");
  }

  // At most one tree walk in flight, and at most one per rescanIntervalMs
  // after the previous one ENDED — so a walk that is slow because the disk is
  // busy paces the next one instead of stacking behind it.
  private requestRescan(urgent = false): void {
    if (this.rescanRunning) {
      this.rescanRequested = true;
      return;
    }
    const wait = urgent
      ? this.debounceMs
      : Math.max(this.debounceMs, this.lastRescanEndedAt + this.rescanIntervalMs - Date.now());
    if (this.rescanTimer) {
      if (!urgent) return;
      clearTimeout(this.rescanTimer); // pull a throttled walk forward
    }
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null;
      void this.runRescan();
    }, wait);
  }

  private async runRescan(): Promise<void> {
    const gen = this.generation;
    this.rescanRunning = true;
    this.rescanRequested = false;
    try {
      await this.primed;
      if (gen === this.generation) await this.walkTree(gen, true);
    } finally {
      this.rescanRunning = false;
      this.lastRescanEndedAt = Date.now();
    }
    if (this.rescanRequested && gen === this.generation) this.requestRescan();
  }

  // Walk the tree, recording each filter-matching file's mtime. With emit=true,
  // fire the callback for any file that is new or whose mtime advanced since it
  // was last seen; emit=false only records state (priming).
  private async walkTree(gen: number, emit: boolean, collect?: (f: WalkFile) => void): Promise<void> {
    await walkFiles(
      this.watchPath,
      { maxDepth: this.maxDepth, dirFilter: this.dirFilter, fileFilter: this.filter },
      (f) => {
        if (gen !== this.generation) return;
        collect?.(f);
        this.noteMtime(f.path, f.stat.mtimeMs, emit);
      },
    );
  }

  private startChokidar(): void {
    this.isPrimed = true;
    this.primed = Promise.resolve();
    this.chokidarWatcher = chokidarWatch(this.watchPath, {
      persistent: true,
      ignoreInitial: true,
      depth: this.maxDepth,
      // Unlike the native path, chokidar CAN be told not to descend — which
      // matters more here, since it opens a real watch per directory.
      ignored: chokidarIgnored(this.watchPath, this.dirFilter),
      awaitWriteFinish: {
        stabilityThreshold: this.debounceMs,
        pollInterval: Math.max(20, this.debounceMs / 2),
      },
    });

    this.chokidarWatcher.on("add", (filePath) => {
      const rel = path.relative(this.watchPath, filePath);
      if (this.filter(rel)) this.callback(filePath, "add");
    });

    this.chokidarWatcher.on("change", (filePath) => {
      const rel = path.relative(this.watchPath, filePath);
      if (this.filter(rel)) this.callback(filePath, "change");
    });

    this.chokidarWatcher.on("error", (err: unknown) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });

    this.chokidarWatcher.on("ready", () => {
      this.emit("ready");
    });
  }

  stop(): void {
    this.generation++;
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.chokidarWatcher) {
      this.chokidarWatcher.close();
      this.chokidarWatcher = null;
    }
    for (const timer of this.probeTimers.values()) {
      clearTimeout(timer);
    }
    this.probeTimers.clear();
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer);
      this.rescanTimer = null;
    }
    this.rescanRequested = false;
    this.knownMtime.clear();
    this.isPrimed = false;
  }

  async restart(): Promise<void> {
    this.stop();
    // Yield before re-opening: bun's native File Watcher thread holds an
    // os_unfair_lock during fs.watch teardown, and a back-to-back close→open
    // on the same path can deadlock the main thread against that worker.
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.start();
  }

  get isWatching(): boolean {
    return this.fsWatcher !== null || this.chokidarWatcher !== null;
  }
}
