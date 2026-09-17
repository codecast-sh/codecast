import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deviceKeyComment } from "../gitIdentity";
import type { RemoteHost } from "../remote/session-move";
import {
  ACCOUNT_KEY_URL, GITHUB_KNOWN_HOSTS, HOST_GIT_REMOTE_COMMAND, SSH_CONFIG_BLOCK_END, SSH_CONFIG_BLOCK_START,
  classifyProbe, deployKeyUrl, ensureHostGitReady, githubRepo, hostAccessPath, hostGitScript, hostProbeOrigin, knownHostLinesFor, laptopIdentity, probeErrorLine,
  laptopKnownHostLines, originHost, parseHostGitOutput, parseIdentityOverride, sshConfigBlock, type HostGitState,
} from "./hostGit";
import { GH_WRAPPER_REL, ghWrapperScript, REAL_GH_REL } from "./ghWrapper";

// Everything the script touches resolves from $HOME, and the tests redirect
// HOME (the "host"), GIT_CONFIG_GLOBAL (the "laptop"'s global git config —
// a separate file, so the two sides cannot be confused) and XDG_CONFIG_HOME
// to a temp dir. The developer's real files are compared byte for byte after
// every test: a leak here would mint a key the real daemon then publishes.
const REAL_HOME_WATCH = [".ssh/known_hosts", ".ssh/config", ".gitconfig", ".codecast/git"];

function snapshotRealHome(realHome: string): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of REAL_HOME_WATCH) {
    const p = path.join(realHome, rel);
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) out[rel] = null;
    else if (st.isDirectory()) {
      const files = fs.readdirSync(p, { recursive: true, encoding: "utf-8" }).sort();
      out[rel] = files.map((f) => {
        const fp = path.join(p, f);
        return `${f}:${fs.lstatSync(fp).isFile() ? fs.readFileSync(fp).toString("base64") : "dir"}`;
      }).join("\n");
    } else out[rel] = fs.readFileSync(p).toString("base64");
  }
  return out;
}

let dir: string, hostHome: string, laptopGitconfig: string, bin: string, realGit: string, realSshKeygen: string;
let savedEnv: NodeJS.ProcessEnv;
let realHomeBefore: Record<string, string | null>;
const host: RemoteHost = { address: "cloud-test.invalid", user: "ubuntu", keyPath: "/k", remoteBaseDir: "/home/ubuntu/work", homeDir: "/home/ubuntu" };

/** The "host": run the script exactly as ssh would, locally, against $HOME. */
function localRun(_host: RemoteHost, script: string) {
  const r = spawnSync("/bin/sh", ["-c", HOST_GIT_REMOTE_COMMAND], { input: script, encoding: "utf-8", env: process.env, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", ...(r.error ? { error: r.error } : {}) };
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: "pipe", env: process.env }).trim();
}

function makeRepo(name: string, opts: { origin?: string } = {}): string {
  const repo = path.join(dir, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  git(repo, "add", "a.txt");
  git(repo, "-c", "user.name=T", "-c", "user.email=t@test.local", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
  if (opts.origin) git(repo, "remote", "add", "origin", opts.origin);
  return repo;
}

/** A bare origin with a `main` branch: read AND write probes both pass against it. */
let origins = 0;
function makeBareOrigin(): string {
  const n = ++origins;
  const src = makeRepo(`publisher-${n}`);
  const bare = path.join(dir, `origin-${n}.git`);
  execFileSync("git", ["clone", "-q", "--bare", src, bare], { stdio: "pipe", env: process.env });
  return bare;
}

function fakeBin(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

beforeEach(() => {
  savedEnv = { ...process.env };
  realHomeBefore = snapshotRealHome(savedEnv.HOME || os.homedir());
  realGit = Bun.which("git")!;
  realSshKeygen = Bun.which("ssh-keygen")!;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-hostgit-")));
  hostHome = path.join(dir, "host-home");
  fs.mkdirSync(hostHome);
  laptopGitconfig = path.join(dir, "laptop-gitconfig");
  bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  process.env.HOME = hostHome;
  process.env.XDG_CONFIG_HOME = path.join(hostHome, ".config");
  process.env.GIT_CONFIG_GLOBAL = laptopGitconfig;
  process.env.PATH = `${bin}:${process.env.PATH}`;
  delete process.env.GIT_SSH_COMMAND;
});

afterEach(() => {
  const realHome = savedEnv.HOME || os.homedir();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
  expect(snapshotRealHome(realHome)).toEqual(realHomeBefore);
});

function ready(opts: Parameters<typeof ensureHostGitReady>[1] = {}): HostGitState {
  return ensureHostGitReady(host, { run: localRun, ...opts });
}

const hostFile = (rel: string) => path.join(hostHome, rel);
const mode = (rel: string) => fs.statSync(hostFile(rel)).mode & 0o777;

describe("origin parsing", () => {
  test.each([
    ["git@github.com:o/r.git", "github.com", "o/r"],
    ["ssh://git@github.com/o/r", "github.com", "o/r"],
    ["ssh://git@github.com:22/o/r.git", "github.com", "o/r"],
    ["https://github.com/o/r.git", "github.com", "o/r"],
  ])("%s → deploy-key url for o/r", (origin, hostName, repo) => {
    expect(originHost(origin)).toBe(hostName);
    expect(githubRepo(origin)).toBe(repo);
    expect(deployKeyUrl(origin)).toBe(`https://github.com/${repo}/settings/keys/new`);
  });

  test("a non-GitHub host has no deploy-key url; a local path has no host at all", () => {
    expect(originHost("git@gitlab.example:o/r.git")).toBe("gitlab.example");
    expect(deployKeyUrl("git@gitlab.example:o/r.git")).toBeUndefined();
    expect(githubRepo("git@gitlab.example:o/r.git")).toBeUndefined();
    expect(originHost("/tmp/origin.git")).toBeUndefined();
    expect(originHost(undefined)).toBeUndefined();
    expect(ACCOUNT_KEY_URL).toBe("https://github.com/settings/ssh/new");
  });

  test("known_hosts lines: GitHub's are pinned, another host's come from the laptop's file, or none", () => {
    expect(knownHostLinesFor("github.com")).toEqual({ lines: [...GITHUB_KNOWN_HOSTS], source: "pinned" });
    const kh = path.join(dir, "laptop-known-hosts");
    const line = "gitlab.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    fs.writeFileSync(kh, `${line}\nother.example ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n`);
    expect(laptopKnownHostLines("gitlab.example", kh)).toEqual([line]);
    expect(knownHostLinesFor("gitlab.example", kh)).toEqual({ lines: [line], source: "laptop" });
    expect(knownHostLinesFor("nowhere.example", kh)).toEqual({ lines: [], source: "none" });
    expect(laptopKnownHostLines("bad host;rm", kh)).toEqual([]);
  });

  test("the three pinned lines are github.com's ed25519, ecdsa and rsa keys", () => {
    expect(GITHUB_KNOWN_HOSTS.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual([
      "github.com ssh-ed25519", "github.com ecdsa-sha2-nistp256", "github.com ssh-rsa",
    ]);
  });
});

describe("laptop identity", () => {
  test("--git-identity parses Name <email>, and wins over the repo and the global config", () => {
    expect(parseIdentityOverride('Ada Lovelace <ada@example.com>')).toEqual({ name: "Ada Lovelace", email: "ada@example.com" });
    expect(parseIdentityOverride("<ada@example.com>")).toEqual({ name: undefined, email: "ada@example.com" });
    fs.writeFileSync(laptopGitconfig, "[user]\n\tname = Global\n\temail = global@example.com\n");
    const repo = makeRepo("laptop");
    git(repo, "config", "user.name", "Local");
    git(repo, "config", "user.email", "local@example.com");
    expect(laptopIdentity(repo, "Ada <ada@example.com>")).toEqual({ name: "Ada", email: "ada@example.com" });
    expect(laptopIdentity(repo)).toEqual({ name: "Local", email: "local@example.com" });
    expect(laptopIdentity(undefined)).toEqual({ name: "Global", email: "global@example.com" });
  });

  test("nothing configured anywhere resolves to nothing", () => {
    expect(laptopIdentity(undefined)).toEqual({ name: undefined, email: undefined });
  });
});

describe("hostGitScript on a redirected HOME", () => {
  test("the script closes stdin first and is delivered as bash -c \"$(cat)\"", () => {
    const script = hostGitScript({ knownHostLines: [], sshHost: "github.com", identity: undefined, keyComment: "c", identitiesOnly: false });
    expect(script.split("\n").slice(0, 3)).toEqual(["set -u", "umask 077", "exec </dev/null"]);
    expect(HOST_GIT_REMOTE_COMMAND).toBe('bash -c "$(cat)"');
    expect(() => hostGitScript({ knownHostLines: [], sshHost: "bad host", identity: undefined, keyComment: "c", identitiesOnly: false })).toThrow(/not safe/);
  });

  test("known_hosts: ~/.ssh 0700, known_hosts 0600 with the pinned lines; a rerun appends nothing and keeps a foreign line", () => {
    fs.mkdirSync(hostFile(".ssh"), { recursive: true });
    fs.writeFileSync(hostFile(".ssh/known_hosts"), "foreign.example ssh-ed25519 AAAA\n");
    ready({ origin: "git@github.com:o/r.git" });
    expect(mode(".ssh")).toBe(0o700);
    expect(mode(".ssh/known_hosts")).toBe(0o600);
    const first = fs.readFileSync(hostFile(".ssh/known_hosts"), "utf-8");
    expect(first.split("\n").filter(Boolean)).toEqual(["foreign.example ssh-ed25519 AAAA", ...GITHUB_KNOWN_HOSTS]);
    ready({ origin: "git@github.com:o/r.git" });
    expect(fs.readFileSync(hostFile(".ssh/known_hosts"), "utf-8")).toBe(first);
  });

  test("ssh config block: inserted once, replaced in place on rerun, user stanzas untouched, 0600, IdentitiesOnly no until write is proven", () => {
    fs.mkdirSync(hostFile(".ssh"), { recursive: true });
    fs.writeFileSync(hostFile(".ssh/config"), "Host mine\n  User me\n");
    const state = ready({ origin: "git@github.com:o/r.git" });
    expect(state.access.write).toBe(false); // github.com is unreachable from a fake key
    const cfg = fs.readFileSync(hostFile(".ssh/config"), "utf-8");
    expect(cfg.startsWith("Host mine\n  User me\n")).toBe(true);
    expect(cfg).toContain(`${SSH_CONFIG_BLOCK_START}\nHost github.com\n  IdentityFile ~/.codecast/git/id_ed25519\n  IdentitiesOnly no\n  BatchMode yes\n  AddKeysToAgent no\n${SSH_CONFIG_BLOCK_END}`);
    expect(cfg.split(SSH_CONFIG_BLOCK_START)).toHaveLength(2);
    expect(mode(".ssh/config")).toBe(0o600);
    // A rerun replaces the block where it sits, and a stanza after it survives.
    fs.appendFileSync(hostFile(".ssh/config"), "\nHost later\n  User you\n");
    ready({ origin: "git@github.com:o/r.git" });
    const again = fs.readFileSync(hostFile(".ssh/config"), "utf-8");
    expect(again.split(SSH_CONFIG_BLOCK_START)).toHaveLength(2);
    expect(again.indexOf("Host mine")).toBeLessThan(again.indexOf(SSH_CONFIG_BLOCK_START));
    expect(again.indexOf(SSH_CONFIG_BLOCK_END)).toBeLessThan(again.indexOf("Host later"));
    expect(again).toContain("Host later\n  User you\n");
    expect(sshConfigBlock("github.com", true)).toContain("IdentitiesOnly yes");
  });

  test("IdentitiesOnly flips to yes after a granted write probe (local bare origin)", () => {
    const origin = makeBareOrigin();
    const state = ready({ origin });
    expect(state.access).toEqual({ origin, read: true, write: true });
    expect(state.knownHosts).toBe("pinned"); // no host in a path origin: github.com is pinned by default
    const cfg = fs.readFileSync(hostFile(".ssh/config"), "utf-8");
    expect(cfg).toContain("IdentitiesOnly yes");
    expect(cfg).not.toContain("IdentitiesOnly no");
  });

  test("the device key: minted once at gitIdentity's path with the device comment, 0600, same pubkey on rerun", () => {
    const state = ready({ origin: makeBareOrigin(), keyComment: "i-abc 123" });
    expect(state.pubkey).toBe(fs.readFileSync(hostFile(".codecast/git/id_ed25519.pub"), "utf-8").trim());
    expect(state.pubkey!.endsWith(` ${deviceKeyComment("i-abc 123")}`)).toBe(true);
    expect(mode(".codecast/git/id_ed25519")).toBe(0o600);
    expect(mode(".codecast/git")).toBe(0o700);
    expect(ready({ origin: makeBareOrigin() }).pubkey).toBe(state.pubkey);
  });

  test("a prompting ssh-keygen (concurrent mint by the host daemon) cannot eat the script: every later step still runs", () => {
    // The fake prompts on stdin the way `ssh-keygen -f <existing>` does, and
    // writes nothing. stdin is /dev/null, so the prompt sees EOF at once.
    fakeBin("ssh-keygen", 'printf "Overwrite (y/n)? "; read -r answer; echo "answer=[$answer]" >&2; exit 1');
    fs.writeFileSync(laptopGitconfig, "[user]\n\tname = Ada\n\temail = ada@example.com\n");
    const state = ready({ origin: makeBareOrigin() });
    expect(state.pubkey).toBeNull();
    expect(state.identity).toBe("mirrored");
    expect(state.access.error).toContain("no device key");
    expect(git(hostHome, "config", "--file", hostFile(".gitconfig"), "user.email")).toBe("ada@example.com");
  });

  test("identity: mirrored from the laptop (repo-local over global), push.autoSetupRemote set, repo-local placeholder unset", () => {
    fs.writeFileSync(laptopGitconfig, "[user]\n\tname = Global\n\temail = global@example.com\n");
    const laptop = makeRepo("laptop", { origin: "git@github.com:o/r.git" });
    git(laptop, "config", "user.name", "Local");
    git(laptop, "config", "user.email", "local@example.com");
    const hostRepo = makeRepo("host-repo");
    git(hostRepo, "config", "user.name", "codecast");
    git(hostRepo, "config", "user.email", "codecast@local");
    const state = ready({ localGitRoot: laptop, repoPath: hostRepo });
    expect(state.identity).toBe("mirrored");
    expect(state.access.origin).toBe("git@github.com:o/r.git");
    const gc = hostFile(".gitconfig");
    expect(git(hostHome, "config", "--file", gc, "user.name")).toBe("Local");
    expect(git(hostHome, "config", "--file", gc, "user.email")).toBe("local@example.com");
    expect(git(hostHome, "config", "--file", gc, "push.autoSetupRemote")).toBe("true");
    expect(mode(".gitconfig")).toBe(0o600);
    expect(spawnSync("git", ["-C", hostRepo, "config", "--local", "--get", "user.email"], { env: process.env }).status).not.toBe(0);
    expect(spawnSync("git", ["-C", hostRepo, "config", "--local", "--get", "user.name"], { env: process.env }).status).not.toBe(0);
    // The laptop's own global config was never written by the host script.
    expect(fs.readFileSync(laptopGitconfig, "utf-8")).toBe("[user]\n\tname = Global\n\temail = global@example.com\n");
  });

  test("identity: --git-identity wins over both, and a real repo-local identity on the host is left alone", () => {
    fs.writeFileSync(laptopGitconfig, "[user]\n\tname = Global\n\temail = global@example.com\n");
    const laptop = makeRepo("laptop", { origin: makeBareOrigin() });
    const hostRepo = makeRepo("host-repo");
    git(hostRepo, "config", "user.name", "Real Person");
    git(hostRepo, "config", "user.email", "real@example.com");
    const state = ready({ localGitRoot: laptop, repoPath: hostRepo, gitIdentity: "Ada <ada@example.com>" });
    expect(state.identity).toBe("mirrored");
    expect(git(hostHome, "config", "--file", hostFile(".gitconfig"), "user.email")).toBe("ada@example.com");
    expect(git(hostRepo, "config", "--local", "--get", "user.email")).toBe("real@example.com");
  });

  test("identity: no laptop identity and no host identity → the GLOBAL placeholder, and the repo-local one is NOT unset", () => {
    const hostRepo = makeRepo("host-repo");
    git(hostRepo, "config", "user.name", "codecast");
    git(hostRepo, "config", "user.email", "codecast@local");
    const state = ready({ origin: makeBareOrigin(), repoPath: hostRepo });
    expect(state.identity).toBe("placeholder");
    expect(git(hostHome, "config", "--file", hostFile(".gitconfig"), "user.name")).toBe("codecast");
    expect(git(hostHome, "config", "--file", hostFile(".gitconfig"), "user.email")).toBe("codecast@local");
    expect(git(hostRepo, "config", "--local", "--get", "user.email")).toBe("codecast@local");
    // A host that already has a global identity keeps it: nothing to mirror, nothing to invent.
    fs.writeFileSync(hostFile(".gitconfig"), "[user]\n\tname = Host Owner\n\temail = owner@example.com\n");
    expect(ready({ origin: makeBareOrigin() }).identity).toBe("kept");
    expect(git(hostHome, "config", "--file", hostFile(".gitconfig"), "user.email")).toBe("owner@example.com");
  });

  test("the ~/.gitconfig write takes the shared mirror lock: a dead holder or a stale unreadable lock is broken, and the lock is released", () => {
    fs.writeFileSync(laptopGitconfig, "[user]\n\tname = G\n\temail = g@example.com\n");
    const lock = hostFile(".codecast/mirror.lock");
    fs.mkdirSync(hostFile(".codecast"), { recursive: true });
    // A lock whose holder pid is dead (999999 is above the default pid_max on Linux and never live here).
    fs.writeFileSync(lock, JSON.stringify({ pid: 999999, token: "t", at: "x" }));
    expect(ready({ origin: makeBareOrigin() }).identity).toBe("mirrored");
    expect(fs.existsSync(lock)).toBe(false);
    expect(git(hostHome, "config", "--file", hostFile(".gitconfig"), "user.email")).toBe("g@example.com");
    // An unreadable lock older than 5s is stale too.
    fs.writeFileSync(lock, "garbage");
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lock, old, old);
    expect(ready({ origin: makeBareOrigin() }).identity).toBe("mirrored");
    expect(fs.existsSync(lock)).toBe(false);
    // A lock written by the script itself carries pid + token like the TS one.
    expect(hostGitScript({ knownHostLines: [], sshHost: "github.com", identity: undefined, keyComment: "c", identitiesOnly: false }))
      .toContain(`printf '{"pid":%s,"token":"%s","at":"%s"}'`);
  });

  test("identity: a missing repoPath means no repo-local step and no error", () => {
    fs.writeFileSync(laptopGitconfig, "[user]\n\tname = G\n\temail = g@example.com\n");
    const state = ready({ origin: makeBareOrigin(), repoPath: path.join(dir, "not-there") });
    expect(state.identity).toBe("mirrored");
    expect(state.access.write).toBe(true);
  });

  test("access: a bare local origin is read+write (write via --upload-pack=git-receive-pack); a missing path is unreachable", () => {
    const origin = makeBareOrigin();
    expect(ready({ origin }).access).toEqual({ origin, read: true, write: true });
    const missing = path.join(dir, "nowhere.git");
    const state = ready({ origin: missing });
    expect(state.access.read).toBe(false);
    expect(state.access.write).toBe(false);
    expect(state.access.readonly).toBeUndefined();
    expect(state.access.error).toBeTruthy();
    // No origin at all: nothing to probe, said so.
    expect(ready({}).access).toEqual({ origin: "", read: false, write: false, error: "no repository origin to probe" });
  });

  test("access: a fake git refusing with Permission denied is denied; read-only on the write probe only is read+readonly", () => {
    const origin = makeBareOrigin();
    fakeBin("git", `case "$*" in *ls-remote*) echo "git@github.com: Permission denied (publickey)." >&2; exit 128;; esac
exec ${realGit} "$@"`);
    const denied = ready({ origin });
    expect(denied.access).toEqual({ origin, read: false, write: false, error: "git@github.com: Permission denied (publickey)." });
    fakeBin("git", `case "$*" in *git-receive-pack*) echo "ERROR: The key you are authenticating with has been marked as read only." >&2; echo "fatal: Could not read from remote repository." >&2; exit 128;; esac
exec ${realGit} "$@"`);
    const ro = ready({ origin });
    expect(ro.access).toEqual({ origin, read: true, write: false, readonly: true, error: "ERROR: The key you are authenticating with has been marked as read only." });
    expect(fs.readFileSync(hostFile(".ssh/config"), "utf-8")).toContain("IdentitiesOnly no");
    expect(classifyProbe(0, "")).toEqual({ ok: true });
    expect(classifyProbe(128, "ssh: Could not resolve hostname github.com")).toEqual({ ok: false, error: "ssh: Could not resolve hostname github.com" });
  });

  test("the reported error is the line that says why, not git's trailing 'and the repository exists.' hint", () => {
    // What git actually prints for a denied ssh probe (verified with a real
    // git on a missing local path: the same four-line trailer).
    const denied = "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    expect(classifyProbe(128, denied)).toEqual({ ok: false, error: "git@github.com: Permission denied (publickey)." });
    const readonly = "ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    expect(classifyProbe(128, readonly)).toEqual({ ok: false, readonly: true, error: "ERROR: The key you are authenticating with has been marked as read only." });
    const hostKey = "Host key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    expect(classifyProbe(128, hostKey)).toEqual({ ok: false, error: "Host key verification failed." });
    expect(probeErrorLine("fatal: '/nope.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n"))
      .toBe("fatal: '/nope.git' does not appear to be a git repository");
    // Only the trailer: its last line is still better than nothing.
    expect(probeErrorLine("fatal: Could not read from remote repository.\n\nand the repository exists.\n")).toBe("and the repository exists.");
    expect(probeErrorLine("")).toBeUndefined();
    // A real git against a missing local origin reports the fatal line.
    const gone = ready({ origin: path.join(dir, "nope.git") });
    expect(gone.access.read).toBe(false);
    expect(gone.access.error).toMatch(/does not appear to be a git repository/);
  });

  test("the probes force the device key and never touch the laptop's own GIT_SSH_COMMAND", () => {
    const script = hostGitScript({ knownHostLines: [], sshHost: "github.com", identity: undefined, keyComment: "c", identitiesOnly: false, origin: "git@github.com:o/r.git" });
    // The key path is quoted for the shell git re-splits the value with (a HOME with a space).
    expect(script).toContain(`GIT_SSH_COMMAND="ssh -i '$KEY' -o IdentitiesOnly=yes -o BatchMode=yes"`);
    // HEAD, not a branch name: the read probe measures upload-pack access, not whether `main` exists.
    expect(script).toContain("git ls-remote --exit-code -- \"$ORIGIN\" HEAD");
    expect(script).not.toContain('"$ORIGIN" main');
    expect(script).toContain("git ls-remote --upload-pack=git-receive-pack -- \"$ORIGIN\"");
    expect(script).toContain("GIT_TERMINAL_PROMPT=0");
  });

  test("a run that probes nothing (no origin: a wake) keeps a granted IdentitiesOnly yes; a refused probe turns it off", () => {
    const origin = makeBareOrigin();
    expect(ready({ origin }).access.write).toBe(true);
    expect(fs.readFileSync(hostFile(".ssh/config"), "utf-8")).toContain("IdentitiesOnly yes");
    // `cast hosts wake` / `cast cloud wake`: readyHostHome without a repo, the registry says write=true.
    const wake = ready({ identitiesOnly: true });
    expect(wake.access).toEqual({ origin: "", read: false, write: false, error: "no repository origin to probe" });
    const cfg = fs.readFileSync(hostFile(".ssh/config"), "utf-8");
    expect(cfg).toContain("IdentitiesOnly yes");
    expect(cfg).not.toContain("IdentitiesOnly no");
    // The registry's word is what carries across: a wake that does not know of a grant writes no.
    ready({});
    expect(fs.readFileSync(hostFile(".ssh/config"), "utf-8")).toContain("IdentitiesOnly no");
    // A probe that ran and was refused overrides a granted registry entry.
    fakeBin("git", `case "$*" in *ls-remote*) echo "git@github.com: Permission denied (publickey)." >&2; exit 128;; esac
exec ${realGit} "$@"`);
    ready({ origin, identitiesOnly: true });
    expect(fs.readFileSync(hostFile(".ssh/config"), "utf-8")).toContain("IdentitiesOnly no");
  });

  test("the read probe uses HEAD: a bare origin whose only branch is master reads and writes", () => {
    const src = path.join(dir, "master-src");
    fs.mkdirSync(src);
    git(src, "init", "-q", "-b", "master");
    fs.writeFileSync(path.join(src, "a.txt"), "a\n");
    git(src, "add", "a.txt");
    git(src, "-c", "user.name=T", "-c", "user.email=t@test.local", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
    const bare = path.join(dir, "master-origin.git");
    execFileSync("git", ["clone", "-q", "--bare", src, bare], { stdio: "pipe", env: process.env });
    expect(ready({ origin: bare }).access).toEqual({ origin: bare, read: true, write: true });
  });

  test("an https origin is never probed as https: GitHub's is probed as its ssh form, any other is reported and leaves IdentitiesOnly alone", () => {
    expect(hostProbeOrigin("https://github.com/o/r.git")).toEqual({ origin: "git@github.com:o/r.git" });
    expect(hostProbeOrigin("https://github.com/o/r")).toEqual({ origin: "git@github.com:o/r.git" });
    expect(hostProbeOrigin("https://ghe.github.com/o/r.git")).toEqual({ origin: "git@ghe.github.com:o/r.git" });
    expect(hostProbeOrigin("git@github.com:o/r.git")).toEqual({ origin: "git@github.com:o/r.git" });
    expect(hostProbeOrigin("ssh://git@gitlab.example:2222/o/r.git")).toEqual({ origin: "ssh://git@gitlab.example:2222/o/r.git" });
    expect(hostProbeOrigin("/srv/git/r.git")).toEqual({ origin: "/srv/git/r.git" });
    expect(hostProbeOrigin(undefined)).toEqual({});
    expect(hostProbeOrigin("https://gitlab.example/o/r.git").origin).toBeUndefined();
    expect(hostProbeOrigin("https://gitlab.example/o/r.git").reason).toContain("only works over ssh");
    expect(hostProbeOrigin("git://github.com/o/r.git")).toEqual({ origin: "git@github.com:o/r.git" });
    // The script sees the ssh form: a fake git records what it was asked to probe.
    // The App path answers nothing here (a helper that refuses), so the https
    // spelling reaches no probe either.
    fakeBin("cast", "exit 1");
    const asked = path.join(dir, "asked");
    fakeBin("git", `case "$*" in *ls-remote*) echo "$*" >> ${JSON.stringify(asked)}; echo "git@github.com: Permission denied (publickey)." >&2; exit 128;; esac
exec ${realGit} "$@"`);
    const lines: string[] = [];
    const gh = ready({ origin: "https://github.com/o/r.git", onProgress: (m) => lines.push(m) });
    expect(gh.access).toEqual({ origin: "git@github.com:o/r.git", read: false, write: false, error: "git@github.com: Permission denied (publickey)." });
    expect(fs.readFileSync(asked, "utf-8")).toContain("git@github.com:o/r.git");
    expect(fs.readFileSync(asked, "utf-8")).not.toContain("https://");
    expect(lines.some((l) => l.includes("the ssh form of https://github.com/o/r.git"))).toBe(true);
    // A non-GitHub https origin: nothing probed, the answer says why, and a granted block survives.
    fs.rmSync(asked, { force: true });
    const other = ready({ origin: "https://gitlab.example/o/r.git", identitiesOnly: true });
    expect(other.access).toEqual({ origin: "https://gitlab.example/o/r.git", read: false, write: false, error: "origin https://gitlab.example/o/r.git is not ssh — the host's key only works over ssh" });
    expect(fs.existsSync(asked)).toBe(false);
    expect(fs.readFileSync(hostFile(".ssh/config"), "utf-8")).toContain("IdentitiesOnly yes");
  });

  test("a lock that exists but cannot be read (a directory) is waited for up to the deadline, not spun on, and then the identity is still written", () => {
    fs.writeFileSync(laptopGitconfig, "[user]\n\tname = G\n\temail = g@example.com\n");
    fs.mkdirSync(hostFile(".codecast/mirror.lock"), { recursive: true });
    const t0 = Date.now();
    // Whole-second deadline arithmetic: 2s means at least one full second of 0.25s polls.
    const state = ready({ origin: makeBareOrigin(), lockWaitSeconds: 2 });
    const took = Date.now() - t0;
    expect(state.identity).toBe("mirrored");
    expect(took).toBeGreaterThanOrEqual(1000);
    expect(took).toBeLessThan(15_000);
    expect(fs.statSync(hostFile(".codecast/mirror.lock")).isDirectory()).toBe(true);
    expect(git(hostHome, "config", "--file", hostFile(".gitconfig"), "user.email")).toBe("g@example.com");
    expect(hostGitScript({ knownHostLines: [], sshHost: "github.com", identity: undefined, keyComment: "c", identitiesOnly: false })).toContain("+ 60 ))");
  });

  test("the github.com credential helper is written once, keeps another helper, and turns on useHttpPath", () => {
    fakeBin("cast", "exit 1");
    const gc = hostFile(".gitconfig");
    const helpers = () => git(hostHome, "config", "--file", gc, "--get-all", "credential.https://github.com.helper").split("\n");
    ready({ origin: makeBareOrigin() });
    expect(helpers()).toEqual([`!${bin}/cast git-credential`]);
    expect(git(hostHome, "config", "--file", gc, "credential.https://github.com.useHttpPath")).toBe("true");
    // No prompt can block an agent's pane when the helper has nothing.
    expect(git(hostHome, "config", "--file", gc, "core.askPass")).toBe("/bin/true");
    // A helper the human configured is not ours to remove, and a second run
    // leaves exactly one of ours.
    // The helpers git itself ships carry "git-credential" in their own names,
    // so the removal pattern must match only the shape this script writes.
    git(hostHome, "config", "--file", gc, "--add", "credential.https://github.com.helper", "store");
    git(hostHome, "config", "--file", gc, "--add", "credential.https://github.com.helper", "/usr/lib/git-core/git-credential-libsecret");
    git(hostHome, "config", "--file", gc, "--add", "credential.https://github.com.helper", "manager");
    git(hostHome, "config", "--file", gc, "core.askPass", "/usr/bin/mine");
    ready({ origin: makeBareOrigin() });
    expect(git(hostHome, "config", "--file", gc, "core.askPass")).toBe("/usr/bin/mine");
    expect(helpers().filter((h) => h.endsWith("cast git-credential"))).toHaveLength(1);
    expect(helpers()).toContain("store");
    expect(helpers()).toContain("/usr/lib/git-core/git-credential-libsecret");
    expect(helpers()).toContain("manager");
  });

  test("the gh wrapper is installed at ~/.local/bin/gh, a real gh there is moved behind it, and a rerun keeps both", () => {
    fakeBin("cast", "exit 1");
    fs.mkdirSync(hostFile(".local/bin"), { recursive: true });
    fs.writeFileSync(hostFile(GH_WRAPPER_REL), "#!/bin/sh\necho real gh\n", { mode: 0o755 });
    ready();
    expect(fs.readFileSync(hostFile(GH_WRAPPER_REL), "utf-8")).toBe(ghWrapperScript());
    expect(fs.readFileSync(hostFile(REAL_GH_REL), "utf-8")).toContain("real gh");
    ready();
    expect(fs.readFileSync(hostFile(REAL_GH_REL), "utf-8")).toContain("real gh");
    expect(fs.readFileSync(hostFile(GH_WRAPPER_REL), "utf-8")).toBe(ghWrapperScript());
  });

  test("the App token path: a helper that answers plus a fetch that works is push access with no key", () => {
    // The helper prints a credential exactly as git reads it; the token must
    // not reach the script's output or the state.
    fakeBin("cast", 'printf "username=x-access-token\npassword=ghs_secret\n"');
    fakeBin("git", `case "$*" in
  *ls-remote*https://*) exit 0;;
  *ls-remote*) echo "git@github.com: Permission denied (publickey)." >&2; exit 128;;
esac
exec ${realGit} "$@"`);
    const lines: string[] = [];
    const state = ready({ origin: "https://github.com/o/r.git", onProgress: (m) => lines.push(m) });
    expect(state.app).toEqual({ origin: "https://github.com/o/r.git", read: true, write: true });
    expect(state.access.write).toBe(false);
    expect(state.helper).toBe(`!${bin}/cast git-credential`);
    expect(JSON.stringify(state)).not.toContain("ghs_secret");
    expect(lines.some((l) => l.includes("through the codecast GitHub App"))).toBe(true);
    // An ssh origin is the same repository, so the App path is probed for it too.
    const viaSsh = ready({ origin: "git@github.com:o/r.git" });
    expect(viaSsh.app).toEqual({ origin: "https://github.com/o/r.git", read: true, write: true });
  });

  test("a helper whose first line is not a credential leaves the App path dark", () => {
    // git reads the first line as a key it knows and throws the whole answer
    // away when it is not, so a probe that accepted this would report push
    // access on a host where every fetch fails with "could not read Username".
    // The notice is what the full CLI prints when a release is pending.
    fakeBin("cast", 'printf "\\n  Update available: v1 -> v2\\n\\nusername=x-access-token\\npassword=ghs_secret\\n"');
    fakeBin("git", `case "$*" in *ls-remote*) exit 0;; esac
exec ${realGit} "$@"`);
    const state = ready({ origin: "https://github.com/o/r.git" });
    expect(state.app?.write).toBe(false);
    expect(state.app?.error).toContain("no credential");
  });

  test("a helper with nothing to say leaves the App path dark, with the reason and no fetch", () => {
    fakeBin("cast", "exit 1");
    const asked = path.join(dir, "asked-app");
    fakeBin("git", `case "$*" in *ls-remote*) echo "$*" >> ${JSON.stringify(asked)}; exit 0;; esac
exec ${realGit} "$@"`);
    const state = ready({ origin: "https://github.com/o/r.git" });
    expect(state.app).toEqual({
      origin: "https://github.com/o/r.git",
      read: false,
      write: false,
      error: "cast git-credential returned no credential for o/r.git",
    });
    expect(fs.readFileSync(asked, "utf-8")).not.toContain("https://");
  });

  test("a local origin has no App path at all, and access paths rank app over key over bridge", () => {
    fakeBin("cast", "exit 1");
    expect(ready({ origin: makeBareOrigin() }).app).toBeUndefined();
    const key = { read: true, write: true };
    expect(hostAccessPath(key, { write: true })).toEqual({ path: "app-token" });
    expect(hostAccessPath(key, { write: false, error: "not installed" })).toEqual({ path: "device-key" });
    expect(hostAccessPath({ read: true, write: false, error: "push refused" }, undefined, true)).toEqual({ path: "agent-bridge" });
    expect(hostAccessPath({ read: true, write: false, error: "push refused" }, undefined, false)).toEqual({ path: "none", reason: "push refused" });
    expect(hostAccessPath(undefined, undefined, false)).toEqual({ path: "none", reason: "never probed" });
  });

  test("parseHostGitOutput rejects a missing or invalid result naming the host, never echoing stdout", () => {
    expect(() => parseHostGitOutput("SECRET_VALUE", "ubuntu@h", { knownHosts: "none" })).toThrow("host git setup on ubuntu@h printed no result");
    expect(() => parseHostGitOutput('{"SECRET_VALUE"', "ubuntu@h", { knownHosts: "none" })).toThrow("host git setup on ubuntu@h printed an invalid result");
    expect(() => parseHostGitOutput('{"v":9}', "ubuntu@h", { knownHosts: "none" })).toThrow("unknown result version");
    const ok = parseHostGitOutput(`banner\n{"v":1,"pubkey":"${Buffer.from("ssh-ed25519 AAAA c").toString("base64")}","identity":"kept","read_rc":0,"read_err":"","write_rc":0,"write_err":""}\n`, "h", { origin: "o", knownHosts: "pinned" });
    expect(ok.pubkey).toBe("ssh-ed25519 AAAA c");
    expect(ok.access).toEqual({ origin: "o", read: true, write: true });
    // An older host answers without the App fields: the path is reported dark, never granted.
    const old = parseHostGitOutput(`{"v":1,"pubkey":"","identity":"kept","read_rc":0,"read_err":"","write_rc":0,"write_err":""}\n`, "h", { origin: "o", appOrigin: "https://github.com/o/r.git", knownHosts: "pinned" });
    expect(old.app).toEqual({ origin: "https://github.com/o/r.git", read: false, write: false, error: "the App token path did not answer" });
  });

  test("a transport failure throws with the last stderr line and no stdout", () => {
    expect(() => ensureHostGitReady(host, { run: () => ({ status: 255, stdout: "SECRET_VALUE", stderr: "ssh: connect to host: Connection refused\n" }) }))
      .toThrow("host git setup on ubuntu@cloud-test.invalid failed (exit 255): ssh: connect to host: Connection refused");
    expect(() => ensureHostGitReady(host, { run: () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn"), { code: "ENOENT" }) }) }))
      .toThrow("failed (ENOENT)");
  });

  test("over ssh: the remote command is bash -c \"$(cat)\" with the script on stdin, through sshBase's options", () => {
    fs.writeFileSync(path.join(bin, "ssh"), `#!${process.execPath}
const fs = require("node:fs"), { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.HOSTGIT_TEST_ARGS, JSON.stringify(args));
const r = spawnSync("/bin/sh", ["-c", args.at(-1)], { input: fs.readFileSync(0), stdio: ["pipe", "inherit", "inherit"] });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
    process.env.HOSTGIT_TEST_ARGS = path.join(dir, "ssh-args.json");
    const origin = makeBareOrigin();
    const state = ensureHostGitReady(host, { origin });
    expect(state.access.write).toBe(true);
    const args: string[] = JSON.parse(fs.readFileSync(process.env.HOSTGIT_TEST_ARGS, "utf-8"));
    expect(args.at(-1)).toBe(HOST_GIT_REMOTE_COMMAND);
    expect(args.at(-2)).toBe("ubuntu@cloud-test.invalid");
    expect(args).toContain("ControlMaster=auto");
    expect(fs.existsSync(hostFile(".codecast/git/id_ed25519.pub"))).toBe(true);
    expect(realSshKeygen).toBeTruthy();
  });
});
