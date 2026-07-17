// One configurable transcript-directory watcher, parameterized by a per-client
// config, replacing the near-identical CodexWatcher and GeminiWatcher classes.
// Both were the same shape — prime the tree, emit the pre-existing files newest
// first, then tail the directory via RecursiveWatcher — differing only in base
// path, file filter, session-id extraction, scan predicate, and (gemini only) an
// extra projectHash field. Those differences are the config; the machinery is
// shared. A new jsonl-dir CLI client adds a config entry rather than a new class.
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { RecursiveWatcher } from "./recursiveWatcher.js";
import { AGENT_CLIENTS, type AgentClientId } from "@codecast/shared/contracts";

export interface TranscriptDirEvent {
  sessionId: string;
  filePath: string;
  eventType: "add" | "change";
  /** Populated only for clients whose config sets extractProjectHash (gemini). */
  projectHash?: string;
}

export interface TranscriptDirWatcherConfig {
  /** Absolute base directory the client writes transcripts under. */
  basePath: string;
  /** Filter for the live watch, matched against the path RELATIVE to basePath
   *  (passed straight to RecursiveWatcher). */
  watchFilter: (rel: string) => boolean;
  /** Whether a file found during the initial full scan should be emitted. Takes the
   *  containing directory and the entry name — the two watchers' scan predicates
   *  differed from watchFilter (codex matched by extension anywhere; gemini also
   *  required the parent dir to be a `chats` dir), so this stays separate. */
  scanMatch: (dir: string, name: string) => boolean;
  /** Derive the session id from a file path. */
  extractSessionId: (filePath: string) => string;
  /** Optional extra field derivation (gemini's projectHash). */
  extractProjectHash?: (filePath: string) => string;
  /** Recursive-watch depth cap (codex used 4; gemini unbounded). */
  maxDepth?: number;
  debounceMs?: number;
}

export interface TranscriptDirWatcherEvents {
  session: (event: TranscriptDirEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
}

export declare interface TranscriptDirWatcher {
  on<K extends keyof TranscriptDirWatcherEvents>(event: K, listener: TranscriptDirWatcherEvents[K]): this;
  emit<K extends keyof TranscriptDirWatcherEvents>(event: K, ...args: Parameters<TranscriptDirWatcherEvents[K]>): boolean;
}

export class TranscriptDirWatcher extends EventEmitter {
  private watcher: RecursiveWatcher | null = null;
  private cfg: TranscriptDirWatcherConfig;

  constructor(cfg: TranscriptDirWatcherConfig) {
    super();
    this.cfg = cfg;
  }

  start(): void {
    if (this.watcher) return;

    if (!fs.existsSync(this.cfg.basePath)) {
      fs.mkdirSync(this.cfg.basePath, { recursive: true });
    }

    this.emitExistingFilesSorted();

    this.watcher = new RecursiveWatcher({
      path: this.cfg.basePath,
      filter: this.cfg.watchFilter,
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      maxDepth: this.cfg.maxDepth,
      debounceMs: this.cfg.debounceMs,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
  }

  private emitExistingFilesSorted(): void {
    const files: { path: string; mtime: number }[] = [];

    const scanDir = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && this.cfg.scanMatch(dir, entry.name)) {
            try {
              const stat = fs.statSync(fullPath);
              files.push({ path: fullPath, mtime: stat.mtimeMs });
            } catch {}
          }
        }
      } catch {}
    };

    scanDir(this.cfg.basePath);
    files.sort((a, b) => b.mtime - a.mtime);

    for (const file of files) {
      this.handleFileEvent(file.path, "add");
    }
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  private handleFileEvent(filePath: string, eventType: "add" | "change"): void {
    const event: TranscriptDirEvent = {
      sessionId: this.cfg.extractSessionId(filePath),
      filePath,
      eventType,
    };
    if (this.cfg.extractProjectHash) event.projectHash = this.cfg.extractProjectHash(filePath);
    this.emit("session", event);
  }
}

/** Expand a home-relative descriptor transcript root ("~/.codex/sessions") to an
 *  absolute path, matching the old watchers' `path.join(HOME, ...)` default. */
export function expandTranscriptRoot(root: string): string {
  return root.startsWith("~/") ? path.join(process.env.HOME || "", root.slice(2)) : root;
}

const CODEX_UUID_SUFFIX_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

// pi stores sessions at ~/.pi/agent/sessions/<cwd-slug>/<ISO-ts>_<uuid>.jsonl. The
// filename's trailing uuid is the session id (== the header's `id`), and the ISO
// timestamp before it also carries hyphens, so we anchor the uuid at the end.
const PI_UUID_SUFFIX_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Encode a working directory into pi's session-directory name, verbatim to pi's
 * own rule (session-manager.ts): drop a leading slash, replace every `/`, `\`, `:`
 * with `-`, and wrap in `--…--`. e.g. `/Users/ashot/src/codecast` ->
 * `--Users-ashot-src-codecast--`, `/private/tmp` -> `--private-tmp--`.
 */
export function encodePiCwdSlug(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Best-effort inverse of encodePiCwdSlug: strip the `--…--` wrapper and turn `-` back
 * into `/`, re-adding the leading slash. LOSSY on purpose — pi's encoder collapses
 * `/`, `\`, `:` AND any real `-` in the path all to `-`, so a directory named
 * `footage-app` decodes to `.../footage/app`. The session file's header `cwd`
 * (parser.extractPiCwd) is the authoritative source for project mapping; this decoder
 * is only the fallback for when the header is unavailable.
 */
export function decodePiCwdSlug(slug: string): string {
  const inner = slug.replace(/^--/, "").replace(/--$/, "");
  return inner ? `/${inner.replace(/-/g, "/")}` : "/";
}

/**
 * The per-client config for a jsonl-dir transcript watcher, sourced from the
 * client's registry descriptor (base path) plus its transcript-format specifics.
 * Only codex and gemini use the generic dir watcher today; claude has a bespoke
 * sessionWatcher and cursor a SQLite watcher (different watcherKinds).
 */
export function transcriptDirWatcherConfig(
  clientId: Extract<AgentClientId, "codex" | "gemini" | "pi">,
  basePathOverride?: string,
): TranscriptDirWatcherConfig {
  const basePath = basePathOverride ?? expandTranscriptRoot(AGENT_CLIENTS[clientId].transcriptRoots[0]);

  if (clientId === "pi") {
    // pi transcripts sit exactly one directory deep: sessions/<cwd-slug>/<file>.jsonl.
    // The session id is the filename's trailing uuid; the containing slug dir decodes
    // (lossily) back to the cwd, but processPiSession prefers the header cwd.
    return {
      basePath,
      watchFilter: (rel) => rel.endsWith(".jsonl"),
      scanMatch: (_dir, name) => name.endsWith(".jsonl"),
      extractSessionId: (filePath) => {
        const filename = path.basename(filePath, ".jsonl");
        const match = filename.match(PI_UUID_SUFFIX_RE);
        return match ? match[1] : filename;
      },
      maxDepth: 2,
      debounceMs: 100,
    };
  }

  if (clientId === "codex") {
    return {
      basePath,
      watchFilter: (rel) => rel.endsWith(".jsonl"),
      scanMatch: (_dir, name) => name.endsWith(".jsonl"),
      extractSessionId: (filePath) => {
        const filename = path.basename(filePath, ".jsonl");
        const match = filename.match(CODEX_UUID_SUFFIX_RE);
        return match ? match[1] : filename;
      },
      maxDepth: 4,
      debounceMs: 100,
    };
  }

  // gemini: transcripts live under a per-project `chats` dir; the session id is the
  // full filename and the parent-of-`chats` segment is the project hash.
  return {
    basePath,
    watchFilter: (rel) => rel.endsWith(".json") && (rel.includes(`chats${path.sep}`) || rel.includes("chats/")),
    scanMatch: (dir, name) => name.endsWith(".json") && dir.endsWith("/chats"),
    extractSessionId: (filePath) => path.basename(filePath, ".json"),
    extractProjectHash: (filePath) => {
      const parts = filePath.split(path.sep);
      const chatsIdx = parts.lastIndexOf("chats");
      return chatsIdx > 0 ? parts[chatsIdx - 1] : "";
    },
    debounceMs: 200,
  };
}
