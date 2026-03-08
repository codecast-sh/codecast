import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";
import { watch as chokidarWatch, type FSWatcher as ChokidarWatcher } from "chokidar";

type WatcherCallback = (filePath: string, eventType: "add" | "change") => void;

const supportsRecursiveWatch = process.platform === "darwin" || process.platform === "win32";

export class RecursiveWatcher extends EventEmitter {
  private fsWatcher: fs.FSWatcher | null = null;
  private chokidarWatcher: ChokidarWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    this.fsWatcher = fs.watch(this.watchPath, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      const parts = filename.split(path.sep);
      if (parts.length > this.maxDepth) return;
      if (!this.filter(filename)) return;

      const fullPath = path.join(this.watchPath, filename);

      const existing = this.debounceTimers.get(fullPath);
      if (existing) clearTimeout(existing);
      this.debounceTimers.set(fullPath, setTimeout(() => {
        this.debounceTimers.delete(fullPath);
        try {
          fs.statSync(fullPath);
          this.callback(fullPath, "change");
        } catch {
          // deleted
        }
      }, this.debounceMs));
    });

    this.fsWatcher.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.emit("ready");
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
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  restart(): void {
    this.stop();
    this.start();
  }

  get isWatching(): boolean {
    return this.fsWatcher !== null || this.chokidarWatcher !== null;
  }
}
