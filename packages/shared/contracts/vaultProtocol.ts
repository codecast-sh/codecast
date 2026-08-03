// Vault loopback protocol — the contract between the daemon's local HTTP/WS
// bridge (packages/cli/src/terminal/terminalServer.ts /vault/* routes) and the
// web vault client (packages/web/lib/vault/client.ts).
//
// A vault is a registered local directory of markdown files. The local
// filesystem is canonical: the browser reads and writes it directly over the
// loopback server (same token/origin/CORS envelope as the terminal channel).
// Nothing here touches Convex; the remote mirror tier has its own contract.
//
// PURE isomorphic data — safe to import from the daemon and the browser.

/** A registered vault root, as reported by GET /vault/roots. */
export interface VaultInfo {
  /** Stable id: 12-hex digest of the absolute root path. */
  id: string;
  /** Absolute path of the vault root on the daemon's machine. */
  root: string;
  /** Display name (defaults to the root's basename). */
  name: string;
  /** Count of markdown files at last scan (advisory, may be stale). */
  note_count?: number;
  /** Epoch ms when the vault was registered. */
  added_at: number;
  /** "project" = one of the user's own code projects, discovered rather than
   *  registered by hand (vaultRegistry.projectVaults). Absent means someone ran
   *  `cast vault add`. The only difference downstream is how it is presented:
   *  once opened, a project vault scans, watches and edits identically. */
  kind?: "project";
  /** Vault-relative directory to land in — "docs" for a repo that has one.
   *  Empty/absent means the root. A repo root is mostly source directories, so
   *  opening there is a poor first impression; see vaultProjectHome. */
  home?: string;
  /** Opt-in one-way remote mirror (vaultMirror.ts) for cross-device reading.
   *  Absent/false means the vault is local-only — nothing about it ever leaves
   *  this machine. */
  mirror?: boolean;
}

/** GET /vault/roots response. */
export interface VaultRootsResponse {
  vaults: VaultInfo[];
}

/** One file entry from GET /vault/scan. Paths are vault-relative, "/"-separated. */
export interface VaultFileEntry {
  path: string;
  /** Epoch ms mtime. */
  mtime: number;
  /** Byte size. */
  size: number;
  /** Directory flag: directories appear so empty folders render. */
  dir?: boolean;
}

export interface VaultScanResponse {
  vault: VaultInfo;
  files: VaultFileEntry[];
  /** Epoch ms when the scan ran (client uses as its sync watermark). */
  scanned_at: number;
}

/** GET /vault/file response is the raw body with headers:
 *  X-Vault-Mtime: epoch ms, X-Vault-Size: bytes, ETag: sha256 prefix.
 *  This one route also accepts the bearer token as a `?token=` query param
 *  instead of the Authorization header, because an <img>/<video> src can set
 *  no headers at all. Reads only — PUT and /vault/op always require the header.
 *  PUT /vault/file sends the raw body; If-Match carries the last-seen ETag
 *  (or X-Vault-Base-Mtime the last-seen mtime) — a mismatch returns 409 with
 *  the current file body so the client can merge. */
export interface VaultWriteResponse {
  path: string;
  mtime: number;
  size: number;
  etag: string;
}

/** POST /vault/op request. Deletes go to the OS trash, never unlink. */
export type VaultOpRequest =
  | { op: "mkdir"; path: string }
  | { op: "rename"; path: string; to: string }
  | { op: "delete"; path: string }
  | { op: "create"; path: string; content?: string }
  /** Show the file in the OS file manager (Finder, Explorer, the Linux
   *  desktop's handler). `mode: "open"` hands it to the default application
   *  instead — the user's editor for a markdown file. */
  | { op: "reveal"; path: string; mode?: "reveal" | "open" };

export interface VaultOpResponse {
  ok: true;
  /** Present on create/rename: the resulting file entry. */
  file?: VaultFileEntry;
}

/** Events streamed over WS /vault/ws after the auth hello.
 *  "removed" is emitted by the reconcile scan (the watcher itself has no
 *  delete events); "reset" tells the client to re-run /vault/scan. */
export type VaultWsEvent =
  | { type: "add" | "change"; vault: string; path: string; mtime: number; size: number }
  | { type: "removed"; vault: string; path: string }
  | { type: "reset"; vault: string };

/** Client → server WS hello, mirroring the terminal channel's auth frame. */
export interface VaultWsHello {
  type: "hello";
  token: string;
  vault: string;
}

/** File extensions the vault serves. Markdown is the content set; the asset
 *  set renders as attachments (images inline, others as links). */
export const VAULT_MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;
export const VAULT_ASSET_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif",
  ".pdf", ".mp3", ".wav", ".m4a", ".mp4", ".webm", ".mov",
] as const;

/** Directories never scanned or watched, matched on any path segment. */
export const VAULT_IGNORED_SEGMENTS = [
  ".git", ".obsidian", ".trash", "node_modules", ".DS_Store",
] as const;

/** Build output and vendored dependencies, ignored ON TOP of the list above
 *  when the vault root is a code repository. Kept off plain note vaults: a
 *  folder called "build" in someone's notes is a topic, not a target dir. */
export const VAULT_REPO_IGNORED_SEGMENTS = [
  "dist", "build", "out", "target", "coverage",
  "vendor", "bower_components", "Pods", "DerivedData",
  "__pycache__", "venv",
] as const;

/** Inside a repo, a dot-directory is tooling by convention, so the whole class
 *  is ignored rather than enumerated — that way next year's `.somecache` is
 *  handled too. These are the exceptions: dot-directories people actually
 *  write markdown into. */
export const VAULT_REPO_ALLOWED_DOT_DIRS = [
  ".github", ".claude", ".cursor", ".codex",
] as const;

/** Directories a repo keeps its prose in. First match wins; see
 *  vaultScope.vaultProjectHome. */
export const VAULT_DOC_DIRS = ["docs", "doc", "wiki", "notes"] as const;

export function isVaultMarkdownPath(p: string): boolean {
  const lower = p.toLowerCase();
  return VAULT_MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isVaultAssetPath(p: string): boolean {
  const lower = p.toLowerCase();
  return VAULT_ASSET_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isVaultIgnoredPath(p: string): boolean {
  return p.split("/").some((seg) => (VAULT_IGNORED_SEGMENTS as readonly string[]).includes(seg));
}

/** The repo-only half of the rule, on ONE path segment. Callers walk segments
 *  themselves; vaultScope.isVaultPathIgnored is the predicate to use. */
export function isRepoIgnoredSegment(seg: string): boolean {
  if ((VAULT_REPO_IGNORED_SEGMENTS as readonly string[]).includes(seg)) return true;
  return seg.startsWith(".") && !(VAULT_REPO_ALLOWED_DOT_DIRS as readonly string[]).includes(seg);
}
