import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitSshUrl, remoteHome, shq, sshBase, type RemoteHost } from "../remote/session-move.js";
import { hostProbeOrigin } from "./hostGit.js";
import { MANIFEST_REL_PATH, resolveManifest } from "../workspace/resolver.js";
import { buildMirrorBundle } from "./mirror/bundle.js";
import { kindForPath, transformForHost } from "./mirror/transform.js";
import { collectProjectContext } from "./mirror/discovery.js";
import { ManifestError } from "../workspace/manifest.js";
import { CLOUD_SEED_EXCLUDES, createWipSnapshotStrict } from "../wipSnapshot.js";

function checked(result: SpawnSyncReturns<string>, operation: string): string {
  if (result.error || result.status !== 0) {
    throw new Error(`${operation} failed (${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.signal ?? `exit ${result.status}`})`);
  }
  return result.stdout.trim();
}

function remote(host: RemoteHost, command: string, input?: number | Buffer): SpawnSyncReturns<string> {
  const stdin = Buffer.isBuffer(input) ? "pipe" : input ?? "ignore";
  return spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, command], {
    encoding: "utf-8", stdio: [stdin, "pipe", "pipe"], timeout: 300_000, env: process.env,
    ...(Buffer.isBuffer(input) ? { input, maxBuffer: 64 * 1024 * 1024 } : {}),
  });
}

function git(repo: string, args: string[], operation: string): string {
  return checked(spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf-8", stdio: "pipe", timeout: 300_000,
  }), operation);
}

function withFreshMain<T>(origin: string, use: (repo: string) => T): T {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cast-cloud-main-"));
  try {
    git(temp, ["init", "--bare", "-q"], "initialize isolated origin fetch");
    git(temp, ["fetch", "-q", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
      "--", origin, "refs/heads/main:refs/heads/main"], "fetch fresh origin/main on laptop");
    return use(temp);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function absoluteRemotePath(value: string): void {
  if (!value.startsWith("/") || value === "/" || /[\x00-\x1f\x7f]/.test(value)
    || path.posix.normalize(value) !== value) {
    throw new Error("cloud checkout requires a normalized absolute path");
  }
}

/**
 * The path guard, run whenever the checkout exists and in BOTH refresh modes:
 * not a symlink, and the directory is the top of its own working tree (no
 * nested checkout, no plain directory). Everything after it (fetch, set-url,
 * a HEAD move) runs against a verified path.
 */
function assertCheckoutPath(host: RemoteHost, repo: string): void {
  const q = shq(repo);
  checked(remote(host, `test ! -L ${q} && cd ${q} && test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"`), `inspect cloud checkout ${repo}`);
}

export interface CheckoutProbe {
  /** `git status --porcelain --untracked-files=all` lines. */
  dirty: string[];
  /** `git rev-parse --abbrev-ref HEAD` ("HEAD" when detached). */
  headRef: string;
  /** Some local or remote ref contains HEAD's commit. */
  containedBy: boolean;
}

/** One ssh: the working tree's status, its HEAD ref, and whether any ref holds HEAD's commit. */
function probeCheckout(host: RemoteHost, repo: string): CheckoutProbe {
  const q = shq(repo);
  const out = checked(remote(host,
    `cd ${q} && git status --porcelain --untracked-files=all && printf '\\036%s\\036' "$(git rev-parse --abbrev-ref HEAD)" && git for-each-ref --contains HEAD --count=1 refs/heads refs/remotes`),
  `inspect cloud checkout ${repo}`);
  const [status = "", headRef = "", refs = ""] = out.split("\x1e");
  return {
    dirty: status.split("\n").map((l) => l.trimEnd()).filter(Boolean),
    headRef: headRef.trim(),
    containedBy: refs.trim().length > 0,
  };
}

/**
 * Why HEAD must NOT be moved in this checkout, or null. Only a shared
 * placement (moveHead) asks; the fetch-only default clobbers nothing, so a
 * shared session's normal edits never block an isolated spawn beside it.
 */
export function checkoutRefusal(probe: CheckoutProbe, repo = "the host checkout"): string | null {
  if (probe.dirty.length) {
    const shown = probe.dirty.slice(0, 5).join(", ") + (probe.dirty.length > 5 ? `, … ${probe.dirty.length - 5} more` : "");
    return `host checkout ${repo} has uncommitted changes (${shown}) — commit, stash or reset them on the host, or run isolated`;
  }
  if (probe.headRef === "HEAD" && !probe.containedBy) {
    return "host checkout is detached at commits no branch holds — create a branch for them on the host first";
  }
  return null;
}

/**
 * Bring the host's main checkout up to date with origin/main.
 *
 * Fetch-only by default: the clone / fetch / laptop-bundle fallbacks write
 * `refs/remotes/origin/main` and `origin`'s url, never HEAD, so every isolated
 * caller (spawn, fork, the web) coexists with a live shared session in that
 * checkout without opting in. Only a SHARED placement passes `moveHead`,
 * which additionally refuses a dirty tree or orphaned detached commits
 * (checkoutRefusal) and then detaches HEAD at origin/main.
 */
export function refreshRemoteCheckout(
  host: RemoteHost,
  localGitRoot: string,
  repoPath: string,
  onProgress: (message: string) => void = () => {},
  opts: { moveHead?: boolean; appToken?: boolean } = {},
): { branch: string; head: string; reset: boolean; via: "host" | "laptop" } {
  absoluteRemotePath(repoPath);
  const moveHead = opts.moveHead === true;
  const refuse = (): void => {
    if (!moveHead) return;
    const reason = checkoutRefusal(probeCheckout(host, repoPath), repoPath);
    if (reason) throw new Error(reason);
  };
  const origin = git(localGitRoot, ["remote", "get-url", "origin"], "read repository origin");
  if (!origin || origin.startsWith("-") || /[\x00-\x1f\x7f]/.test(origin)) throw new Error("invalid repository origin");
  // How the HOST reaches origin decides how the origin is spelled there
  // (hostProbeOrigin). With the codecast GitHub App covering the repository it
  // is https, and `cast git-credential` hands git an installation token per
  // operation — no key for anyone to grant. Otherwise it is the ssh form, and
  // the host's fetches and every push from the box (an agent's, the WIP
  // snapshot's) authenticate with the device key that `cast hosts key` grants.
  // The laptop fallbacks below keep the laptop's own origin and credentials.
  const hostOrigin = hostProbeOrigin(origin, { appToken: opts.appToken === true }).origin ?? origin;
  const q = shq(repoPath);
  const exists = checked(remote(host, `if [ -e ${q} ] || [ -L ${q} ]; then echo present; else echo missing; fi`),
    "inspect cloud checkout path") === "present";
  let viaLaptop = false;
  if (!exists) {
    // GIT_TERMINAL_PROMPT=0 beside the ssh config block's BatchMode: a host
    // without access fails fast into the laptop fallback, never hangs on a
    // credential prompt nobody can answer.
    const clone = remote(host, `GIT_TERMINAL_PROMPT=0 git clone -q --single-branch --no-tags --branch main -- ${shq(hostOrigin)} ${q}`);
    if (clone.error || clone.status !== 0) {
      onProgress("host cannot clone origin — fetching fresh origin/main on laptop for a main-only bundle");
      withFreshMain(origin, (repo) => {
        const bundle = path.join(repo, "main.bundle");
        git(repo, ["bundle", "create", bundle, "refs/heads/main"], "create main-only bundle");
        fs.chmodSync(bundle, 0o600);
        const fd = fs.openSync(bundle, "r");
        try {
          checked(remote(host,
            `set -eu; umask 077; stage=$(mktemp -d); trap 'rm -rf "$stage"' EXIT; cat > "$stage/main.bundle"; git clone -q --single-branch --no-tags --branch main -- "$stage/main.bundle" ${q}`, fd),
          "transfer and clone main-only bundle");
        } finally {
          fs.closeSync(fd);
        }
      });
      viaLaptop = true;
    }
  } else {
    assertCheckoutPath(host, repoPath);
    refuse();
    const fetch = remote(host,
      `cd ${q} && GIT_TERMINAL_PROMPT=0 git fetch -q --no-tags --no-recurse-submodules -- ${shq(hostOrigin)} '+refs/heads/main:refs/remotes/origin/main'`);
    if (fetch.error || fetch.status !== 0) {
      onProgress("host cannot fetch origin — fetching fresh origin/main on laptop before transfer");
      withFreshMain(origin, (repo) => {
        checked(spawnSync("git", ["-C", repo, "push", "-q", "--force", "--",
          gitSshUrl(host, repoPath), "refs/heads/main:refs/remotes/origin/main"], {
          encoding: "utf-8", stdio: "pipe", timeout: 300_000,
          env: { ...process.env, GIT_SSH_COMMAND: ["ssh", ...sshBase(host)].map(shq).join(" ") },
        }), "push fresh origin/main to cloud checkout");
      });
      viaLaptop = true;
    }
  }
  assertCheckoutPath(host, repoPath);
  if (moveHead) {
    refuse();
    checked(remote(host, `cd ${q} && git remote set-url origin ${shq(hostOrigin)} && git checkout -q --detach --no-overwrite-ignore refs/remotes/origin/main`),
      `checkout origin/main in ${repoPath}`);
    // Every shared placement leaves its `codecast/cloud-<hex>` branch behind.
    // Drop the ones origin/main already contains; `-d` refuses a branch with
    // unmerged commits or one checked out in a worktree, so nothing is lost.
    remote(host, `cd ${q} && for b in $(git for-each-ref --format='%(refname:short)' --merged refs/remotes/origin/main 'refs/heads/codecast/cloud-*'); do git branch -q -d "$b" 2>/dev/null || true; done`);
    const head = checked(remote(host, `cd ${q} && git rev-parse HEAD`), "read cloud checkout revision");
    onProgress(`checkout at ${head.slice(0, 8)} from origin/main${viaLaptop ? " (via laptop)" : ""}`);
    return { branch: "main", head, reset: true, via: viaLaptop ? "laptop" : "host" };
  }
  checked(remote(host, `cd ${q} && git remote set-url origin ${shq(hostOrigin)}`), `set origin in ${repoPath}`);
  const head = checked(remote(host, `cd ${q} && git rev-parse refs/remotes/origin/main`), "read cloud checkout revision");
  const branch = (() => { try { return checked(remote(host, `cd ${q} && git rev-parse --abbrev-ref HEAD`), "read cloud checkout branch") || "main"; } catch { return "main"; } })();
  onProgress(`origin/main at ${head.slice(0, 8)}${viaLaptop ? " (via laptop)" : ""}; checkout left on ${branch}`);
  return { branch, head, reset: false, via: viaLaptop ? "laptop" : "host" };
}

// ---------------------------------------------------------------------------
// The laptop seed: what a cloud worktree starts from
// ---------------------------------------------------------------------------

/**
 * Hidden ref namespace in the HOST's main repo for the laptop's WIP snapshot.
 * Never refs/heads/*: it must not trip receive.denyCurrentBranch on the host
 * checkout, and `git ls-remote --heads` must not list it. Linked worktrees
 * share the object DB, so `git worktree add … --start-point <ref>` sees it
 * without a second transfer.
 */
export const CLOUD_SEED_REF_PREFIX = "refs/codecast/cloud";

/** A worktree name that is not a valid ref component — rejected before any ssh. */
export class CloudSeedNameError extends Error {}

/** The laptop checkout cannot be a seed in principle (not a repo, no commits). */
export class CloudSeedUnavailable extends Error {}

export interface CloudSeed {
  source: "checkout" | "origin_main";
  /** The commit the worktree starts at (laptop HEAD, or origin/main's). */
  base: string;
  /** The laptop branch; absent when detached. */
  branch?: string;
  /** The laptop tree had uncommitted or untracked work. */
  dirty?: boolean;
  laptopRoot?: string;
  /** The preparing device. */
  deviceId?: string;
  /** Why an automatic downgrade to origin/main happened. */
  reason?: string;
  /** The hidden ref the snapshot was pushed to (checkout seeds, after the push). */
  ref?: string;
  /** The snapshot commit (its parent is `base`). */
  snapshot?: string;
  /** The snapshot's tree. */
  tree?: string;
}

/**
 * The seed ref for a worktree name. stageCloudInputs' name regex admits
 * `a..b` and `x.lock`, which are not valid refnames and would only surface as
 * an opaque transport error; git's own check runs here, locally, first.
 */
export function cloudSeedRef(name: string): string {
  const ref = `${CLOUD_SEED_REF_PREFIX}/${name}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
    || spawnSync("git", ["check-ref-format", ref], { stdio: "ignore" }).status !== 0) {
    throw new CloudSeedNameError(`worktree name ${JSON.stringify(name)} is not a valid git ref component`);
  }
  return ref;
}

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Take the laptop's snapshot (once per fan-out): HEAD, branch, dirtiness and a
 * dangling snapshot commit whose parent is HEAD, with the workspace state
 * dirs left out. Throws CloudSeedUnavailable only when the checkout cannot
 * be a seed in principle; any other git failure is fatal with git's stderr.
 */
export async function planLaptopSeed(seedCwd: string): Promise<CloudSeed> {
  const head = spawnSync("git", ["-C", seedCwd, "rev-parse", "--verify", "HEAD"], { encoding: "utf-8", stdio: "pipe" });
  if (head.error || head.status !== 0) throw new CloudSeedUnavailable(`${seedCwd} is not a git checkout with commits`);
  let snap;
  try {
    snap = await createWipSnapshotStrict(seedCwd, { exclude: CLOUD_SEED_EXCLUDES });
  } catch (e) {
    const err = e as { stderr?: string | Buffer; message?: string };
    const detail = (err.stderr?.toString() || err.message || String(e)).trim().split("\n").find(Boolean) ?? "unknown git failure";
    throw new Error(`seed snapshot failed: ${detail}`);
  }
  if (!snap) throw new CloudSeedUnavailable(`${seedCwd} is not a git checkout with commits`);
  return {
    source: "checkout",
    base: snap.base,
    ...(snap.branch !== "HEAD" ? { branch: snap.branch } : {}),
    dirty: snap.dirty,
    laptopRoot: seedCwd,
    snapshot: snap.sha,
    tree: snap.tree,
  };
}

/**
 * Force-push the snapshot to the host main repo's hidden ref for `name`, over
 * the same shell-quoted ssh transport the other transfer commands use (the
 * multiplexed connection, the quoted key path). Called only AFTER the name is
 * reserved on the host, so a failed reservation never leaves a pinned copy of
 * the laptop's uncommitted tree behind. Idempotent: the same laptop tree
 * yields the same date-pinned snapshot commit.
 */
export function pushLaptopSeed(host: RemoteHost, seedCwd: string, repoPath: string, name: string, seed: CloudSeed): CloudSeed {
  absoluteRemotePath(repoPath);
  const ref = cloudSeedRef(name);
  if (!seed.snapshot || !SHA_RE.test(seed.snapshot)) throw new Error("seed has no snapshot to push");
  checked(spawnSync("git", ["-C", seedCwd, "push", "-q", "--force", "--", gitSshUrl(host, repoPath), `${seed.snapshot}:${ref}`], {
    encoding: "utf-8", stdio: "pipe", timeout: 300_000,
    env: { ...process.env, GIT_SSH_COMMAND: ["ssh", ...sshBase(host)].map(shq).join(" ") },
  }), `push laptop seed for ${name} to cloud checkout`);
  return { ...seed, ref };
}

/** Best-effort removal of a seed ref (acquire failed after the push). */
export function dropLaptopSeed(host: RemoteHost, repoPath: string, name: string): void {
  try {
    const ref = cloudSeedRef(name);
    remote(host, `cd ${shq(repoPath)} && git update-ref -d ${shq(ref)}`);
  } catch { /* best effort */ }
}

/**
 * After `cast ws acquire --start-point`: turn the snapshot commit back into
 * uncommitted work (`git reset --mixed <laptop HEAD>`), then prove the seed:
 * HEAD == base and the ref's tree == the snapshot tree. The status count is
 * informational only — install and the manifest copy ran before this, so it
 * cannot prove the laptop's dirty set; `dirty` comes from the laptop snapshot.
 */
export function finishSeededWorktree(host: RemoteHost, wsPath: string, seed: CloudSeed): { head: string; treeOk: boolean; statusEntries: number } {
  absoluteRemotePath(wsPath);
  if (!SHA_RE.test(seed.base) || !seed.snapshot || !SHA_RE.test(seed.snapshot) || !seed.tree || !SHA_RE.test(seed.tree) || !seed.ref) {
    throw new Error("seed is missing a full sha or its ref; refusing to reset the host worktree");
  }
  const out = checked(remote(host,
    `cd ${shq(wsPath)} && git reset -q --mixed ${seed.base} && git rev-parse HEAD && git rev-parse ${shq(seed.ref)}^{tree} && git status --porcelain | wc -l`),
  `finish seeded worktree ${wsPath}`);
  const [head = "", tree = "", count = ""] = out.split("\n").map((l) => l.trim());
  const treeOk = tree === seed.tree;
  if (head !== seed.base || !treeOk) throw new Error(`seeded worktree ${wsPath} is not at the laptop snapshot (HEAD ${head.slice(0, 8)}, tree ${treeOk ? "ok" : "differs"})`);
  return { head, treeOk, statusEntries: parseInt(count, 10) || 0 };
}

/**
 * Seed refs in the host main repo with no workspace state dir behind them
 * (a leftover of a failed acquire, or a worktree removed by hand): what
 * `cast hosts ls` lists as `seed ref only (orphan)`.
 */
export function listDanglingSeedRefs(host: RemoteHost, repoPath: string): string[] {
  absoluteRemotePath(repoPath);
  const out = checked(remote(host, `cd ${shq(repoPath)} && ${DANGLING_SEED_REFS_SCRIPT}`), `list seed refs in ${repoPath}`);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Shell run inside a checkout: one worktree name per line for every seed ref
 * with no workspace state dir behind it (strip=3 drops refs/codecast/cloud).
 * `cast hosts ls` runs it in every checkout on the host.
 */
export const DANGLING_SEED_REFS_SCRIPT =
  `for n in $(git for-each-ref --format='%(refname:strip=3)' ${CLOUD_SEED_REF_PREFIX}); do [ -d ".codecast/workspaces/$n" ] || echo "$n"; done`;

function validateRelativePath(rel: string): void {
  if (!rel || /[\\:\x00-\x1f\x7f]/.test(rel)
    || rel.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")) {
    throw new Error(`unsafe workspace copy path: ${JSON.stringify(rel)}`);
  }
}

function sourceStat(root: string, rel: string): fs.Stats | undefined {
  validateRelativePath(rel);
  let current = root;
  let stat: fs.Stats | undefined;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return undefined;
    if (stat.isSymbolicLink()) throw new Error(`workspace copy refuses symlink: ${rel}`);
  }
  return stat;
}

export function cloudCopyFiles(localGitRoot: string): string[] {
  const root = fs.realpathSync(localGitRoot);
  sourceStat(root, MANIFEST_REL_PATH);
  sourceStat(root, ".wt-setup-files");
  let candidates: string[];
  try {
    candidates = resolveManifest(root).setup.copy;
  } catch (err) {
    if (!(err instanceof ManifestError)) throw err;
    throw new Error("invalid workspace manifest; fix .codecast/workspace.toml before cloud acquire");
  }
  const files = new Set<string>();
  const context = new Set(collectProjectContext({ root, includeTracked: false, includeAncestors: false }).files.filter((f) => f.scope === "project").map((f) => f.relativePath));
  const visit = (rel: string) => {
    validateRelativePath(rel);
    if (context.has(rel)) { files.add(rel); return; }
    const stat = sourceStat(root, rel);
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(path.join(root, rel))) visit(`${rel}/${child}`);
    } else if (stat.isFile()) {
      files.add(rel);
    } else {
      throw new Error(`workspace copy requires a regular file: ${rel}`);
    }
  };
  for (const rel of [...candidates, MANIFEST_REL_PATH, ".wt-setup-files"]) visit(rel);
  return [...files];
}

const receiveFile = `
try {
const fs = require("node:fs"), path = require("node:path");
const [root, rel, mode] = process.argv.slice(1);
const dest = path.join(root, rel);
let dir = "/";
for (const part of path.dirname(dest).split("/").filter(Boolean)) {
  dir = path.join(dir, part);
  // Two preparers may create the same parent at once (parallel cloud_spawns
  // on a fresh host repo): an existing directory is fine, anything else is not.
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  if (!fs.lstatSync(dir).isDirectory()) throw Error("unsafe destination directory");
}
const old = fs.lstatSync(dest, { throwIfNoEntry: false });
if (old && !old.isFile()) throw Error("unsafe destination file");
const temp = fs.mkdtempSync(path.join(dir, ".cast-copy-"));
try {
  const file = path.join(temp, "file");
  fs.writeFileSync(file, fs.readFileSync(0), { mode: Number(mode) });
  fs.renameSync(file, dest);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
process.stdout.write("copied");
} catch {
  process.exit(1);
}
`;

const reserveInputs = `
try {
const fs = require("node:fs"), path = require("node:path");
const [repo, name, reuse] = process.argv.slice(1);
if (fs.lstatSync(path.join(repo, ".codecast/worktrees", name), { throwIfNoEntry: false })) throw Error("workspace exists");
const result = require("node:child_process").spawnSync("git", ["-C", repo, "rev-parse", "--git-path", "info/exclude"], { encoding: "utf8" });
if (result.status !== 0 || !result.stdout.trim()) throw Error("cannot locate git excludes");
const exclude = path.resolve(repo, result.stdout.trim());
fs.mkdirSync(path.dirname(exclude), { recursive: true });
if (fs.lstatSync(exclude, { throwIfNoEntry: false })?.isSymbolicLink()) throw Error("unsafe excludes");
const prior = fs.existsSync(exclude) ? fs.readFileSync(exclude, "utf8") : "";
const missing = ["/.codecast/workspaces/", "/.codecast/worktrees/"].filter(rule => !prior.split("\\n").includes(rule));
if (missing.length) fs.appendFileSync(exclude, "\\n" + missing.join("\\n") + "\\n", { mode: 0o600 });
let dir = "/";
for (const part of path.join(repo, ".codecast/workspaces").split("/").filter(Boolean)) {
  dir = path.join(dir, part);
  // Two preparers may create the same parent at once (parallel cloud_spawns
  // on a fresh host repo): an existing directory is fine, anything else is not.
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  if (!fs.lstatSync(dir).isDirectory()) throw Error("unsafe destination directory");
}
if (reuse === "reuse" && fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false })?.isDirectory()) {
  // The reserved root record: its state dir persists across placements, so
  // only the inputs snapshot is replaced.
  fs.rmSync(path.join(dir, name, "inputs"), { recursive: true, force: true });
} else {
  fs.mkdirSync(path.join(dir, name), { mode: 0o700 });
}
fs.mkdirSync(path.join(dir, name, "inputs"), { mode: 0o700 });
process.stdout.write("reserved");
} catch {
  process.exit(1);
}
`;

export function stageCloudInputs(
  host: RemoteHost,
  localGitRoot: string,
  repoPath: string,
  name: string,
  opts: { warn?: (m: string) => void; reuse?: boolean } = {},
): string {
  absoluteRemotePath(repoPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`worktree name ${JSON.stringify(name)} — use letters, digits, dot, dash, underscore`);
  }
  const files = cloudCopyFiles(localGitRoot);
  const inputRoot = path.posix.join(repoPath, ".codecast/workspaces", name, "inputs");
  // `reuse`: an existing state dir of that name keeps its record and only
  // has its inputs snapshot recreated (the shared-checkout record); a
  // worktree of that name still refuses. Without it, an existing state dir
  // is a refusal (the name is taken).
  const reserved = checked(remote(host,
    `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; bun -e ${shq(reserveInputs)} -- ${shq(repoPath)} ${shq(name)}${opts.reuse ? " reuse" : ""}`),
  `reserve inputs for workspace ${name}; existing worktree or state must be retained`);
  if (reserved !== "reserved") throw new Error(`input reservation for workspace ${name} was not confirmed by the host`);
  copyCloudFiles(host, localGitRoot, inputRoot, files, { warn: opts.warn ?? ((m) => console.error(`WARNING: ${m}`)) });
  return inputRoot;
}

/** Above this many files one batched `mirror-apply --into` ssh replaces the per-file loop. */
export const STAGING_BATCH_THRESHOLD = 8;

/**
 * Copy the staged files to `repoPath` on the host. Each file is read with
 * O_NOFOLLOW and passed through transformForHost (project settings and codex
 * config get the home mirror's scrub/remap/hook-drop; portable support text
 * gets path remapping).
 * A set larger than STAGING_BATCH_THRESHOLD ships as ONE bundle to the
 * host's `cast cloud mirror-apply --stdin --into`; a host whose cast predates
 * that command (`unknown command`) or has no cast on PATH (`not found`,
 * exit 127) falls back to the per-file loop, which needs only bun.
 */
export function copyCloudFiles(
  host: RemoteHost,
  localGitRoot: string,
  repoPath: string,
  files = cloudCopyFiles(localGitRoot),
  opts: { warn?: (m: string) => void } = {},
): void {
  absoluteRemotePath(repoPath);
  const root = fs.realpathSync(localGitRoot);
  const ctx = { fromHome: process.env.HOME || os.homedir(), toHome: remoteHome(host) };
  const staged: Array<{ rel: string; bytes: Buffer; mode: number }> = [];
  const context = new Map(collectProjectContext({ root, includeTracked: false, includeAncestors: false }).files.filter((f) => f.scope === "project").map((f) => [f.relativePath, f]));
  for (const rel of files) {
    validateRelativePath(rel);
    const discovered = context.get(rel);
    if (discovered) {
      const bytes = transformForHost(rel, discovered.bytes, ctx);
      if (bytes === null) throw new Error(`project context cannot be parsed: ${rel}`);
      staged.push({ rel, bytes, mode: Number.parseInt(discovered.mode, 8) });
      continue;
    }
    const stat = sourceStat(root, rel);
    if (!stat?.isFile()) throw new Error(`workspace copy source changed: ${rel}`);
    const fd = fs.openSync(path.join(root, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let raw: Buffer;
    try { raw = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
    const bytes = kindForPath(rel) === "verbatim" ? raw : transformForHost(rel, raw, ctx);
    if (bytes === null) throw new Error(`project context cannot be parsed: ${rel}`);
    staged.push({ rel, bytes, mode: 0o600 | (stat.mode & 0o100) });
  }
  if (staged.length > STAGING_BATCH_THRESHOLD && stageBatched(host, repoPath, staged)) return;
  for (const { rel, bytes, mode } of staged) {
    const received = checked(remote(host,
      `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; bun -e ${shq(receiveFile)} -- ${shq(repoPath)} ${shq(rel)} ${shq(String(mode))}`, bytes),
    `transfer workspace file ${rel}`);
    if (received !== "copied") throw new Error(`transfer workspace file ${rel} was not confirmed by the host`);
  }
}

/** One bundle for the whole set. False when the host does not know the command. */
function stageBatched(host: RemoteHost, repoPath: string, staged: Array<{ rel: string; bytes: Buffer; mode: number }>): boolean {
  const bundle = buildMirrorBundle(
    staged.map((f) => ({ path: f.rel, kind: "verbatim" as const, mode: f.mode & 0o100 ? "0700" as const : "0600" as const, bytes: f.bytes })),
    { source: { device_id: "", user_id: "", home: "", platform: process.platform, cast_version: "" }, target_home: repoPath, managed_roots: [] },
  );
  const result = remote(host,
    `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; cast cloud mirror-apply --stdin --into ${shq(repoPath)}`, bundle.bytes);
  if (result.status !== 0 && (result.status === 127 || /unknown command|error: unknown|not found/i.test(result.stderr ?? ""))) return false;
  const line = (result.stdout ?? "").trim().split("\n").reverse().find((l) => l.trimStart().startsWith("{"));
  let reply: { copied?: unknown; errors?: unknown } | null = null;
  try { reply = line ? JSON.parse(line) : null; } catch { reply = null; }
  if (result.error || result.status !== 0 || !reply) {
    throw new Error(`transfer workspace files failed (${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.signal ?? `exit ${result.status}`})`);
  }
  const copied = new Set(Array.isArray(reply.copied) ? reply.copied.filter((p): p is string => typeof p === "string") : []);
  const missing = staged.filter((f) => !copied.has(f.rel));
  if (missing.length) throw new Error(`transfer workspace file ${missing[0]!.rel} was not confirmed by the host`);
  return true;
}
