/**
 * What a session works on, read from its transcripts: the repositories and
 * folders it wrote to or used, the launchd services it set up, and the tools
 * it ran. A move carries one checkout, the session's own; this is how a move
 * learns what else the session depends on before it leaves (rehearse.ts).
 *
 * Read from the main transcript and the newest subagent transcripts, since a
 * session that delegates does most of its work there. Bash commands are read
 * for paths and command names, not run or interpreted, so the result is a
 * good guess that a person confirms, never a guarantee.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";

export interface FootprintArea {
  /** Absolute path: a repository's top level, or a folder under the home. */
  path: string;
  kind: "repo" | "folder";
  /** Files the session wrote there (Edit/Write tools). */
  writes: number;
  /** Other mentions: reads, and paths named in shell commands. */
  uses: number;
}

export interface FootprintService {
  label: string;
  plist: string;
  /** Loaded in launchd on this machine now. */
  running: boolean;
}

export interface FootprintTool {
  tool: string;
  /** Where this machine's shell finds it. */
  path: string;
  count: number;
  /** How this machine got it, so a host can get the same thing (installSource). */
  install?: ToolInstall;
}

/** A Homebrew formula, or an npm package pinned to this machine's version. */
export type ToolInstall = { brew: string } | { npm: string };

/**
 * Where a command on this machine came from, read from where its path really
 * leads: a Homebrew keg (`Cellar/<formula>/…`), or a global npm or bun package
 * (`node_modules/<pkg>/…`, pinned to the installed version so a host never gets
 * an unrelated package of the same name). A linked package (npm link), a
 * script in ~/bin or anything else has no source a host can repeat.
 */
export function installSource(binPath: string): ToolInstall | undefined {
  let real: string;
  try { real = fs.realpathSync(binPath); } catch { return undefined; }
  const keg = /\/Cellar\/([^/]+)\//.exec(real);
  if (keg) return { brew: keg[1] };
  const mod = /^(.*\/node_modules\/)(@[^/]+\/[^/]+|[^/@][^/]*)\//.exec(real);
  if (!mod) return undefined;
  const dir = mod[1] + mod[2];
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return undefined;
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    return pkg.name === mod[2] && typeof pkg.version === "string" ? { npm: `${pkg.name}@${pkg.version}` } : undefined;
  } catch { return undefined; }
}

export interface Footprint {
  /** The checkout the move carries anyway. */
  root: string;
  areas: FootprintArea[];
  services: FootprintService[];
  tools: FootprintTool[];
}

/** Subagent transcripts read, newest first, until this many bytes. */
const SUBAGENT_BYTES = 256 * 1024 * 1024;

/** Folders under the home that belong to the machine or its agents, never to one session's work. */
const MACHINE_DIRS = [
  ".claude", ".codex", ".gemini", ".grok", ".codecast", ".cache", ".npm", ".bun", ".cargo", ".rustup", ".local", ".nvm", ".pnpm-store",
  ".Trash", ".zsh_history", ".bash_history", ".config", ".ssh", ".gitconfig", ".zshrc", ".bashrc", ".profile",
  "Library/Caches", "Library/Developer", "Library/Logs", "Library/LaunchAgents", "Library/Application Support/Code",
  "Library/pnpm", "Downloads", "Desktop",
];

/** Commands that every machine has or that codecast installs itself: never worth reporting. */
const BASELINE_TOOLS = new Set([
  "cast", "codecast", "claude", "codex", "git", "gh", "node", "npm", "npx", "bun", "bunx", "ssh", "scp", "rsync", "curl", "brew",
  "python3", "python", "pip", "pip3", "tmux", "jq", "sudo", "env", "time", "nohup", "exec", "xargs", "sed", "awk", "grep", "find",
]);

const SHELL_WORDS = new Set(["if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "in", "function", "select", "{", "}", "!", "[[", "]]", "[", "true", "false", "export", "local", "return", "set", "unset", "source", ".", "cd", "echo", "printf", "read", "test", "eval", "wait", "trap", "shift", "break", "continue", "exit", "let", "declare", "type", "command", "builtin", "alias", "ulimit", "umask", "pushd", "popd", "kill", "sleep"]);

/** The transcripts that hold a session's work: its own, then subagents' newest first up to a byte budget. */
export function sessionTranscripts(jsonlPath: string, budget = SUBAGENT_BYTES): string[] {
  const dir = path.join(path.dirname(jsonlPath), path.basename(jsonlPath, ".jsonl"), "subagents");
  const subs: Array<{ file: string; mtime: number; size: number }> = [];
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const st = fs.statSync(path.join(dir, name));
      subs.push({ file: path.join(dir, name), mtime: st.mtimeMs, size: st.size });
    }
  } catch { /* no subagents */ }
  subs.sort((a, b) => b.mtime - a.mtime);
  const out = [jsonlPath];
  let used = 0;
  for (const s of subs) {
    if (used + s.size > budget) break;
    used += s.size;
    out.push(s.file);
  }
  return out;
}

export interface ToolCalls {
  writes: string[];
  reads: string[];
  commands: string[];
}

/** The file paths and shell commands in a transcript's tool calls. Lines without a tool call are skipped unparsed. */
export function readToolCalls(files: string[]): ToolCalls {
  const out: ToolCalls = { writes: [], reads: [], commands: [] };
  for (const file of files) {
    let text: string;
    try { text = fs.readFileSync(file, "utf-8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.includes('"tool_use"')) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      for (const b of o?.message?.content ?? []) {
        if (b?.type !== "tool_use" || !b.input) continue;
        const i = b.input;
        if (["Edit", "Write", "MultiEdit"].includes(b.name) && typeof i.file_path === "string") out.writes.push(i.file_path);
        else if (b.name === "NotebookEdit" && typeof i.notebook_path === "string") out.writes.push(i.notebook_path);
        else if (b.name === "Read" && typeof i.file_path === "string") out.reads.push(i.file_path);
        else if (b.name === "Bash" && typeof i.command === "string") out.commands.push(i.command);
      }
    }
  }
  return out;
}

/** Paths under the home a shell command names (`~/x`, `$HOME/x`, `/Users/me/x`). */
export function commandPaths(command: string, home: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?:~|\\$HOME|\\$\\{HOME\\}|${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(/[^\\s'"\`;|&<>()$]+)`, "g");
  for (const m of command.matchAll(re)) out.push(path.join(home, m[1]));
  return out;
}

/** A shell command without its heredoc bodies, which are data (a script, a message), not commands. */
export function withoutHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]);
    const m = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(lines[i]);
    if (!m) continue;
    while (i + 1 < lines.length && lines[i + 1].trim() !== m[1]) i++;
    i++;
  }
  return out.join("\n");
}

/** A quoted string that spans lines is a script handed to an interpreter (`python3 -c "…"`), not commands: it becomes one word. */
export function withoutQuotedLines(command: string): string {
  return command.replace(/'[^']*\n[^']*'|"(?:[^"\\]|\\.)*\n(?:[^"\\]|\\.)*"/g, "Q");
}

/** The command names a shell command runs: the first word of each pipeline stage, past env assignments and wrappers. */
export function commandNames(command: string): string[] {
  const out: string[] = [];
  for (const stage of withoutQuotedLines(withoutHeredocs(command)).split(/&&|\|\||[;|\n]|\$\(|`|\(/)) {
    const words = stage.trim().split(/\s+/).filter(Boolean);
    let w = 0;
    while (w < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[w]) || ["sudo", "time", "env", "nohup", "exec", "command", "then", "do", "else", "!"].includes(words[w]))) w++;
    const word = words[w];
    if (!word || word.startsWith("-") || word.startsWith("$") || /[='"{}<>*]/.test(word)) continue;
    const name = word.includes("/") ? path.basename(word) : word;
    if (/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) && !SHELL_WORDS.has(name)) out.push(name);
  }
  return out;
}

/** The repository a path sits in (nearest folder holding `.git`), or null. */
export function repoOf(p: string, home: string, cache = new Map<string, string | null>()): string | null {
  let dir = p;
  try { if (!fs.statSync(p).isDirectory()) dir = path.dirname(p); } catch { dir = path.dirname(p); }
  const seen: string[] = [];
  while (dir.startsWith(home) && dir !== home) {
    if (cache.has(dir)) { const hit = cache.get(dir)!; for (const s of seen) cache.set(s, hit); return hit; }
    seen.push(dir);
    if (fs.existsSync(path.join(dir, ".git"))) { for (const s of seen) cache.set(s, dir); return dir; }
    dir = path.dirname(dir);
  }
  for (const s of seen) cache.set(s, null);
  return null;
}

function isMachinePath(p: string, home: string): boolean {
  const rel = path.relative(home, p);
  return MACHINE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
}

/** The folder a path outside any repository is reported as: two levels under the home (`~/.dailies`, `~/src/notes`). */
export function folderOf(p: string, home: string): string | null {
  const rel = path.relative(home, p);
  if (!rel || rel.startsWith("..")) return null;
  if (isMachinePath(p, home)) return null;
  const parts = rel.split(path.sep);
  // A dot folder is an app's own data (~/.dailies); a plain one is a parent of projects (~/src/x).
  return path.join(home, ...(parts[0].startsWith(".") || parts.length === 1 ? parts.slice(0, 1) : parts.slice(0, 2)));
}

/** Plists the session wrote or loaded under ~/Library/LaunchAgents. */
export function launchdPlists(calls: ToolCalls, home: string): string[] {
  const dir = path.join(home, "Library", "LaunchAgents");
  const found = new Set<string>();
  for (const w of calls.writes) if (w.startsWith(`${dir}/`) && w.endsWith(".plist")) found.add(w);
  for (const c of calls.commands) {
    if (!/\blaunchctl\b/.test(c)) continue;
    for (const p of commandPaths(c, home)) if (p.startsWith(`${dir}/`) && p.endsWith(".plist")) found.add(p);
  }
  return [...found];
}

export interface FootprintDeps {
  home?: string;
  /** Where the shell finds each name (login shell PATH); absent = not found. */
  which?: (names: string[]) => Record<string, string>;
  /** Whether a launchd label is loaded. */
  loaded?: (label: string) => boolean;
  /** Whether the file at `p` is spelled `name` exactly (macOS finds `Tests` as `tests`). */
  exactName?: (p: string, name: string) => boolean;
  installSource?: (p: string) => ToolInstall | undefined;
}

function exactName(p: string, name: string): boolean {
  try { return fs.readdirSync(path.dirname(p)).includes(name); } catch { return false; }
}

/** One login shell answering `command -v` for every name, since the daemon's PATH lacks what the person's rc adds. */
export function whichAll(names: string[], shell = process.env.SHELL || "/bin/bash"): Record<string, string> {
  if (!names.length) return {};
  const probe = names.map((n) => `p=$(command -v ${n} 2>/dev/null) && printf '%s\\t%s\\n' ${n} "$p"`).join("\n");
  const r = spawnSync(shell, ["-lc", probe], { encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "ignore"] });
  const out: Record<string, string> = {};
  for (const line of (r.stdout ?? "").split("\n")) {
    const [n, p] = line.split("\t");
    if (n && p?.startsWith("/")) out[n] = p;
  }
  return out;
}

const SYSTEM_PREFIXES = ["/bin/", "/sbin/", "/usr/bin/", "/usr/sbin/", "/usr/libexec/", "/System/", "/Library/Apple/"];

export function computeFootprint(root: string, calls: ToolCalls, deps: FootprintDeps = {}): Footprint {
  const home = deps.home ?? os.homedir();
  const cache = new Map<string, string | null>();
  const areas = new Map<string, FootprintArea>();
  const note = (p: string, write: boolean) => {
    if (!path.isAbsolute(p) || !p.startsWith(`${home}/`)) return;
    if (p === root || p.startsWith(`${root}/`) || isMachinePath(p, home)) return;
    const repo = repoOf(p, home, cache);
    const at = repo ?? folderOf(p, home);
    if (!at || at === root || root.startsWith(`${at}/`)) return;
    if (!fs.existsSync(at)) return;
    const a = areas.get(at) ?? { path: at, kind: repo ? "repo" as const : "folder" as const, writes: 0, uses: 0 };
    if (write) a.writes++; else a.uses++;
    areas.set(at, a);
  };
  for (const w of calls.writes) note(w, true);
  for (const r of calls.reads) note(r, false);
  for (const c of calls.commands) for (const p of new Set(commandPaths(c, home))) note(p, false);

  // The session's services: plists it wrote or loaded, and any in LaunchAgents
  // that run something from its checkout or the folders it works in (a job is
  // often loaded through a shell variable no transcript spells out).
  const agentsDir = path.join(home, "Library", "LaunchAgents");
  const places = [root, ...[...areas.values()].filter((a) => a.writes > 0 || a.uses >= 3).map((a) => a.path)];
  const plists = new Set(launchdPlists(calls, home));
  try {
    for (const name of fs.readdirSync(agentsDir)) {
      if (!name.endsWith(".plist") || name.startsWith("sh.codecast.")) continue;
      const file = path.join(agentsDir, name);
      let text = "";
      try { text = fs.readFileSync(file, "utf-8"); } catch { continue; }
      if (places.some((p) => text.includes(`${p}/`) || text.includes(`${p}<`))) plists.add(file);
    }
  } catch { /* no LaunchAgents */ }
  const services = [...plists].filter((p) => fs.existsSync(p)).map((plist) => {
    const label = path.basename(plist, ".plist");
    return { label, plist, running: (deps.loaded ?? launchdLoaded)(label) };
  });

  const counts = new Map<string, number>();
  for (const c of calls.commands) for (const n of commandNames(c)) if (!BASELINE_TOOLS.has(n)) counts.set(n, (counts.get(n) ?? 0) + 1);
  const where = (deps.which ?? whichAll)([...counts.keys()].filter((n) => counts.get(n)! >= 2));
  const inArea = (p: string) => p.startsWith(`${root}/`) || [...areas.keys()].some((a) => p.startsWith(`${a}/`));
  const tools = [...counts]
    .filter(([n]) => where[n] && (deps.exactName ?? exactName)(where[n], n) && !SYSTEM_PREFIXES.some((s) => where[n].startsWith(s)) && !inArea(where[n]) && !where[n].includes("/node_modules/"))
    .map(([tool, count]) => { const install = (deps.installSource ?? installSource)(where[tool]); return { tool, path: where[tool], count, ...(install ? { install } : {}) }; })
    .sort((a, b) => b.count - a.count);

  // A folder named once in passing is noise; one written to, or used again and again, is work.
  const kept = [...areas.values()].filter((a) => a.writes > 0 || a.uses >= 3).sort((a, b) => b.writes - a.writes || b.uses - a.uses);
  return { root, areas: kept, services, tools };
}

function launchdLoaded(label: string): boolean {
  return spawnSync("launchctl", ["list", label], { stdio: "ignore", timeout: 10_000 }).status === 0;
}

/** The footprint of a session whose transcript is at `jsonlPath` and whose checkout is `root`. */
export function sessionFootprint(jsonlPath: string, root: string, deps: FootprintDeps = {}): Footprint {
  return computeFootprint(root, readToolCalls(sessionTranscripts(jsonlPath)), deps);
}
