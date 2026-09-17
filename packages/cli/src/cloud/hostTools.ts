/**
 * Project-required runtimes and tools on a cloud host: what the laptop's
 * mirrored home and the repo need to actually run there, and one idempotent
 * script that checks and installs them user-locally.
 *
 * `requiredHostTools` derives the set on the laptop: the agent CLIs at the
 * laptop's versions (codex, gemini, grok, claude, opencode, pi), a Node whose major
 * satisfies the installed convex package's engines (else the repo's own
 * pin, else the laptop's node — never below NODE_FLOOR_MAJOR, the Convex
 * CLI on apt's node 18 was already hit in a migration), bun at the laptop's
 * version, gh, uv when any mirrored hook/skill calls it, and helper commands
 * named by settings.json hook commands or the shebang/first tokens of
 * ~/.claude/hooks/*.sh and ~/.claude/skills/**\/*.sh. Mach-O executables
 * under those dirs cannot run on Linux: they are reported by path under
 * `unsupported`, never copied or executed.
 *
 * `hostToolsScript` runs on the host under `bash -c "$(cat)"`: `command -v`
 * per tool, a major/version compare for node/bun, installs of what is
 * missing (node tarball into ~/.local/node-<ver>, extracted in a temp dir
 * and renamed so an interrupted download leaves nothing half-built; bun's
 * installer pinned; gh from its release tarball into ~/.local/bin; uv's
 * installer; codex/gemini/pi through `bun install -g`; grok, claude and
 * opencode through their installers with the version argument). Never sudo for a package,
 * never a distro package: apt's node stays for novnc. The one root touch is
 * a best-effort `sudo -n ln -sf` of node/npm/npx into /usr/local/bin, the
 * only place that shadows /usr/bin/node on the daemon's PATH
 * (/usr/local/bin:/usr/bin:/bin:~/.local/bin). On a non-Linux host (the
 * Scaleway Macs) the script only checks. It prints one JSON line
 * `{ ok, installed, missing, unsupported }` and writes it to
 * ~/.codecast/host-tools.json for `cast hosts ls`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { INSTALLABLE_CLIENTS, parseClientVersion, readInstalledClientVersions, type InstallableClient } from "../remote/agentAuth.js";
import { remoteHome, shq, sshBase, type RemoteHost } from "../remote/session-move.js";
import { ghWrapperInstallSnippet, realGhFunction, REAL_GH_REL } from "./ghWrapper.js";
import {
  emptyOverrides, normalizeCommand, parseHostMcpOverrides, reconcilePins, serializeHostMcpOverrides, HOST_MCP_OVERRIDES_FILE,
  type HostMcpOverrides, type McpClassified, type McpHarness, type McpSourceServer, type McpStatus,
} from "./hostMcpOverrides.js";
import type { ProjectRegistration } from "./mirror/projectRefresh.js";
import { remapContextPaths, splitTomlTables, tableFirstSegment } from "./mirror/transform.js";

/**
 * The remote command the tools script runs under: the host git script's
 * `bash -c "$(cat)"` with a distinct $0, so a test's fake ssh can tell the
 * two apart (this one downloads tarballs; a test must never run it).
 */
export const HOST_TOOLS_REMOTE_COMMAND = 'bash -c "$(cat)" cast-host-tools';

/** The Node the host gets when its own is too old (nodejs.org/dist tarball). */
export const NODE_22_VERSION = "22.12.0";
/** The major that tarball provides — the most any install here can satisfy. */
export const NODE_INSTALL_MAJOR = Number(NODE_22_VERSION.split(".")[0]);
/** No host runs a Node older than this whatever the repo says (the Convex CLI needs it). */
export const NODE_FLOOR_MAJOR = 20;
/** The gh release installed when the laptop has no gh to copy the version of. */
export const GH_DEFAULT_VERSION = "2.86.0";

export interface HostToolRequirement {
  tool: string;
  /** Pinned version when known (x.y.z, or a major for node). */
  version?: string;
  /** The laptop file that names it (a hook, a skill, settings.json). */
  referenced_by?: string;
}

export interface UnsupportedItem {
  tool: string;
  referenced_by: string;
  reason: string;
}

export interface RequiredHostTools {
  node: { minMajor: number; install: string; source: string };
  /** The laptop's bun version, when bun is installed here. */
  bun?: string;
  clients: Partial<Record<InstallableClient, string>>;
  /** gh, uv and helper commands, with what referenced them. */
  tools: HostToolRequirement[];
  unsupported: UnsupportedItem[];
  /** The laptop's MCP servers (codex config.toml, ~/.claude.json), each with its host-side command and static verdict. */
  mcp?: McpCheck[];
}

// ---------------------------------------------------------------------------
// Node requirement
// ---------------------------------------------------------------------------

/** The lowest major a semver range accepts (`>=18.0.0` → 18, `^20 || >=22` → 20, `22.x` → 22), or undefined. */
export function minMajorOfRange(range: string | undefined): number | undefined {
  if (typeof range !== "string") return undefined;
  const majors = [...range.matchAll(/(\d+)(?:\.\d+|\.x|\.\*)*/g)].map((m) => Number(m[1])).filter((n) => Number.isFinite(n));
  return majors.length ? Math.min(...majors) : undefined;
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * Where the node requirement comes from, in order: the installed convex
 * package's engines (packages/convex first, then the repo root), the repo's
 * .nvmrc / .node-version / package.json engines, the laptop's node major.
 */
export function nodeRequirement(repoRoot: string | undefined, laptopNodeMajor: number | undefined): RequiredHostTools["node"] {
  const candidates: Array<{ major: number | undefined; source: string }> = [];
  if (repoRoot) {
    for (const rel of ["packages/convex/node_modules/convex/package.json", "node_modules/convex/package.json"]) {
      const pkg = readJson(path.join(repoRoot, rel));
      if (pkg) { candidates.push({ major: minMajorOfRange(pkg?.engines?.node), source: `convex ${pkg.version ?? ""} engines`.trim() }); break; }
    }
    for (const rel of [".nvmrc", ".node-version"]) {
      const text = readText(path.join(repoRoot, rel));
      if (text) candidates.push({ major: minMajorOfRange(text.trim().replace(/^v/, "")), source: rel });
    }
    const pkg = readJson(path.join(repoRoot, "package.json"));
    if (pkg?.engines?.node) candidates.push({ major: minMajorOfRange(pkg.engines.node), source: "package.json engines" });
  }
  // The laptop's own node is a hint, not a pin: a laptop on 24 with no repo
  // pin must not make a host on the installable 22 "missing" forever.
  if (laptopNodeMajor !== undefined) candidates.push({ major: Math.min(laptopNodeMajor, NODE_INSTALL_MAJOR), source: laptopNodeMajor > NODE_INSTALL_MAJOR ? `laptop node (capped at ${NODE_INSTALL_MAJOR})` : "laptop node" });
  const pick = candidates.find((c) => c.major !== undefined);
  const major = pick?.major ?? NODE_FLOOR_MAJOR;
  return {
    minMajor: Math.max(NODE_FLOOR_MAJOR, major),
    install: NODE_22_VERSION,
    source: pick ? (major < NODE_FLOOR_MAJOR ? `${pick.source} (raised to ${NODE_FLOOR_MAJOR})` : pick.source) : `floor ${NODE_FLOOR_MAJOR}`,
  };
}

// ---------------------------------------------------------------------------
// Helper commands from hooks and skills
// ---------------------------------------------------------------------------

/** Commands the base provisioning guarantees, shell builtins, and words that are not programs. */
const KNOWN_ON_HOST: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "env", "git", "python3", "python", "curl", "wget", "tar", "gzip", "unzip", "zip", "tmux", "rsync", "ssh", "scp", "jq",
  "cat", "ls", "grep", "egrep", "fgrep", "sed", "awk", "mkdir", "rm", "rmdir", "cp", "mv", "ln", "date", "dirname", "basename", "head", "tail", "sort",
  "uniq", "wc", "tr", "cut", "find", "xargs", "sleep", "touch", "chmod", "chown", "tee", "printf", "echo", "test", "true", "false", "which", "command",
  "type", "pwd", "readlink", "realpath", "stat", "kill", "ps", "pgrep", "pkill", "id", "whoami", "hostname", "uname", "df", "du", "mktemp", "tail", "seq",
  "expr", "diff", "cmp", "patch", "less", "more", "nohup", "timeout", "nproc", "base64", "md5sum", "sha256sum", "od", "hexdump", "yes", "tput", "clear",
  "sudo", "systemctl", "service", "apt", "apt-get", "dpkg", "make", "cc", "gcc", "perl", "ruby", "openssl", "gpg", "ssh-keygen", "ssh-agent", "ssh-add",
  "docker", "cast", "claude", "codex", "gemini", "grok", "opencode", "pi", "node", "npm", "npx", "bun", "bunx", "gh", "uv", "uvx", "pip", "pip3",
]);
const SHELL_WORDS: ReadonlySet<string> = new Set([
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac", "function", "select", "time", "coproc",
  "exit", "return", "set", "unset", "export", "local", "declare", "typeset", "readonly", "shift", "source", ".", "trap", "eval", "exec", "read",
  "cd", "pushd", "popd", "let", "wait", "break", "continue", "alias", "unalias", "getopts", "hash", "ulimit", "umask", "builtin", "exec", "[", "[[", "]]",
  "{", "}", "(", ")", "!", "then", "do", "done", "fi", "esac",
]);
const WORD = /^[A-Za-z][A-Za-z0-9._+-]*$/;

/** The program words a shell command line invokes (env assignments, pipes, `&&`, `;` and subshells handled). */
export function commandWords(line: string): string[] {
  const out: string[] = [];
  const stripped = line.replace(/#.*$/, "").replace(/"[^"]*"|'[^']*'/g, " ");
  for (const seg of stripped.split(/\|\||&&|\||;|\(|\)|\$\(|`/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || tokens[i] === "env" || tokens[i] === "exec" || tokens[i] === "nohup" || tokens[i] === "sudo" || tokens[i] === "time" || tokens[i] === "timeout" || /^-/.test(tokens[i]) || (tokens[i] === "then" || tokens[i] === "do" || tokens[i] === "else"))) {
      if (tokens[i] === "timeout") { i++; while (i < tokens.length && /^(-|\d)/.test(tokens[i])) i++; continue; }
      i++;
    }
    const word = tokens[i];
    if (!word || SHELL_WORDS.has(word)) continue;
    const base = word.includes("/") ? path.posix.basename(word) : word;
    if (!WORD.test(base)) continue;
    out.push(base);
  }
  return out;
}

/** The interpreter a shebang names (`#!/usr/bin/env bash` → bash, `#!/bin/sh` → sh), or undefined. */
export function shebangInterpreter(text: string): string | undefined {
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(text);
  if (!m) return undefined;
  const first = path.posix.basename(m[1]);
  return first === "env" && m[2] ? path.posix.basename(m[2]) : first;
}

/** Hook commands from a settings.json `hooks` block (every `{type:"command", command}` at any depth). */
export function settingsHookCommands(settings: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (typeof o.command === "string" && (o.type === "command" || o.type === undefined)) out.push(o.command);
    for (const x of Object.values(o)) if (x && typeof x === "object") walk(x);
  };
  walk((settings as any)?.hooks);
  return out;
}

const MACH_O_MAGICS = new Set(["feedface", "feedfacf", "cafebabe", "cefaedfe", "cffaedfe", "bebafeca"]);

/** Mach-O (macOS) executable, by magic bytes — it cannot run on the Linux host. */
export function isMachO(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    return n === 4 && MACH_O_MAGICS.has(buf.toString("hex"));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function walkFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name === ".git" || e.name === "__pycache__") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out, depth + 1);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

export interface ScanOptions {
  laptopHome: string;
}

/** Helper commands and unsupported binaries from the laptop's ~/.claude hooks, skills and settings.json. */
export function scanMirroredHelpers(opts: ScanOptions): { tools: HostToolRequirement[]; unsupported: UnsupportedItem[]; needsUv: boolean } {
  const tools = new Map<string, HostToolRequirement>();
  const unsupported: UnsupportedItem[] = [];
  let needsUv = false;
  const home = opts.laptopHome;
  const add = (tool: string, referenced_by: string) => {
    if (tool === "uv" || tool === "uvx") { needsUv = true; return; }
    if (KNOWN_ON_HOST.has(tool)) return;
    if (!tools.has(tool)) tools.set(tool, { tool, referenced_by: referenced_by.startsWith(home) ? `~${referenced_by.slice(home.length)}` : referenced_by });
  };
  const settingsFile = path.join(home, ".claude", "settings.json");
  for (const cmd of settingsHookCommands(readJson(settingsFile))) {
    if (/\buvx?\b/.test(cmd)) needsUv = true;
    for (const w of commandWords(cmd)) add(w, settingsFile);
  }
  for (const rel of [".claude/hooks", ".claude/skills"]) {
    for (const file of walkFiles(path.join(home, rel))) {
      if (isMachO(file)) {
        unsupported.push({ tool: `~${file.slice(home.length)}`, referenced_by: `~${file.slice(home.length)}`, reason: "Mach-O binary — cannot run on Linux; not copied" });
        continue;
      }
      const text = readText(file);
      if (text === undefined) continue;
      if (/\b(uv|uvx)\b/.test(text)) needsUv = true;
      if (!/\.(sh|bash)$/.test(file) && !text.startsWith("#!")) continue;
      const interp = shebangInterpreter(text);
      if (interp) add(interp, file);
      if (interp && interp !== "sh" && interp !== "bash" && interp !== "zsh" && interp !== "dash") continue;
      for (const line of text.split("\n").slice(0, 400)) for (const w of commandWords(line)) add(w, file);
    }
  }
  return { tools: [...tools.values()], unsupported, needsUv };
}

// ---------------------------------------------------------------------------
// The requirement set
// ---------------------------------------------------------------------------

export interface RequiredHostToolsOptions {
  repoRoot?: string;
  laptopHome: string;
  /** The host's home, so MCP definitions are spelled exactly as the mirror writes them there (default `~`). */
  hostHome?: string;
  /** The mirror's project registrations for this host: project MCP sources and their root remap. */
  projects?: readonly ProjectRegistration[];
  env?: NodeJS.ProcessEnv;
  /** Injection for tests: the laptop's installed versions. */
  versions?: { node?: string; bun?: string; gh?: string; clients?: Partial<Record<InstallableClient, string>> };
}

function localVersion(bin: string, args = ["--version"]): string | undefined {
  try {
    const r = spawnSync(bin, args, { encoding: "utf-8", timeout: 10_000, env: process.env });
    if (r.status !== 0) return undefined;
    return parseClientVersion(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  } catch {
    return undefined;
  }
}

export function requiredHostTools(opts: RequiredHostToolsOptions): RequiredHostTools {
  const v = opts.versions ?? { node: localVersion("node"), bun: localVersion("bun"), gh: localVersion("gh"), clients: readInstalledClientVersions() };
  const nodeMajor = v.node ? Number(v.node.split(".")[0]) : undefined;
  const scan = scanMirroredHelpers({ laptopHome: opts.laptopHome });
  const tools: HostToolRequirement[] = [{ tool: "gh", version: v.gh ?? GH_DEFAULT_VERSION, referenced_by: "the authorized GitHub workflow" }];
  if (scan.needsUv) tools.push({ tool: "uv", referenced_by: "mirrored hooks/skills" });
  tools.push(...scan.tools);
  return {
    node: nodeRequirement(opts.repoRoot, Number.isFinite(nodeMajor) ? nodeMajor : undefined),
    ...(v.bun ? { bun: v.bun } : {}),
    clients: { ...(v.clients ?? {}) },
    tools,
    unsupported: scan.unsupported,
    mcp: mcpChecks(readMcpSources(opts.laptopHome, opts.env ?? process.env, opts.projects), opts.laptopHome, opts.hostHome),
  };
}


// ---------------------------------------------------------------------------
// MCP servers: which of the laptop's definitions can run on the host
// ---------------------------------------------------------------------------

/**
 * One MCP server as the laptop defines it, ready for the host: `command` /
 * `args` are HOST-SIDE spellings, remapped the way the mirror remaps them
 * (a registered repo root becomes its host root, the laptop home becomes
 * the host home, or `~/…` when the host home is unknown; the script and
 * normalizeCommand expand `~` to the host home), `verdict`
 * is what the laptop can already tell (a `.app` bundle, a Homebrew path, a
 * Mach-O file — nothing on Linux will ever run it), `probe` is what the host
 * checks when the laptop cannot tell (`command -v <word>` for a bare name,
 * `[ -x <path> ]` for a path).
 */
export interface McpCheck extends McpSourceServer {
  harness: McpHarness;
  name: string;
  /** The command line as the laptop wrote it, its home spelled `~` (for the report; never a laptop path). */
  laptop_command: string;
  verdict?: { status: "unsupported"; reason: string };
  /** The host-side check for the first token, when no static verdict exists. */
  probe?: { kind: "which"; word: string } | { kind: "path"; path: string };
  /** The first token is a package launcher (npx, uvx, bunx, …): missing on the host = installable. */
  launcher?: boolean;
  /** The first token is a file under the laptop home (the mirror ships ~/.claude and ~/.codex; nothing else). */
  underHome?: boolean;
  /** A project-scoped definition: the host root it belongs to. Absent for the global roster. */
  scope?: string;
}

/** Package launchers: a definition that goes through one runs anywhere the launcher does. */
const MCP_LAUNCHERS: ReadonlySet<string> = new Set(["npx", "uvx", "bunx", "npm", "pnpm", "yarn", "deno", "node", "bun", "uv", "python", "python3", "docker", "podman"]);
/** Path prefixes that only exist on macOS. */
const MAC_ONLY_PREFIXES = ["/Applications/", "/System/", "/Library/", "/opt/homebrew/", "/usr/local/Cellar/", "/private/var/", "/Volumes/"];
const BROWSER_LIKE = /computer[-_ ]?use|browser|chrome|chromium|playwright|puppeteer|safari/i;

const TRIPLE_BASIC = '"'.repeat(3);
const TRIPLE_LITERAL = "'".repeat(3);

/** A TOML string literal's value at the start of `text`, and how many chars it consumed. */
function tomlString(text: string): { value: string; length: number } | undefined {
  if (text.startsWith(TRIPLE_BASIC) || text.startsWith(TRIPLE_LITERAL)) {
    const q = text.slice(0, 3);
    const end = text.indexOf(q, 3);
    if (end === -1) return undefined;
    const raw = text.slice(3, end).replace(/^\n/, "");
    return { value: q === TRIPLE_BASIC ? unescapeToml(raw) : raw, length: end + 3 };
  }
  if (text.startsWith("'")) {
    const end = text.indexOf("'", 1);
    if (end === -1) return undefined;
    return { value: text.slice(1, end), length: end + 1 };
  }
  if (text.startsWith('"')) {
    let i = 1;
    while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
    if (i >= text.length) return undefined;
    return { value: unescapeToml(text.slice(1, i)), length: i + 1 };
  }
  return undefined;
}

function unescapeToml(raw: string): string {
  return raw.replace(/\\(u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (_m, e: string) => {
    switch (e[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "b": return "\b";
      case "f": return "\f";
      case '"': return '"';
      case "\\": return "\\";
      case "u": case "U": return String.fromCodePoint(parseInt(e.slice(1), 16));
      default: return e;
    }
  });
}

/** The strings of a TOML array starting at `[`. */
function tomlStringArray(text: string): string[] | undefined {
  if (!text.startsWith("[")) return undefined;
  const out: string[] = [];
  let i = 1;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "]") return out;
    if (c === "#") { const nl = text.indexOf("\n", i); if (nl === -1) return undefined; i = nl + 1; continue; }
    if (c === '"' || c === "'") {
      const str = tomlString(text.slice(i));
      if (!str) return undefined;
      out.push(str.value);
      i += str.length;
      continue;
    }
    i++;
  }
  return undefined;
}

/**
 * The `[mcp_servers.<name>]` tables of a codex config.toml: name → command /
 * args / enabled. Sub-tables (`[mcp_servers.x.env]`) and url-transport
 * servers (no `command`) are left out; a server the laptop itself disabled
 * (`enabled = false`) is reported with `enabled: false` so it is not classified.
 */
export function parseCodexMcpServers(toml: string): Record<string, McpSourceServer & { enabled?: boolean }> {
  const out: Record<string, McpSourceServer & { enabled?: boolean }> = {};
  for (const t of splitTomlTables(toml)) {
    if (t.name === null || tableFirstSegment(t.name) !== "mcp_servers") continue;
    const rest = t.name.slice(t.name.indexOf(".") + 1).trim();
    const m = /^(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_-]+))$/.exec(rest);
    if (!m) continue; // a sub-table or a name we cannot read
    const name = m[1] ?? m[2] ?? m[3]!;
    const body = t.lines.join("\n");
    const cmd = /^\s*command\s*=\s*(.*)$/m.exec(body);
    if (!cmd) continue;
    const command = tomlString(cmd[1]!.trim())?.value;
    if (!command) continue;
    const entry: McpSourceServer & { enabled?: boolean } = { command };
    const argsAt = /^\s*args\s*=\s*/m.exec(body);
    if (argsAt) {
      const args = tomlStringArray(body.slice(argsAt.index + argsAt[0].length));
      if (args) entry.args = args;
    }
    if (/^\s*enabled\s*=\s*false\b/m.test(body)) entry.enabled = false;
    out[name] = entry;
  }
  return out;
}

export interface McpSources {
  codex: Record<string, McpSourceServer>;
  claude: Record<string, McpSourceServer>;
  /**
   * Project-scoped claude servers by LAPTOP root: every `projects[root].mcpServers`
   * of `~/.claude.json` (the mirror ships them all, roots remapped) and the
   * `.mcp.json` at each registered repo root.
   */
  claudeProjects?: Record<string, Record<string, McpSourceServer>>;
  /** Registered laptop repo root to host root: the mirror's remap for roots, commands and args. */
  mappings?: Array<{ from: string; to: string }>;
}

/** Stdio servers (`command` plus string args) of an `mcpServers` table; http/sse ones need no executable. */
function claudeStdioServers(servers: unknown): Record<string, McpSourceServer> {
  const out: Record<string, McpSourceServer> = {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return out;
  for (const [name, def] of Object.entries(servers as Record<string, any>)) {
    if (!def || typeof def !== "object" || typeof def.command !== "string" || !def.command) continue;
    if (typeof def.type === "string" && def.type !== "stdio") continue;
    const args = Array.isArray(def.args) ? def.args.filter((a: unknown) => typeof a === "string") : undefined;
    out[name] = { command: def.command, ...(args?.length ? { args } : {}) };
  }
  return out;
}

/**
 * The laptop's MCP roster: codex `$CODEX_HOME/config.toml` (default
 * ~/.codex) `[mcp_servers.*]`, `~/.claude.json` user-scope `mcpServers`, and
 * the project MCP the mirror also ships: every `projects[root].mcpServers`
 * in `~/.claude.json` (a registered repo root, its worktrees, any other
 * root) plus `.mcp.json` in the laptop home (scoped to the home) and at
 * each registered repo root. Servers the laptop disabled itself are skipped. Readiness reconciles pins over this whole
 * roster, so a server defined only for a project keeps its pin.
 */
export function readMcpSources(laptopHome: string, env: NodeJS.ProcessEnv = process.env, projects: readonly ProjectRegistration[] = []): Required<McpSources> {
  const live = projects.filter((p) => !p.retired);
  const out: Required<McpSources> = { codex: {}, claude: {}, claudeProjects: {}, mappings: live.map((p) => ({ from: p.sourceRoot, to: p.targetRoot })) };
  const toml = readText(path.join(env.CODEX_HOME || path.join(laptopHome, ".codex"), "config.toml"));
  if (toml) {
    for (const [name, s] of Object.entries(parseCodexMcpServers(toml))) {
      if (s.enabled === false) continue;
      out.codex[name] = { command: s.command, ...(s.args ? { args: s.args } : {}) };
    }
  }
  const claude = readJson(path.join(laptopHome, ".claude.json"));
  const scoped = (root: string, servers: Record<string, McpSourceServer>) => {
    if (!Object.keys(servers).length) return;
    out.claudeProjects[root] = { ...(out.claudeProjects[root] ?? {}), ...servers };
  };
  if (claude && typeof claude === "object") {
    Object.assign(out.claude, claudeStdioServers(claude.mcpServers));
    const roots = claude.projects && typeof claude.projects === "object" && !Array.isArray(claude.projects) ? claude.projects as Record<string, any> : {};
    for (const [root, project] of Object.entries(roots)) if (path.isAbsolute(root) && project && typeof project === "object") scoped(root, claudeStdioServers(project.mcpServers));
  }
  for (const root of [...(laptopHome ? [laptopHome] : []), ...live.map((p) => p.sourceRoot)]) {
    const file = readJson(path.join(root, ".mcp.json"));
    if (file && typeof file === "object") scoped(root, claudeStdioServers(file.mcpServers));
  }
  return out;
}

/**
 * A laptop spelling as the mirror writes it on the host: a registered repo
 * root becomes its host root (longest match first), the laptop home becomes
 * `hostHome` (`~` when unknown), wherever a path boundary follows; anything
 * else is unchanged. The same remapContextPaths the mirror's transform uses,
 * so `source_command` compares host-side against host-side.
 */
export function remapForHost(word: string, laptopHome: string, hostHome = "~", mappings: ReadonlyArray<{ from: string; to: string }> = []): string {
  return remapContextPaths(word, { fromHome: laptopHome, toHome: hostHome, pathMappings: [...mappings] });
}

/**
 * What the laptop can tell without the host: an executable that cannot
 * exist on Linux. Everything else is a host probe.
 */
export function staticMcpVerdict(command: string, laptopHome: string): { status: "unsupported"; reason: string } | undefined {
  // `command` is the executable itself (args live beside it), so a path with
  // spaces ("Codex Computer Use.app") is one path, never split.
  const head = command.trim();
  if (!head) return { status: "unsupported", reason: "empty command" };
  let p = head;
  if (p === "~" || p.startsWith("~/")) p = laptopHome + p.slice(1);
  if (!p.startsWith("/")) return undefined; // a bare name: the host's PATH decides
  if (/\.app\//.test(p)) return { status: "unsupported", reason: "a macOS .app bundle — nothing on Linux runs it" };
  const macPrefix = MAC_ONLY_PREFIXES.find((pre) => p.startsWith(pre));
  if (macPrefix) return { status: "unsupported", reason: `under ${macPrefix.replace(/\/$/, "")}, a macOS-only path` };
  // Only a file under the laptop home is the laptop's own: /usr/local/bin/node
  // is Mach-O on a Mac and a working symlink on the host, so the host's
  // `[ -x ]` probe decides those, not the laptop's bytes.
  if (laptopHome && laptopHome !== "/" && p.startsWith(laptopHome + "/") && isMachO(p)) return { status: "unsupported", reason: "a Mach-O (macOS) binary — cannot run on Linux; not copied" };
  return undefined;
}

/**
 * The per-server checks for the host script, from the laptop's roster: the
 * global servers of each harness, then every project scope (roots sorted),
 * a project definition identical to one already listed (a worktree
 * repeating its repo's) collapsed into it. `hostHome` spells the host side
 * exactly as the mirror will write it; `~` when the host is not known yet.
 */
export function mcpChecks(sources: McpSources, laptopHome: string, hostHome = "~"): McpCheck[] {
  const out: McpCheck[] = [];
  const seen = new Set<string>();
  const mappings = sources.mappings ?? [];
  const add = (harness: McpHarness, name: string, src: McpSourceServer, scope?: string) => {
    const args = (src.args ?? []).map((a) => remapForHost(a, laptopHome, hostHome, mappings));
    const laptopArgs = (src.args ?? []).map((a) => remapForHost(a, laptopHome));
    const head = src.command.trim();
    const hostHead = remapForHost(head, laptopHome, hostHome, mappings);
    const key = `${harness}\0${name}\0${normalizeCommand({ command: hostHead, args }, hostHome)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const check: McpCheck = { harness, name, laptop_command: normalizeCommand({ command: remapForHost(head, laptopHome), args: laptopArgs }, "~"), command: hostHead, ...(args.length ? { args } : {}) };
    const verdict = staticMcpVerdict(src.command, laptopHome);
    if (verdict) check.verdict = verdict;
    else if (hostHead.includes("/")) check.probe = { kind: "path", path: hostHead };
    else check.probe = { kind: "which", word: hostHead };
    if (MCP_LAUNCHERS.has(path.posix.basename(hostHead))) check.launcher = true;
    if (head === "~" || head.startsWith("~/") || remapForHost(head, laptopHome) !== head) check.underHome = true;
    if (scope !== undefined) check.scope = scope;
    out.push(check);
  };
  for (const harness of ["codex", "claude"] as const) {
    for (const name of Object.keys(sources[harness]).sort()) add(harness, name, sources[harness][name]!);
  }
  const projects = sources.claudeProjects ?? {};
  for (const root of Object.keys(projects).sort()) {
    const scope = remapForHost(root, laptopHome, hostHome, mappings);
    for (const name of Object.keys(projects[root]!).sort()) add("claude", name, projects[root]![name]!, scope);
  }
  return out;
}

/**
 * The `__MCP__ <i> <0|1>` lines the script prints, one per probed check,
 * plus the host's current manifest — read back even for an empty roster, so
 * pins left by an earlier roster are cleared rather than assumed absent.
 */
function mcpScriptLines(checks: McpCheck[]): string {
  const lines: string[] = [];
  checks.forEach((c, i) => {
    if (!c.probe) return;
    if (c.probe.kind === "which") lines.push(`if command -v ${shq(c.probe.word)} >/dev/null 2>&1; then echo "__MCP__ ${i} 1"; else echo "__MCP__ ${i} 0"; fi`);
    else {
      const p = c.probe.path;
      const expanded = p.startsWith("~/") ? `"$HOME"/${shq(p.slice(2))}` : shq(p);
      lines.push(`if [ -x ${expanded} ]; then echo "__MCP__ ${i} 1"; else echo "__MCP__ ${i} 0"; fi`);
    }
  });
  lines.push(`if [ -f "$HOME/.codecast/${HOST_MCP_OVERRIDES_FILE}" ]; then printf '__MCP_OVERRIDES__ %s\\n' "$(base64 < "$HOME/.codecast/${HOST_MCP_OVERRIDES_FILE}" | tr -d '\\n')"; fi`);
  return lines.join("\n");
}

/** The host's answers: which checks resolved, and its manifest text when it has one. */
export function parseMcpLines(out: string): { resolved: Map<number, boolean>; overridesText?: string } {
  const resolved = new Map<number, boolean>();
  let overridesText: string | undefined;
  for (const line of out.split("\n")) {
    const m = /^__MCP__ (\d+) ([01])$/.exec(line.trim());
    if (m) { resolved.set(Number(m[1]), m[2] === "1"); continue; }
    const o = /^__MCP_OVERRIDES__ (\S*)$/.exec(line.trim());
    if (o) {
      try { overridesText = Buffer.from(o[1]!, "base64").toString("utf-8"); } catch { /* garbled: treated as absent */ }
    }
  }
  return { resolved, ...(overridesText !== undefined ? { overridesText } : {}) };
}

export interface McpReportItem {
  harness: McpHarness;
  name: string;
  /** The host root of a project-scoped definition; absent for the global roster. */
  scope?: string;
  /** The command as the laptop wrote it. */
  command: string;
  status: McpStatus;
  reason?: string;
  /** What readiness did about it. */
  action: string;
}

/** Classify every check with the host's probe answers (a check the host did not answer counts as unresolved). */
export function classifyMcp(checks: McpCheck[], resolved: ReadonlyMap<number, boolean>): Array<McpClassified & { harness: McpHarness; laptop_command: string; scope?: string }> {
  return checks.map((c, i) => {
    const base = { harness: c.harness, name: c.name, ...(c.scope !== undefined ? { scope: c.scope } : {}), laptop_command: c.laptop_command, command: c.command, ...(c.args ? { args: c.args } : {}) };
    if (c.verdict) return { ...base, status: "unsupported" as const, reason: c.verdict.reason + (BROWSER_LIKE.test(`${c.name} ${c.laptop_command}`) ? " — the host's own Chrome is reachable through `cast browser` there instead" : "") };
    if (resolved.get(i) === true) return { ...base, status: "ok" as const };
    const head = path.posix.basename(c.command);
    const reason = c.launcher
      ? `its launcher \`${head}\` is not on the host yet — the tools step installs node/bun/uv; run \`cast hosts tools\` again once it has`
      : c.underHome
        ? `${c.command} is not on the host — the mirror ships scripts under ~/.claude and ~/.codex; anything else must be installed there by hand`
        : `\`${head}\` is not on the host — install it there by hand`;
    return { ...base, status: "missing_portable" as const, reason };
  });
}

/**
 * The shell that lands stdin at `$HOME/.codecast/<name>` the way
 * atomicWriteFile does on the laptop: it refuses a symlinked ~/.codecast
 * (exit 3), creates the directory 0700, writes through a unique temp that
 * mktemp creates exclusively at 0600 beside the target, publishes with one
 * rename, and removes the temp on any failure. A planted temp file or
 * symlink can never be adopted because the name is never predictable.
 */
export function codecastFileWriteCommand(name: string): string {
  const dir = '"$HOME/.codecast"';
  return `umask 077; if [ -L ${dir} ]; then echo "refusing to write through a symlinked ~/.codecast" >&2; exit 3; fi; `
    + `mkdir -p ${dir} && [ -d ${dir} ] && tmp=$(mktemp "$HOME/.codecast/.${name}.XXXXXX") || exit 1; `
    + `if cat > "$tmp" && mv -f "$tmp" "$HOME/.codecast/${name}"; then exit 0; else rm -f "$tmp"; exit 1; fi`;
}

/** Write the manifest on the host (codecastFileWriteCommand), one ssh with the bytes on stdin. */
export function writeHostMcpOverridesRemote(host: RemoteHost, o: HostMcpOverrides): void {
  const r = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, codecastFileWriteCommand(HOST_MCP_OVERRIDES_FILE)], {
    encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], input: serializeHostMcpOverrides(o), timeout: 30_000, env: process.env,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`writing ${HOST_MCP_OVERRIDES_FILE} on ${host.user}@${host.address} failed (exit ${r.status})${r.stderr?.trim() ? `: ${r.stderr.trim().split("\n").pop()}` : ""}`);
}

/**
 * Turn the host's probe answers into the report's `mcp` list and the next
 * manifest: reconcilePins per harness over the laptop's whole roster, one
 * entry per name (the manifest is keyed by name; when a name is defined in
 * several scopes the unsupported definition is the one pinned, and the
 * mirror applies the pin only where the command matches). The manifest is
 * rewritten on the host only when it changes (and never in check-only
 * mode, where the report says what a real run would pin). A host manifest
 * that does not parse counts as empty and is named in `invalid`.
 */
export function reconcileMcp(
  checks: McpCheck[],
  answers: { resolved: ReadonlyMap<number, boolean>; overridesText?: string },
  opts: { hostHome: string; at: string; install: boolean },
): { mcp: McpReportItem[]; current: HostMcpOverrides; next: HostMcpOverrides; changed: boolean; invalid?: string } {
  let invalid: string | undefined;
  const current = answers.overridesText !== undefined ? parseHostMcpOverrides(answers.overridesText, (reason) => { invalid = reason; }) : emptyOverrides();
  const classified = classifyMcp(checks, answers.resolved);
  let next = current;
  for (const harness of ["codex", "claude"] as const) {
    const roster = new Map<string, McpClassified>();
    for (const c of classified) {
      if (c.harness !== harness) continue;
      const prev = roster.get(c.name);
      if (!prev || (prev.status !== "unsupported" && c.status === "unsupported")) roster.set(c.name, c);
    }
    next = reconcilePins(next, harness, [...roster.values()], opts.at, opts.hostHome);
  }
  const changed = serializeHostMcpOverrides(next) !== serializeHostMcpOverrides(current);
  const mcp: McpReportItem[] = classified.map((c) => {
    const wasPinned = !!current[c.harness][c.name];
    const pinned = !!next[c.harness][c.name];
    const how = c.harness === "codex" ? "the mirror sets enabled = false on the host's copy" : "the mirror leaves it out of the host's ~/.claude.json";
    const action = c.status === "unsupported"
      ? (opts.install ? (wasPinned ? `disabled on the host (pinned in ~/.codecast/${HOST_MCP_OVERRIDES_FILE}; ${how})` : `disabled on the host now (pinned in ~/.codecast/${HOST_MCP_OVERRIDES_FILE}; ${how})`) : `would be disabled on the host (check-only run; ${how})`)
      : wasPinned && !pinned
        ? (opts.install ? "pin dropped — it resolves on the host again" : "would drop its pin (check-only run)")
        : c.status === "ok" ? "none — runs on the host" : "none — left enabled; it fails to start on the host until installed";
    return { harness: c.harness, name: c.name, ...(c.scope !== undefined ? { scope: c.scope } : {}), command: c.laptop_command, status: c.status, ...(c.reason ? { reason: c.reason } : {}), action };
  });
  return { mcp, current, next, changed, ...(invalid !== undefined ? { invalid } : {}) };
}

// ---------------------------------------------------------------------------
// The host script
// ---------------------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+$/;
/** Every installer download: a hung mirror must not hold session placement for the script's whole cap. */
const CURL_LIMITS = "-fsSL --connect-timeout 10 --max-time 300";
const TOOL_RE = /^[A-Za-z][A-Za-z0-9._+-]*$/;

/** A version string that may be interpolated into a script, or undefined (unpinned). */
export function safeVersion(v: string | undefined): string | undefined {
  return v && VERSION_RE.test(v) ? v : undefined;
}

/**
 * The node guard shared with provisioning: install a user-local Node when
 * the host's `node -v` major is below `minMajor`. Extracts into a temp dir
 * and renames so an interrupted download leaves no half-built
 * ~/.local/node-<ver>; symlinks node/npm/npx into ~/.local/bin, and into
 * /usr/local/bin when passwordless sudo is available (the only place that
 * shadows /usr/bin/node on the daemon's PATH). apt's node stays.
 */
export function nodeInstallSnippet(minMajor: number, version = NODE_22_VERSION): string {
  const ver = safeVersion(version) ?? NODE_22_VERSION;
  // A requirement the tarball cannot meet (a repo pinned above its major)
  // is reported, never "fixed" by a pointless download.
  if (minMajor > Number(ver.split(".")[0])) return `node_major=0
if command -v node >/dev/null 2>&1; then node_major=$(node -v 2>/dev/null | sed 's/^v\\([0-9]*\\).*/\\1/'); fi
[ -n "$node_major" ] || node_major=0
[ "$node_major" -ge ${minMajor} ] || node_err="node ${minMajor} is above the ${ver} this step installs: install it on the host by hand"`;
  return `node_major=0
if command -v node >/dev/null 2>&1; then node_major=$(node -v 2>/dev/null | sed 's/^v\\([0-9]*\\).*/\\1/'); fi
[ -n "$node_major" ] || node_major=0
if [ "$node_major" -lt ${minMajor} ]; then
  arch=$(uname -m); case "$arch" in x86_64) a=x64;; aarch64|arm64) a=arm64;; *) a="";; esac
  if [ -z "$a" ]; then echo "node: unsupported arch $arch" >&2; node_err="unsupported arch $arch"
  elif [ -x "$HOME/.local/node-${ver}/bin/node" ]; then :
  else
    mkdir -p "$HOME/.local/bin"
    tmp=$(mktemp -d "$HOME/.local/.node-download.XXXXXX")
    if curl ${CURL_LIMITS} "https://nodejs.org/dist/v${ver}/node-v${ver}-linux-$a.tar.xz" 2>"$tmp/err" | tar -xJ -C "$tmp" 2>>"$tmp/err" && [ -x "$tmp/node-v${ver}-linux-$a/bin/node" ]; then
      rm -rf "$HOME/.local/node-${ver}" && mv "$tmp/node-v${ver}-linux-$a" "$HOME/.local/node-${ver}"
    else
      node_err=$(tail -c 200 "$tmp/err" 2>/dev/null | tr -d '\\n"\\\\'); [ -n "$node_err" ] || node_err="download failed"
    fi
    rm -rf "$tmp"
  fi
  if [ -x "$HOME/.local/node-${ver}/bin/node" ]; then
    mkdir -p "$HOME/.local/bin"
    for b in node npm npx; do ln -sf "$HOME/.local/node-${ver}/bin/$b" "$HOME/.local/bin/$b"; done
    if [ "$(uname -s)" = Linux ] && sudo -n true >/dev/null 2>&1; then for b in node npm npx; do sudo -n ln -sf "$HOME/.local/node-${ver}/bin/$b" "/usr/local/bin/$b" >/dev/null 2>&1 || true; done; fi
    node_installed=1
  fi
fi`;
}

/** The `command -v` guarded install line for one agent CLI at a pinned version (unpinned when malformed). */
export function clientInstallSnippet(client: InstallableClient, version: string | undefined): string {
  const ver = safeVersion(version);
  switch (client) {
    case "claude": return `command -v claude >/dev/null 2>&1 || (curl ${CURL_LIMITS} https://claude.ai/install.sh | bash -s${ver ? ` ${ver}` : ""}) >/dev/null 2>&1`;
    case "codex": return `command -v codex >/dev/null 2>&1 || bun install -g @openai/codex${ver ? `@${ver}` : ""} >/dev/null 2>&1`;
    case "gemini": return `command -v gemini >/dev/null 2>&1 || bun install -g @google/gemini-cli${ver ? `@${ver}` : ""} >/dev/null 2>&1`;
    case "grok": return `command -v grok >/dev/null 2>&1 || (curl ${CURL_LIMITS} https://x.ai/cli/install.sh | bash -s${ver ? ` ${ver}` : ""}) >/dev/null 2>&1`;
    // The opencode.ai installer writes ~/.opencode/bin/opencode (the dir opencodeServer.ts
    // puts on PATH); the ~/.local/bin link reaches the daemon's PATH without sudo.
    case "opencode": return `command -v opencode >/dev/null 2>&1 || { (curl ${CURL_LIMITS} https://opencode.ai/install | bash -s -- --no-modify-path${ver ? ` --version ${ver}` : ""}) >/dev/null 2>&1; [ -x "$HOME/.opencode/bin/opencode" ] && mkdir -p "$HOME/.local/bin" && ln -sf "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"; }`;
    // pi is the node script of @mariozechner/pi-coding-agent (daemon.ts matches its process by that path).
    case "pi": return `command -v pi >/dev/null 2>&1 || bun install -g @mariozechner/pi-coding-agent${ver ? `@${ver}` : ""} >/dev/null 2>&1`;
  }
}

export interface HostToolsScriptOptions {
  /** Check only, install nothing (`cast hosts tools --check`, non-Linux hosts). */
  install?: boolean;
}

/** The PATH every tool check and install runs under on the host. */
export const HOST_TOOLS_PATH = 'export PATH="$HOME/.bun/bin:$HOME/.local/bin:$HOME/.grok/bin:$HOME/.opencode/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"';

export function hostToolsScript(required: RequiredHostTools, opts: HostToolsScriptOptions = {}): string {
  const install = opts.install !== false;
  const bun = safeVersion(required.bun);
  const gh = safeVersion(required.tools.find((t) => t.tool === "gh")?.version) ?? GH_DEFAULT_VERSION;
  const needsUv = required.tools.some((t) => t.tool === "uv");
  // Only what the laptop has: provisioning installs the agent CLIs
  // once; every wake must not retry an unpinned install of a CLI the
  // laptop itself lacks.
  const clients = INSTALLABLE_CLIENTS.filter((c) => c in required.clients);
  const helpers = required.tools.filter((t) => t.tool !== "gh" && t.tool !== "uv" && TOOL_RE.test(t.tool));
  const unsupported = JSON.stringify(required.unsupported.map((u) => ({ tool: u.tool, referenced_by: u.referenced_by, reason: u.reason })));
  const lines: string[] = [];
  // Install branches exist only in install mode: a check-only script carries no installer at all.
  const inst = (code: string) => (install ? `elif [ "$INSTALL" = 1 ]; then
${code}
` : "");
  lines.push(`set -u
umask 022
exec </dev/null
${HOST_TOOLS_PATH}
INSTALL=${install ? 1 : 0}
[ "$(uname -s)" = Linux ] || INSTALL=0
ok=""; installed=""; missing=""
ver_of() { "$1" --version 2>/dev/null </dev/null | head -1 | tr -cd 'A-Za-z0-9._ -' | head -c 40; }
add() { local v item; v=$(ver_of "\${3:-$2}"); item="{\\"tool\\":\\"$2\\",\\"version\\":\\"$v\\"},"; case "$1" in ok) ok="$ok$item";; installed) installed="$installed$item";; esac; }
miss() { local err; err=$(printf '%s' "$3" | tr -cd 'A-Za-z0-9._ :/-' | head -c 160); missing="$missing{\\"tool\\":\\"$1\\",\\"referenced_by\\":\\"$2\\",\\"error\\":\\"$err\\"},"; }
# node: a user-local install when the host's major is too old (apt's node stays for novnc).
node_installed=0; node_err=""
${install ? nodeInstallSnippet(required.node.minMajor, required.node.install) : `if command -v node >/dev/null 2>&1; then node_major=$(node -v 2>/dev/null | sed 's/^v\\([0-9]*\\).*/\\1/'); else node_major=0; fi; [ -n "$node_major" ] || node_major=0`}
node_major=0; command -v node >/dev/null 2>&1 && node_major=$(node -v 2>/dev/null | sed 's/^v\\([0-9]*\\).*/\\1/'); [ -n "$node_major" ] || node_major=0
if [ "$node_major" -ge ${required.node.minMajor} ]; then
  if [ "$node_installed" = 1 ]; then add installed node; else add ok node; fi
else
  miss node "${required.node.source.replace(/[^A-Za-z0-9._ ()-]/g, "")}" "$( [ -n "$node_err" ] && printf '%s' "$node_err" || printf 'node %s is below %s' "$node_major" "${required.node.minMajor}")"
fi`);
  // bun
  lines.push(`if command -v bun >/dev/null 2>&1; then add ok bun
${inst(`  if err=$( (curl ${CURL_LIMITS} https://bun.sh/install | bash -s${bun ? ` "bun-v${bun}"` : ""}) 2>&1 >/dev/null ) && command -v bun >/dev/null 2>&1; then add installed bun; else miss bun "the workspace manifest" "$err"; fi`)}else miss bun "the workspace manifest" "not installed"; fi`);
  // gh
  // The real gh, not the wrapper in front of it (ghWrapper.ts): a host with
  // only the wrapper has no gh, and asking the wrapper for a version would
  // mint a token. An install lands where the wrapper looks first
  // (REAL_GH_REL), never on the wrapper's path, and the wrapper is then
  // written in front of it, so the order of this step and the host git step
  // does not matter.
  lines.push(`${realGhFunction}
if gh_path=$(real_gh); then add ok gh "$gh_path"
${inst(`  arch=$(uname -m); case "$arch" in x86_64) ga=amd64;; aarch64|arm64) ga=arm64;; *) ga="";; esac
  tmp=$(mktemp -d); mkdir -p "$HOME/.local/bin" "$(dirname "$HOME/${REAL_GH_REL}")"; err=""
  if [ -n "$ga" ] && curl ${CURL_LIMITS} "https://github.com/cli/cli/releases/download/v${gh}/gh_${gh}_linux_$ga.tar.gz" 2>"$tmp/err" | tar -xz -C "$tmp" 2>>"$tmp/err" && install -m 755 "$tmp/gh_${gh}_linux_$ga/bin/gh" "$HOME/${REAL_GH_REL}" 2>>"$tmp/err"; then add installed gh "$HOME/${REAL_GH_REL}"
${ghWrapperInstallSnippet()}
  else err=$(tail -c 200 "$tmp/err" 2>/dev/null); [ -n "$err" ] || err="download failed"; miss gh "the authorized GitHub workflow" "$err"; fi
  rm -rf "$tmp"`)}else miss gh "the authorized GitHub workflow" "not installed"; fi`);
  if (needsUv) {
    lines.push(`if command -v uv >/dev/null 2>&1; then add ok uv
${inst(`  if err=$( (curl ${CURL_LIMITS} https://astral.sh/uv/install.sh | sh) 2>&1 >/dev/null ) && command -v uv >/dev/null 2>&1; then add installed uv; else miss uv "mirrored hooks/skills" "$err"; fi`)}else miss uv "mirrored hooks/skills" "not installed"; fi`);
  }
  for (const client of clients) {
    const ver = required.clients[client];
    lines.push(`if command -v ${client} >/dev/null 2>&1; then add ok ${client}
${inst(`  ${clientInstallSnippet(client, ver)}
  if command -v ${client} >/dev/null 2>&1; then add installed ${client}; else miss ${client} "the laptop's ${client}${safeVersion(ver) ? ` ${safeVersion(ver)}` : ""}" "install failed"; fi`)}else miss ${client} "the laptop's ${client}" "not installed"; fi`);
  }
  for (const h of helpers) {
    const ref = (h.referenced_by ?? "").replace(/["\\\n\r]/g, "");
    lines.push(`if command -v ${h.tool} >/dev/null 2>&1; then add ok ${h.tool}; else miss ${h.tool} "${ref}" "no portable install known — install it by hand on the host"; fi`);
  }
  // MCP: probe what the laptop could not decide, and hand back the host's manifest.
  if (required.mcp) lines.push(mcpScriptLines(required.mcp));
  lines.push(`UNSUPPORTED=${shq(unsupported)}
json="{\\"ok\\":[\${ok%,}],\\"installed\\":[\${installed%,}],\\"missing\\":[\${missing%,}],\\"unsupported\\":$UNSUPPORTED,\\"install\\":$INSTALL,\\"at\\":\\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\\"}"
(printf '%s\\n' "$json" | (${codecastFileWriteCommand("host-tools.json")})) 2>/dev/null || true
printf '%s\\n' "$json"
exit 0`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface HostToolItem { tool: string; version?: string }
export interface HostToolMissing { tool: string; referenced_by?: string; error?: string }

export interface HostToolsReport {
  ok: HostToolItem[];
  installed: HostToolItem[];
  missing: HostToolMissing[];
  unsupported: UnsupportedItem[];
  /** Whether installs were attempted (0 on a check-only run or a non-Linux host). */
  install?: boolean;
  at?: string;
  /** The laptop's MCP servers as classified for this host, with what readiness did about each. */
  mcp?: McpReportItem[];
  /** The host's ~/.codecast/host-mcp-overrides.json after this run (or, on a check-only run, as it would be). */
  mcpOverrides?: HostMcpOverrides;
  /** The manifest was (re)written on the host during this run. */
  mcpOverridesWritten?: boolean;
  /** The host's manifest did not parse (why); it counted as empty and, on an installing run, was rewritten whole. */
  mcpOverridesInvalid?: string;
}

/** The report from the script's stdout (the last JSON line) or from the host's ~/.codecast/host-tools.json. */
export function parseHostToolsOutput(out: string): HostToolsReport {
  const line = out.trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
  if (!line) throw new Error("the host tools script printed no JSON");
  let parsed: any;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error("the host tools script printed invalid JSON");
  }
  const items = (v: unknown): HostToolItem[] => (Array.isArray(v) ? v : []).filter((x) => x && typeof x.tool === "string").map((x) => ({ tool: x.tool, ...(typeof x.version === "string" && x.version ? { version: x.version } : {}) }));
  const missing = (v: unknown): HostToolMissing[] => (Array.isArray(v) ? v : []).filter((x) => x && typeof x.tool === "string").map((x) => ({ tool: x.tool, ...(typeof x.referenced_by === "string" ? { referenced_by: x.referenced_by } : {}), ...(typeof x.error === "string" && x.error ? { error: x.error } : {}) }));
  const unsupported = (v: unknown): UnsupportedItem[] => (Array.isArray(v) ? v : []).filter((x) => x && typeof x.tool === "string").map((x) => ({ tool: x.tool, referenced_by: typeof x.referenced_by === "string" ? x.referenced_by : "", reason: typeof x.reason === "string" ? x.reason : "" }));
  return {
    ok: items(parsed.ok), installed: items(parsed.installed), missing: missing(parsed.missing), unsupported: unsupported(parsed.unsupported),
    ...(parsed.install !== undefined ? { install: parsed.install === 1 || parsed.install === true } : {}),
    ...(typeof parsed.at === "string" ? { at: parsed.at } : {}),
  };
}

/** `tools: N ok, M installed, K missing, U unsupported` — the one line every listing prints. */
export function summarizeHostTools(r: HostToolsReport): string {
  return `${r.ok.length} ok, ${r.installed.length} installed, ${r.missing.length} missing, ${r.unsupported.length} unsupported${mcpSummarySuffix(r.mcpOverrides)}`;
}

/** The detail lines behind the summary (--verbose): what is missing and why, what cannot run. */
export function hostToolsDetailLines(r: HostToolsReport): string[] {
  const lines: string[] = [];
  for (const i of r.installed) lines.push(`installed ${i.tool}${i.version ? ` ${i.version}` : ""}`);
  for (const m of r.missing) lines.push(`missing ${m.tool}${m.referenced_by ? ` (for ${m.referenced_by})` : ""}${m.error ? ` — ${m.error}` : ""}`);
  for (const u of r.unsupported) lines.push(`unsupported ${u.tool} — ${u.reason}`);
  for (const m of r.mcp ?? []) if (m.status !== "ok") lines.push(`mcp ${m.harness}/${m.name}${m.scope ? ` in ${m.scope}` : ""} (${m.command}): ${m.status}${m.reason ? ` — ${m.reason}` : ""}; ${m.action}`);
  if (r.mcpOverridesInvalid) lines.push(`mcp: the host's ~/.codecast/${HOST_MCP_OVERRIDES_FILE} did not parse (${r.mcpOverridesInvalid}); treated as empty`);
  return lines;
}

/** `, 1 MCP server disabled (codex: computer_use)` — appended to the summary when the host pins any. */
export function mcpSummarySuffix(o: HostMcpOverrides | undefined): string {
  if (!o) return "";
  const names = [...Object.keys(o.codex).sort().map((n) => `codex: ${n}`), ...Object.keys(o.claude).sort().map((n) => `claude: ${n}`)];
  return names.length ? `, ${names.length} MCP server${names.length === 1 ? "" : "s"} disabled (${names.join(", ")})` : "";
}

export interface RunHostToolsOptions extends HostToolsScriptOptions {
  timeoutMs?: number;
  /** Injection for tests: how the script reaches the host. */
  run?: (host: RemoteHost, script: string) => { status: number | null; stdout: string; stderr: string; error?: Error };
  /** Injection for tests: how the MCP manifest reaches the host. */
  writeOverrides?: (host: RemoteHost, o: HostMcpOverrides) => void;
  now?: () => Date;
}

function runOverSsh(host: RemoteHost, script: string, timeoutMs: number) {
  const r = spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, HOST_TOOLS_REMOTE_COMMAND], {
    encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], input: script, timeout: timeoutMs, env: process.env, maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
}

/** Run the check/install script on a host. Throws on transport failure; a missing tool is a result. */
export function runHostTools(host: RemoteHost, required: RequiredHostTools, opts: RunHostToolsOptions = {}): HostToolsReport {
  const script = hostToolsScript(required, { install: opts.install });
  const timeoutMs = opts.timeoutMs ?? 15 * 60_000;
  const r = opts.run ? opts.run(host, script) : runOverSsh(host, script, timeoutMs);
  const label = `${host.user}@${host.address}`;
  if (r.error) throw new Error(`host tools check on ${label} failed (${(r.error as NodeJS.ErrnoException).code ?? r.error.message})`);
  if (r.status !== 0) {
    const detail = r.stderr.trim().split("\n").filter(Boolean).pop();
    throw new Error(`host tools check on ${label} failed (exit ${r.status})${detail ? `: ${detail}` : ""}`);
  }
  const report = parseHostToolsOutput(r.stdout);
  if (required.mcp) {
    // The MCP manifest: the readiness path is its sole writer. Rewritten only
    // on change, and only on a real (installing) run — a check-only run reports.
    const install = opts.install !== false;
    const { mcp, next, changed, invalid } = reconcileMcp(required.mcp, parseMcpLines(r.stdout), { hostHome: remoteHome(host), at: (opts.now ?? (() => new Date()))().toISOString(), install });
    report.mcp = mcp;
    report.mcpOverrides = next;
    if (invalid !== undefined) report.mcpOverridesInvalid = invalid;
    if (changed && install) {
      (opts.writeOverrides ?? writeHostMcpOverridesRemote)(host, next);
      report.mcpOverridesWritten = true;
    }
  }
  return report;
}

/** The host's last report, as `cat ~/.codecast/host-tools.json` returned it, or null when it has none. */
export function parseHostToolsStamp(out: string): HostToolsReport | null {
  if (!out.trim()) return null;
  try {
    return parseHostToolsOutput(out);
  } catch {
    return null;
  }
}
