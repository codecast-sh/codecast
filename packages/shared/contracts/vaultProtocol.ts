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
   *  `cast files add`. The only difference downstream is how it is presented:
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

/** GET /vault/locate?path=<absolute local path> response: the vault that holds
 *  the path, registered on the spot when none did (vaultRegistry.locateVault),
 *  and the path's vault-relative form ("" for the root itself). 404 when the
 *  path does not exist on the daemon's machine. */
export interface VaultLocateResponse {
  vault: VaultInfo;
  rel: string;
  /** The located path's own row, so a link opens a file the scan leaves out
   *  (ignored, or past the entry cap). Absent from older daemons and for a
   *  path the vault would refuse to read. */
  entry?: VaultFileEntry;
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
  /** Present only when the scan was asked for ignored paths (`?ignored=1`):
   *  this entry is one the repo rules hide by default — build output, a
   *  .gitignore name, a tool dot-directory. Never prefetched or indexed, and
   *  not watched: it is a snapshot until the next scan. Writable only by a
   *  request that opts in with `ignored=1`. */
  ignored?: boolean;
}

export interface VaultScanResponse {
  vault: VaultInfo;
  files: VaultFileEntry[];
  /** Epoch ms when the scan ran (client uses as its sync watermark). */
  scanned_at: number;
  /** True when the root is a git checkout, so the repo ignore rules applied
   *  (vaultScope.isRepoVaultRoot). A plain notes folder hides nothing beyond the
   *  always-ignored set, so a "show ignored" control has nothing to offer it. */
  repo: boolean;
}

/** GET /vault/file response is the raw body with headers:
 *  X-Vault-Mtime: epoch ms, X-Vault-Size: bytes, ETag: sha256 prefix.
 *  This one route also accepts the bearer token as a `?token=` query param
 *  instead of the Authorization header, because an <img>/<video> src can set
 *  no headers at all. Reads only — PUT and /vault/op always require the header.
 *
 *  PUT /vault/file sends the raw body, written byte for byte (line endings and
 *  BOM untouched) with the file's mode bits kept. If-Match carries the
 *  last-seen ETag (or X-Vault-Base-Mtime the last-seen mtime); the compare and
 *  the write are one step per file, so of two PUTs carrying the same guard
 *  exactly one lands and the other gets 409 with the current body and its
 *  ETag / X-Vault-Mtime / X-Vault-Size headers, for the client to merge.
 *
 *  Writable paths (vaultScope.isVaultWritablePath): markdown and attachments,
 *  plus any file whose extension is not in VAULT_BINARY_EXTENSIONS. For a
 *  non-document path the body must be valid UTF-8 with no NUL byte, or the
 *  write is refused with 415 `{ error: "binary" }`. A path the repo rules hide
 *  (build output, a .gitignore name, a dot-file like `.env`) is writable only
 *  when the request carries `ignored=1`, on PUT and on /vault/op alike; the
 *  always-ignored set (.git, node_modules, ...) never is, in any letter case.
 *
 *  An existing file this process may not write (mode 0444, owned elsewhere)
 *  gets 403 `{ error: "read-only" }`; the client asks the person and resends
 *  with `force=1` to replace it anyway. */
export interface VaultWriteResponse {
  path: string;
  mtime: number;
  size: number;
  etag: string;
}

/** POST /vault/op request. Deletes go to the OS trash, never unlink. Create,
 *  rename and delete take the same writable-path rule as PUT (and the same
 *  `ignored=1` opt-in in the query), and a file cannot be renamed to a path
 *  PUT would refuse; folders rename and trash whatever they hold. Create is
 *  exclusive: 409 `{ error: "exists" }` if anything already holds the path. */
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

/**
 * Extensions that are binary by convention: compiled output, archives, media
 * the vault does not render, fonts, databases, office documents. A path here is
 * never written as source, whatever its bytes look like. It is a REFUSAL list,
 * not an allowlist: an extensionless script or a `.prisma` file nobody listed
 * is writable, and the body check (UTF-8, no NUL) catches binaries it misses.
 * The document set (markdown, attachments) is exempt: an attachment upload is
 * binary on purpose.
 */
export const VAULT_BINARY_EXTENSIONS = [
  // Executables, objects, libraries, bytecode
  ".exe", ".dll", ".so", ".dylib", ".a", ".lib", ".o", ".obj", ".ko", ".elf",
  ".class", ".jar", ".war", ".pyc", ".pyo", ".wasm", ".node", ".rlib", ".pdb",
  ".msi", ".apk", ".aab", ".ipa",
  // Archives and disk images
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".zst", ".lz4", ".7z", ".rar", ".tar",
  ".iso", ".dmg", ".pkg", ".deb", ".rpm", ".crx", ".xpi",
  // Images, audio and video outside the attachment set
  ".bmp", ".ico", ".icns", ".tif", ".tiff", ".heic", ".heif", ".psd", ".raw",
  ".cr2", ".nef", ".sketch", ".fig", ".xcf",
  ".flac", ".ogg", ".oga", ".opus", ".aac", ".aiff", ".mid", ".midi",
  ".mkv", ".avi", ".wmv", ".flv", ".m4v", ".mpg", ".mpeg",
  // Fonts
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  // Databases and binary data
  ".db", ".sqlite", ".sqlite3", ".mdb", ".parquet", ".avro", ".arrow", ".feather",
  ".npy", ".npz", ".pkl", ".pickle", ".h5", ".hdf5", ".onnx", ".pt", ".pth",
  ".safetensors", ".ckpt", ".tflite", ".lockb", ".bin", ".dat",
  // Office and design documents
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp",
  ".pages", ".numbers", ".car",
] as const;

const BINARY_EXTENSION_SET = new Set(VAULT_BINARY_EXTENSIONS.map((e) => e.toLowerCase()));

/** The lower-cased basename of a vault path. */
function baseNameOf(p: string): string {
  return (p.split("/").pop() ?? "").toLowerCase();
}

/** True when the path's extension marks it binary (VAULT_BINARY_EXTENSIONS).
 *  A dot-file (".env") has no extension: its whole name is the name. */
export function isVaultBinaryPath(p: string): boolean {
  const name = baseNameOf(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 && BINARY_EXTENSION_SET.has(name.slice(dot));
}

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
  return ALLOWED_DOT_DIR_SET.has(seg.toLowerCase());
}

// Segment rules match without case. macOS and Windows filesystems fold case, so
// `.GIT/hooks/pre-commit` IS `.git/hooks/pre-commit` there, and a case-sensitive
// match would let a write land in the one place it can run code. Folding on a
// case-sensitive filesystem too costs nothing: a `.GIT` or `Node_Modules`
// directory is never anyone's source.
const lowerSet = (xs: readonly string[]) => new Set(xs.map((x) => x.toLowerCase()));
const IGNORED_SEGMENT_SET = lowerSet(VAULT_IGNORED_SEGMENTS);
const REPO_IGNORED_SEGMENT_SET = lowerSet(VAULT_REPO_IGNORED_SEGMENTS);
const ALLOWED_DOT_DIR_SET = lowerSet(VAULT_REPO_ALLOWED_DOT_DIRS);

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
  const name = baseNameOf(p);
  if ((VAULT_TEXT_FILENAMES as readonly string[]).includes(name)) return true;
  // A leading-dot name with no further dot (".gitignore", ".env") IS its own
  // extension — endsWith would match it anyway, but a bare ".foo" that isn't
  // in the list should not fall through to some shorter suffix.
  return VAULT_TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * What kind of thing a vault file is, for the ONE switch every surface makes:
 * markdown gets the full reading/editing experience, an asset renders inline,
 * a known binary extension is declared unpreviewable, and everything else
 * opens as text. An unlisted extension (".cast", a bare "noextension") is far
 * more often text than not, and the viewer still declines a body whose bytes
 * hold a NUL, so a binary with an odd name never decodes into garbage.
 */
export type VaultFileKind = "markdown" | "asset" | "text" | "binary";

export function vaultFileKind(p: string): VaultFileKind {
  if (isVaultMarkdownPath(p)) return "markdown";
  if (isVaultAssetPath(p)) return "asset";
  if (isVaultBinaryPath(p)) return "binary";
  return "text";
}

export function isVaultIgnoredPath(p: string): boolean {
  return p.split("/").some((seg) => IGNORED_SEGMENT_SET.has(seg.toLowerCase()));
}

/** The repo-only half of the rule, on ONE path segment. Callers walk segments
 *  themselves; vaultScope.isVaultPathIgnored is the predicate to use. */
export function isRepoIgnoredSegment(seg: string): boolean {
  if (REPO_IGNORED_SEGMENT_SET.has(seg.toLowerCase())) return true;
  return seg.startsWith(".") && !isAllowedProseDotDir(seg);
}
