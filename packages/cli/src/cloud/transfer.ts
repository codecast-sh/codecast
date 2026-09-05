import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitSshUrl, shq, sshBase, type RemoteHost } from "../remote/session-move.js";
import { MANIFEST_REL_PATH, resolveManifest } from "../workspace/resolver.js";

function checked(result: SpawnSyncReturns<string>, operation: string): string {
  if (result.error || result.status !== 0) {
    throw new Error(`${operation} failed (${(result.error as NodeJS.ErrnoException | undefined)?.code ?? result.signal ?? `exit ${result.status}`})`);
  }
  return result.stdout.trim();
}

function remote(host: RemoteHost, command: string, input?: number): SpawnSyncReturns<string> {
  return spawnSync("ssh", [...sshBase(host), `${host.user}@${host.address}`, command], {
    encoding: "utf-8", stdio: [input ?? "ignore", "pipe", "pipe"], timeout: 300_000, env: process.env,
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

function assertClean(host: RemoteHost, repo: string): void {
  const q = shq(repo);
  const dirty = checked(remote(host,
    `test ! -L ${q} && cd ${q} && test "$(git rev-parse --show-toplevel)" = "$(pwd -P)" && git status --porcelain --untracked-files=all`),
  `inspect cloud checkout ${repo}`);
  if (dirty) throw new Error(`cloud checkout ${repo} has uncommitted changes; preserve or move that work before retrying — refusing to branch from a dirty moved session`);
}

export function refreshRemoteCheckout(
  host: RemoteHost,
  localGitRoot: string,
  repoPath: string,
  onProgress: (message: string) => void = () => {},
): { branch: string; head: string; reset: boolean } {
  absoluteRemotePath(repoPath);
  const origin = git(localGitRoot, ["remote", "get-url", "origin"], "read repository origin");
  if (!origin || origin.startsWith("-") || /[\x00-\x1f\x7f]/.test(origin)) throw new Error("invalid repository origin");
  const q = shq(repoPath);
  const exists = checked(remote(host, `if [ -e ${q} ] || [ -L ${q} ]; then echo present; else echo missing; fi`),
    "inspect cloud checkout path") === "present";
  let viaLaptop = false;
  if (!exists) {
    const clone = remote(host, `git clone -q --single-branch --no-tags --branch main -- ${shq(origin)} ${q}`);
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
    assertClean(host, repoPath);
    const fetch = remote(host,
      `cd ${q} && git fetch -q --no-tags --no-recurse-submodules -- ${shq(origin)} '+refs/heads/main:refs/remotes/origin/main'`);
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
  assertClean(host, repoPath);
  checked(remote(host, `cd ${q} && git remote set-url origin ${shq(origin)} && git checkout -q --detach --no-overwrite-ignore refs/remotes/origin/main`),
    `checkout origin/main in ${repoPath}`);
  const head = checked(remote(host, `cd ${q} && git rev-parse HEAD`), "read cloud checkout revision");
  onProgress(`checkout at ${head.slice(0, 8)} from origin/main${viaLaptop ? " (via laptop)" : ""}`);
  return { branch: "main", head, reset: true };
}

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
  } catch {
    throw new Error("invalid workspace manifest; fix .codecast/workspace.toml before cloud acquire");
  }
  const files = new Set<string>();
  const visit = (rel: string) => {
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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
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
const [repo, name] = process.argv.slice(1);
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
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory()) throw Error("unsafe destination directory");
}
fs.mkdirSync(path.join(dir, name), { mode: 0o700 });
fs.mkdirSync(path.join(dir, name, "inputs"), { mode: 0o700 });
process.stdout.write("reserved");
} catch {
  process.exit(1);
}
`;

export function stageCloudInputs(host: RemoteHost, localGitRoot: string, repoPath: string, name: string): string {
  absoluteRemotePath(repoPath);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`worktree name ${JSON.stringify(name)} — use letters, digits, dot, dash, underscore`);
  }
  const files = cloudCopyFiles(localGitRoot);
  const inputRoot = path.posix.join(repoPath, ".codecast/workspaces", name, "inputs");
  const reserved = checked(remote(host,
    `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; bun -e ${shq(reserveInputs)} -- ${shq(repoPath)} ${shq(name)}`),
  `reserve inputs for workspace ${name}; existing worktree or state must be retained`);
  if (reserved !== "reserved") throw new Error(`input reservation for workspace ${name} was not confirmed by the host`);
  copyCloudFiles(host, localGitRoot, inputRoot, files);
  return inputRoot;
}

export function copyCloudFiles(host: RemoteHost, localGitRoot: string, repoPath: string, files = cloudCopyFiles(localGitRoot)): void {
  absoluteRemotePath(repoPath);
  const root = fs.realpathSync(localGitRoot);
  for (const rel of files) {
    const stat = sourceStat(root, rel);
    if (!stat?.isFile()) throw new Error(`workspace copy source changed: ${rel}`);
    const fd = fs.openSync(path.join(root, rel), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const received = checked(remote(host,
        `export PATH="$HOME/.bun/bin:$HOME/.local/bin:/usr/local/bin:$PATH"; bun -e ${shq(receiveFile)} -- ${shq(repoPath)} ${shq(rel)} ${shq(String(0o600 | (stat.mode & 0o100)))}`, fd),
      `transfer workspace file ${rel}`);
      if (received !== "copied") throw new Error(`transfer workspace file ${rel} was not confirmed by the host`);
    } finally {
      fs.closeSync(fd);
    }
  }
}
