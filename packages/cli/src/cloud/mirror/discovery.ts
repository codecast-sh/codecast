import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
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
  ".netrc", ".npmrc", ".pgpass", ".codecast", ".config/opencode/plugins/codecast-stable.js",
  "*.pem", "id_*", "*.key", "credentials*.json", "hosts.yml", "auth.json", "auth.json.*", "oauth_creds.json", ".env", ".env.*",
];
export const DEFAULT_EXCLUDES: readonly string[] = [
  "**/node_modules/**", "**/.git/**", "**/__pycache__/**", "**/.DS_Store", "**/*.log",
  "**/.venv/**", "**/venv/**", "**/.plugin-appserver/**", "**/*.sqlite*", "**/*.db", "**/*.db-*",
  "**/.codecast/**", "**/.conductor/**", "**/.worktrees/**", "**/.next/**", "**/.turbo/**", "**/.cache/**",
  "**/*.jsonl", "**/*.lock", "**/*.sock", "**/*.pid", "**/*.pyc", "**/*.dylib", "**/*.dll", "**/*.exe", "**/*.so", "**/*.node",
];

export function globToRegExp(glob: string): RegExp {
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
  return new RegExp(`^${re}$`);
}

export function matchesContextPattern(pattern: string, rel: string, isDir = false): boolean {
  if (/[*?]/.test(pattern) && !pattern.includes("/")) return !isDir && globToRegExp(pattern).test(path.posix.basename(rel));
  const base = pattern.replace(/\/\*\*$/, "");
  return rel === base || rel.startsWith(`${base}/`) || globToRegExp(pattern).test(rel);
}

export function isDeniedPath(rel: string, isDir = false): boolean {
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
  for (const m of text.matchAll(new RegExp(`(["'\x60])(${prefix}[^\\n]*?)\\1`, "g"))) add(m[2]!);
  for (const m of text.matchAll(new RegExp(`${prefix}[^\\s"'\x60<>()[\\]{},;]+`, "g"))) add(m[0].replace(/[.:]+$/, ""));
  for (const m of text.matchAll(/\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))/g)) add(m[1] ?? m[2]!);
  for (const m of text.matchAll(/["'`]((?:\.\.?\/)[^"'`\n]+)["'`]/g)) add(m[1]!);
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

export function collectProjectContext(opts: ProjectContextOptions): ProjectContext {
  const root = fs.realpathSync(opts.root);
  const home = fs.realpathSync(opts.home ?? os.homedir());
  const result: ProjectContext = { files: [], skipped: [], warnings: [], totalBytes: 0 };
  const files = new Map<string, ProjectContextFile>();
  const scanned = new Set<string>();
  const excludes = configPatterns(opts.config?.cloud_mirror_exclude);
  const tracked = new Set<string>();
  if (opts.includeTracked === false) {
    const r = spawnSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) throw new Error(`project context git enumeration failed: ${r.error.message}`);
    if (r.status === 0) for (const rel of r.stdout.split("\0")) if (rel) tracked.add(rel);
  }
  const denied = (abs: string, directory: boolean) => {
    const rel = homeRelative(abs, root);
    const homeRel = homeRelative(abs, home);
    return [rel, homeRel].some((p) => p !== null && (isDeniedPath(p, directory) || isDefaultExcluded(p) || isCodecastOwnedHomePath(p) || excludes.some((g) => matchesContextPattern(g, p, directory))));
  };
  const visit = (source: string, ancestors: Set<string>, includeAll = false) => {
    const logical = path.resolve(source);
    if (homeRelative(logical, root) === null && homeRelative(logical, home) === null) return;
    const stat = fs.lstatSync(logical, { throwIfNoEntry: false });
    if (!stat || denied(logical, stat.isDirectory())) return;
    let real: string;
    try { real = fs.realpathSync(logical); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" && (err as NodeJS.ErrnoException).code !== "ELOOP") throw err;
      result.skipped.push({ path: logical, reason: "dangling or cyclic symlink" });
      return;
    }
    const actual = fs.statSync(real);
    if (homeRelative(real, root) === null && homeRelative(real, home) === null || denied(real, actual.isDirectory())) {
      result.skipped.push({ path: logical, reason: "symlink resolves outside context roots or into a denied path" });
      return;
    }
    if (actual.isDirectory()) {
      if (ancestors.has(real)) { result.skipped.push({ path: logical, reason: "symlink cycle" }); return; }
      const chain = new Set(ancestors).add(real);
      for (const name of fs.readdirSync(real).sort()) visit(path.join(logical, name), chain, includeAll);
      return;
    }
    if (!actual.isFile() || scanned.has(logical)) return;
    const projectRel = homeRelative(logical, root);
    const scope = projectRel === null ? "home" : "project";
    const rel = projectRel ?? homeRelative(logical, home)!;
    const agentFile = AGENT_CONTEXT_ROOTS.some((r) => rel.startsWith(`${r}/`)) || /(?:^|\/)\.(?:claude|codex|gemini|grok|opencode|agents)\//.test(rel);
    const instruction = INSTRUCTION_FILE_RE.test(path.basename(rel));
    const document = /\.(?:md|mdx|rst|txt|adoc|org)$/i.test(rel);
    const support = /(?:^|\/)(?:docs|scripts|agent-scripts|references|assets)\//.test(rel);
    if (!includeAll && !agentFile && !instruction && !document && !support && rel !== ".mcp.json") return;
    scanned.add(logical);
    const fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const prefix = Buffer.alloc(4);
      fs.readSync(fd, prefix, 0, 4, 0);
      if (isNativeBinary(prefix)) { result.skipped.push({ path: logical, reason: "native binary" }); return; }
      if (actual.size + result.totalBytes > (opts.maxBytes ?? CONTEXT_SIZE_CAP)) throw new Error(`project context exceeds ${(opts.maxBytes ?? CONTEXT_SIZE_CAP) / 1048576} MiB at ${logical}`);
      bytes = fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
    const emit = scope !== "project" || opts.includeTracked !== false || !tracked.has(rel);
    if (emit) {
      files.set(`${scope}:${rel}`, { sourcePath: logical, relativePath: rel, scope, kind: kindForPath(rel), mode: actual.mode & 0o100 ? "0700" : "0600", bytes });
      result.totalBytes += bytes.length;
    }
    const text = portableText(bytes);
    if (text !== null) {
      result.warnings.push(...commandCompatibilityWarnings(text, rel));
      for (const ref of contextReferences(text, logical, home)) {
        const st = fs.lstatSync(ref, { throwIfNoEntry: false });
        if (st && (!st.isDirectory() || isReferencedDirectory(ref))) visit(ref, new Set(), true);
      }
    }
  };
  visit(root, new Set());
  if (opts.includeAncestors !== false) {
    for (let dir = path.dirname(root); homeRelative(dir, home) !== null; dir = path.dirname(dir)) {
      for (const name of fs.readdirSync(dir)) if (INSTRUCTION_FILE_RE.test(name) || name === ".mcp.json") visit(path.join(dir, name), new Set(), true);
      if (dir === home) break;
    }
  }
  for (const extra of configPatterns(opts.config?.cloud_mirror_include)) visit(path.resolve(home, extra), new Set(), true);
  result.files = [...files.values()].sort((a, b) => a.scope.localeCompare(b.scope) || a.relativePath.localeCompare(b.relativePath));
  result.warnings = [...new Set(result.warnings)];
  return result;
}
