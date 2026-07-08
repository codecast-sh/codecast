import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";

type WatcherCallback = (filePath: string, eventType: "add" | "change") => void;

const supportsRecursiveWatch = process.platform === "darwin" || process.platform === "win32";

export class RecursiveWatcher extends EventEmitter {
  private fsWatcher: fs.FSWatcher | null = null;
  private chokidarWatcher: ChokidarWatcher | null = null;
  // Per-directory rescan timers (native fs.watch path). Keyed by the directory a
  // change was seen under, so a burst under one dir coalesces into one rescan.
  private scanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Last-seen mtimeMs per filter-matching file, so a rescan emits only files that
  // are new or actually changed — not every file it walks past.
  private knownMtime = new Map<string, number>();
  private watchPath: string;
  private filter: (relativePath: string) => boolean;
  private callback: WatcherCallback;
  private maxDepth: number;
  private debounceMs: number;

  constructor(opts: {
    path: string;
    filter: (relativePath: string) => boolean;
    callback: WatcherCallback;
    maxDepth?: number;
    debounceMs?: number;
  }) {
    super();
    this.watchPath = opts.path;
    this.filter = opts.filter;
    this.callback = opts.callback;
    this.maxDepth = opts.maxDepth ?? Infinity;
    this.debounceMs = opts.debounceMs ?? 100;
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

  private startFsWatch(): void {
    // Prime known mtimes so pre-existing files don't flood as "add" on the first
    // event, and so a later append to one of them reads as "change" (mirrors
    // chokidar's ignoreInitial).
    this.walk(this.watchPath, false);

    this.fsWatcher = fs.watch(this.watchPath, { recursive: true }, (_eventType, filename) => {
      // Bun's fs.watch coalesces a same-tick burst of filesystem events into a
      // SINGLE callback carrying only the first event's filename (verified on bun
      // 1.3.14/macOS: four synchronous writes surfaced one callback). So one
      // callback does NOT mean one changed file. Treat it as "something under here
      // changed" and rescan the affected directory subtree, emitting files whose
      // mtime advanced. This also recovers files in subdirectories the coalesced
      // event dropped — the reason nested-file detection was failing.
      let scanDir = this.watchPath;
      if (filename) {
        const target = path.join(this.watchPath, filename);
        let isDir = false;
        try { isDir = fs.statSync(target).isDirectory(); } catch { /* deleted/renamed */ }
        // File event (the hot path — a session appending to its transcript):
        // rescan just its directory, so ongoing writes stay cheap. Directory
        // event (a new subdir appearing — infrequent): a coalesced burst may have
        // created sibling directories too, and bun surfaces only the first, so
        // rescan the whole tree to catch them all.
        scanDir = isDir ? this.watchPath : path.dirname(target);
      }
      this.scheduleScan(scanDir);
    });

    this.fsWatcher.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.emit("ready");
  }

  // Debounce a rescan of `dir`, coalescing a burst of events under it into one
  // walk. Keyed by directory so activity in unrelated subtrees doesn't reset each
  // other's timers.
  private scheduleScan(dir: string): void {
    const existing = this.scanTimers.get(dir);
    if (existing) clearTimeout(existing);
    this.scanTimers.set(dir, setTimeout(() => {
      this.scanTimers.delete(dir);
      this.walk(dir, true);
    }, this.debounceMs));
  }

  // Walk `dir` down to maxDepth, recording each filter-matching file's mtime.
  // With emit=true, fire the callback for any file that is new or whose mtime
  // advanced since the last walk; emit=false only records state (start priming).
  // Depth is measured in path segments relative to watchPath, matching the
  // original `filename.split(sep).length > maxDepth` semantics.
  private walk(dir: string, emit: boolean): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(this.watchPath, full);
      const depth = rel.split(path.sep).length;
      if (entry.isDirectory()) {
        // Descend only while a file one level deeper would still be within
        // maxDepth (a file in a dir at depth D sits at depth D+1).
        if (depth < this.maxDepth) this.walk(full, emit);
      } else if (entry.isFile()) {
        if (depth > this.maxDepth) continue;
        if (!this.filter(rel)) continue;
        let mtime: number;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        const prev = this.knownMtime.get(full);
        this.knownMtime.set(full, mtime);
        if (emit && (prev === undefined || mtime > prev)) {
          this.callback(full, prev === undefined ? "add" : "change");
        }
      }
    }
  }

  private startChokidar(): void {
    this.chokidarWatcher = chokidarWatch(this.watchPath, {
      persistent: true,
      ignoreInitial: true,
      depth: this.maxDepth,
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
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.chokidarWatcher) {
      this.chokidarWatcher.close();
      this.chokidarWatcher = null;
    }
    for (const timer of this.scanTimers.values()) {
      clearTimeout(timer);
    }
    this.scanTimers.clear();
    this.knownMtime.clear();
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
