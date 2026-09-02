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
import type { WalkFile } from "./fsWalk.js";
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
  /** Derive the session id from a file path. Return null to REFUSE the file: a
   *  filename that doesn't carry the client's real id shape would otherwise be
   *  tracked under attacker-controlled text (the raw filename), which flows to
   *  convex as the session_id and later into a resume shell command. */
  extractSessionId: (filePath: string) => string | null;
  /** Optional extra field derivation (gemini's projectHash). */
  extractProjectHash?: (filePath: string) => string;
  /** Recursive-watch depth cap (codex used 4; gemini unbounded). */
  maxDepth?: number;
  /** Whether the walk enters a directory, by its path relative to basePath.
   *  Prunes sibling trees a client keeps next to its transcripts. */
  dirFilter?: (rel: string) => boolean;
  debounceMs?: number;
}

export interface TranscriptDirWatcherEvents {
  session: (event: TranscriptDirEvent) => void;
  error: (error: Error) => void;
  ready: () => void;
}

/** The minimal surface the daemon's watcher-registration seam needs. Both the
 *  generic jsonl-dir TranscriptDirWatcher and the opencode json-store watcher
 *  satisfy it, so `registerJsonlDirWatcher` can drive either. */
export interface DirEventWatcher {
  on<K extends keyof TranscriptDirWatcherEvents>(event: K, listener: TranscriptDirWatcherEvents[K]): this;
  /** May resolve when priming completes; a caller that only needs the watch
   *  open ignores the value. */
  start(): void | Promise<void>;
  stop(): void;
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

  /** Resolves once the priming walk has emitted the pre-existing files. */
  start(): Promise<void> {
    if (this.watcher) return this.watcher.whenPrimed();

    if (!fs.existsSync(this.cfg.basePath)) {
      fs.mkdirSync(this.cfg.basePath, { recursive: true });
    }

    this.watcher = new RecursiveWatcher({
      path: this.cfg.basePath,
      filter: this.cfg.watchFilter,
      dirFilter: this.cfg.dirFilter,
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      onExisting: (files) => this.emitExistingFilesSorted(files),
      maxDepth: this.cfg.maxDepth,
      debounceMs: this.cfg.debounceMs,
    });

    this.watcher.on("error", (err: Error) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
    return this.watcher.whenPrimed();
  }

  whenPrimed(): Promise<void> {
    return this.watcher ? this.watcher.whenPrimed() : Promise.resolve();
  }

  // Files the watcher's priming walk found (one walk serves both), narrowed by
  // scanMatch and emitted newest first.
  private emitExistingFilesSorted(files: WalkFile[]): void {
    const matched = files.filter((f) => this.cfg.scanMatch(path.dirname(f.path), path.basename(f.path)));
    matched.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    for (const file of matched) {
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
    const sessionId = this.cfg.extractSessionId(filePath);
    if (sessionId == null) {
      // Malformed filename → the "id" would be the raw filename (attacker text).
      // Skip it: don't track it, don't push it to convex. Never crash the watcher.
      console.warn(`[SECURITY] skipping transcript with a malformed session id: ${path.basename(filePath)}`);
      return;
    }
    const event: TranscriptDirEvent = { sessionId, filePath, eventType };
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

// A grok session dir is named by the session's FULL uuid; anything else in an
// encoded-cwd dir (`.cwd`, `*.lock`, `*.tmp`, `session_search.sqlite` at the
// root) is cruft the watcher must refuse. Anchored full-match on purpose — the
// dir name flows into a resume shell command (see extractSessionId's contract).
const GROK_SESSION_DIR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encode a working directory into grok's session-directory name, verbatim to
 * grok's `encode_cwd_dirname` (xai-grok-config paths.rs): the Rust `urlencoding`
 * crate percent-encodes every UTF-8 byte outside `[A-Za-z0-9_.~-]` with
 * uppercase hex. STRICTER than JS `encodeURIComponent`, which leaves `!'()*`
 * bare — hence the byte loop instead of a delegation.
 * `/Users/ashot/src/codecast` -> `%2FUsers%2Fashot%2Fsrc%2Fcodecast`.
 *
 * Long-path branch NOT implemented on purpose: when the encoded form exceeds 255
 * bytes grok names the dir `{slugify(leaf,40)}-{blake3_hex16}` (a hash we can't
 * reproduce without a blake3 dep). Callers that miss with this encoding must
 * fall back to scanning the cwd dirs for the session-uuid DIRECTORY instead.
 */
export function encodeGrokCwdSlug(cwd: string): string {
  let out = "";
  for (const byte of Buffer.from(cwd, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.~-]/.test(ch) ? ch : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * Inverse of encodeGrokCwdSlug, mirroring grok's `decode_cwd_from_dirname`:
 * URL-decode and accept ONLY a result that starts with `/` (an absolute cwd).
 * Returns null for the long-path hash dirs (`{slug}-{blake3_16}` decodes to
 * relative text) and malformed percent sequences — there grok keeps the original
 * path in a `.cwd` file inside the dir, and the session's summary.json `info.cwd`
 * (parser.extractGrokCwd) is authoritative anyway, including across cwd
 * relocation; this decoder is only the sibling-less fallback.
 */
export function decodeGrokCwdSlug(slug: string): string | null {
  try {
    const decoded = decodeURIComponent(slug);
    return decoded.startsWith("/") ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * The per-client config for a jsonl-dir transcript watcher, sourced from the
 * client's registry descriptor (base path) plus its transcript-format specifics.
 * Only codex and gemini use the generic dir watcher today; claude has a bespoke
 * sessionWatcher and cursor a SQLite watcher (different watcherKinds).
 */
export function transcriptDirWatcherConfig(
  clientId: Extract<AgentClientId, "codex" | "gemini" | "pi" | "grok">,
  basePathOverride?: string,
): TranscriptDirWatcherConfig {
  const basePath = basePathOverride ?? expandTranscriptRoot(AGENT_CLIENTS[clientId].transcriptRoots[0]);

  if (clientId === "grok") {
    // grok transcripts sit exactly two directories deep:
    // sessions/<url-encoded-cwd>/<session-uuid>/updates.jsonl. Watch ONE file per
    // session dir: the dir holds ~10 siblings that churn during a turn
    // (chat_history.jsonl, summary.json, plan.json, signals.json, *.lock,
    // *.pre-strip, *.tmp) — matching more than updates.jsonl would double-fire
    // per session, and chat_history.jsonl is a rewriteable cache we deliberately
    // never watch. The session id is the CONTAINING DIRECTORY's uuid name.
    return {
      basePath,
      watchFilter: (rel) => /[\\/]updates\.jsonl$/.test(rel),
      scanMatch: (_dir, name) => name === "updates.jsonl",
      extractSessionId: (filePath) => {
        const dirname = path.basename(path.dirname(filePath));
        // A real grok session dir IS the session's full uuid. Anything else
        // (`.cwd`, lock/tmp cruft, `session_search.sqlite` at the root, or a
        // crafted name) must be refused rather than tracked under raw dir text,
        // which would become the session_id and, unescaped, a resume-command
        // injection vector (the same guard as pi's filename rule).
        return GROK_SESSION_DIR_UUID_RE.test(dirname) ? dirname : null;
      },
      // Enter a cwd dir and a session uuid dir only; `.cwd` and friends are
      // files, and any other dir at depth 2 cannot hold a session.
      dirFilter: (rel) => {
        const parts = rel.split(path.sep);
        return parts.length === 1 || (parts.length === 2 && GROK_SESSION_DIR_UUID_RE.test(parts[1]));
      },
      maxDepth: 3,
      debounceMs: 100,
    };
  }

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
        // A real pi transcript ALWAYS ends in its session UUID (<ISO-ts>_<uuid>.jsonl).
        // No trailing UUID → a crafted/foreign filename, not a pi session: refuse it
        // rather than track it under the raw filename (which would become the
        // session_id and, unescaped, a resume-command injection vector).
        return match ? match[1] : null;
      },
      // No dirFilter: maxDepth 2 already stops the walk at the slug dirs.
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
      // Rollouts live under sessions/YYYY/MM/DD. Anything else at the root
      // (leftover `watcher-test-*` dirs, an editor's scratch dir) is skipped.
      dirFilter: (rel) => {
        const parts = rel.split(path.sep);
        if (parts.length === 1) return /^\d{4}$/.test(parts[0]);
        return parts.length <= 3 && /^\d{2}$/.test(parts[parts.length - 1]);
      },
      maxDepth: 4,
      debounceMs: 100,
    };
  }

  // gemini: transcripts live under a per-project `chats` dir; the session id is the
  // full filename and the parent-of-`chats` segment is the project hash.
  return {
    basePath,
    watchFilter: (rel) => rel.endsWith(".json") && rel.split(/[\\/]/).includes("chats"),
    scanMatch: (dir, name) => name.endsWith(".json") && path.basename(dir) === "chats",
    extractSessionId: (filePath) => path.basename(filePath, ".json"),
    extractProjectHash: (filePath) => {
      const parts = filePath.split(path.sep);
      const chatsIdx = parts.lastIndexOf("chats");
      return chatsIdx > 0 ? parts[chatsIdx - 1] : "";
    },
    // Layout is <project-hash>/chats/<id>.json; a project dir also holds
    // checkpoints and other state that never carry a transcript.
    dirFilter: (rel) => {
      const parts = rel.split(path.sep);
      return parts.length === 1 || (parts.length === 2 && parts[1] === "chats");
    },
    maxDepth: 3,
    debounceMs: 200,
  };
}

/** Clients that give every session its own transcript FILE, so a process holding
 *  one open can be named from the path alone. opencode and cursor keep all their
 *  sessions in a single SQLite store and are absent by construction — an open
 *  handle on that store says "an agent", never "which session". For grok the
 *  per-session identity is the uuid DIRECTORY holding updates.jsonl, which its
 *  extractSessionId already returns from the file path. */
const FILE_PER_SESSION_CLIENTS = ["claude", "codex", "gemini", "pi", "grok"] as const;

/**
 * Which agent session (if any) a transcript path belongs to — the registry-driven
 * inverse of the watchers' session-id extraction, used to identify a spawner
 * process by the file it holds open. Adding client #7 with its own file-per-session
 * layout teaches this for free: list it above, and its watcher config supplies the
 * extraction.
 *
 * The id is only ever used as a conversation-cache lookup key, so an unrecognized
 * filename costs a miss, not a bad write.
 */
export function agentSessionFromTranscriptPath(
  filePath: string,
): { agentType: AgentClientId; sessionId: string } | null {
  for (const clientId of FILE_PER_SESSION_CLIENTS) {
    const root = expandTranscriptRoot(AGENT_CLIENTS[clientId].transcriptRoots[0]);
    if (!filePath.startsWith(root + path.sep)) continue;
    const relativePath = path.relative(root, filePath);
    if (clientId === "claude") {
      // Claude has a bespoke watcher, so its rule lives here: the session id is the
      // filename. A live claude process holds its SUBAGENTS' transcripts open next
      // to its own, and those name the child rather than the session running the
      // process — skipping them keeps the wrong id out of the lookup.
      if (!filePath.endsWith(".jsonl") || relativePath.split(path.sep).length !== 2) return null;
      return { agentType: "claude", sessionId: path.basename(filePath, ".jsonl") };
    }
    const config = transcriptDirWatcherConfig(clientId);
    if (!config.watchFilter(relativePath)) continue;
    const sessionId = config.extractSessionId(filePath);
    if (sessionId) return { agentType: clientId, sessionId };
  }
  return null;
}
