// Code editor loopback protocol: the contract between the daemon's /code/* and
// /lsp/* routes (packages/cli/src/code/) and the web editor
// (packages/web/lib/code/). Same envelope as /vault/*: allowed Origin plus
// `Authorization: Bearer <token>` on HTTP, a hello frame carrying the token on
// WebSockets. Every route names a vault (`?vault=<id>`, VaultInfo.id) and every
// path is vault-relative, resolved through vaultScope.resolveVaultPath.
// Design: docs/architecture/code-editor.md.
//
// PURE isomorphic data: safe to import from the daemon and the browser.

// ── Search: GET /code/search ────────────────────────────────────────────────
// Query: vault, q, and optional regex=1, case=1 (case sensitive), word=1,
// include=<glob>[,<glob>], exclude=<glob>[,<glob>], max=<matches cap>,
// ignored=1 (search ignored files too). The response is NDJSON
// (`application/x-ndjson`), one CodeSearchEvent per line, flushed as ripgrep
// produces them. Aborting the request kills the search process.

export interface CodeSearchRange {
  /** UTF-16 column offsets into `text`, end exclusive. */
  start: number;
  end: number;
}

export interface CodeSearchLine {
  /** 1-based line number. */
  line: number;
  /** The whole line, or a window of it CODE_SEARCH_MAX_LINE_CHARS long that
   *  keeps the first match in view. */
  text: string;
  /** UTF-16 column of `text[0]` in the real line, when the line was trimmed.
   *  A jump to a match lands at `offset + range.start`. */
  offset?: number;
  ranges: CodeSearchRange[];
}

export type CodeSearchEvent =
  | { type: "file"; path: string; lines: CodeSearchLine[] }
  | {
      type: "done";
      files: number;
      matches: number;
      /** True when `max` (or the daemon's own cap) cut the search short. */
      truncated: boolean;
      elapsed_ms: number;
      engine: "rg" | "git-grep" | "walk";
    }
  | { type: "error"; message: string };

export const CODE_SEARCH_DEFAULT_MAX = 5_000;
export const CODE_SEARCH_MAX_LINE_CHARS = 400;

// ── Git: GET /code/git/status, GET /code/git/base ───────────────────────────

/** One path's state against HEAD, folded from `git status --porcelain=v2`. */
export type CodeGitFileState = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface CodeGitStatusResponse {
  /** False when the vault root is not inside a git work tree; the rest is empty. */
  repo: boolean;
  branch: string | null;
  head: string | null;
  /** Ahead/behind the upstream, when there is one. */
  ahead?: number;
  behind?: number;
  /** Vault-relative path to its state. Clean paths are absent. */
  files: Record<string, CodeGitFileState>;
}

/** GET /code/git/base?vault=&path=&ref=HEAD: the file's text at a ref, the
 *  baseline the gutter and diff view compare against. */
/** A ref form the daemon resolves itself, never one git reads: the commit
 *  where HEAD left the default branch (origin/HEAD, else main, else master). */
export const CODE_GIT_MERGE_BASE_REF = "@merge-base";

export interface CodeGitBaseResponse {
  path: string;
  ref: string;
  /** False when the path does not exist at `ref` (a new file). */
  exists: boolean;
  content?: string;
  /** Blob sha at `ref`. */
  sha?: string;
}

// ── Blame: GET /code/blame?vault=&path= ─────────────────────────────────────

export interface CodeBlameSession {
  /** Conversation short id (renders as a live reference). */
  id: string;
  /** The full conversation id, for navigation. */
  conversation_id?: string;
  title?: string;
  /** Message the edit came from, when known, for deep links. */
  message_id?: string;
  agent?: string;
  /** The person who ran the session. */
  author_name?: string;
  /** How the session was found: trailer, commit, hash, subject, overlap, edit. */
  via?: string;
}

/** A run of consecutive lines with one origin. */
export interface CodeBlameHunk {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  /** Commit sha; absent for uncommitted lines. */
  sha?: string;
  author?: string;
  /** Epoch ms of the commit (or of the session edit for uncommitted lines). */
  time?: number;
  summary?: string;
  uncommitted?: boolean;
  /** The codecast session that wrote these lines, from the Codecast-Session
   *  trailer or, for uncommitted lines, a content match against session edits. */
  session?: CodeBlameSession;
  /** Set when the commit is a sweep naming this many sessions in its
   *  Codecast-Session trailers and no single one of them could be matched to
   *  these lines; `session` is then absent rather than the session that ran
   *  the commit. */
  sweep_sessions?: number;
}

export interface CodeBlameResponse {
  path: string;
  hunks: CodeBlameHunk[];
}

// ── Vim config: GET /code/vimrc, PUT /code/vimrc/overlay ────────────────────

export interface CodeVimrcSource {
  /** Absolute path on the daemon's machine, shown in the report. */
  path: string;
  content: string;
  /** Which file `source`d this one; absent for an entry point. */
  sourced_from?: string;
  truncated?: boolean;
}

export interface CodeVimrcResponse {
  /** Entry points in load order (~/.vimrc, ~/.vim/vimrc,
   *  ~/.config/nvim/init.vim), each followed by the files it sources. */
  sources: CodeVimrcSource[];
  /** ~/.codecast/editor/vimrc, applied last. Null when it does not exist. */
  overlay: { path: string; content: string } | null;
  /** `source`/`runtime` lines the daemon did not follow, and why. */
  unread?: CodeVimrcUnread[];
}

export interface CodeVimrcUnread {
  /** The path as the line names it, expanded. */
  path: string;
  sourced_from: string;
  reason: "not found" | "outside home" | "too deep" | "size limit";
}

/** PUT body is the overlay's full text (text/plain). Response: */
export interface CodeVimrcOverlayWriteResponse {
  path: string;
  bytes: number;
}

export const CODE_VIMRC_MAX_BYTES = 512 * 1024;

// ── Language servers: GET /lsp/servers, WS /lsp/ws ──────────────────────────

export interface LspServerInfo {
  /** Registry id: "typescript", "rust-analyzer", "clangd", "sourcekit",
   *  "pyright", "gopls", ... */
  id: string;
  name: string;
  /** CodeMirror/LSP language ids this server answers for. */
  languages: string[];
  available: boolean;
  /** Resolved binary when available. */
  command?: string;
  /** How to install it when missing (shown in Settings > Editor). */
  install_hint?: string;
  /** Running instances for this vault. */
  running?: boolean;
}

export interface LspServersResponse {
  servers: LspServerInfo[];
}

/** First frame on /lsp/ws, within 10s. One socket drives one server process
 *  for one (vault, server) pair. The web keeps one socket per pair and opens
 *  every file of that language through it, so a window runs one process per
 *  language; the daemon keeps a closed socket's process warm for a short grace
 *  period so a reload reattaches instead of re-indexing. */
export interface LspWsHello {
  type: "hello";
  token: string;
  vault: string;
  /** LspServerInfo.id, or omitted to pick by `language`. */
  server?: string;
  language?: string;
  /** The browser sends LspWsAck frames. The daemon then stops reading the
   *  server while too much it sent is unacknowledged, instead of queueing
   *  without bound for a tab that is not reading (bun's socket drops
   *  messages past its buffer limit, and reports nothing). */
  acks?: boolean;
  /** Start a new server process: never reattach to a warm one, and kill the
   *  ones this client left (its Restart when the old socket stopped
   *  answering): parked ones it last held now, attached ones when their
   *  socket closes. Without `client`, only parked ones. */
  fresh?: boolean;
  /** Names one browser connection across its reconnects (one per editor
   *  transport), so a fresh hello touches only the processes it held. */
  client?: string;
}

/** Browser to daemon, when the hello set `acks`: the total length (JS string
 *  length) of every frame received on this socket so far, sent every few
 *  hundred kilobytes. */
export interface LspWsAck {
  type: "ack";
  chars: number;
}

/** Browser to daemon: stop the server process and start a fresh one (a person
 *  pressed Restart). Not counted as a crash. The socket sees the usual
 *  `exit` with `restarting: true`, then `ready`, and initializes again. */
export interface LspWsRestart {
  type: "restart";
}

/** Daemon control frames. Every other text frame in either direction is one
 *  JSON-RPC message, verbatim (no Content-Length framing on the socket),
 *  except LspWsAck and LspWsRestart from the browser. Control frames start with `{"type":`, so
 *  a receiver can route a frame without parsing it. */
export type LspWsControl =
  | { type: "ready"; server: LspServerInfo; root_uri: string }
  | { type: "unavailable"; server?: string; reason: string; install_hint?: string }
  | {
      type: "exit";
      code: number | null;
      signal?: string | null;
      /** True when the daemon is starting a fresh process; a "ready" follows
       *  and the client must initialize again. False ends the socket. */
      restarting: boolean;
      /** The server's last stderr line, when it said why. */
      reason?: string;
    };
