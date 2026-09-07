import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { isCodecastOwnedHomePath } from "../../codecastOwned.js";
import type { Config } from "../../config/types.js";
import { homeRelative, kindForPath, portableText, type MirrorKind } from "./transform.js";

export const AGENT_CONTEXT_ROOTS = [".claude", ".codex", ".gemini", ".grok", ".opencode", ".agents", ".config/opencode"] as const;
export const CONTEXT_SIZE_CAP = 256 * 1024 * 1024;
export const INSTRUCTION_FILE_RE = /^(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI|GROK|OPENCODE)\.md$/i;
export const CONTEXT_DENYLIST: readonly string[] = [
  ".claude/.credentials.json", ".claude.json", ".claude/history.jsonl",
  ".claude/sessions", ".claude/session-env", ".claude/shell-snapshots", ".claude/file-history",
  ".claude/backups", ".claude/cache", ".claude/downloads", ".claude/todos", ".claude/statsig",
  ".claude/chrome", ".claude/daemon", ".claude/debug", ".claude/feedback", ".claude/image-cache",
  ".claude/jobs", ".claude/paste-cache", ".claude/tasks", ".claude/teams", ".claude/telemetry", ".claude/worktrees",
  ".claude/daemon-auth-status.json", ".claude/daemon-auth-cooldown", ".claude/stats-cache.json",
  ".codex/auth.json", ".codex/sessions", ".codex/archived_sessions", ".codex/cache", ".codex/tmp", ".codex/.tmp",
  ".codex/shell_snapshots", ".codex/thread-writer-locks", ".codex/models_cache.json", ".codex/installation_id",
  ".codex/browser", ".codex/computer-use", ".codex/dictation-history", ".codex/history", ".codex/ipc",
  ".codex/log", ".codex/node_repl", ".codex/process_manager", ".codex/sqlite", ".codex/vendor_imports",
  ".codex/attachments", ".codex/generated_images", ".codex/visualizations", ".codex/ambient-suggestions",
  ".codex/.codex-global-state.json", ".codex/.codex-global-state.json.bak", ".codex/chrome-native-hosts-v2.json",
  ".codex/realtime-voice-continuity.json", ".grok/sessions", ".grok/active_sessions.json", ".grok/agent_id",
  ".grok/logs", ".grok/memtrace", ".grok/relocations", ".grok/upload_queue", ".grok/models_cache.json",
  ".gemini/oauth_creds.json", ".gemini/google_accounts.json", ".gemini/tmp", ".gemini/history",
  ".config/gh", ".config/gcloud", ".ssh", ".aws", ".gnupg", ".kube", ".docker/config.json",
  "Library", "Applications", ".Trash", ".mozilla", ".config/google-chrome", ".config/chromium",
  ".netrc", ".npmrc", ".pgpass", ".codecast", ".config/opencode/plugins/codecast-stable.js",
  "*.pem", "id_*", "*.key", "*.sqlite*", "credentials*.json", "hosts.yml", "auth.json", "auth.json.*", "oauth_creds.json", ".env", ".env.*",
];
export const DEFAULT_EXCLUDES: readonly string[] = [
  "**/node_modules/**", "**/.git/**", "**/__pycache__/**", "**/.DS_Store", "**/*.log",
  "**/.venv/**", "**/venv/**", "**/.plugin-appserver/**", "**/*.sqlite*", "**/*.db", "**/*.db-*",
  "**/.codecast/**", "**/.conductor/**", "**/.worktrees/**", "**/.next/**", "**/.turbo/**", "**/.cache/**",
  "**/.build/**", "**/Pods/**", "**/DerivedData/**", "**/.gradle/**", "**/.expo/**",
  "**/*.jsonl", "**/*.lock", "**/*.sock", "**/*.pid", "**/*.pyc", "**/*.dylib", "**/*.dll", "**/*.exe", "**/*.so", "**/*.node",
];

const globCache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = globCache.get(glob);
  if (cached) return cached;
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const compiled = new RegExp(`^${re}$`);
  globCache.set(glob, compiled);
  return compiled;
}

export function matchesContextPattern(pattern: string, rel: string, isDir = false): boolean {
  if (/[*?]/.test(pattern) && !pattern.includes("/")) return !isDir && globToRegExp(pattern).test(path.posix.basename(rel));
  const base = pattern.replace(/\/\*\*$/, "");
  return rel === base || rel.startsWith(`${base}/`) || /[*?]/.test(pattern) && globToRegExp(pattern).test(rel);
}

export function isDeniedPath(rel: string, isDir = false): boolean {
  if (!isDir && (/(?:^|\/)\.env(?:\.[^/]*)?$/.test(rel) || ["auth.json", ".credentials.json", "oauth_creds.json", "google_accounts.json", "hosts.yml", ".netrc", ".npmrc", ".pgpass"].includes(path.posix.basename(rel)))) return true;
  if (rel.startsWith(".claude/projects/")) {
    const parts = rel.split("/");
    if (parts.length > 3 && parts[3] !== "memory") return true;
    if (parts.length === 3 && !isDir) return true;
  }
  return CONTEXT_DENYLIST.some((p) => matchesContextPattern(p, rel, isDir));
}

export function isDefaultExcluded(rel: string): boolean {
  return DEFAULT_EXCLUDES.some((p) => globToRegExp(p).test(rel) || globToRegExp(p).test(`${rel}/`));
}

export function isNativeBinary(bytes: Buffer): boolean {
  const magic = bytes.subarray(0, 4).toString("hex");
  return bytes.subarray(0, 2).toString() === "MZ" || ["7f454c46", "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"].includes(magic);
}

export function configPatterns(value: string | undefined): string[] {
  return (value ?? "").split(",").map((p) => p.trim().replace(/^~\//, "").replace(/^\.\//, "")).filter(Boolean);
}

export function contextReferences(text: string, sourcePath: string, home: string): string[] {
  const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = `(?:${escapedHome}/|~/|\\$HOME/|\\$\\{HOME\\}/)`;
  const found = new Set<string>();
  const add = (raw: string) => {
    const clean = raw.replace(/:[0-9]+(?::[0-9]+)?$/, "").split("#")[0]!;
    if (!clean || /^[a-z]+:\/\//i.test(clean)) return;
    const expanded = clean.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home);
    const abs = path.resolve(path.dirname(sourcePath), expanded);
    found.add(abs);
  };
  for (const m of text.matchAll(new RegExp(`(["'\x60])(${prefix}[^\\n"'\x60]{1,4096}?)\\1`, "g"))) add(m[2]!);
  for (const m of text.matchAll(new RegExp(`${prefix}[^\\s"'\x60<>()[\\]{},;]{1,4096}`, "g"))) add(m[0].replace(/[.:]+$/, ""));
  for (const m of text.matchAll(/\[[^\]\n]{0,500}\]\((?:<([^>\n]{1,4096})>|([^\s)]{1,4096}))/g)) add(m[1] ?? m[2]!);
  for (const m of text.matchAll(/["'`]((?:\.\.?\/)[^"'`\n]{1,4096})["'`]/g)) add(m[1]!);
  for (const m of text.matchAll(/(?:^|\s)@((?:\.?\.?\/)?[\w./-]+\.[\w-]+)/gm)) add(m[1]!);
  return [...found];
}

export function isReferencedDirectory(abs: string): boolean {
  return /(?:^|\/)(?:agent-scripts|scripts|skills|docs|rules|commands|hooks|references|assets|memory|memories|prompts|agents)(?:\/|$)/.test(abs);
}

export function commandCompatibilityWarnings(text: string, rel: string): string[] {
  const found = [...new Set(text.match(/\/Applications\/[^\s"'`]+|\/(?:opt\/homebrew|usr\/local\/Cellar)\/[^\s"'`]+|\b(?:osascript|xcrun|pbcopy|pbpaste)\b|\bopen\s+-a\b/g) ?? [])];
  return found.map((command) => `${rel}: host compatibility requires review for ${command}`);
}

export interface ProjectContextFile {
  sourcePath: string;
  relativePath: string;
  scope: "project" | "home";
  kind: MirrorKind;
  mode: "0600" | "0700";
  bytes: Buffer;
}

export interface ProjectContextOptions {
  root: string;
  home?: string;
  includeTracked?: boolean;
  includeAncestors?: boolean;
  config?: Pick<Config, "cloud_mirror_include" | "cloud_mirror_exclude"> | null;
  maxBytes?: number;
}

export interface ProjectContext {
  files: ProjectContextFile[];
  skipped: Array<{ path: string; reason: string }>;
  warnings: string[];
  totalBytes: number;
}

function isContextFile(rel: string): boolean {
  return AGENT_CONTEXT_ROOTS.some((r) => rel.startsWith(`${r}/`))
    || /(?:^|\/)\.(?:claude|codex|gemini|grok|opencode|agents)\//.test(rel)
    || INSTRUCTION_FILE_RE.test(path.basename(rel))
    || /\.(?:md|mdx|rst|txt|adoc|org)$/i.test(rel)
    || /(?:^|\/)(?:docs|scripts|agent-scripts|references|assets)\//.test(rel)
    || path.basename(rel) === ".mcp.json";
}

function* projectContextSteps(opts: ProjectContextOptions): ContextSteps<ProjectContext> {
  const root: string = yield { op: "realpath", path: opts.root };
  const home: string = yield { op: "realpath", path: opts.home ?? os.homedir() };
  const result: ProjectContext = { files: [], skipped: [], warnings: [], totalBytes: 0 };
  const files = new Map<string, ProjectContextFile>();
  const scanned = new Set<string>();
  const scannedDirs = new Set<string>();
  const scannedReferences = new Set<string>();
  const excludes = configPatterns(opts.config?.cloud_mirror_exclude);
  const tracked = new Set<string>();
  if (opts.includeTracked === false) {
    const paths: string[] = yield { op: "tracked", path: root };
    for (const rel of paths) tracked.add(rel);
  }
  const denied = (abs: string, directory: boolean) => {
    const rel = homeRelative(abs, root);
    const homeRel = homeRelative(abs, home);
    return [rel, homeRel].some((p) => p !== null && (isDeniedPath(p, directory) || isDefaultExcluded(p) || isCodecastOwnedHomePath(p) || excludes.some((g) => matchesContextPattern(g, p, directory))));
  };
  const visit = function* (source: string, ancestors: Set<string>, includeAll = false): ContextSteps<void> {
    const logical = path.resolve(source);
    if (homeRelative(logical, root) === null && homeRelative(logical, home) === null || denied(logical, true)) return;
    const projectPath = homeRelative(logical, root);
    if (!includeAll && projectPath && /(?:^|\/)(?:dist(?:-[^/]+)?|build|target)(?:\/|$)/.test(projectPath) && !/(?:^|\/)\.(?:claude|codex|gemini|grok|opencode|agents)\//.test(projectPath)) return;
    const stat: fs.Stats | undefined = yield { op: "lstat", path: logical };
    if (!stat || denied(logical, stat.isDirectory())) return;
    if (stat.isFile() && !includeAll && !isContextFile(homeRelative(logical, root) ?? homeRelative(logical, home)!)) return;
    let real: string;
    try { real = yield { op: "realpath", path: logical }; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ELOOP") throw err;
      result.skipped.push({ path: logical, reason: "dangling or cyclic symlink" });
      return;
    }
    const actual: fs.Stats = yield { op: "stat", path: real };
    if (homeRelative(real, root) === null && homeRelative(real, home) === null || denied(real, actual.isDirectory())) {
      result.skipped.push({ path: logical, reason: "symlink resolves outside context roots or into a denied path" });
      return;
    }
    if (actual.isDirectory()) {
      if (scannedDirs.has(logical)) return;
      if (ancestors.has(real)) { result.skipped.push({ path: logical, reason: "symlink cycle" }); return; }
      scannedDirs.add(logical);
      const chain = new Set(ancestors).add(real);
      const names: string[] = yield { op: "readdir", path: real };
      for (const name of names.sort()) yield* visit(path.join(logical, name), chain, includeAll);
      return;
    }
    if (!actual.isFile() || scanned.has(logical)) return;
    const projectRel = homeRelative(logical, root);
    const scope = projectRel === null ? "home" : "project";
    const rel = projectRel ?? homeRelative(logical, home)!;
    if (!includeAll && !isContextFile(rel)) return;
    const prefix: Buffer = yield { op: "prefix", path: real };
    if (isNativeBinary(prefix)) { result.skipped.push({ path: logical, reason: "native binary" }); return; }
    if (actual.size + result.totalBytes > (opts.maxBytes ?? CONTEXT_SIZE_CAP)) throw new Error(`project context exceeds ${(opts.maxBytes ?? CONTEXT_SIZE_CAP) / 1048576} MiB at ${logical}`);
    const bytes: Buffer = yield { op: "bytes", path: real };
    scanned.add(logical);
    const emit = scope !== "project" || opts.includeTracked !== false || !tracked.has(rel);
    if (emit) {
      files.set(`${scope}:${rel}`, { sourcePath: logical, relativePath: rel, scope, kind: kindForPath(rel), mode: actual.mode & 0o100 ? "0700" : "0600", bytes });
      result.totalBytes += bytes.length;
    }
    const text = portableText(bytes);
    if (text !== null) {
      result.warnings.push(...commandCompatibilityWarnings(text, rel));
      for (const ref of contextReferences(text, logical, home)) {
        if (scanned.has(ref) || scannedDirs.has(ref) || scannedReferences.has(ref) && !isActiveConfig(kindForPath(rel))) continue;
        scannedReferences.add(ref);
        if (homeRelative(ref, root) === null && homeRelative(ref, home) === null) { result.skipped.push({ path: ref, reason: "reference outside context roots" }); continue; }
        if (denied(ref, true)) { result.skipped.push({ path: ref, reason: "excluded reference or unsupported host dependency" }); continue; }
        try {
          const st: fs.Stats | undefined = yield { op: "lstat", path: ref };
          if (!st) { result.skipped.push({ path: ref, reason: "referenced path not found" }); continue; }
          if (!st.isDirectory() || isReferencedDirectory(ref)) yield* visit(ref, new Set(), true);
        } catch (err) {
          if (isActiveConfig(kindForPath(rel)) || !isAccessError(err)) throw err;
          result.skipped.push({ path: ref, reason: `optional reference inaccessible (${(err as NodeJS.ErrnoException).code})` });
        }
      }
    }
  };
  yield* visit(root, new Set());
  if (opts.includeAncestors !== false) {
    for (let dir = path.dirname(root); homeRelative(dir, home) !== null; dir = path.dirname(dir)) {
      const names: string[] = yield { op: "readdir", path: dir };
      for (const name of names) if (INSTRUCTION_FILE_RE.test(name) || name === ".mcp.json") yield* visit(path.join(dir, name), new Set(), true);
      if (dir === home) break;
    }
  }
  for (const extra of configPatterns(opts.config?.cloud_mirror_include)) yield* visit(path.resolve(home, extra), new Set(), true);
  result.files = [...files.values()].sort((a, b) => a.scope.localeCompare(b.scope) || (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  result.warnings = [...new Set(result.warnings)];
  return result;
}


type ContextOperation = { op: "lstat" | "realpath" | "stat" | "readdir" | "prefix" | "bytes" | "tracked"; path: string };
type ContextSteps<T> = Generator<ContextOperation, T, any>;

export function isActiveConfig(kind: MirrorKind): boolean {
  return ["claude-settings", "codex-toml", "codex-hooks", "gemini-settings", "opencode-json", "json-remap", "toml-remap"].includes(kind);
}

export function isAccessError(err: unknown): boolean {
  return ["EACCES", "EPERM", "ENOENT", "ENOTDIR"].includes((err as NodeJS.ErrnoException)?.code ?? "");
}

function trackedFiles(stdout: string, stderr: string, code: number | null): string[] {
  if (code !== 0 && !stderr.includes("not a git repository")) throw new Error(`project context git enumeration failed (exit ${code})`);
  return code === 0 ? stdout.split("\0").filter(Boolean) : [];
}

function executeContextSync(op: ContextOperation): unknown {
  if (op.op === "lstat") return fs.lstatSync(op.path, { throwIfNoEntry: false });
  if (op.op === "realpath") return fs.realpathSync(op.path);
  if (op.op === "stat") return fs.statSync(op.path);
  if (op.op === "readdir") return fs.readdirSync(op.path);
  if (op.op === "tracked") {
    const r = spawnSync("git", ["-C", op.path, "ls-files", "-z"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (process.env.CLOUD_CONTEXT_TRACE) fs.appendFileSync(process.env.CLOUD_CONTEXT_TRACE, JSON.stringify({ printf: spawnSync("printf", ["capture-test"], { encoding: "utf8" }).stdout, git: Bun.which("git"), env: Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith("GIT"))), op, r, bun: Bun.spawnSync(["git", "-C", op.path, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" }).stdout.toString() }) + "\n");
    return trackedFiles(r.stdout, r.stderr, r.status);
  }
  const fd = fs.openSync(op.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (op.op === "bytes") return fs.readFileSync(fd);
    const prefix = Buffer.alloc(4);
    fs.readSync(fd, prefix, 0, 4, 0);
    return prefix;
  } finally { fs.closeSync(fd); }
}

async function executeContextAsync(op: ContextOperation): Promise<unknown> {
  if (op.op === "lstat") return fs.promises.lstat(op.path).catch((err: NodeJS.ErrnoException) => { if (err.code !== "ENOENT") throw err; return undefined; });
  if (op.op === "realpath") return fs.promises.realpath(op.path);
  if (op.op === "stat") return fs.promises.stat(op.path);
  if (op.op === "readdir") return fs.promises.readdir(op.path);
  if (op.op === "tracked") return new Promise((resolve, reject) => {
    execFile("git", ["-C", op.path, "ls-files", "-z"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stderr.includes("not a git repository")) { reject(new Error("project context git enumeration failed")); return; }
      resolve(trackedFiles(stdout, stderr, err ? 1 : 0));
    });
  });
  const fd = await fs.promises.open(op.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (op.op === "bytes") return await fd.readFile();
    const prefix = Buffer.alloc(4);
    await fd.read(prefix, 0, 4, 0);
    return prefix;
  } finally { await fd.close(); }
}

export function collectProjectContext(opts: ProjectContextOptions): ProjectContext {
  const steps = projectContextSteps(opts);
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try { value = executeContextSync(next.value); } catch (err) { next = steps.throw(err); continue; }
    next = steps.next(value);
  }
  return next.value;
}

export async function collectProjectContextAsync(opts: ProjectContextOptions): Promise<ProjectContext> {
  const steps = projectContextSteps(opts);
  let next = steps.next();
  while (!next.done) {
    let value: unknown;
    try { value = await executeContextAsync(next.value); } catch (err) { next = steps.throw(err); continue; }
    next = steps.next(value);
  }
  return next.value;
}
