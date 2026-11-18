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

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "../../proc.js";
import { ensureRemoteRepo, gitEnv, gitSshUrl, pushPath, remoteHome, remoteRepoPath, shq, ssh, sshBase, sshDestination, type RemoteHost } from "../../remote/session-move.js";
import { readyHostHome, type ReadyHostHomeReport } from "../prepare.js";
import { refreshRemoteCheckout } from "../transfer.js";
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
  exists?: (p: string) => boolean;
  /** Which home-relative files have the same bytes here and on the host. */
  sameBytes?: (rels: string[]) => Set<string>;
  /** The config mirror push that carries each repository's project context. */
  pushMirror?: () => Promise<unknown>;
  /** Re-establish the ssh connection after a transport failure. */
  reconnect?: () => Promise<void>;
  /** Called after each step, so the report on disk is never behind by more than one step. */
  checkpoint?: () => void;
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

/** The project an agent config path belongs to: everything before its first agent folder. */
export function projectOfAgentPath(rel: string): string {
  const m = /^(.*?)\/(\.agents|\.claude|\.codex|\.cursor|\.gemini|\.grok|\.pi|\.opencode)(\/|$)/.exec(rel);
  return m?.[1] || rel.split("/").slice(0, -1).join("/") || rel;
}

/** Which of these home-relative files have the same sha256 here and on the host. */
export function sameBytesOnHost(host: RemoteHost, home: string, rels: string[]): Set<string> {
  const local = new Map<string, string>();
  for (const r of rels) {
    try { local.set(r, createHash("sha256").update(fs.readFileSync(path.join(home, r))).digest("hex")); } catch { /* gone here */ }
  }
  if (!local.size) return new Set();
  const hostHome = remoteHome(host);
  const out = execFileSync("ssh", [...sshBase(host), sshDestination(host), "xargs -0 sha256sum 2>/dev/null; true"],
    { input: [...local.keys()].map((r) => path.posix.join(hostHome, r)).join("\0"), encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const same = new Set<string>();
  for (const line of out.split("\n")) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const rel = m[2]!.startsWith(`${hostHome}/`) ? m[2]!.slice(hostHome.length + 1) : m[2]!;
    if (local.get(rel) === m[1]) same.add(rel);
  }
  return same;
}

/** `config mirror failed: a: why; b: why` as path → why. */
export function parseMirrorErrors(message: string): Map<string, string> {
  const out = new Map<string, string>();
  const body = message.replace(/^(config mirror failed: )+/, "");
  for (const part of body.split("; ")) {
    const m = /^([^\s:][^:]*): (.+)$/.exec(part.trim());
    if (m && !m[1]!.includes(" ")) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** An ssh transport failure (the shared connection dropped), worth one retry after reconnecting. */
export const SSH_TRANSPORT_ERROR = /mux_client|control socket|Connection closed|Connection reset|Broken pipe|kex_exchange_identification|Connection timed out|ssh: connect to host/i;

/** The repository has an origin with a main branch the host can clone instead of taking the laptop's history. */
function hasOriginMain(root: string): boolean {
  try {
    execFileSync("git", ["-C", root, "rev-parse", "-q", "--verify", "refs/remotes/origin/main"], { stdio: "pipe" });
    return !!execFileSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch { return false; }
}

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
  if (repo.worktreeOf) {
    // A linked worktree's checkout is cloned from its main's on the host, sharing its objects.
    ensureRemoteRepo(host, repo.root, remote, remoteRepoPath(host, repo.worktreeOf));
  } else if (hasOriginMain(repo.root)) {
    // The host clones main from origin itself (GitHub to the cloud is fast, and
    // a laptop's whole history can be tens of GB); only what this laptop alone
    // has crosses from here, with the snapshot and the branches below.
    refreshRemoteCheckout(host, repo.root, remote, (l) => log(`  ${l}`));
    // Every origin branch too, so the branch push below sends only commits that exist nowhere but here.
    ssh(host, `cd ${shq(remote)} && git config receive.denyCurrentBranch updateInstead && { GIT_TERMINAL_PROMPT=0 git fetch -q --no-tags origin '+refs/heads/*:refs/remotes/origin/*' || true; }`, 1_800_000);
  } else {
    ensureRemoteRepo(host, repo.root, remote);
  }
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
  const out = execFileSync("ssh", [...sshBase(host), sshDestination(host),
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

  // The mirror's per-file refusals. Recorded here, item by item, instead of
  // failing the push: a refused file says nothing about the thousands beside
  // it, nor about the logins and tools set up in the same step.
  const mirrorErrors = new Map<string, string>();
  const mirror = async (h: RemoteHost, o: Parameters<typeof import("../mirror/push.js").mirrorHomeToHost>[1]) => {
    const { mirrorHomeToHost } = await import("../mirror/push.js");
    const r = await mirrorHomeToHost(h, o);
    const errors = r.result?.errors ?? [];
    for (const e of errors) mirrorErrors.set(e.path, e.error);
    return errors.length ? { ...r, pushed: true, result: { ...r.result!, errors: [] } } : r;
  };

  // 1. The host home.
  log("setting up the host: cast, logins, tools, git, agent config");
  let home: ReadyHostHomeReport | undefined;
  try {
    home = await (deps.readyHome ?? (() => readyHostHome(host, {
      cloudId: deps.cloudId, force: true, extraTools: plan.extraTools, onProgress: (l) => log(`  ${l}`),
      toolsDeps: { required: () => plan.required }, mirrorDeps: mirror,
    })))();
  } catch (e) {
    const reason = `the host setup stopped: ${(e as Error).message}`;
    ledger.settleWhere((i) => i.area === "config" || i.area === "login" || i.area === "tool" || i.area === "mcp", "failed", { reason });
  }
  if (home) settleHome(ledger, plan, home, deps.cloudId);
  deps.checkpoint?.();
  if (home?.tools) installAptTools(ledger, plan, home.tools.missing.map((m) => m.tool), deps);

  // 2. Repositories.
  const landed: Array<{ repo: RepoPlan; remote: string }> = [];
  for (const repo of plan.repos) {
    log(`carrying ${repo.name}`);
    if (!(deps.exists ?? fs.existsSync)(repo.root)) {
      ledger.settle(repo.key, "failed", { reason: "no longer exists here: it was removed while this run was going" });
      if (repo.branchesKey) ledger.settle(repo.branchesKey, "failed", { reason: "the repository is gone" });
      if (repo.agentKey) ledger.settle(repo.agentKey, "failed", { reason: "the repository is gone" });
      continue;
    }
    const t0 = Date.now();
    try {
      const carry = deps.carryRepo ?? ((r: RepoPlan) => carryRepoToHost(host, r, log));
      const c = await carry(repo).catch(async (e: Error) => {
        if (!SSH_TRANSPORT_ERROR.test(e.message)) throw e;
        log(`  the connection dropped (${e.message.split("\n").pop()}); reconnecting and trying once more`);
        await (deps.reconnect ?? (async () => {
          // The shared connection can still answer a quick check while refusing
          // new sessions (after a long transfer): close it, then open a fresh one.
          try { execFileSync("ssh", [...sshBase(host), "-O", "exit", sshDestination(host)], { stdio: "ignore", timeout: 10_000 }); } catch { /* no shared connection open */ }
          const { ensureUp, resolveCloudHost } = await import("../../browser/cloudHost.js");
          await ensureUp(resolveCloudHost(deps.cloudId));
        }))();
        return carry(repo);
      });
      log(`  done in ${Math.round((Date.now() - t0) / 1000)}s`);
      deps.checkpoint?.();
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
    deps.checkpoint?.();
  }

  // 4. Project context, then each repo's own setup.
  for (const { repo, remote } of landed) {
    try {
      await (deps.projectContext ?? (async (r, root) => { await registerProjectContext(host, r.root, root, { hostId: deps.cloudId }); }))(repo, remote);
    } catch (e) {
      if (repo.agentKey) ledger.settle(repo.agentKey, "failed", { reason: (e as Error).message });
    }
  }
  // Refusals inside a repository are attributed to it when the host is checked below.
  if (landed.length) {
    try {
      await (deps.pushMirror ?? (() => readyHostHome(host, { cloudId: deps.cloudId, skipLogins: true, skipGit: true, onProgress: (l) => log(`  ${l}`), mirrorDeps: mirror })))();
    } catch (e) {
      for (const [p, err] of parseMirrorErrors((e as Error).message)) mirrorErrors.set(p, err);
      if (!mirrorErrors.size) ledger.scope.push(`the config mirror stopped: ${(e as Error).message}`);
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
  verify(ledger, plan, landed, deps, mirrorErrors);
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

/** Commands Ubuntu's package spells differently, with what to do about it. */
const APT_RENAMED: Record<string, { reason: string; fix: string }> = {
  magick: { reason: "Ubuntu ships ImageMagick 6, which names the command convert; magick is ImageMagick 7's name", fix: "call convert on the host, or install ImageMagick 7 (its AppImage) under [host] run in ~/.codecast/host.toml" },
};

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
    else if (!error && APT_RENAMED[tool]) ledger.settle(key, "failed", { reason: APT_RENAMED[tool]!.reason, fix: APT_RENAMED[tool]!.fix });
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
      else if (logins.kept.includes(`${remotePath} host-owned`)) ledger.settle(key, "present", { detail: "the host's own copy, never pushed from this laptop, was kept" });
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

function verify(ledger: ParityLedger, plan: EnvPlan, landed: Array<{ repo: RepoPlan; remote: string }>, deps: ApplyDeps, mirrorErrors = new Map<string, string>()): void {
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
  const hostHome = remoteHome(deps.host);
  const claimed = new Set<string>();
  for (const { repo, remote } of landed) {
    const rel = path.posix.relative(hostHome, remote);
    const refused = [...mirrorErrors].filter(([p]) => p === rel || p.startsWith(`${rel}/`));
    for (const [p] of refused) claimed.add(p);
    if (!repo.agentKey || ledger.get(repo.agentKey)?.status !== "planned") continue;
    const gone = (repo.snapshot.agentPaths ?? []).filter((p) => probe.missing.has(path.posix.join(remote, p)));
    const why = refused.slice(0, 3).map(([p, err]) => `${p.slice(rel.length + 1)} (${err})`).join("; ");
    if (gone.length) ledger.settle(repo.agentKey, "failed", { reason: `not on the host: ${gone.join(", ")}${why ? `; the mirror refused ${refused.length} file${refused.length === 1 ? "" : "s"}: ${why}` : ""}` });
    else ledger.settle(repo.agentKey, "carried", refused.length ? { detail: `${ledger.get(repo.agentKey)?.detail ?? ""}; ${refused.length} file${refused.length === 1 ? "" : "s"} the mirror would not rewrite were already on the host with the repository`.replace(/^; /, "") } : {});
  }
  // A refusal outside every repository this run carried: often a project an
  // earlier run registered, whose files the host already holds from git. Each
  // is checked by its bytes on both machines, then reported per project and reason.
  const unclaimed = [...mirrorErrors].filter(([p]) => !claimed.has(p));
  if (unclaimed.length) {
    const same = (deps.sameBytes ?? ((paths) => sameBytesOnHost(deps.host, deps.home, paths)))(unclaimed.map(([p]) => p));
    const groups = new Map<string, { project: string; err: string; ok: boolean; paths: string[] }>();
    for (const [p, err] of unclaimed) {
      const project = projectOfAgentPath(p);
      const ok = same.has(p);
      const key = `${project}\0${err}\0${ok}`;
      const g = groups.get(key) ?? { project, err, ok, paths: [] };
      g.paths.push(`~/${p}`);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      const name = `~/${g.project}: agent config the mirror refused${g.ok ? "" : ` (${g.err})`}`;
      const detail = `${g.paths.length} file${g.paths.length === 1 ? "" : "s"}`;
      if (g.ok) ledger.settle(parityKey("config", name), "present", { detail: `${detail}; the same bytes are already on the host (the mirror there refused them: ${g.err})` });
      else ledger.settle(parityKey("config", name), "failed", { detail, reason: `the config mirror would not write them, and the host's copies differ: ${g.err}`, fix: `cast hosts update ${deps.cloudId}, then cast cloud again` });
      const item = ledger.get(parityKey("config", name));
      if (item) item.paths = g.paths;
    }
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
