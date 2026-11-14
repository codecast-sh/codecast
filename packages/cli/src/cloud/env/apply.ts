/**
 * The second half of `cast cloud`: put the inventoried environment on a host
 * and record what happened to every item in the parity ledger.
 *
 * Steps, each reusing the path a cloud session already relies on:
 *   1. the host home (cloud/prepare readyHostHome, forced): this laptop's
 *      cast, the personal [host] setup, the Claude credential and the login
 *      bundle, the tools, git readiness, and the config mirror;
 *   2. each repository: a sync snapshot of its working folder landed into the
 *      host checkout (cloud/liveSync's host side), its HEAD moved to this
 *      laptop's branch and commit, branches the host lacks pushed;
 *   3. each folder: carried whole (remote/session-move pushPath);
 *   4. each repository's project context through the config mirror, then its
 *      own [host] setup;
 *   5. verification: the host is asked what it has, and an item counts as
 *      carried only when the host's answer matches this laptop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "../../proc.js";
import { ensureRemoteRepo, gitEnv, gitSshUrl, pushPath, remoteHome, remoteRepoPath, shq, ssh, sshBase, type RemoteHost } from "../../remote/session-move.js";
import { readyHostHome, type ReadyHostHomeReport } from "../prepare.js";
import { describeHostSetup, runHostSetup, resolveHostSpec } from "../hostSetup.js";
import { sshHostSide } from "../liveSync.js";
import { registerProjectContext } from "../mirror/projectRefresh.js";
import type { SnapshotResult } from "../syncSide.js";
import { parityKey, type ParityLedger } from "./parity.js";
import { envNames, tilde, type EnvPlan, type RepoPlan } from "./inventory.js";

export interface ApplyDeps {
  host: RemoteHost;
  cloudId: string;
  home: string;
  log: (line: string) => void;
  /** Seams for tests. */
  readyHome?: () => Promise<ReadyHostHomeReport>;
  carryRepo?: (repo: RepoPlan) => Promise<RepoCarry>;
  carryFolder?: (local: string) => Promise<{ remote: string; error?: string }>;
  projectContext?: (repo: RepoPlan, remoteRoot: string) => Promise<void>;
  hostSetup?: (repo: RepoPlan, remoteRoot: string) => { ok: boolean; skipped?: boolean; line: string };
  probe?: (input: ProbeInput) => ProbeOutput;
  aptInstall?: (packages: string[]) => { ok: boolean; error?: string };
  hasCommands?: (names: string[]) => Set<string>;
}

export interface RepoCarry {
  remote: string;
  /** The host folder's tree after landing; equal to the laptop snapshot's when it carried. */
  tree: string;
  /** Branches this laptop has that the host still lacks or holds at another commit. */
  branchesMissing: string[];
  /** Where the host's own branch was kept when the laptop's replaced it. */
  backupRef?: string;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

const BACKUP_PREFIX = "refs/codecast/backup/cloud-env";

/** Branches of `laptop` the host lacks or holds at another commit, from `git for-each-ref` output there. */
export function missingBranches(laptop: Record<string, string>, hostRefs: string): string[] {
  const host = new Map(hostRefs.split("\n").map((l) => l.trim().split(" ")).filter((p) => p.length === 2).map(([b, s]) => [b!, s!]));
  return Object.keys(laptop).filter((b) => host.get(b) !== laptop[b]).sort();
}

/**
 * The host checkout made to match this laptop's working folder: the snapshot
 * lands (only differing files are written), then HEAD moves to the laptop's
 * branch at the laptop's commit, keeping the host's old branch tip under a
 * backup ref when it was not already behind. Branches the host lacks are
 * pushed without force, so a host branch with its own commits is reported,
 * never overwritten.
 */
export async function carryRepoToHost(host: RemoteHost, repo: RepoPlan, log: (l: string) => void): Promise<RepoCarry> {
  const remote = remoteRepoPath(host, repo.root);
  // A linked worktree's checkout is cloned from its main's on the host, sharing its objects.
  ensureRemoteRepo(host, repo.root, remote, repo.worktreeOf ? remoteRepoPath(host, repo.worktreeOf) : undefined);
  const side = sshHostSide(host, remote, "cloud-env", repo.root, repo.scope, log);
  const snap = repo.snapshot;
  if (!snap.sha) throw new Error("no snapshot commit to carry");
  let landedTree = "";
  for (let attempt = 1; attempt <= 3 && !landedTree; attempt++) {
    const h = await side.snapshot();
    if (h.tree === snap.tree) { landedTree = h.tree; break; }
    await side.send(snap.sha);
    const r = await side.land(snap.sha, h.tree);
    if (r.landed) landedTree = r.tree;
  }
  if (!landedTree) throw new Error("the host folder kept changing while it was being written");
  const q = shq(remote);
  const branch = snap.branch !== "HEAD" ? snap.branch : null;
  const backup = `${BACKUP_PREFIX}/${Date.now()}`;
  // HEAD and the index follow the laptop; the files are already the laptop's.
  const moved = ssh(host, `cd ${q} && old=$(git rev-parse -q --verify ${branch ? shq(`refs/heads/${branch}`) : "HEAD"} || true) && ` +
    `if [ -n "$old" ] && [ "$old" != ${shq(snap.head)} ] && ! git merge-base --is-ancestor "$old" ${shq(snap.head)}; then git update-ref ${shq(backup)} "$old" && echo backup; fi; ` +
    (branch ? `git update-ref ${shq(`refs/heads/${branch}`)} ${shq(snap.head)} && git symbolic-ref HEAD ${shq(`refs/heads/${branch}`)}` : `git update-ref --no-deref HEAD ${shq(snap.head)}`) +
    ` && git reset -q --mixed`).trim();
  // Branches the host lacks. A branch the host has at another commit is left as it is and reported.
  const hostRefs = () => ssh(host, `cd ${q} && git for-each-ref --format='%(refname:short) %(objectname)' refs/heads`);
  const refsNow = hostRefs();
  const absent = new Set(missingBranches(repo.branches, refsNow).filter((b) => b !== branch && !refsNow.split("\n").some((l) => l.startsWith(`${b} `))));
  if (absent.size) {
    try {
      execFileSync("git", ["-C", repo.root, "push", "--quiet", "--no-verify", gitSshUrl(host, remote), ...[...absent].map((b) => `refs/heads/${b}:refs/heads/${b}`)], { env: gitEnv(host), stdio: "pipe", encoding: "utf-8", timeout: 600_000 });
    } catch (e) {
      log(`  some branches did not push: ${(e as Error).message.split("\n").pop()}`);
    }
  }
  const after = side.snapshot();
  return { remote, tree: (await after).tree, branchesMissing: missingBranches(repo.branches, hostRefs()), ...(moved.includes("backup") ? { backupRef: backup } : {}) };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface ProbeInput {
  /** Home-relative paths that must exist on the host. */
  files: string[];
  /** Absolute host paths that must exist. */
  paths: string[];
}

export interface ProbeOutput {
  missing: Set<string>;
  /** Variable names the host's login shell sets. */
  env: Set<string>;
}

/** The host's answer in one ssh: which paths are missing, and its login shell's variable names. */
export function probeHost(host: RemoteHost, input: ProbeInput): ProbeOutput {
  const home = remoteHome(host);
  const list = [...input.files.map((f) => path.posix.join(home, f)), ...input.paths].join("\0");
  const out = execFileSync("ssh", [...sshBase(host), `${host.user}@${host.address}`,
    `xargs -0 -n 200 sh -c 'for p; do [ -e "$p" ] || [ -L "$p" ] || printf "%s\\0" "$p"; done' sh; printf '\\036'; "\${SHELL:-/bin/bash}" -lic 'env -0' 2>/dev/null </dev/null`],
  { input: list, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000, stdio: ["pipe", "pipe", "ignore"] });
  const [missing = "", env = ""] = out.split("\x1e");
  const back = (p: string) => (p.startsWith(`${home}/`) && input.files.includes(p.slice(home.length + 1)) ? p.slice(home.length + 1) : p);
  return { missing: new Set(missing.split("\0").filter(Boolean).map(back)), env: new Set(envNames(env)) };
}

const RC_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".bash_profile", ".bashrc", ".profile"];

/** Files a shell file sources (`source x`, `. x`), with ~ and $HOME expanded. */
function sourcedFiles(home: string, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(?:source|\.)\s+["']?([^\s"';|&]+)/gm)) {
    const p = m[1]!.replace(/^~(?=\/)/, home).replace(/^\$\{?HOME\}?(?=\/)/, home);
    if (path.isAbsolute(p)) out.push(p);
  }
  return out;
}

/** Where this laptop's shell files set a variable (one level of sourcing deep), for the report's fix line. */
export function whereSet(home: string, name: string): string | undefined {
  const sets = new RegExp(`(^|[\\s;]|export\\s+)${name}=`, "m");
  const read = (f: string) => { try { return fs.readFileSync(f, "utf-8"); } catch { return null; } };
  for (const rc of RC_FILES) {
    const text = read(path.join(home, rc));
    if (text === null) continue;
    if (sets.test(text)) return `~/${rc}`;
    for (const src of sourcedFiles(home, text)) {
      if (sets.test(read(src) ?? "")) return src.startsWith(`${home}/`) ? `~/${src.slice(home.length + 1)}` : src;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function applyEnvironment(ledger: ParityLedger, plan: EnvPlan, deps: ApplyDeps): Promise<void> {
  const { host, log } = deps;

  // 1. The host home.
  log("setting up the host: cast, logins, tools, git, agent config");
  let home: ReadyHostHomeReport | undefined;
  try {
    home = await (deps.readyHome ?? (() => readyHostHome(host, {
      cloudId: deps.cloudId, force: true, extraTools: plan.extraTools, onProgress: (l) => log(`  ${l}`),
      toolsDeps: { required: () => plan.required },
    })))();
  } catch (e) {
    const reason = `the host setup stopped: ${(e as Error).message}`;
    ledger.settleWhere((i) => i.area === "config" || i.area === "login" || i.area === "tool" || i.area === "mcp", "failed", { reason });
  }
  if (home) settleHome(ledger, plan, home, deps.cloudId);
  if (home?.tools) installAptTools(ledger, plan, home.tools.missing.map((m) => m.tool), deps);

  // 2. Repositories.
  const landed: Array<{ repo: RepoPlan; remote: string }> = [];
  for (const repo of plan.repos) {
    log(`carrying ${repo.name}`);
    try {
      const c = await (deps.carryRepo ?? ((r) => carryRepoToHost(host, r, log)))(repo);
      landed.push({ repo, remote: c.remote });
      if (c.tree === repo.snapshot.tree) ledger.settle(repo.key, "carried", { detail: `${ledger.get(repo.key)?.detail ?? ""} → ${c.remote}`.replace(/^ → /, "") });
      else ledger.settle(repo.key, "failed", { reason: "after landing, the host folder differs from this laptop's snapshot (something on the host wrote to it meanwhile)", fix: "run cast cloud again" });
      if (!repo.branchesKey) { /* a worktree: its branches are its main checkout's item */ }
      else if (c.branchesMissing.length) {
        ledger.settle(repo.branchesKey, "skipped", {
          reason: `${c.branchesMissing.length} local branch${c.branchesMissing.length === 1 ? "" : "es"} the host already has at a different commit, left as the host has ${c.branchesMissing.length === 1 ? "it" : "them"}: ${c.branchesMissing.join(", ")}`,
          fix: "push the branch you want from this laptop, or reset it on the host",
        });
      } else ledger.settle(repo.branchesKey, "carried");
      if (c.backupRef) ledger.scope.push(`${repo.name}: the host's previous ${repo.snapshot.branch} tip is kept at ${c.backupRef}`);
    } catch (e) {
      const reason = (e as Error).message.split("\n").slice(-2).join(" ").slice(0, 300);
      ledger.settle(repo.key, "failed", { reason, fix: "fix the cause, then run cast cloud again" });
      if (repo.branchesKey) ledger.settle(repo.branchesKey, "failed", { reason: "the repository did not carry" });
      if (repo.agentKey) ledger.settle(repo.agentKey, "failed", { reason: "the repository did not carry" });
    }
  }

  // 3. Folders.
  for (const f of plan.folders) {
    log(`carrying ${tilde(f.path, deps.home)}`);
    const r = await (deps.carryFolder ?? (async (p) => pushPath(host, p)))(f.path);
    if (r.error) ledger.settle(f.key, "failed", { reason: r.error });
    else ledger.settle(f.key, "carried", { detail: r.remote });
  }

  // 4. Project context, then each repo's own setup.
  for (const { repo, remote } of landed) {
    try {
      await (deps.projectContext ?? (async (r, root) => { await registerProjectContext(host, r.root, root, { hostId: deps.cloudId }); }))(repo, remote);
    } catch (e) {
      if (repo.agentKey) ledger.settle(repo.agentKey, "failed", { reason: (e as Error).message });
    }
  }
  if (landed.length && !deps.projectContext) {
    try {
      await readyHostHome(host, { cloudId: deps.cloudId, skipLogins: true, skipGit: true, onProgress: (l) => log(`  ${l}`) });
    } catch (e) {
      for (const { repo } of landed) if (repo.agentKey) ledger.settle(repo.agentKey, "failed", { reason: `the config mirror failed: ${(e as Error).message}` });
    }
  }
  for (const { repo, remote } of landed) {
    const spec = resolveHostSpec({ repoRoot: repo.root, home: deps.home });
    if (!spec.packages.length && !spec.services.length && !spec.run.length) continue;
    const key = ledger.plan("repo", `${repo.name}: [host] setup`, { detail: [spec.packages.length && `${spec.packages.length} packages`, spec.services.length && `${spec.services.length} services`, spec.run.length && `${spec.run.length} commands`].filter(Boolean).join(", ") });
    log(`running ${repo.name}'s [host] setup`);
    try {
      const r = (deps.hostSetup ?? ((rp, root) => {
        const { report } = runHostSetup(host, { repoRoot: rp.root, repoPath: root, force: true, spec });
        return { ok: report.ok, skipped: !!report.skipped, line: describeHostSetup(report, spec) };
      }))(repo, remote);
      if (r.ok) ledger.settle(key, "installed");
      else ledger.settle(key, "failed", { reason: r.line, fix: `fix the step in .codecast/workspace.toml, then cast hosts setup ${deps.cloudId}` });
    } catch (e) {
      ledger.settle(key, "failed", { reason: (e as Error).message });
    }
  }

  // 5. Verification.
  log("checking what the host has");
  verify(ledger, plan, landed, deps);
}

/**
 * Homebrew formulas whose commands an Ubuntu package provides. The tools step
 * installs user-locally and never through apt; these go through the declared
 * host setup instead, which does.
 */
export const BREW_TO_APT: Array<[RegExp, string]> = [
  [/^(libpq|postgresql@?\d*)$/, "postgresql-client"],
  [/^poppler$/, "poppler-utils"],
  [/^imagemagick(@\d+)?$/, "imagemagick"],
  [/^ffmpeg$/, "ffmpeg"],
  [/^dialog$/, "dialog"],
  [/^ripgrep$/, "ripgrep"],
  [/^fd$/, "fd-find"],
  [/^sqlite$/, "sqlite3"],
  [/^redis$/, "redis-tools"],
  [/^graphviz$/, "graphviz"],
  [/^tesseract$/, "tesseract-ocr"],
  [/^pandoc$/, "pandoc"],
  [/^tree$/, "tree"],
  [/^wget$/, "wget"],
  [/^htop$/, "htop"],
  [/^watch$/, "procps"],
  [/^coreutils$/, "coreutils"],
  [/^gnu-sed$/, "sed"],
  [/^yq$/, "yq"],
];

/** Server commands a client package does not carry: postgres itself. */
const APT_FOR_COMMAND: Record<string, string> = { postgres: "postgresql", pg_ctl: "postgresql", initdb: "postgresql" };

export function aptPackageFor(tool: string, brew: string | undefined): string | undefined {
  if (APT_FOR_COMMAND[tool]) return APT_FOR_COMMAND[tool];
  if (!brew) return undefined;
  return BREW_TO_APT.find(([re]) => re.test(brew))?.[1];
}

/** The tools the tools step could not install that an apt package provides: installed through the host setup, then checked. */
function installAptTools(ledger: ParityLedger, plan: EnvPlan, missing: string[], deps: ApplyDeps): void {
  const brewOf = new Map(plan.extraTools.map((t) => [t.tool, t.install && "brew" in t.install ? t.install.brew : undefined]));
  const wanted = new Map<string, string>();
  for (const tool of missing) {
    const pkg = aptPackageFor(tool, brewOf.get(tool));
    if (pkg) wanted.set(tool, pkg);
  }
  if (!wanted.size) return;
  const packages = [...new Set(wanted.values())].sort();
  deps.log(`installing ${packages.join(", ")} with apt for ${[...wanted.keys()].join(", ")}`);
  let error: string | undefined;
  try {
    const r = (deps.aptInstall ?? ((pkgs) => {
      const { report } = runHostSetup(deps.host, { force: true, spec: { packages: pkgs, services: [], run: [] } });
      return { ok: report.ok, error: report.error };
    }))(packages);
    if (!r.ok) error = r.error ?? "apt failed";
  } catch (e) { error = (e as Error).message; }
  const found = error ? new Set<string>() : (deps.hasCommands ?? ((names) => hostHasCommands(deps.host, names)))([...wanted.keys()]);
  for (const [tool, pkg] of wanted) {
    const key = parityKey("tool", tool);
    if (found.has(tool)) ledger.settle(key, "installed", { detail: `apt ${pkg}` });
    else ledger.settle(key, "failed", { reason: error ? `apt install of ${pkg} failed: ${error.split("\n").pop()}` : `apt installed ${pkg}, but ${tool} is still not on the host's PATH` });
  }
}

/** Which of `names` the host's login shell finds. */
export function hostHasCommands(host: RemoteHost, names: string[]): Set<string> {
  // Ubuntu keeps Postgres's server commands in a versioned folder off PATH.
  const out = ssh(host, `bash -lc ${shq(names.map((n) => `{ command -v ${shq(n)} || ls /usr/lib/postgresql/*/bin/${shq(n)}; } >/dev/null 2>&1 && echo ${shq(n)}`).join("; ") + "; true")}`);
  return new Set(out.split("\n").map((l) => l.trim()).filter(Boolean));
}

/** Commands that exist only on one OS: a hook that branches per platform names them all. */
export const OS_ONLY_COMMANDS: Record<string, string> = {
  afplay: "macOS", osascript: "macOS", pbcopy: "macOS", pbpaste: "macOS", open: "macOS", say: "macOS", defaults: "macOS", launchctl: "macOS",
  security: "macOS", sw_vers: "macOS", xcrun: "macOS", xcodebuild: "macOS", mdfind: "macOS", sips: "macOS", ditto: "macOS", caffeinate: "macOS", terminal_notifier: "macOS", "terminal-notifier": "macOS",
  "powershell.exe": "Windows", "cmd.exe": "Windows", "clip.exe": "Windows", wslpath: "Windows (WSL)", "wsl.exe": "Windows",
};

function settleHome(ledger: ParityLedger, plan: EnvPlan, home: ReadyHostHomeReport, cloudId: string): void {
  // Config: the mirror throws when it cannot write; the probe checks each file.
  for (const i of ledger.all()) if (i.area === "config" && i.status === "planned") ledger.settle(i.key, "carried");

  const logins = home.logins;
  if (logins) {
    ledger.settle(parityKey("login", "claude"), logins.claude.pushed ? "carried" : "failed", logins.claude.pushed ? {} : { reason: logins.claude.reason ?? "not pushed", fix: "claude login on this laptop, then cast cloud again" });
    const errors = new Map((logins.receiver?.errors ?? []).map((e) => [e.split(":")[0]!, e]));
    for (const [remotePath, id] of Object.entries(plan.loginPaths)) {
      const key = parityKey("login", id);
      if (!logins.pushed) ledger.settle(key, "failed", { reason: logins.reason ?? "the login bundle was not sent" });
      else if (logins.kept.some((k) => k.includes(id))) ledger.settle(key, "present", { detail: "the host's copy is newer and was kept" });
      else if (errors.has(remotePath)) ledger.settle(key, "failed", { reason: errors.get(remotePath)! });
      else ledger.settle(key, "carried");
    }
    for (const k of logins.receiver?.env ?? []) ledger.settle(parityKey("env", k), "carried", { detail: "in the host's ~/.claude/settings.json" });
  }

  const tools = home.tools;
  if (tools) {
    for (const t of tools.ok) ledger.settle(parityKey("tool", t.tool), "present", t.version ? { detail: t.version } : {});
    for (const t of tools.installed) ledger.settle(parityKey("tool", t.tool), "installed", t.version ? { detail: t.version } : {});
    for (const m of tools.missing) {
      const key = parityKey("tool", m.tool);
      const detail = m.referenced_by ? { detail: `for ${m.referenced_by}` } : {};
      const only = OS_ONLY_COMMANDS[m.tool];
      if (only) ledger.settle(key, "skipped", { ...detail, reason: `a ${only} command; Linux has none, so scripts that call it take their Linux branch or skip that step` });
      else if (m.error && /no portable install known/.test(m.error)) ledger.settle(key, "skipped", { ...detail, reason: "no Linux install is known for it", fix: `add the command that installs it under [host] run in ~/.codecast/host.toml, then cast hosts setup ${cloudId}` });
      else ledger.settle(key, "failed", { ...detail, reason: m.error ? `install failed: ${m.error}` : "missing on the host and not installed" });
    }
    for (const u of tools.unsupported) ledger.skip("tool", u.tool, u.reason);
    for (const m of tools.mcp ?? []) {
      const key = parityKey("mcp", `${m.harness}/${m.name}${m.scope ? ` (${m.scope})` : ""}`);
      if (m.status === "ok") ledger.settle(key, "present");
      else ledger.settle(key, m.status === "unsupported" ? "skipped" : "failed", { reason: `${m.reason ?? m.status}; ${m.action}` });
    }
  }
}

function verify(ledger: ParityLedger, plan: EnvPlan, landed: Array<{ repo: RepoPlan; remote: string }>, deps: ApplyDeps): void {
  const configFiles = plan.mirror.entries.map((e) => e.path);
  const loginFiles = Object.keys(plan.loginPaths).map((p) => p.replace(/^~\//, ""));
  const agentPaths = landed.flatMap(({ repo, remote }) => (repo.agentKey ? (repo.snapshot.agentPaths ?? []).map((p) => path.posix.join(remote, p)) : []));
  const folderPaths = plan.folders.filter((f) => ledger.get(f.key)?.status === "carried").map((f) => ledger.get(f.key)!.detail!).filter(Boolean);
  let probe: ProbeOutput;
  try {
    probe = (deps.probe ?? ((i) => probeHost(deps.host, i)))({ files: [...configFiles, ...loginFiles], paths: [...agentPaths, ...folderPaths] });
  } catch (e) {
    ledger.scope.push(`the host could not be checked after the carry: ${(e as Error).message}`);
    return;
  }
  // Config: an item is a root; any of its files missing fails it, naming them.
  const missingByRoot = new Map<string, string[]>();
  for (const e of plan.mirror.entries) if (probe.missing.has(e.path)) missingByRoot.set(e.root, [...(missingByRoot.get(e.root) ?? []), e.path]);
  for (const [root, files] of missingByRoot) {
    const key = parityKey("config", `~/${root}`);
    if (ledger.get(key)?.status === "carried") ledger.settle(key, "failed", { reason: `${files.length} file${files.length === 1 ? "" : "s"} not on the host after the mirror: ${files.slice(0, 5).join(", ")}${files.length > 5 ? ", …" : ""}` });
  }
  for (const [remotePath, id] of Object.entries(plan.loginPaths)) {
    const key = parityKey("login", id);
    if (probe.missing.has(remotePath.replace(/^~\//, "")) && ledger.get(key)?.status === "carried") ledger.settle(key, "failed", { reason: `${remotePath} is not on the host` });
  }
  for (const { repo, remote } of landed) {
    if (!repo.agentKey || ledger.get(repo.agentKey)?.status !== "planned") continue;
    const gone = (repo.snapshot.agentPaths ?? []).filter((p) => probe.missing.has(path.posix.join(remote, p)));
    if (gone.length) ledger.settle(repo.agentKey, "failed", { reason: `not on the host after the mirror: ${gone.join(", ")}` });
    else ledger.settle(repo.agentKey, "carried");
  }
  for (const f of plan.folders) {
    const item = ledger.get(f.key);
    if (item?.status === "carried" && item.detail && probe.missing.has(item.detail)) ledger.settle(f.key, "failed", { reason: `${item.detail} is not on the host` });
  }
  // Shell variables: by name, in the host's login shell.
  for (const name of plan.envNames) {
    const key = parityKey("env", name);
    if (ledger.get(key)?.status !== "planned") continue;
    if (probe.env.has(name)) ledger.settle(key, "present");
    else {
      const where = whereSet(deps.home, name);
      ledger.settle(key, "failed", {
        reason: `set in this laptop's login shell${where ? ` (${where})` : ""} but not in the host's`,
        fix: where ? `the mirror carries ${where}; if it reads the value from a file or a command that exists only here, set it under [host] run or in your vault` : "find where it is set here and add the same line to a shell file the mirror carries",
      });
    }
  }
}
