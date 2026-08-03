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
   *  opening there is a poor first impression; see vaultScope.probeProjectVault. */
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

/**
 * Largest file the browser pulls into the read-only viewer. Above it the file
 * still lists and still opens — it just says how big it is and offers Finder
 * instead of handing a 40MB bundle to a syntax highlighter. The client knows
 * every file's size from the scan, so it declines BEFORE the round trip.
 */
export const VAULT_MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * Largest file the daemon will read into memory to serve at all. Once the
 * servable set is "every file", a repo can hold a multi-gigabyte database or a
 * core dump, and `fs.readFile` on one would take the daemon down. Set well
 * above any real attachment so no existing image or video read regresses.
 */
export const VAULT_MAX_SERVE_BYTES = 32 * 1024 * 1024;

/** File extensions the vault serves. Markdown is the content set; the asset
 *  set renders as attachments (images inline, others as links). */
export const VAULT_MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;
export const VAULT_ASSET_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif",
  ".pdf", ".mp3", ".wav", ".m4a", ".mp4", ".webm", ".mov",
] as const;

/**
 * Files the browser will render as text in the read-only code viewer. This is a
 * PREVIEW list, not a scope list: the daemon serves every non-ignored file, and
 * anything missing here just falls through to the honest "no preview" state
 * rather than becoming a wall of mojibake. Extensions only — a `.min.js` is
 * still `.js`, and the size cap is what keeps a bundle out of the viewer.
 */
export const VAULT_TEXT_EXTENSIONS = [
  // Web / app code
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".html", ".htm", ".css", ".scss", ".sass", ".less", ".vue", ".svelte", ".astro",
  // Other languages
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".m", ".mm",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".pl", ".lua", ".r",
  ".ex", ".exs", ".erl", ".hs", ".clj", ".scala", ".dart", ".zig", ".nim",
  ".sql", ".graphql", ".gql", ".proto", ".sol",
  // Shell / config / data
  ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat",
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".env", ".properties", ".editorconfig", ".gitignore", ".gitattributes",
  ".xml", ".csv", ".tsv", ".txt", ".text", ".log", ".diff", ".patch",
  ".tf", ".tfvars", ".hcl", ".dockerfile", ".make", ".mk", ".cmake", ".gradle",
  ".rst", ".org", ".tex", ".bib", ".adoc",
] as const;

/** Text files with no extension at all. Lowercased comparison, so `makefile`
 *  and `Makefile` both match. */
export const VAULT_TEXT_FILENAMES = [
  "makefile", "dockerfile", "rakefile", "gemfile", "procfile", "brewfile",
  "justfile", "vagrantfile", "jenkinsfile", "caddyfile",
  "license", "licence", "notice", "authors", "contributors", "copying",
  "readme", "changelog", "todo", "codeowners", "version",
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
  // Whole duplicate checkouts of the repo. Admitting these is the single worst
  // thing a docs browser can do: every note appears once per worktree, so
  // search returns twenty copies of the same file, backlinks fan out across
  // checkouts, and the graph becomes disconnected clones of itself. Measured on
  // codecast: 17 agent worktrees held 700 of the 844 markdown files present.
  "worktrees",
] as const;

/** Inside a repo, a dot-directory is tooling by convention, so the whole class
 *  is ignored rather than enumerated — that way next year's `.somecache` is
 *  handled too. These are the exceptions: dot-directories people actually write
 *  markdown into.
 *
 *  They also OUTRANK .gitignore. `.claude/` is gitignored in most repos that
 *  have one (codecast included) and yet holds hand-written design docs — being
 *  untracked is not the same as being uninteresting, and hiding a directory of
 *  someone's own prose is the one mistake this feature cannot afford. Junk
 *  inside them is still caught by the ordinary segment rules, which is what
 *  keeps `.claude/worktrees/` out. */
export const VAULT_REPO_ALLOWED_DOT_DIRS = [
  ".github", ".claude", ".cursor", ".codex",
] as const;

/** True for a dot-directory we deliberately keep, whatever .gitignore says. */
export function isAllowedProseDotDir(seg: string): boolean {
  return (VAULT_REPO_ALLOWED_DOT_DIRS as readonly string[]).includes(seg);
}

/** Directories a repo keeps its prose in. First match wins; see
 *  vaultScope.probeProjectVault. */
export const VAULT_DOC_DIRS = ["docs", "doc", "wiki", "notes"] as const;

export function isVaultMarkdownPath(p: string): boolean {
  const lower = p.toLowerCase();
  return VAULT_MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isVaultAssetPath(p: string): boolean {
  const lower = p.toLowerCase();
  return VAULT_ASSET_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** True for a file the code viewer can render as text. */
export function isVaultTextPath(p: string): boolean {
  const name = (p.split("/").pop() ?? "").toLowerCase();
  if ((VAULT_TEXT_FILENAMES as readonly string[]).includes(name)) return true;
  // A leading-dot name with no further dot (".gitignore", ".env") IS its own
  // extension — endsWith would match it anyway, but a bare ".foo" that isn't
  // in the list should not fall through to some shorter suffix.
  return VAULT_TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * What kind of thing a vault file is, for the ONE switch every surface makes:
 * markdown gets the full reading/editing experience, an asset renders inline,
 * text opens read-only in the code viewer, and everything else is honestly
 * declared unpreviewable rather than decoded into garbage.
 */
export type VaultFileKind = "markdown" | "asset" | "text" | "binary";

export function vaultFileKind(p: string): VaultFileKind {
  if (isVaultMarkdownPath(p)) return "markdown";
  if (isVaultAssetPath(p)) return "asset";
  if (isVaultTextPath(p)) return "text";
  return "binary";
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
