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
  | { op: "create"; path: string; content?: string };

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
