/**
 * What `cast cloud` reads off this laptop before anything moves: the folders
 * recent sessions worked in, each repository's working folder as a sync
 * snapshot (cloud/syncSide.ts decides what travels, so a file skipped here
 * is skipped for the same reason `cast sync` skips it), the tools and
 * services sessions used (migrate/footprint.ts), the agent config the home
 * mirror ships (cloud/mirror), the logins the login bundle ships
 * (remote/agentAuth.ts), the variable names the login shell sets, and the
 * things that never leave a machine (services listening here, containers,
 * SSH keys).
 *
 * Every finding lands in the parity ledger, planned or skipped with its
 * reason. The returned plan is what the apply step carries.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../../proc.js";
import { extractCodexCwd } from "../../codexSessionMeta.js";
import { slugToCwd } from "../../remote/session-move.js";
import { computeFootprint, readToolCalls, type Footprint } from "../../migrate/footprint.js";
import { collectMirrorFiles, type Inventory } from "../mirror/inventory.js";
import { AGENT_AUTH_SOURCES, TOOL_AUTH_SOURCES, collectAgentAuthBundle, hostLoginName, hostLoginTravels, type HostLogins } from "../../remote/agentAuth.js";
import { nodeRequirement, requiredHostTools, type HostToolRequirement, type RequiredHostTools } from "../hostTools.js";
import { resolveHostSpec } from "../hostSetup.js";
import { readSyncScope } from "../syncScope.js";
import { runSide, type Skipped, type SnapshotResult, type SyncScope } from "../syncSide.js";
import { SYNC_SKIP_WORDS, type SyncSkipReason } from "@codecast/shared/contracts";
import type { Config } from "../../config/types.js";
import { ParityLedger, parityKey } from "./parity.js";

export const DEFAULT_DAYS = 14;
/** Above this a folder (not a repository) is reported instead of copied, unless named with --only. */
export const FOLDER_MAX_BYTES = 2 * 1024 ** 3;

/** Repositories directly in `dir` or one level down: the mark of a folder of projects. */
export function projectsInside(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name === ".git") continue;
      const sub = path.join(d, e.name);
      if (fs.existsSync(path.join(sub, ".git"))) out.push(sub);
      else if (depth < 1) walk(sub, depth + 1);
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** A folder's size, by du with a time limit; undefined when it could not be read in time. */
export function folderBytes(dir: string): number | undefined {
  const r = spawnSync("du", ["-sk", dir], { encoding: "utf-8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
  const kb = Number((r.stdout ?? "").split(/\s/)[0]);
  return r.status === 0 && Number.isFinite(kb) ? kb * 1024 : undefined;
}
/** Transcript bytes read for the tools and services sessions used, newest first. */
export const FOOTPRINT_BYTES = 256 * 1024 * 1024;
/** The ref a repo's snapshot is kept under until the host has it. */
export const ENV_SNAPSHOT_REF = "refs/codecast/cloud-env/snapshot";

export interface RepoPlan {
  key: string;
  root: string;
  name: string;
  snapshot: SnapshotResult;
  scope?: SyncScope;
  /** Local branches and the commits they point at, checked on the host after the carry. */
  branches: Record<string, string>;
  /** Empty for a linked worktree, whose branches are its main checkout's. */
  branchesKey: string;
  /** The main checkout, when this is a linked worktree with uncommitted work. */
  worktreeOf?: string;
  /** The files item for agent config inside the repo, carried by the config mirror. */
  agentKey?: string;
}

export interface FolderPlan { key: string; path: string }

export interface EnvPlan {
  repos: RepoPlan[];
  folders: FolderPlan[];
  /** Commands sessions ran that a host can install (footprint). */
  extraTools: HostToolRequirement[];
  required: RequiredHostTools;
  mirror: Inventory;
  /** Login sources the bundle ships, by the host path each lands at. */
  loginPaths: Record<string, string>;
  /** Variable names the laptop's login shell sets that a host shell should too. */
  envNames: string[];
}

export interface InventoryDeps {
  home: string;
  now: number;
  days: number;
  config: Config | null;
  userId?: string;
  deviceId?: string;
  /** The target host's login setting (`cast hosts logins`); missing = every login. */
  logins?: HostLogins;
  /** Carry only these folders (and the repositories they are in); everything else in the home still travels. */
  only?: string[];
  /** Leave the commit (and its ref) out: a dry run writes nothing. */
  dryRun?: boolean;
  /** Seams for tests. */
  run?: (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => { status: number | null; stdout: string };
  snapshot?: (cwd: string, scope: SyncScope | undefined, commit: boolean) => Promise<SnapshotResult>;
  footprint?: (calls: ReturnType<typeof readToolCalls>) => Footprint;
  mirror?: () => Promise<Inventory>;
  required?: (repoRoot: string | undefined, extra: HostToolRequirement[]) => RequiredHostTools;
  loginShellEnv?: () => string[];
  listening?: () => Array<{ command: string; port: string; pid: string }>;
  containers?: () => string[];
  exePath?: (pid: string) => string;
  folderBytes?: (dir: string) => number | undefined;
  log?: (line: string) => void;
}

function defaultRun(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf-8", timeout: opts.timeoutMs ?? 30_000, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "" };
}

export const tilde = (p: string, home: string) => (p === home ? "~" : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);

// ---------------------------------------------------------------------------
// Where sessions worked
// ---------------------------------------------------------------------------

export interface SessionFolders {
  /** Folder → its newest transcripts (Claude main transcripts only, for the footprint). */
  folders: Map<string, string[]>;
  /** Recent session folders that no longer exist here. */
  gone: number;
  claudeSessions: number;
  codexSessions: number;
}

/** The folders Claude and Codex sessions active in the last `days` ran in. */
export function recentSessionFolders(home: string, cutoff: number): SessionFolders {
  const folders = new Map<string, string[]>();
  let gone = 0, claudeSessions = 0, codexSessions = 0;
  const add = (cwd: string | null | undefined, transcript?: string) => {
    if (!cwd) { gone++; return; }
    const list = folders.get(cwd) ?? [];
    if (transcript) list.push(transcript);
    folders.set(cwd, list);
  };
  const projects = path.join(home, ".claude", "projects");
  let slugs: string[] = [];
  try { slugs = fs.readdirSync(projects); } catch { /* no Claude */ }
  for (const slug of slugs) {
    let recent: Array<{ file: string; mtime: number }> = [];
    try {
      for (const name of fs.readdirSync(path.join(projects, slug))) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(projects, slug, name);
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime >= cutoff) recent.push({ file, mtime });
      }
    } catch { continue; }
    if (!recent.length) continue;
    claudeSessions += recent.length;
    recent = recent.sort((a, b) => b.mtime - a.mtime);
    const cwd = slugToCwd(slug);
    if (!cwd) { gone++; continue; }
    for (const r of recent) add(cwd, r.file);
  }
  const codex = path.join(home, ".codex", "sessions");
  for (const day = new Date(cutoff); day.getTime() <= Date.now() + 86_400_000; day.setUTCDate(day.getUTCDate() + 1)) {
    const dir = path.join(codex, String(day.getUTCFullYear()), String(day.getUTCMonth() + 1).padStart(2, "0"), String(day.getUTCDate()).padStart(2, "0"));
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) continue; } catch { continue; }
      codexSessions++;
      let head = "";
      try {
        const fd = fs.openSync(file, "r");
        try { const b = Buffer.alloc(64 * 1024); head = b.toString("utf-8", 0, fs.readSync(fd, b, 0, b.length, 0)); } finally { fs.closeSync(fd); }
      } catch { continue; }
      const cwd = extractCodexCwd(head.slice(0, head.lastIndexOf("\n") + 1));
      add(cwd && fs.existsSync(cwd) ? cwd : null);
    }
  }
  return { folders, gone, claudeSessions, codexSessions };
}

/** Folders under the home that hold the machine's or its agents' own state. */
const STATE_DIRS = [".claude", ".codex", ".codecast", ".gemini", ".grok", ".cursor", ".pi", ".config", ".local", ".cache", "Library"];
/** macOS media libraries: Photos and Music keep databases rsync cannot read, and the folders are rarely a session's work. */
const MEDIA_LIBRARIES = ["Pictures", "Movies", "Music"];

export type FolderKind =
  | { kind: "repo"; root: string }
  | { kind: "worktree"; root: string; main: string }
  | { kind: "folder"; path: string }
  | { kind: "skip"; path: string; reason: string; fix?: string };

/** What one session folder is, and so how it travels. */
export function classifyFolder(cwd: string, home: string, run = defaultRun): FolderKind {
  const rel = path.relative(home, cwd);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { kind: "skip", path: cwd, reason: "outside your home folder (scratch space)" };
  if (!rel) return { kind: "skip", path: cwd, reason: "your home folder itself: its agent config travels with the config mirror, its projects one by one" };
  if (MEDIA_LIBRARIES.some((d) => rel === d || rel.startsWith(`${d}/`))) {
    return { kind: "skip", path: path.join(home, rel.split("/")[0]!), reason: "a macOS media library (Photos and Music keep databases only their apps can read)", fix: "copy the files a session needs into a project, or name a subfolder with --only" };
  }
  if (STATE_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`))) {
    const top = run("git", ["rev-parse", "--show-toplevel"], { cwd });
    if (top.status !== 0) return { kind: "skip", path: path.join(home, rel.split("/")[0]!), reason: "agent or machine state, not a project (the config mirror carries agent config)" };
  }
  const r = run("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd });
  if (r.status !== 0) return { kind: "folder", path: cwd };
  const [top, common] = r.stdout.trim().split("\n");
  if (!top) return { kind: "folder", path: cwd };
  // A repository with no commits yet has nothing to snapshot: its files travel as a folder.
  if (run("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: top }).status !== 0) return { kind: "folder", path: top };
  const main = common && path.basename(common) === ".git" ? path.dirname(common) : top;
  if (main !== top) return { kind: "worktree", root: top, main };
  return { kind: "repo", root: top };
}

// ---------------------------------------------------------------------------
// Files a snapshot leaves behind
// ---------------------------------------------------------------------------

const SKIP_DETAIL: Record<SyncSkipReason, { reason: string; fix?: string }> = {
  rebuilt: { reason: "dependency and build folders: rebuilt by an install on the host, never copied" },
  media: { reason: `${SYNC_SKIP_WORDS.media}; stays on this laptop`, fix: "list the path under [sync] always in .codecast/workspace.toml" },
  binary: { reason: "compiled programs built for this laptop's OS; rebuild them on the host" },
  large: { reason: "each over the 100 MB per-file limit", fix: "list the path under [sync] always in .codecast/workspace.toml" },
  total: { reason: "the largest untracked files, dropped to keep the carry under 1 GB", fix: "list the path under [sync] always in .codecast/workspace.toml" },
  live: { reason: "owned by a running process (sockets, pid files, database journals); they mean nothing on another machine" },
  repo: { reason: "nested repositories: each has its own history and travels as a repository if a session worked in it" },
  special: { reason: "not regular files (devices, fifos)" },
  never: { reason: "matched by your [sync] never patterns" },
};

/** Group a snapshot's skipped paths into one ledger item per reason. */
export function recordSkippedFiles(ledger: ParityLedger, repoName: string, skipped: Skipped[], opts: { installs: boolean }): void {
  const by = new Map<SyncSkipReason, Skipped[]>();
  for (const s of skipped) by.set(s.reason, [...(by.get(s.reason) ?? []), s]);
  for (const [reason, list] of by) {
    const d = SKIP_DETAIL[reason];
    const bytes = list.reduce((n, s) => n + (s.bytes ?? 0), 0);
    const why = reason === "rebuilt" && !opts.installs
      ? "dependency and build folders, never copied; nothing on the host runs an install for this repo yet"
      : d.reason;
    const fix = reason === "rebuilt" && !opts.installs ? "add the install command under [host] run in .codecast/workspace.toml (cast hosts setup applies it)" : d.fix;
    ledger.skip("files", `${repoName}: ${SYNC_SKIP_WORDS[reason]}`, why, {
      detail: `${list.length} path${list.length === 1 ? "" : "s"}${bytes ? `, ${formatBytes(bytes)}` : ""}`,
      paths: list.map((s) => s.path),
      ...(fix ? { fix } : {}),
    });
  }
}

export function formatBytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// ---------------------------------------------------------------------------
// What the config mirror leaves behind
// ---------------------------------------------------------------------------

/** The mirror's terse reasons in words a person can act on. */
/** The mirror's terse reasons in words a person can act on, each with a short label that names its group. */
const MIRROR_REASON: Array<[RegExp, string, string, string?]> = [
  [/^denied$|denied path/, "machine data", "machine data the mirror never copies (transcripts, caches, logs, app state)"],
  [/^excluded$|^referenced path absent or excluded$/, "excluded", "excluded by the mirror's defaults or your cloud_mirror_exclude", "remove the pattern from cloud_mirror_exclude, or name the path in cloud_mirror_include"],
  [/^codecast-owned path$/, "codecast's own", "codecast's own files; the host's cast writes its own"],
  [/account data/, "account data", "account data (sign-in state of an app); logins travel through the login bundle instead"],
  [/^native binary$/, "macOS programs", "programs compiled for macOS; they cannot run on a Linux host"],
  [/^not a portable text script$/, "not scripts", "programs in ~/.local/bin that are not plain text scripts; the tools step installs what the host needs"],
  [/credential/, "credentials", "files holding credentials; logins travel through the login bundle, keys through the vault", "store the key with cast vault, or name the file in cloud_mirror_include to carry it as it is"],
  [/symlink/, "links", "links that point outside the folders the mirror carries, or nowhere"],
  [/^not a (regular )?file/, "not files", "not regular files (sockets, devices)"],
];

function mirrorReason(raw: string): { label: string; reason: string; fix?: string } {
  for (const [re, label, reason, fix] of MIRROR_REASON) if (re.test(raw)) return { label, reason, ...(fix ? { fix } : {}) };
  return { label: raw, reason: raw };
}

function isLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** The first segments of a home-relative path: the folder an item stands for. */
const folderKey = (rel: string) => rel.split("/").slice(0, /^(Library|\.config|\.local)\//.test(rel) ? 2 : 1).join("/");

/**
 * The mirror's skipped paths as ledger items, one per folder and reason with
 * every path kept. A reference to a path that does not exist here, or that
 * sits inside a repository this run carries, leaves nothing behind: those are
 * counted in the report's scope instead of listed.
 */
export function recordMirrorSkips(ledger: ParityLedger, skipped: Array<{ path: string; reason: string }>, home: string, repoRoots: string[], loginFiles: string[] = []): void {
  const groups = new Map<string, { folder: string; raw: string; paths: string[] }>();
  let absent = 0, inRepos = 0, asLogins = 0;
  const logins = new Set(loginFiles);
  for (const s of skipped) {
    const abs = path.join(home, s.path);
    if (repoRoots.some((r) => abs === r || abs.startsWith(`${r}/`))) { inRepos++; continue; }
    // A login the bundle ships, or a folder holding only such logins, travels that way.
    if (logins.has(abs) || [...logins].some((f) => f.startsWith(`${abs}/`))) { asLogins++; continue; }
    // A name read out of instruction text that is no file here leaves nothing behind.
    if (!fs.existsSync(abs) && !isLink(abs)) { absent++; continue; }
    const folder = folderKey(s.path);
    const key = `${folder}\0${mirrorReason(s.reason).label}`;
    const g = groups.get(key) ?? { folder, raw: s.reason, paths: [] };
    g.paths.push(`~/${s.path}`);
    groups.set(key, g);
  }
  // One item per folder and reason. A folder with one reason is named plainly; a
  // folder some of whose files go (a mirror root) or that stays for several
  // reasons names the reason too, so no group can stand in for another.
  const reasonsPer = new Map<string, number>();
  for (const g of groups.values()) reasonsPer.set(g.folder, (reasonsPer.get(g.folder) ?? 0) + 1);
  for (const g of groups.values()) {
    const { label, reason, fix } = mirrorReason(g.raw);
    const plain = g.paths.length === 1 ? g.paths[0]! : `~/${g.folder}`;
    const shared = reasonsPer.get(g.folder)! > 1 || !!ledger.get(parityKey("config", plain));
    ledger.skip("config", shared ? `~/${g.folder}: ${label}` : plain, reason, {
      ...(g.paths.length > 1 || shared ? { detail: `${g.paths.length} path${g.paths.length === 1 ? "" : "s"}`, paths: g.paths } : {}), ...(fix ? { fix } : {}),
    });
  }
  if (asLogins) ledger.scope.push(`${asLogins} paths the config mirror leaves out are logins, and travel in the login bundle instead`);
  if (absent) ledger.scope.push(`${absent} paths named in agent instruction files do not exist on this laptop, so there is nothing of them to carry`);
  if (inRepos) ledger.scope.push(`${inRepos} paths named in agent instruction files sit inside repositories this run carries, and travel with them`);
}

// ---------------------------------------------------------------------------
// The login shell's variables
// ---------------------------------------------------------------------------

/** Names that belong to the session or the machine, never to the person's setup. */
const MACHINE_ENV = /^(PATH|MANPATH|INFOPATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|SHLVL|_|TERM|TERM_.*|COLORTERM|TMPDIR|LANG|LC_.*|SSH_.*|XPC_.*|__CF.*|__CFBundleIdentifier|COMMAND_MODE|MallocNanoZone|TMUX.*|ITERM.*|LaunchInstanceID|SECURITYSESSIONID|DISPLAY|CODECAST_.*|CLAUDE_CODE_.*|CLAUDECODE|ZSH|ZDOTDIR|HISTFILE|HISTSIZE|SAVEHIST|PS[1-4]|PROMPT.*|RPROMPT|LSCOLORS|LS_COLORS|LESS|PAGER|EDITOR|VISUAL|GIT_ASKPASS|VSCODE_.*|OSLogRateLimit|ORIGINAL_XDG_CURRENT_DESKTOP)$/;

/** Names a Linux host has its own value for, or that only mean something on a Mac. */
const MAC_ONLY_ENV = /^(HOMEBREW_.*|DYLD_.*|SDKROOT|DEVELOPER_DIR|JAVA_HOME|ANDROID_(HOME|SDK_ROOT)|NVM_.*|BUN_INSTALL|PNPM_HOME|VOLTA_HOME|GOPATH|CONDA_.*|PYENV_.*|RBENV_.*)$/;

/**
 * What a fresh login shell on this laptop sets: started from an empty
 * environment, so variables this process inherited (an agent's own, a
 * terminal's) are not mistaken for the person's setup.
 */
export function loginShellEnvNames(shell = process.env.SHELL || "/bin/bash", home = process.env.HOME || os.homedir()): string[] {
  const user = os.userInfo().username;
  const r = spawnSync("/usr/bin/env", ["-i", `HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`, `SHELL=${shell}`, "TERM=xterm-256color", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", shell, "-lic", "env -0"],
    { encoding: "utf-8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"], cwd: home });
  return envNames(r.stdout ?? "");
}

/** Variable names from `env -0` output. Values are never kept. */
export function envNames(out: string): string[] {
  const names = new Set<string>();
  for (const pair of out.split("\0")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(pair.replace(/^\s+/, ""));
    if (m) names.add(m[1]!);
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Things that stay on this machine
// ---------------------------------------------------------------------------

/** Processes of this user listening on TCP, minus apps and codecast itself. */
export function listeningServices(run = defaultRun): Array<{ command: string; port: string; pid: string }> {
  const r = run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-u", String(os.userInfo().uid), "-a", "-Fpcn"], { timeoutMs: 15_000 });
  const out: Array<{ command: string; port: string; pid: string }> = [];
  let pid = "", command = "";
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("c")) command = line.slice(1);
    else if (line.startsWith("n")) {
      const port = /:(\d+)$/.exec(line)?.[1];
      if (port && !out.some((o) => o.pid === pid && o.port === port)) out.push({ command, port, pid });
    }
  }
  return out;
}

/** The ports the OS hands out for a moment; a service someone runs on purpose sits below them. */
const EPHEMERAL_PORT = 49152;

/**
 * The person's own services among the listeners: not an app or a macOS
 * service (by where its program lives), not codecast, not on an ephemeral
 * port. Grouped by command with every port it holds.
 */
export function personalListeners(listening: Array<{ command: string; port: string; pid: string }>, exePath: (pid: string) => string): { listeners: Map<string, string[]>; ignored: number } {
  const listeners = new Map<string, string[]>();
  const exe = new Map<string, string>();
  let ignored = 0;
  for (const l of listening) {
    const where = exe.get(l.pid) ?? exePath(l.pid);
    exe.set(l.pid, where);
    if (Number(l.port) >= EPHEMERAL_PORT || APP_LISTENERS.test(l.command) || /^\/(Applications|System|Library|usr\/libexec|usr\/sbin)\//.test(where) || /\.app\/Contents\//.test(where)) { ignored++; continue; }
    const ports = listeners.get(l.command) ?? [];
    if (!ports.includes(l.port)) ports.push(l.port);
    listeners.set(l.command, ports.sort((a, b) => Number(a) - Number(b)));
  }
  return { listeners, ignored };
}

/** Desktop apps and codecast's own processes listen too; they are not the person's services. */
const APP_LISTENERS = /^(cast|codecast|Codecast.*|Electron|Google|Chrome|Slack|Discord|Spotify|Dropbox|rapportd|ControlCe|ControlCenter|figma_age|Figma|Cursor|Code|Raycast|Notion|zoom|Linear|1Password|Tailscale|IPNExtension|Arc|Safari|WebKit|com\.apple.*|sharingd|identitys|AirPlayXP|Eaiden|Superhuman|Claude|ollama)/i;

export function runningContainers(run = defaultRun): string[] {
  const r = run("docker", ["ps", "--format", "{{.Names}} ({{.Image}})"], { timeoutMs: 10_000 });
  return r.status === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

// ---------------------------------------------------------------------------
// The inventory
// ---------------------------------------------------------------------------

export async function readLaptopEnvironment(ledger: ParityLedger, deps: InventoryDeps): Promise<EnvPlan> {
  const { home } = deps;
  const run = deps.run ?? defaultRun;
  const log = deps.log ?? (() => {});
  const cutoff = deps.now - deps.days * 86_400_000;

  // Sessions, then what they worked on.
  log("reading recent sessions");
  const sessions = recentSessionFolders(home, cutoff);
  ledger.scope.push(`${sessions.claudeSessions} Claude and ${sessions.codexSessions} Codex sessions active in the last ${deps.days} days, in ${sessions.folders.size} folders`);
  if (sessions.gone) ledger.scope.push(`${sessions.gone} recent sessions ran in folders that no longer exist here`);

  const transcripts = [...sessions.folders.values()].flat()
    .map((file) => { try { return { file, mtime: fs.statSync(file).mtimeMs, size: fs.statSync(file).size }; } catch { return null; } })
    .filter((t): t is { file: string; mtime: number; size: number } => !!t)
    .sort((a, b) => b.mtime - a.mtime);
  const read: string[] = [];
  let bytes = 0;
  for (const t of transcripts) { if (bytes + t.size > FOOTPRINT_BYTES && read.length) break; bytes += t.size; read.push(t.file); }
  log(`reading tool calls from ${read.length} transcripts (${formatBytes(bytes)})`);
  const calls = readToolCalls(read);
  // A root no path can fall under, so every repository and folder sessions touched is reported.
  const footprint = (deps.footprint ?? ((c) => computeFootprint(path.join(home, "\0cast-cloud"), c, { home })))(calls);
  ledger.scope.push(`tools, services and other folders from the tool calls of the newest ${read.length} of ${transcripts.length} Claude transcripts (${formatBytes(bytes)})`);

  // root → the main checkout it is a linked worktree of, or null for a main checkout.
  const repos = new Map<string, string | null>();
  const cleanWorktrees = new Map<string, string[]>();
  const folders = new Set<string>();
  const only = deps.only?.map((p) => path.resolve(p));
  const inOnly = (p: string) => !only || only.some((o) => p === o || p.startsWith(`${o}/`));
  if (only) {
    ledger.scope.push(`limited to ${only.map((o) => tilde(o, home)).join(", ")} (--only): other repositories and folders were not read`);
    for (const o of only) if (!sessions.folders.has(o)) sessions.folders.set(o, []);
  }
  const consider = (cwd: string) => {
    if (!inOnly(cwd)) return;
    const c = classifyFolder(cwd, home, run);
    if (c.kind === "repo") { if (!repos.has(c.root)) repos.set(c.root, null); }
    else if (c.kind === "worktree") {
      if (!repos.has(c.main)) repos.set(c.main, null);
      // A worktree with uncommitted work travels as its own checkout; a clean
      // one holds nothing its branch does not, and its branch travels with the main checkout.
      const dirty = run("git", ["status", "--porcelain"], { cwd: c.root }).stdout.split("\n").some(Boolean);
      if (dirty) repos.set(c.root, c.main);
      else if (!repos.has(c.root)) cleanWorktrees.set(c.main, [...new Set([...(cleanWorktrees.get(c.main) ?? []), tilde(c.root, home)])]);
    } else if (c.kind === "folder") folders.add(c.path);
    else ledger.skip("folder", tilde(c.path, home), c.reason, c.fix ? { fix: c.fix } : {});
  };
  for (const cwd of sessions.folders.keys()) consider(cwd);
  for (const area of footprint.areas) consider(area.path);
  for (const f of [...folders]) if ([...repos.keys()].some((r) => f === r || f.startsWith(`${r}/`))) folders.delete(f);

  // Repositories: one sync snapshot each.
  const repoPlans: RepoPlan[] = [];
  // Main checkouts first: a worktree's host checkout is cloned from its main's.
  for (const root of [...repos.keys()].sort((a, b) => Number(!!repos.get(a)) - Number(!!repos.get(b)) || a.localeCompare(b))) {
    const worktreeOf = repos.get(root) ?? undefined;
    const name = tilde(root, home);
    log(`reading ${name}`);
    const scope = readSyncScope(root, deps.config);
    let snap: SnapshotResult;
    try {
      snap = deps.snapshot
        ? await deps.snapshot(root, scope, !deps.dryRun)
        : await runSide<SnapshotResult>({ op: "snapshot", cwd: root, scope, skippedLimit: 1_000_000, agentPaths: true, ...(deps.dryRun ? { listOnly: true } : { commit: true, ref: ENV_SNAPSHOT_REF }) });
    } catch (e) {
      ledger.skip("repo", name, `could not read its working folder: ${(e as Error).message}`, { fix: "fix the repository here (git status), then run cast cloud again" });
      continue;
    }
    const dirty = run("git", ["status", "--porcelain"], { cwd: root }).stdout.split("\n").filter(Boolean).length;
    const untracked = snap.untrackedCount ? `, ${snap.untrackedCount} untracked or ignored files (${formatBytes(snap.untrackedBytes ?? 0)})` : "";
    const key = ledger.plan("repo", name, { detail: `${snap.branch === "HEAD" ? "detached" : snap.branch} at ${snap.head.slice(0, 8)}${dirty ? `, ${dirty} uncommitted` : ""}${untracked}` });
    const installs = (resolveHostSpec({ repoRoot: root, home }).run ?? []).length > 0;
    recordSkippedFiles(ledger, name, snap.skipped, { installs });
    let agentKey: string | undefined;
    if (snap.agentPaths?.length) agentKey = ledger.plan("files", `${name}: agent config`, { detail: `${snap.agentPaths.length} path${snap.agentPaths.length === 1 ? "" : "s"}, carried by the config mirror`, paths: snap.agentPaths });
    // A worktree shares its main checkout's branches: they are checked there.
    const branches: Record<string, string> = {};
    if (!worktreeOf) for (const line of run("git", ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads"], { cwd: root }).stdout.split("\n")) {
      const [b, sha] = line.trim().split(" ");
      if (b && sha) branches[b] = sha;
    }
    const clean = cleanWorktrees.get(root) ?? [];
    const branchesKey = worktreeOf ? "" : ledger.plan("repo", `${name}: branches`, {
      detail: `${Object.keys(branches).length} local${clean.length ? `, including those of ${clean.length} clean linked worktree${clean.length === 1 ? "" : "s"}` : ""}`,
      ...(clean.length ? { paths: clean } : {}),
    });
    const stashes = run("git", ["stash", "list"], { cwd: root }).stdout.split("\n").filter(Boolean).length;
    if (stashes && !worktreeOf) ledger.skip("repo", `${name}: stashes`, "stashes are not carried", { detail: `${stashes}`, fix: "apply and commit what you need, then run cast cloud again" });
    if (fs.existsSync(path.join(root, ".gitmodules"))) ledger.skip("repo", `${name}: submodules`, "submodules are not checked out on the host", { fix: "run git submodule update --init in the host checkout" });
    repoPlans.push({ key, root, name, snapshot: snap, scope, branches, branchesKey, agentKey, ...(worktreeOf ? { worktreeOf } : {}) });
  }

  const folderPlans: FolderPlan[] = [];
  for (const p of [...folders].sort()) {
    const name = tilde(p, home);
    const explicit = !!only?.some((o) => o === p);
    // A folder holding repositories is a folder of projects, not one: copying it
    // whole would carry every project in it. The ones sessions used travel one by one.
    const projects = projectsInside(p);
    if (projects.length) {
      ledger.skip("folder", name, `a folder of ${projects.length} project${projects.length === 1 ? "" : "s"}; the ones sessions worked in travel one by one as repositories`, {
        paths: projects.map((r) => tilde(r, home)), fix: "name a project with --only to carry it",
      });
      continue;
    }
    const bytes = (deps.folderBytes ?? folderBytes)(p);
    if (!explicit && bytes !== undefined && bytes > FOLDER_MAX_BYTES) {
      ledger.skip("folder", name, `larger than ${formatBytes(FOLDER_MAX_BYTES)}, too big to copy as a folder`, { detail: formatBytes(bytes), fix: `cast cloud --only ${name} carries it anyway` });
      continue;
    }
    folderPlans.push({ key: ledger.plan("folder", name, bytes === undefined ? {} : { detail: formatBytes(bytes) }), path: p });
  }

  // Tools: what the mirrored home and each repo need, plus what sessions ran.
  const extraTools: HostToolRequirement[] = [];
  for (const t of footprint.tools) {
    if (t.install) extraTools.push({ tool: t.tool, referenced_by: `ran ${t.count} times in sessions`, install: t.install });
    else ledger.skip("tool", t.tool, `ran ${t.count} times in sessions, but it was not installed by Homebrew or as a global npm or bun package, so a host cannot install the same thing`, {
      detail: tilde(t.path, home), fix: "add its install command under [host] run in ~/.codecast/host.toml",
    });
  }
  const requiredFor = deps.required ?? ((repoRoot, extra) => requiredHostTools({ repoRoot, extraTools: extra, laptopHome: home }));
  const required = requiredFor(repoPlans[0]?.root, extraTools);
  // The node every repo needs: the highest any of them asks for.
  for (const r of repoPlans.slice(1)) {
    const node = nodeRequirement(r.root, undefined);
    if (node.minMajor > required.node.minMajor) required.node = { ...node, source: `${r.name}: ${node.source}` };
  }
  ledger.plan("tool", "node", { detail: `${required.node.minMajor}+ (${required.node.source})` });
  if (required.bun) ledger.plan("tool", "bun", { detail: required.bun });
  for (const [client, version] of Object.entries(required.clients)) ledger.plan("tool", client, { ...(version ? { detail: version } : {}) });
  for (const t of required.tools) ledger.plan("tool", t.tool, { ...(t.version ? { detail: t.version } : t.referenced_by ? { detail: t.referenced_by } : {}) });
  for (const [cli, version] of Object.entries(required.cli ?? {})) ledger.plan("tool", cli, { ...(version ? { detail: version } : {}) });
  for (const u of required.unsupported) ledger.skip("tool", u.tool, u.reason, { detail: tilde(u.referenced_by, home) });
  for (const m of required.mcp ?? []) {
    const name = `${m.harness}/${m.name}${m.scope ? ` (${m.scope})` : ""}`;
    if (m.verdict?.status === "unsupported") ledger.skip("mcp", name, m.verdict.reason, { detail: m.command });
    else ledger.plan("mcp", name, { detail: m.command });
  }

  // Agent config: the home mirror.
  log("reading agent config");
  const mirror = await (deps.mirror ?? (() => collectMirrorFiles({ home, config: deps.config, hostHome: "/home/ubuntu" })))();
  const byRoot = new Map<string, number>();
  for (const e of mirror.entries) byRoot.set(e.root, (byRoot.get(e.root) ?? 0) + 1);
  for (const [root, n] of byRoot) ledger.plan("config", `~/${root}`, { detail: `${n} file${n === 1 ? "" : "s"}` });
  const loginLocal = [...AGENT_AUTH_SOURCES, ...TOOL_AUTH_SOURCES].map((src) => src.localPath(home, process.env)).filter((f) => fs.existsSync(f));
  recordMirrorSkips(ledger, mirror.skipped, home, repoPlans.map((r) => r.root), loginLocal);
  for (const w of mirror.warnings) ledger.scope.push(`config mirror: ${w}`);

  // Logins.
  ledger.plan("login", "claude", { detail: "Claude Code credential" });
  const loginPaths: Record<string, string> = {};
  if (deps.userId && deps.deviceId) {
    const collected = collectAgentAuthBundle({ home, now: deps.now, userId: deps.userId, deviceId: deps.deviceId, hostHome: "/home/ubuntu", logins: deps.logins });
    const heldBack = new Set([...AGENT_AUTH_SOURCES, ...TOOL_AUTH_SOURCES].filter((src) => !hostLoginTravels(deps.logins, hostLoginName(src)) && fs.existsSync(src.localPath(home, process.env))).map(hostLoginName));
    for (const name of heldBack) ledger.skip("login", name, "off for this host", { fix: `cast hosts logins <host> --on ${name}` });
    const ids = new Map([...AGENT_AUTH_SOURCES, ...TOOL_AUTH_SOURCES].map((s) => [s.remotePath, s.id]));
    for (const f of collected.bundle.files) {
      const id = ids.get(f.path) ?? (f.path.includes("gcloud") ? "gcloud" : f.path);
      loginPaths[f.path] = id;
      ledger.plan("login", id, { detail: f.path });
    }
    for (const s of collected.skipped) {
      const fix = s.reason === "access token expired" || s.reason === "logged-out stub" ? `run ${s.id} login on this laptop, then cast cloud again` : undefined;
      ledger.skip("login", s.id, s.reason, fix ? { fix } : {});
    }
    for (const key of Object.keys(collected.bundle.claudeEnv ?? {})) ledger.plan("env", key, { detail: "from ~/.claude/settings.json" });
    for (const e of collected.envSkipped) ledger.skip("env", e.key, e.reason, { detail: "from ~/.claude/settings.json" });
  } else {
    ledger.skip("login", "agent and tool logins", "this laptop is not signed in to codecast", { fix: "cast login" });
  }

  // Shell variables: the names only.
  const envNamesAll = (deps.loginShellEnv ?? (() => loginShellEnvNames()))().filter((n) => !MACHINE_ENV.test(n));
  const envNamesCarried: string[] = [];
  for (const n of envNamesAll) {
    if (ledger.get(parityKey("env", n))) continue;
    if (MAC_ONLY_ENV.test(n)) { ledger.skip("env", n, "set by a macOS install (Homebrew, an SDK, a version manager); the host's own tools set their own"); continue; }
    ledger.plan("env", n, { detail: "set by your login shell" });
    envNamesCarried.push(n);
  }
  ledger.scope.push(`${envNamesAll.length} variables a fresh login shell on this laptop sets (names only; values are never read into this report)`);

  // Services and the machine.
  for (const s of footprint.services) {
    ledger.skip("service", s.label, `a launchd job${s.running ? " running here" : ""}; Linux hosts have no launchd`, { detail: tilde(s.plist, home), fix: "declare it as a systemd unit under [host] services, or start it with [host] run" });
  }
  const services = personalListeners((deps.listening ?? (() => listeningServices(run)))(), deps.exePath ?? ((pid) => run("ps", ["-o", "comm=", "-p", pid]).stdout.trim()));
  for (const [command, ports] of services.listeners) {
    ledger.skip("service", command, "listening on this laptop; nothing starts it on the host", {
      detail: `port${ports.length === 1 ? "" : "s"} ${ports.join(", ")}`, fix: "declare it under [host] services or [host] run in .codecast/workspace.toml",
    });
  }
  if (services.ignored) ledger.scope.push(`${services.ignored} listening sockets left out: apps, macOS services and short-lived helpers on ephemeral ports`);
  for (const c of (deps.containers ?? (() => runningContainers(run)))()) {
    ledger.skip("service", `container ${c}`, "a Docker container running on this laptop; the host does not start it", { fix: "start it from [host] run in .codecast/workspace.toml" });
  }
  try {
    const keys = fs.readdirSync(path.join(home, ".ssh")).filter((n) => /^id_[a-z0-9]+$/.test(n));
    for (const k of keys) ledger.skip("machine", `~/.ssh/${k}`, "private keys never leave this laptop; the host gets its own key for GitHub", { fix: "cast hosts key <host> --grant" });
  } catch { /* no ~/.ssh */ }
  ledger.scope.push("this laptop's listening services, Docker containers and SSH keys");

  return { repos: repoPlans, folders: folderPlans, extraTools, required, mirror, loginPaths, envNames: envNamesCarried };
}
