import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cloudCopyFiles, copyCloudFiles, CloudSeedNameError, CloudSeedUnavailable, finishSeededWorktree, listDanglingSeedRefs, planLaptopSeed, refreshRemoteCheckout, stageCloudInputs, type CloudSeed } from "./transfer";
import { hostProbeOrigin } from "./gitOrigin";
import { acquireRemoteRootCheckout, acquireRemoteWorkspace, forgetHostCapabilities, hostSupportsStartPoint, prepareCloudHost, ROOT_WORKSPACE_NAME, seedForHost, type PreparedHost } from "./prepare";
import { HOST_GIT_REMOTE_COMMAND } from "./hostGit";
import { readHosts, writeHosts } from "../browser/cloudHost";
import { shq, type RemoteHost } from "../remote/session-move";
import { healWorkspace, releaseWorkspace } from "../workspace/lifecycle";
import { readState } from "../workspace/contract";
import { AGENT_CONTEXT_ENV_VARS, collectTrustTargets, recordTrust } from "../workspace/trust";

let dir: string, origin: string, laptop: string, publisher: string, remote: string, host: RemoteHost, home: string;
let savedEnv: NodeJS.ProcessEnv;
let realHomeBefore: Record<string, string | null>;

// The developer's real HOME must be untouched by anything the fake ssh runs
// (it executes remote commands locally): every test pins HOME, XDG_CONFIG_HOME,
// GIT_CONFIG_GLOBAL and CODEX_HOME to a temp dir, and these files are compared
// byte for byte afterwards.
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

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
}

function write(root: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function commit(repo: string, rel: string, content: string): string {
  write(repo, rel, content);
  git(repo, "add", rel);
  git(repo, "-c", "user.name=Cloud Test", "-c", "user.email=cloud@test.local", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  return git(repo, "rev-parse", "HEAD");
}

function advanceOrigin(): string {
  const head = commit(publisher, "app.txt", "fresh main\n");
  git(publisher, "push", "-q", "origin", "main");
  return head;
}

function laptopState() {
  return {
    refs: git(laptop, "show-ref"),
    head: fs.readFileSync(path.join(laptop, ".git/HEAD")),
    index: fs.readFileSync(path.join(laptop, ".git/index")),
    files: git(laptop, "diff", "HEAD"),
    fetchHead: fs.existsSync(path.join(laptop, ".git/FETCH_HEAD")),
  };
}

beforeEach(() => {
  savedEnv = { ...process.env };
  realHomeBefore = snapshotRealHome(savedEnv.HOME || os.homedir());
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cloud-transfer-test-")));
  origin = path.join(dir, "origin.git");
  publisher = path.join(dir, "publisher");
  laptop = path.join(dir, "laptop repo");
  remote = path.join(dir, "remote repo");
  home = path.join(dir, "home");
  fs.mkdirSync(laptop);
  fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codecast", "update-state.json"), JSON.stringify({ lastCheck: new Date().toISOString() }));
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
  process.env.CODEX_HOME = path.join(home, ".codex");
  host = { address: "cloud-test.invalid", user: "ubuntu", keyPath: "/test key's path", remoteBaseDir: dir };
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "ssh"), `#!${process.execPath}
const fs = require("node:fs"), { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("-G")) process.exit(0);
let command = args.at(-1);
fs.appendFileSync(process.env.CLOUD_TEST_LOG, JSON.stringify(command) + "\\n");
if (process.env.CLOUD_TEST_UNCONFIRMED && command.includes("bun -e")) process.exit(0);
// The host's daemon answering "cast remote hosts" (learnHostDeviceId).
if (command.startsWith("cast remote hosts")) { process.stdout.write("test host (0123456789abcdef)\\n"); process.exit(0); }
// The host git setup (cloud/hostGit.ts): a transport failure when asked for, else the
// script runs for real against the redirected HOME below.
if (command === 'bash -c "$(cat)"' && process.env.CLOUD_TEST_FAIL_HOSTGIT) { fs.readFileSync(0); process.stderr.write("ssh: connect to host: Connection refused\\n"); process.exit(255); }
// The agent-auth python receiver (remote/agentAuthReceiver.py.ts): drain stdin, answer as applied.
if (command.includes("python3 -c")) { fs.readFileSync(0); process.stdout.write("applied files=0 kept= deleted=0 env= trust=0\\n"); process.exit(0); }
// The host tools script (cloud/hostTools.ts) downloads tarballs: never run it here; answer as all present.
if (command.includes("cast-host-tools")) { fs.readFileSync(0); process.stdout.write('{"ok":[],"installed":[],"missing":[],"unsupported":[],"install":1}\\n'); process.exit(0); }
// The host's own cast: a "cast cloud mirror-apply" command runs this checkout's CLI (like cast ws acquire).
if (command.includes("cast cloud mirror-apply")) {
  if (process.env.CLOUD_TEST_OLD_HOST) { fs.readFileSync(0); process.stderr.write("error: unknown command 'mirror-apply'\\n"); process.exit(1); }
  if (process.env.CLOUD_TEST_NO_CAST) { fs.readFileSync(0); process.stderr.write("bash: line 1: cast: command not found\\n"); process.exit(127); }
  command = command.replace("cast cloud mirror-apply", process.env.CLOUD_TEST_CAST_COMMAND + " cloud mirror-apply");
}
if (process.env.CLOUD_TEST_FAIL_ORIGIN && (command.includes("git fetch -q") || (command.includes("git clone -q") && !command.includes("main.bundle")))) {
  if (process.env.CLOUD_TEST_OCCUPY) {
    fs.mkdirSync(process.env.CLOUD_TEST_OCCUPY, { recursive: true });
    fs.writeFileSync(process.env.CLOUD_TEST_OCCUPY + "/user-work", "preserve me");
  }
  process.exit(128);
}
if (process.env.CLOUD_TEST_FAIL_TRANSFER && (command.includes("bun -e") || command.includes("git-receive-pack") || command.includes("cat >"))) {
  process.stdout.write("SECRET_VALUE"); process.stderr.write("SECRET_VALUE"); process.exit(9);
}
// The seed push alone fails (the reservation before it succeeds).
if (process.env.CLOUD_TEST_FAIL_SEED_PUSH && command.includes("git-receive-pack")) {
  process.stdout.write("SECRET_VALUE"); process.stderr.write("SECRET_VALUE"); process.exit(9);
}
// The capability probe never reaches the host (a transport failure, not an answer).
if (process.env.CLOUD_TEST_FAIL_HELP && command.includes("cast ws acquire --help")) {
  process.stderr.write("ssh: connect to host cloud-test.invalid port 22: Connection refused\\n"); process.exit(255);
}
// A host whose cast predates seeded worktrees: its acquire --help has no --start-point.
if (process.env.CLOUD_TEST_NO_START_POINT && command.includes("cast ws acquire --help")) {
  process.stdout.write("Usage: cast ws acquire [options] <name>\\n  --branch <branch>  Override branch name\\n"); process.exit(0);
}
if (command.includes("cast ws acquire")) {
  if (process.env.CLOUD_TEST_WS_COMMAND) {
    command = command.replace("cast ws acquire", process.env.CLOUD_TEST_WS_COMMAND + " ws acquire");
  } else {
    process.stdout.write(process.env.CLOUD_TEST_ACQUIRE || "{}");
    process.exit(Number(process.env.CLOUD_TEST_ACQUIRE_STATUS || "0"));
  }
}
// The host's cast ws root (shared checkout): an old host does not know it.
if (command.includes("cast ws root")) {
  if (process.env.CLOUD_TEST_OLD_HOST) { process.stderr.write("error: unknown command 'root'\\n"); process.exit(1); }
  if (process.env.CLOUD_TEST_WS_COMMAND) {
    command = command.replace("cast ws root", process.env.CLOUD_TEST_WS_COMMAND + " ws root");
  } else {
    process.stdout.write(process.env.CLOUD_TEST_ROOT || "{}");
    if (process.env.CLOUD_TEST_ROOT_STDERR) process.stderr.write(process.env.CLOUD_TEST_ROOT_STDERR);
    process.exit(Number(process.env.CLOUD_TEST_ROOT_STATUS || "0"));
  }
}
let input;
if (command.includes('cat > "$stage/main.bundle"')) {
  input = fs.readFileSync(0);
  fs.writeFileSync(process.env.CLOUD_TEST_BUNDLE, input, { mode: 0o600 });
}
if (command === 'bash -c "$(cat)"') input = fs.readFileSync(0);
const r = spawnSync("/bin/sh", ["-c", command], { stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", input });
process.exit(r.status ?? 1);
`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CLOUD_TEST_LOG = path.join(dir, "ssh.log");
  process.env.CLOUD_TEST_BUNDLE = path.join(dir, "received.bundle");
  process.env.CLOUD_TEST_CAST_COMMAND = `${shq(process.execPath)} ${shq(path.resolve(import.meta.dir, "../main.ts"))}`;
  process.env.CODECAST_DIR = path.join(dir, "host-state");
  write(process.env.CODECAST_DIR, "config.json", JSON.stringify({ cloud_mirror_enabled: false }));
  // The host's `cast ws acquire` runs the trust gate (workspace/trust.ts),
  // which reads these to tell an agent from a person. Left alone, a run from
  // an agent shell would refuse every acquire; afterEach restores them.
  for (const v of AGENT_CONTEXT_ENV_VARS) delete process.env[v];
});

afterEach(() => {
  const realHome = savedEnv.HOME || os.homedir();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
  expect(snapshotRealHome(realHome)).toEqual(realHomeBefore);
});

function sshLog(): string[] {
  return fs.existsSync(process.env.CLOUD_TEST_LOG!) ? fs.readFileSync(process.env.CLOUD_TEST_LOG!, "utf-8").split("\n").filter(Boolean) : [];
}

describe("cloud origin/main checkout", () => {
  beforeEach(() => {
    fs.mkdirSync(publisher);
    git(dir, "init", "-q", "--bare", "--initial-branch=main", origin);
    git(publisher, "init", "-q", "--initial-branch=main");
    commit(publisher, ".gitignore", ".env\nsecrets/\n.codecast/worktrees/\n");
    commit(publisher, "app.txt", "initial main\n");
    git(publisher, "remote", "add", "origin", origin);
    git(publisher, "push", "-q", "origin", "main");
    git(dir, "clone", "-q", origin, laptop);
  }, 30_000);

  test("two cloud acquisitions isolate locally modified manifest and secrets, keep base clean, and heal from their snapshots", async () => {
    commit(publisher, ".gitignore", ".env\n.env.local\nsecrets/\n");
    const trackedManifest = '[setup]\ninstall = ["exit 99"]\n';
    commit(publisher, ".codecast/workspace.toml", trackedManifest);
    git(publisher, "push", "-q", "origin", "main");
    git(laptop, "pull", "-q", "--ff-only");
    const runner = path.join(dir, "workspace-cli.ts");
    fs.writeFileSync(runner, `
import { Command } from ${JSON.stringify(import.meta.resolve("commander"))};
import { registerWorkspaceCommand } from ${JSON.stringify(path.resolve(import.meta.dir, "../workspace/cli.ts"))};
const program = new Command();
registerWorkspaceCommand(program);
await program.parseAsync(process.argv);
`);
    process.env.CLOUD_TEST_WS_COMMAND = `${shq(process.execPath)} ${shq(runner)}`;
    const manifest = (label: string) => `
backend = "not-a-host-backend"
[setup]
copy = [".env", "secrets"]
install = ["cat .env secrets/key > installed-inputs", "printf '%s|%s' \\\"$BUN_INSTALL_GLOBAL_STORE\\\" \\\"$BUN_INSTALL_CACHE_DIR\\\" > dependency-env"]
[ports.web]
base = 44000
range = 100
[env]
SNAPSHOT = "${label}"
`;
    const acquired = [];
    for (const label of ["one", "two"]) {
      write(laptop, ".codecast/workspace.toml", manifest(label));
      write(laptop, ".env", `${label}-env\n`);
      write(laptop, "secrets/key", `${label}-secret\n`);
      expect(git(laptop, "diff", "--name-only")).toBe(".codecast/workspace.toml");
      refreshRemoteCheckout(host, laptop, remote);
      recordTrust(remote, collectTrustTargets({ hooksRoot: remote, manifestRoot: laptop }));
      const ws = await acquireRemoteWorkspace(host, remote, `cloud-${label}`, laptop);
      acquired.push(ws);
      const state = readState(remote, ws.name)!;
      const inputs = path.join(remote, ".codecast/workspaces", ws.name, "inputs");
      expect(state.env.CODECAST_WORKSPACE_INPUT_ROOT).toBe(inputs);
      expect(state.manifest.backend).toBe("local");
      expect(state.manifest.env.SNAPSHOT).toBe(label);
      expect(fs.readFileSync(path.join(inputs, ".env"), "utf8")).toBe(`${label}-env\n`);
      expect(fs.statSync(inputs).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(inputs, "secrets/key")).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(path.join(ws.path, ".codecast/workspace.toml"), "utf8")).toBe(manifest(label));
      expect(fs.readFileSync(path.join(ws.path, "installed-inputs"), "utf8")).toBe(`${label}-env\n${label}-secret\n`);
      expect(fs.readFileSync(path.join(remote, ".codecast/workspace.toml"), "utf8")).toBe(trackedManifest);
      expect(fs.existsSync(path.join(remote, ".env"))).toBe(false);
      expect(fs.existsSync(path.join(remote, "secrets"))).toBe(false);
      expect(git(remote, "status", "--porcelain", "--untracked-files=all")).toBe("");
    }
    const [one, two] = acquired;
    expect(one!.ports.web).not.toBe(two!.ports.web);
    await expect(acquireRemoteWorkspace(host, remote, one!.name, laptop)).rejects.toThrow("reserve inputs for workspace cloud-one");
    write(laptop, ".env", "later-laptop-env");
    write(remote, ".env", "shared-base-env");
    write(remote, "secrets/key", "shared-base-secret");
    for (const [index, ws] of acquired.entries()) {
      const label = index === 0 ? "one" : "two";
      for (const rel of [".env", "secrets", ".codecast/workspace.toml", "installed-inputs", "dependency-env"]) {
        fs.rmSync(path.join(ws.path, rel), { recursive: true });
      }
      const healed = await healWorkspace(remote, ws.name);
      expect(healed.state).toBe("ready");
      expect(healed.ports).toEqual(ws.ports);
      expect(fs.readFileSync(path.join(ws.path, "installed-inputs"), "utf8")).toBe(`${label}-env\n${label}-secret\n`);
      expect(fs.readFileSync(path.join(ws.path, ".codecast/workspace.toml"), "utf8")).toBe(manifest(label));
      expect(fs.readFileSync(path.join(ws.path, "dependency-env"), "utf8")).toBe(`0|${path.join(remote, ".codecast/workspaces", ws.name, "bun-cache")}`);
    }
    await releaseWorkspace(remote, one!.name);
    expect(fs.existsSync(path.join(remote, ".codecast/workspaces", one!.name))).toBe(false);
    expect(fs.existsSync(readState(remote, two!.name)!.env.CODECAST_WORKSPACE_INPUT_ROOT!)).toBe(true);
    await releaseWorkspace(remote, two!.name);
    expect(fs.existsSync(path.join(remote, ".codecast/workspaces", two!.name))).toBe(false);
    expect(git(remote, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }, 30_000);

  test("untracked project agent config reaches the host worktree through the manifest copy path; a tracked CLAUDE.md is untouched", async () => {
    commit(publisher, "CLAUDE.md", "# tracked rules\n");
    commit(publisher, ".gitignore", ".env\nCLAUDE.local.md\n");
    git(publisher, "push", "-q", "origin", "main");
    git(laptop, "pull", "-q", "--ff-only");
    const runner = path.join(dir, "workspace-cli.ts");
    fs.writeFileSync(runner, `
import { Command } from ${JSON.stringify(import.meta.resolve("commander"))};
import { registerWorkspaceCommand } from ${JSON.stringify(path.resolve(import.meta.dir, "../workspace/cli.ts"))};
const program = new Command();
registerWorkspaceCommand(program);
await program.parseAsync(process.argv);
`);
    process.env.CLOUD_TEST_WS_COMMAND = `${shq(process.execPath)} ${shq(runner)}`;
    write(laptop, ".codecast/workspace.toml", 'backend = "not-a-host-backend"\n[setup]\ninstall = ["true"]\n');
    write(laptop, "CLAUDE.local.md", "# personal, gitignored\n");
    write(laptop, "CLAUDE.md", "# laptop edit that must not travel\n");
    write(laptop, ".claude/skills/b/SKILL.md", "untracked skill\n");
    write(laptop, ".claude/settings.local.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-secret", NOTES: `${home}/notes` } }));
    refreshRemoteCheckout(host, laptop, remote);
    recordTrust(remote, collectTrustTargets({ hooksRoot: remote, manifestRoot: laptop }));
    const ws = await acquireRemoteWorkspace(host, remote, "cloud-agent", laptop);
    expect(fs.readFileSync(path.join(ws.path, "CLAUDE.md"), "utf8")).toBe("# tracked rules\n");
    expect(fs.readFileSync(path.join(ws.path, "CLAUDE.local.md"), "utf8")).toBe("# personal, gitignored\n");
    expect(fs.readFileSync(path.join(ws.path, ".claude/skills/b/SKILL.md"), "utf8")).toBe("untracked skill\n");
    const settings = JSON.parse(fs.readFileSync(path.join(ws.path, ".claude/settings.local.json"), "utf8"));
    expect(settings.env).toEqual({ NOTES: "/Users/ubuntu/notes" });
    expect(fs.readFileSync(process.env.CLOUD_TEST_LOG!, "utf-8")).not.toContain("sk-ant-secret");
    expect(fs.existsSync(path.join(remote, "CLAUDE.local.md"))).toBe(false);
    expect(git(remote, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }, 30_000);

  test("clones real origin first and ignores laptop HEAD/default branch", () => {
    git(laptop, "checkout", "-qb", "private");
    commit(laptop, "private.txt", "private local branch");
    git(laptop, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/private");
    const head = advanceOrigin();
    const before = laptopState();
    expect(refreshRemoteCheckout(host, laptop, remote)).toEqual({ branch: "main", head, reset: false, via: "host" });
    expect(git(remote, "rev-parse", "HEAD")).toBe(head);
    expect(git(remote, "remote", "get-url", "origin")).toBe(origin);
    // A shared placement moves HEAD: detached at origin/main, `main` untouched.
    const moved = refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead: true });
    expect(moved).toEqual({ branch: "main", head, reset: true, via: "host" });
    expect(git(remote, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
    expect(fs.existsSync(path.join(remote, "private.txt"))).toBe(false);
    expect(fs.existsSync(process.env.CLOUD_TEST_BUNDLE!)).toBe(false);
    expect(laptopState()).toEqual(before);
  }, 30_000);

  test("fetches fresh main in isolation before fallback push and preserves remote branches", () => {
    git(dir, "clone", "-q", origin, remote);
    git(remote, "checkout", "-qb", "moved-session");
    const moved = commit(remote, "moved.txt", "committed session work");
    write(laptop, "app.txt", "unstaged laptop edit");
    write(laptop, "staged.txt", "staged laptop edit");
    git(laptop, "add", "staged.txt");
    const before = laptopState();
    const head = advanceOrigin();
    process.env.CLOUD_TEST_FAIL_ORIGIN = "1";
    const r = refreshRemoteCheckout(host, laptop, remote);
    expect(r.head).toBe(head);
    expect(r.via).toBe("laptop");
    expect(git(remote, "rev-parse", "moved-session")).toBe(moved);
    // Fetch-only: the moved session keeps its HEAD; only origin/main advanced.
    expect(git(remote, "rev-parse", "HEAD")).toBe(moved);
    expect(git(remote, "rev-parse", "--abbrev-ref", "HEAD")).toBe("moved-session");
    expect(git(remote, "rev-parse", "origin/main")).toBe(head);
    expect(r.reset).toBe(false);
    expect(r.branch).toBe("moved-session");
    expect(laptopState()).toEqual(before);
  }, 30_000);

  test("missing-repo fallback bundles only fresh main, excluding private branches and tags", () => {
    git(laptop, "checkout", "-qb", "private");
    const privateHead = commit(laptop, "private.txt", "must not transfer");
    git(laptop, "tag", "private-tag");
    const head = advanceOrigin();
    process.env.CLOUD_TEST_FAIL_ORIGIN = "1";
    const before = laptopState();
    const r = refreshRemoteCheckout(host, laptop, remote);
    expect(r.head).toBe(head);
    expect(r.via).toBe("laptop");
    expect(git(dir, "bundle", "list-heads", process.env.CLOUD_TEST_BUNDLE!)).toBe(`${head} refs/heads/main`);
    expect(spawnSync("git", ["-C", remote, "cat-file", "-e", privateHead]).status).not.toBe(0);
    expect(git(remote, "tag", "--list")).toBe("");
    expect(laptopState()).toEqual(before);
  }, 30_000);

  test("the HOST reaches a GitHub origin as the credential it holds can (ssh for the key, https for an App token); the laptop fallbacks keep the laptop's origin", () => {
    // A network-free pin: the host-side clone, fetch and set-url are the only
    // places `hostOrigin` (hostProbeOrigin's spelling) may be used, and the
    // laptop's bundle/push fallbacks must stay on the laptop's own `origin`.
    const src = fs.readFileSync(path.join(import.meta.dir, "transfer.ts"), "utf-8");
    const body = src.slice(src.indexOf("export function refreshRemoteCheckout("), src.indexOf("function validateRelativePath("));
    expect(body).toContain("const hostOrigin = hostProbeOrigin(origin, { appToken: opts.appToken === true }).origin ?? origin;");
    // The two spellings, from the one rule the host git step proved.
    expect(hostProbeOrigin("https://github.com/o/r.git").origin).toBe("git@github.com:o/r.git");
    expect(hostProbeOrigin("https://github.com/o/r.git", { appToken: true }).origin).toBe("https://github.com/o/r.git");
    expect(hostProbeOrigin("git@github.com:o/r.git", { appToken: true }).origin).toBe("https://github.com/o/r.git");
    expect(body).toContain("git clone -q --single-branch --no-tags --branch main -- ${shq(hostOrigin)} ${q}");
    expect(body).toContain("git fetch -q --no-tags --no-recurse-submodules -- ${shq(hostOrigin)} '+refs/heads/main:refs/remotes/origin/main'");
    expect(body).toContain("git remote set-url origin ${shq(hostOrigin)} && git checkout");
    expect(body.match(/withFreshMain\(origin, /g)).toHaveLength(2);
    expect(body).not.toContain("withFreshMain(hostOrigin");
    // A local origin is its own host origin: the existing tests above cover that path end to end.
  });

  test("refreshes an existing checkout directly from origin without moving its main branch", () => {
    git(dir, "clone", "-q", origin, remote);
    const oldMain = git(remote, "rev-parse", "main");
    const head = advanceOrigin();
    const r = refreshRemoteCheckout(host, laptop, remote);
    expect(r.head).toBe(head);
    expect(r.via).toBe("host");
    expect(git(remote, "rev-parse", "main")).toBe(oldMain);
    expect(git(remote, "rev-parse", "origin/main")).toBe(head);
    // The host fetched by itself: no bundle, no laptop push, and the fetch ran non-interactively.
    const log = sshLog();
    expect(log.some((l) => l.includes("main.bundle") || l.includes("git-receive-pack"))).toBe(false);
    expect(log.some((l) => l.includes("GIT_TERMINAL_PROMPT=0 git fetch"))).toBe(true);
  }, 30_000);

  describe("host git setup inside prepareCloudHost", () => {
    // A registered non-AWS host (ensureUp is a no-op for it) whose `user`
    // walks the host's /home/<user>/work back under the temp dir, so the
    // "host" checkout lands there and never in the real ~/work.
    const hostId = "i-test";
    let work: string;
    beforeEach(() => {
      work = path.join(dir, "work");
      writeHosts([{ id: hostId, provider: "scaleway-mac", region: "test", user: `u/../..${dir}`, keyPath: "/k", address: "cloud-test.invalid" }]);
    });

    test("the hostGit command runs BEFORE any git clone/fetch, records the probe in the registry, and the checkout follows", async () => {
      const lines: string[] = [];
      const prepared = await prepareCloudHost({ hostArg: hostId, seedCwd: laptop, repoRoot: laptop, onProgress: (m) => lines.push(m) });
      expect(prepared.repoPath).toBe(path.join(work, "laptop repo"));
      expect(prepared.deviceId).toBe("0123456789abcdef");
      expect(prepared.git?.access).toEqual({ origin, read: true, write: true });
      const log = sshLog();
      // The log holds JSON-encoded commands, so the quotes in `bash -c "$(cat)"` are escaped there.
      const gitIdx = log.findIndex((l) => l.includes(JSON.stringify(HOST_GIT_REMOTE_COMMAND).slice(1, -1)));
      const cloneIdx = log.findIndex((l) => l.includes("git clone") || l.includes("git fetch"));
      expect(gitIdx).toBeGreaterThanOrEqual(0);
      expect(cloneIdx).toBeGreaterThan(gitIdx);
      expect(fs.existsSync(path.join(home, ".codecast/git/id_ed25519.pub"))).toBe(true);
      expect(fs.readFileSync(path.join(home, ".ssh/known_hosts"), "utf-8")).toContain("github.com ssh-ed25519");
      expect(git(prepared.repoPath, "rev-parse", "HEAD")).toBe(git(publisher, "rev-parse", "HEAD"));
      const entry = readHosts().find((h) => h.id === hostId)!;
      expect(entry.deviceId).toBe("0123456789abcdef");
      expect(entry.gitPubkey).toBe(prepared.git!.pubkey!);
      expect(entry.gitAccess).toMatchObject({ origin, read: true, write: true });
      expect(lines.some((l) => l.startsWith("host git: push access to"))).toBe(true);
      expect(lines.some((l) => l.includes("cast hosts key"))).toBe(false);
    }, 30_000);

    test("prepareCloudHost is fetch-only: an existing checkout on another branch keeps its HEAD while origin/main advances", async () => {
      const repoPath = path.join(work, "laptop repo");
      git(dir, "clone", "-q", origin, repoPath);
      git(repoPath, "checkout", "-qb", "codecast/cloud-shared");
      const shared = commit(repoPath, "shared.txt", "a shared session's work");
      const head = advanceOrigin();
      const prepared = await prepareCloudHost({ hostArg: hostId, seedCwd: laptop, repoRoot: laptop });
      expect(prepared.mainHead).toBe(head);
      expect(git(repoPath, "rev-parse", "HEAD")).toBe(shared);
      expect(git(repoPath, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/cloud-shared");
      expect(git(repoPath, "rev-parse", "origin/main")).toBe(head);
    }, 30_000);

    test("a transport-failing hostGit step is non-fatal: prepareCloudHost still returns the checkout", async () => {
      process.env.CLOUD_TEST_FAIL_HOSTGIT = "1";
      const lines: string[] = [];
      const prepared = await prepareCloudHost({ hostArg: hostId, seedCwd: laptop, repoRoot: laptop, onProgress: (m) => lines.push(m) });
      expect(prepared.repoPath).toBe(path.join(work, "laptop repo"));
      expect(prepared.git).toBeUndefined();
      expect(lines.some((l) => l.startsWith("host git setup skipped: host git setup on") && l.includes("Connection refused"))).toBe(true);
      expect(fs.existsSync(path.join(prepared.repoPath, "app.txt"))).toBe(true);
      expect(readHosts().find((h) => h.id === hostId)!.gitAccess).toBeUndefined();
    }, 30_000);

    test("a denied probe is a result, not an error: the checkout still lands and the hint names cast hosts key", async () => {
      const realGit = Bun.which("git")!;
      fs.writeFileSync(path.join(dir, "bin", "git"), `#!/bin/sh
case "$*" in *ls-remote*) echo "git@github.com: Permission denied (publickey)." >&2; exit 128;; esac
exec ${realGit} "$@"
`, { mode: 0o755 });
      const lines: string[] = [];
      const prepared = await prepareCloudHost({ hostArg: hostId, seedCwd: laptop, repoRoot: laptop, onProgress: (m) => lines.push(m) });
      expect(prepared.git?.access).toEqual({ origin, read: false, write: false, error: "git@github.com: Permission denied (publickey)." });
      expect(lines).toContain(`host has no push access to ${origin} (git@github.com: Permission denied (publickey).) — cast hosts key ${hostId}`);
      expect(fs.existsSync(path.join(prepared.repoPath, "app.txt"))).toBe(true);
      expect(readHosts().find((h) => h.id === hostId)!.gitAccess).toMatchObject({ read: false, write: false });
    }, 30_000);
  });

  test("a dirty worktree whose .git is a file is fetched around by default and refused only when HEAD must move", () => {
    git(laptop, "worktree", "add", "-qb", "moved-session", remote);
    write(remote, "app.txt", "moved session edits");
    expect(fs.statSync(path.join(remote, ".git")).isFile()).toBe(true);
    const headBefore = git(remote, "rev-parse", "HEAD");
    const r = refreshRemoteCheckout(host, laptop, remote);
    expect(r.reset).toBe(false);
    expect(git(remote, "rev-parse", "HEAD")).toBe(headBefore);
    expect(fs.readFileSync(path.join(remote, "app.txt"), "utf-8")).toBe("moved session edits");
    expect(() => refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead: true })).toThrow(/uncommitted changes \(.*app\.txt.*\)/);
    expect(fs.readFileSync(path.join(remote, "app.txt"), "utf-8")).toBe("moved session edits");
  }, 30_000);

  test.each(["tracked", "staged", "untracked"])("a root with %s edits: the default refresh advances only origin/main; moveHead refuses and changes nothing", (kind) => {
    git(dir, "clone", "-q", origin, remote);
    const rel = kind === "untracked" ? "user-work.txt" : "app.txt";
    write(remote, rel, "preserve me");
    if (kind === "staged") git(remote, "add", rel);
    const headBefore = git(remote, "rev-parse", "HEAD");
    const heads = git(remote, "show-ref", "--heads");
    const status = git(remote, "status", "--porcelain");
    const head = advanceOrigin();
    const r = refreshRemoteCheckout(host, laptop, remote);
    expect(r).toMatchObject({ reset: false, head, branch: "main", via: "host" });
    expect(fs.readFileSync(path.join(remote, rel), "utf-8")).toBe("preserve me");
    expect(git(remote, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(remote, "show-ref", "--heads")).toBe(heads);
    expect(git(remote, "rev-parse", "origin/main")).toBe(head);
    expect(git(remote, "status", "--porcelain")).toBe(status);
    const refs = git(remote, "show-ref");
    expect(() => refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead: true })).toThrow(new RegExp(`uncommitted changes \\(.*${rel.replace(".", "\\.")}.*\\) — commit, stash or reset them on the host, or run isolated`));
    expect(fs.readFileSync(path.join(remote, rel), "utf-8")).toBe("preserve me");
    expect(git(remote, "show-ref")).toBe(refs);
    expect(git(remote, "rev-parse", "HEAD")).toBe(headBefore);
  });

  test.each([false, true])("a symlinked or nested checkout path is refused (moveHead: %p)", (moveHead) => {
    git(dir, "clone", "-q", origin, path.join(dir, "real"));
    fs.symlinkSync(path.join(dir, "real"), remote);
    expect(() => refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead })).toThrow("inspect cloud checkout");
    fs.unlinkSync(remote);
    git(dir, "clone", "-q", origin, path.join(dir, "outer"));
    fs.mkdirSync(path.join(dir, "outer", "inner"));
    expect(() => refreshRemoteCheckout(host, laptop, path.join(dir, "outer", "inner"), () => {}, { moveHead })).toThrow("inspect cloud checkout");
    expect(sshLog().some((l) => l.includes("git fetch") || l.includes("set-url"))).toBe(false);
  });

  test("moveHead: a detached root at commits no ref holds is refused; a root on a branch with extra commits is moved and the branch survives", () => {
    git(dir, "clone", "-q", origin, remote);
    git(remote, "checkout", "-q", "--detach");
    const orphan = commit(remote, "orphan.txt", "unreachable work");
    advanceOrigin();
    expect(() => refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead: true })).toThrow("detached at commits no branch holds — create a branch for them on the host first");
    expect(git(remote, "rev-parse", "HEAD")).toBe(orphan);
    // The default refresh does not mind.
    expect(refreshRemoteCheckout(host, laptop, remote).reset).toBe(false);
    expect(git(remote, "rev-parse", "HEAD")).toBe(orphan);
    git(remote, "checkout", "-qb", "keep-me");
    const head = commit(publisher, "app.txt", "fresher main\n");
    git(publisher, "push", "-q", "origin", "main");
    const moved = refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead: true });
    expect(moved).toMatchObject({ reset: true, head });
    expect(git(remote, "rev-parse", "HEAD")).toBe(head);
    expect(git(remote, "rev-parse", "keep-me")).toBe(orphan);
  }, 30_000);

  test("does not use stale refs when neither host nor laptop can fetch origin", () => {
    git(dir, "clone", "-q", origin, remote);
    const before = git(remote, "show-ref");
    fs.renameSync(origin, `${origin}.offline`);
    process.env.CLOUD_TEST_FAIL_ORIGIN = "1";
    expect(() => refreshRemoteCheckout(host, laptop, remote)).toThrow("fetch fresh origin/main on laptop failed");
    expect(git(remote, "show-ref")).toBe(before);
  });

  test("failed clone never removes work that occupies its destination", () => {
    process.env.CLOUD_TEST_FAIL_ORIGIN = "1";
    process.env.CLOUD_TEST_OCCUPY = remote;
    expect(() => refreshRemoteCheckout(host, laptop, remote)).toThrow("transfer and clone main-only bundle failed");
    expect(fs.readFileSync(path.join(remote, "user-work"), "utf-8")).toBe("preserve me");
  });

  test("refuses an existing non-repository directory", () => {
    write(remote, "user-work", "preserve me");
    expect(() => refreshRemoteCheckout(host, laptop, remote)).toThrow("inspect cloud checkout");
    expect(fs.readFileSync(path.join(remote, "user-work"), "utf-8")).toBe("preserve me");
  });

  test("failed fallback push is fatal and does not expose transport output", () => {
    git(dir, "clone", "-q", origin, remote);
    const before = git(remote, "show-ref");
    process.env.CLOUD_TEST_FAIL_ORIGIN = "1";
    process.env.CLOUD_TEST_FAIL_TRANSFER = "1";
    expect(() => refreshRemoteCheckout(host, laptop, remote)).toThrow("push fresh origin/main to cloud checkout failed");
    expect(git(remote, "show-ref")).toBe(before);
  });
});

describe("manifest file transfer", () => {
  test("copies current manifest, nested files and directories privately via SSH", () => {
    const manifest = '[setup]\ncopy = [".env", "secrets", "optional-missing"]\ninstall = ["true"]\n';
    write(laptop, ".codecast/workspace.toml", manifest);
    write(laptop, ".env", "SECRET_VALUE\n");
    write(laptop, "secrets/nested/key's name", "nested secret\n");
    write(laptop, "not-listed", "must stay local");
    fs.mkdirSync(remote);
    copyCloudFiles(host, laptop, remote);
    expect(fs.readFileSync(path.join(remote, ".codecast/workspace.toml"), "utf-8")).toBe(manifest);
    expect(fs.readFileSync(path.join(remote, ".env"), "utf-8")).toBe("SECRET_VALUE\n");
    expect(fs.readFileSync(path.join(remote, "secrets/nested/key's name"), "utf-8")).toBe("nested secret\n");
    expect(fs.statSync(path.join(remote, ".env")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(remote, "not-listed"))).toBe(false);
    expect(fs.readFileSync(process.env.CLOUD_TEST_LOG!, "utf-8")).not.toContain("SECRET_VALUE");
  });

  test.each(["../outside", "/etc/passwd", "secrets/../../outside", ".git/config", "C:\\outside", "secrets\\outside"])("rejects unsafe manifest path %s", (rel) => {
    write(laptop, ".codecast/workspace.toml", `[setup]\ncopy = [${JSON.stringify(rel)}]\n`);
    expect(() => cloudCopyFiles(laptop)).toThrow("unsafe workspace copy path");
    expect(fs.existsSync(process.env.CLOUD_TEST_LOG!)).toBe(false);
  });

  test.each(["file", "parent", "nested", "manifest"])("rejects %s symlink escape before transfer", (kind) => {
    write(dir, "outside/key", "outside secret");
    write(laptop, ".codecast/workspace.toml", '[setup]\ncopy = ["secrets"]\n');
    if (kind === "manifest") {
      fs.rmSync(path.join(laptop, ".codecast/workspace.toml"));
      fs.symlinkSync(path.join(dir, "outside/key"), path.join(laptop, ".codecast/workspace.toml"));
    } else if (kind === "nested") {
      fs.mkdirSync(path.join(laptop, "secrets"));
      fs.symlinkSync(path.join(dir, "outside/key"), path.join(laptop, "secrets/key"));
    } else {
      fs.symlinkSync(path.join(dir, kind === "file" ? "outside/key" : "outside"), path.join(laptop, "secrets"));
    }
    expect(() => cloudCopyFiles(laptop)).toThrow("workspace copy refuses symlink");
  });

  test.each(["leaf", "parent"])("rejects remote %s symlink without touching its target", (kind) => {
    write(laptop, ".codecast/workspace.toml", '[setup]\ncopy = ["secrets/key"]\n');
    write(laptop, "secrets/key", "local secret");
    write(dir, "outside/key", "preserve me");
    fs.mkdirSync(remote);
    if (kind === "parent") fs.symlinkSync(path.join(dir, "outside"), path.join(remote, "secrets"));
    else {
      fs.mkdirSync(path.join(remote, "secrets"));
      fs.symlinkSync(path.join(dir, "outside/key"), path.join(remote, "secrets/key"));
    }
    expect(() => copyCloudFiles(host, laptop, remote)).toThrow("transfer workspace file secrets/key failed");
    expect(fs.readFileSync(path.join(dir, "outside/key"), "utf-8")).toBe("preserve me");
  });

  test("fails invalid manifest before waking a host, without echoing its contents", async () => {
    write(laptop, ".codecast/workspace.toml", '[setup]\ncopy = ["SECRET_VALUE"\n');
    await expect(prepareCloudHost({ hostArg: "must-not-wake", seedCwd: laptop, repoRoot: laptop })).rejects.toThrow("invalid workspace manifest; fix .codecast/workspace.toml before cloud acquire");
    expect(fs.existsSync(process.env.CLOUD_TEST_LOG!)).toBe(false);
  });

  test("fails actual transfer errors without echoing source or transport contents", () => {
    write(laptop, ".env", "SECRET_VALUE");
    fs.mkdirSync(remote);
    process.env.CLOUD_TEST_FAIL_TRANSFER = "1";
    expect(() => copyCloudFiles(host, laptop, remote)).toThrow("transfer workspace file .env failed (exit 9)");
    expect(fs.existsSync(path.join(remote, ".env"))).toBe(false);
  });

  test("requires a completed-copy acknowledgement even when SSH exits successfully", () => {
    write(laptop, ".env", "SECRET_VALUE");
    process.env.CLOUD_TEST_UNCONFIRMED = "1";
    expect(() => copyCloudFiles(host, laptop, remote)).toThrow("transfer workspace file .env was not confirmed by the host");
    expect(fs.existsSync(remote)).toBe(false);
  });

  test("detects source changes after collection instead of silently skipping files", () => {
    write(laptop, ".env", "SECRET_VALUE");
    const files = cloudCopyFiles(laptop);
    fs.rmSync(path.join(laptop, ".env"));
    expect(() => copyCloudFiles(host, laptop, remote, files)).toThrow("workspace copy source changed");
  });
});

test.each(["state", "worktree"])("existing %s prevents any input recopy before acquire", async (kind) => {
  write(laptop, ".env", "new secret");
  const occupied = path.join(remote, kind === "state" ? ".codecast/workspaces/cloud-1/inputs" : ".codecast/worktrees/cloud-1");
  write(occupied, ".env", "original snapshot");
  await expect(acquireRemoteWorkspace(host, remote, "cloud-1", laptop)).rejects.toThrow("reserve inputs for workspace cloud-1");
  expect(fs.readFileSync(path.join(occupied, ".env"), "utf8")).toBe("original snapshot");
  expect(fs.readFileSync(process.env.CLOUD_TEST_LOG!, "utf8")).not.toContain("cast ws acquire");
});

test("input reservation refuses symlink destinations without copying secrets", async () => {
  write(laptop, ".env", "new secret");
  fs.mkdirSync(path.join(remote, ".codecast"), { recursive: true });
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(remote, ".codecast/workspaces"));
  await expect(acquireRemoteWorkspace(host, remote, "cloud-1", laptop)).rejects.toThrow("reserve inputs for workspace cloud-1");
  expect(fs.readdirSync(outside)).toEqual([]);
});

test("unconfirmed input reservation aborts before copy and acquire", async () => {
  write(laptop, ".env", "new secret");
  process.env.CLOUD_TEST_UNCONFIRMED = "1";
  await expect(acquireRemoteWorkspace(host, remote, "cloud-1", laptop)).rejects.toThrow("input reservation for workspace cloud-1 was not confirmed");
  expect(fs.existsSync(remote)).toBe(false);
});

test("failed acquisition preserves work and never accepts success JSON from a failed process", async () => {
  write(remote, "user-work", "preserve me");
  git(remote, "init", "-q", "-b", "main");
  process.env.CLOUD_TEST_ACQUIRE = JSON.stringify({ name: "cloud-1", state: "ready", contract: { ok: true, failures: [] }, path: remote, ports: {}, branch: "codecast/cloud-1", created: true });
  process.env.CLOUD_TEST_ACQUIRE_STATUS = "2";
  await expect(acquireRemoteWorkspace(host, remote, "cloud-1", laptop)).rejects.toThrow("cast ws acquire cloud-1 failed on the host");
  expect(fs.readFileSync(path.join(remote, "user-work"), "utf-8")).toBe("preserve me");
});

describe("agent config staging", () => {
  function gitInit(repo: string) {
    fs.mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
  }

  test("stages .claude/settings.local.json scrubbed + remapped and CLAUDE.local.md remapped, 0600, under the inputs dir", () => {
    gitInit(laptop);
    gitInit(remote);
    commit(laptop, ".gitignore", "CLAUDE.local.md\n");
    write(laptop, ".claude/settings.local.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-secret", NOTES: `${home}/notes` }, permissions: { disableBypassPermissionsMode: "disable", allow: ["Bash(ls)"] } }));
    write(laptop, "CLAUDE.local.md", `# mine at ${home}/x\n`);
    const inputRoot = stageCloudInputs(host, laptop, remote, "cloud-1");
    expect(inputRoot).toBe(path.join(remote, ".codecast/workspaces/cloud-1/inputs"));
    const settings = JSON.parse(fs.readFileSync(path.join(inputRoot, ".claude/settings.local.json"), "utf8"));
    expect(settings).toEqual({ env: { NOTES: "/Users/ubuntu/notes" }, permissions: { allow: ["Bash(ls)"] } });
    expect(fs.readFileSync(path.join(inputRoot, "CLAUDE.local.md"), "utf8")).toBe("# mine at /Users/ubuntu/x\n");
    expect(fs.statSync(path.join(inputRoot, ".claude/settings.local.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(inputRoot, "CLAUDE.local.md")).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(process.env.CLOUD_TEST_LOG!, "utf-8")).not.toContain("sk-ant-secret");
  });

  test("invalid active settings fail staging before writing any input", () => {
    gitInit(laptop);
    gitInit(remote);
    write(laptop, ".claude/settings.local.json", "{ not json");
    write(laptop, "CLAUDE.local.md", "# mine\n");
    expect(() => stageCloudInputs(host, laptop, remote, "cloud-1")).toThrow("cannot parse active context config:");
    expect(fs.existsSync(path.join(remote, ".codecast/workspaces/cloud-1/inputs/CLAUDE.local.md"))).toBe(false);
  });

  test("an untracked .claude/skills/a -> ../shared symlink does not abort staging", () => {
    gitInit(laptop);
    gitInit(remote);
    write(dir, "shared/SKILL.md", "shared\n");
    fs.mkdirSync(path.join(laptop, ".claude/skills"), { recursive: true });
    fs.symlinkSync(path.join(dir, "shared"), path.join(laptop, ".claude/skills/a"));
    write(laptop, ".claude/skills/b/SKILL.md", "b\n");
    const inputRoot = stageCloudInputs(host, laptop, remote, "cloud-1");
    expect(fs.readFileSync(path.join(inputRoot, ".claude/skills/b/SKILL.md"), "utf8")).toBe("b\n");
    expect(fs.existsSync(path.join(inputRoot, ".claude/skills/a"))).toBe(false);
  });

  test("more than 8 files go through ONE `cast cloud mirror-apply --stdin --into` ssh; an older host falls back to per-file bun -e", () => {
    gitInit(laptop);
    for (let i = 0; i < 12; i++) write(laptop, `.claude/skills/s${i}/SKILL.md`, `skill ${i}\n`);
    write(laptop, ".claude/skills/s0/run.sh", "#!/bin/sh\n");
    fs.chmodSync(path.join(laptop, ".claude/skills/s0/run.sh"), 0o755);
    fs.mkdirSync(remote);
    copyCloudFiles(host, laptop, remote);
    const log = sshLog();
    expect(log.filter((l) => l.includes("cast cloud mirror-apply --stdin --into"))).toHaveLength(1);
    expect(log.filter((l) => l.includes('copied'))).toHaveLength(0);
    for (let i = 0; i < 12; i++) expect(fs.readFileSync(path.join(remote, `.claude/skills/s${i}/SKILL.md`), "utf8")).toBe(`skill ${i}\n`);
    expect(fs.statSync(path.join(remote, ".claude/skills/s0/run.sh")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(remote, ".claude/skills/s1/SKILL.md")).mode & 0o777).toBe(0o600);

    fs.rmSync(remote, { recursive: true, force: true });
    fs.mkdirSync(remote);
    fs.rmSync(process.env.CLOUD_TEST_LOG!);
    process.env.CLOUD_TEST_OLD_HOST = "1";
    copyCloudFiles(host, laptop, remote);
    const old = sshLog();
    expect(old.filter((l) => l.includes("cast cloud mirror-apply"))).toHaveLength(1);
    expect(old.filter((l) => l.includes('copied'))).toHaveLength(13);
    for (let i = 0; i < 12; i++) expect(fs.readFileSync(path.join(remote, `.claude/skills/s${i}/SKILL.md`), "utf8")).toBe(`skill ${i}\n`);

    // A host with no cast on PATH at all (exit 127) also falls back: bun is enough there.
    delete process.env.CLOUD_TEST_OLD_HOST;
    process.env.CLOUD_TEST_NO_CAST = "1";
    fs.rmSync(remote, { recursive: true, force: true });
    fs.mkdirSync(remote);
    fs.rmSync(process.env.CLOUD_TEST_LOG!);
    copyCloudFiles(host, laptop, remote);
    expect(sshLog().filter((l) => l.includes('copied'))).toHaveLength(13);
    for (let i = 0; i < 12; i++) expect(fs.readFileSync(path.join(remote, `.claude/skills/s${i}/SKILL.md`), "utf8")).toBe(`skill ${i}\n`);
  }, 90_000);

  test("a small set stays on the per-file path", () => {
    gitInit(laptop);
    write(laptop, ".claude/skills/only/SKILL.md", "one\n");
    fs.mkdirSync(remote);
    copyCloudFiles(host, laptop, remote);
    expect(sshLog().some((l) => l.includes("mirror-apply"))).toBe(false);
    expect(fs.readFileSync(path.join(remote, ".claude/skills/only/SKILL.md"), "utf8")).toBe("one\n");
  });
});

describe("shared checkout on the host (ct-49428)", () => {
  const runner = () => {
    const file = path.join(dir, "workspace-cli.ts");
    fs.writeFileSync(file, `
import { Command } from ${JSON.stringify(import.meta.resolve("commander"))};
import { registerWorkspaceCommand } from ${JSON.stringify(path.resolve(import.meta.dir, "../workspace/cli.ts"))};
const program = new Command();
registerWorkspaceCommand(program);
await program.parseAsync(process.argv);
`);
    process.env.CLOUD_TEST_WS_COMMAND = `${shq(process.execPath)} ${shq(file)}`;
  };
  beforeEach(() => {
    fs.mkdirSync(publisher);
    git(dir, "init", "-q", "--bare", "--initial-branch=main", origin);
    git(publisher, "init", "-q", "--initial-branch=main");
    commit(publisher, ".gitignore", ".env\n.codecast/workspaces/\n.codecast/worktrees/\nsetup-out\n");
    commit(publisher, "app.txt", "initial main\n");
    git(publisher, "remote", "add", "origin", origin);
    git(publisher, "push", "-q", "origin", "main");
    git(dir, "clone", "-q", origin, laptop);
  }, 30_000);

  test("stageCloudInputs with reuse recreates the inputs of an existing state dir and still refuses a same-named worktree", () => {
    write(laptop, ".env", "first\n");
    git(dir, "clone", "-q", origin, remote);
    const inputs = stageCloudInputs(host, laptop, remote, ROOT_WORKSPACE_NAME, { reuse: true });
    expect(fs.readFileSync(path.join(inputs, ".env"), "utf8")).toBe("first\n");
    write(path.dirname(inputs), "state.json", "{}");
    write(laptop, ".env", "second\n");
    expect(stageCloudInputs(host, laptop, remote, ROOT_WORKSPACE_NAME, { reuse: true })).toBe(inputs);
    expect(fs.readFileSync(path.join(inputs, ".env"), "utf8")).toBe("second\n");
    expect(fs.readFileSync(path.join(path.dirname(inputs), "state.json"), "utf8")).toBe("{}");
    // Without reuse the existing state dir is a refusal, as before.
    expect(() => stageCloudInputs(host, laptop, remote, ROOT_WORKSPACE_NAME)).toThrow(`reserve inputs for workspace ${ROOT_WORKSPACE_NAME}`);
    fs.mkdirSync(path.join(remote, ".codecast/worktrees", ROOT_WORKSPACE_NAME), { recursive: true });
    expect(() => stageCloudInputs(host, laptop, remote, ROOT_WORKSPACE_NAME, { reuse: true })).toThrow(`reserve inputs for workspace ${ROOT_WORKSPACE_NAME}`);
  });

  test("acquireRemoteRootCheckout: a fresh branch from origin/main, the laptop's secret in the root, ports, and the registration barrier last", async () => {
    runner();
    write(laptop, ".codecast/workspace.toml", '[setup]\ncopy = [".env"]\ninstall = ["cat .env > setup-out"]\n[ports.web]\nbase = 46000\nrange = 100\n');
    write(laptop, ".env", "laptop secret\n");
    git(dir, "clone", "-q", origin, remote);
    write(remote, ".env", "host copy\n");
    const head = advanceOrigin();
    refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead: true });
    const order: string[] = [];
    const ws = await acquireRemoteRootCheckout(host, remote, laptop, "codecast/cloud-abc123", { onTargetAcquired: async (t) => { order.push(`registered:${t}`); } });
    expect(ws).toMatchObject({ name: ROOT_WORKSPACE_NAME, path: remote, branch: "codecast/cloud-abc123", created: true });
    expect(ws.ports.web).toBeGreaterThan(0);
    expect(order).toEqual([`registered:${remote}`]);
    expect(git(remote, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/cloud-abc123");
    expect(git(remote, "rev-parse", "HEAD")).toBe(head);
    expect(fs.readFileSync(path.join(remote, ".env"), "utf8")).toBe("laptop secret\n");
    expect(fs.readFileSync(path.join(remote, "setup-out"), "utf8")).toBe("laptop secret\n");
    expect(fs.existsSync(path.join(remote, ".codecast/workspace.toml"))).toBe(false);
    expect(git(remote, "status", "--porcelain", "--untracked-files=all")).toBe("");
    const state = readState(remote, ROOT_WORKSPACE_NAME)!;
    expect(state.path).toBe(remote);
    expect(state.branch).toBe("codecast/cloud-abc123");
    expect(state.env.CODECAST_CLOUD_WORKSPACE).toBeUndefined();
    expect(state.env.BUN_INSTALL_CACHE_DIR).toBeUndefined();
    // A second placement (after the next moveHead refresh) reuses the record: same ports, created false.
    refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead: true });
    const again = await acquireRemoteRootCheckout(host, remote, laptop, "codecast/cloud-def456");
    expect(again.created).toBe(false);
    expect(again.ports).toEqual(ws.ports);
    expect(git(remote, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/cloud-def456");
  }, 60_000);

  test("acquireRemoteRootCheckout fails closed on an old host, a non-root path, and a post-setup dirty tree", async () => {
    write(laptop, ".codecast/workspace.toml", '[setup]\ninstall = ["true"]\n');
    git(dir, "clone", "-q", origin, remote);
    process.env.CLOUD_TEST_OLD_HOST = "1";
    await expect(acquireRemoteRootCheckout(host, remote, laptop, "codecast/cloud-000001")).rejects.toThrow(/host cast predates shared checkouts — re-provision it: cast hosts provision/);
    delete process.env.CLOUD_TEST_OLD_HOST;
    process.env.CLOUD_TEST_ROOT = JSON.stringify({ name: ROOT_WORKSPACE_NAME, path: "/somewhere/else", branch: "codecast/cloud-000002", ports: {}, created: true, state: "ready", contract: { ok: true, failures: [] } });
    await expect(acquireRemoteRootCheckout(host, remote, laptop, "codecast/cloud-000002")).rejects.toThrow(`reported /somewhere/else, not the checkout ${remote}`);
    process.env.CLOUD_TEST_ROOT = JSON.stringify({ name: ROOT_WORKSPACE_NAME, path: remote, branch: "codecast/cloud-000003", ports: {}, created: true, state: "ready", contract: { ok: true, failures: [] } });
    write(remote, "generated.lock", "setup wrote me");
    await expect(acquireRemoteRootCheckout(host, remote, laptop, "codecast/cloud-000003")).rejects.toThrow("setup left the host checkout dirty (?? generated.lock) — fix that upstream (e.g. commit the lockfile) or run isolated");
    await expect(acquireRemoteRootCheckout(host, remote, laptop, "bad branch")).rejects.toThrow("invalid shared checkout branch");
    // No registration ran for any refusal.
    expect(git(remote, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/cloud-000003");
    // A current host whose `cast ws root` fails for its own reason is reported as that reason,
    // even when the text says "not found" — never as an old host to re-provision.
    fs.rmSync(path.join(remote, "generated.lock"));
    process.env.CLOUD_TEST_ROOT = "";
    process.env.CLOUD_TEST_ROOT_STATUS = "1";
    process.env.CLOUD_TEST_ROOT_STDERR = "root failed: workspace 'shared-checkout' not found\n";
    await expect(acquireRemoteRootCheckout(host, remote, laptop, "codecast/cloud-000004")).rejects.toThrow("cast ws root failed on the host (exit 1): root failed: workspace 'shared-checkout' not found; the checkout is on codecast/cloud-000004");
    process.env.CLOUD_TEST_ROOT_STDERR = "bash: bun: command not found\n";
    await expect(acquireRemoteRootCheckout(host, remote, laptop, "codecast/cloud-000005")).rejects.toThrow(/cast ws root failed on the host \(exit 1\): bash: bun: command not found/);
    delete process.env.CLOUD_TEST_ROOT_STDERR;
    delete process.env.CLOUD_TEST_ROOT_STATUS;
  }, 30_000);

  test("the shared HEAD move prunes per-session branches origin/main already contains and keeps the rest", () => {
    git(dir, "clone", "-q", origin, remote);
    git(remote, "branch", "codecast/cloud-merged", "refs/remotes/origin/main");
    git(remote, "checkout", "-qb", "codecast/cloud-work");
    const work = commit(remote, "work.txt", "unpushed shared work");
    git(remote, "branch", "codecast/other", "refs/remotes/origin/main");
    git(remote, "branch", "keep-me", "refs/remotes/origin/main");
    advanceOrigin();
    // An isolated worktree on a merged branch: `-d` refuses a checked-out branch.
    git(remote, "branch", "codecast/cloud-wt", "refs/remotes/origin/main");
    git(remote, "worktree", "add", "-q", path.join(dir, "wt"), "codecast/cloud-wt");
    refreshRemoteCheckout(host, laptop, remote, () => {}, { moveHead: true });
    const branches = git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n");
    expect(branches).not.toContain("codecast/cloud-merged");
    expect(branches).toContain("codecast/cloud-work");
    expect(branches).toContain("codecast/cloud-wt");
    expect(branches).toContain("codecast/other");
    expect(branches).toContain("keep-me");
    expect(git(remote, "rev-parse", "codecast/cloud-work")).toBe(work);
  }, 30_000);

  test("acquireRemoteWorkspace pre-branches from origin/main, so the worktree base is origin/main even when the root sits elsewhere", async () => {
    runner();
    write(laptop, ".codecast/workspace.toml", '[setup]\ninstall = ["true"]\n');
    git(dir, "clone", "-q", origin, remote);
    git(remote, "checkout", "-qb", "codecast/cloud-shared");
    const rootWork = commit(remote, "shared-work.txt", "a shared session's commit");
    const head = advanceOrigin();
    refreshRemoteCheckout(host, laptop, remote);
    expect(git(remote, "rev-parse", "HEAD")).toBe(rootWork);
    const ws = await acquireRemoteWorkspace(host, remote, "cloud-iso", laptop);
    expect(ws.branch).toBe("codecast/cloud-iso");
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(head);
    expect(fs.existsSync(path.join(ws.path, "shared-work.txt"))).toBe(false);
    expect(git(remote, "rev-parse", "HEAD")).toBe(rootWork);
    expect(git(remote, "rev-parse", "--abbrev-ref", "HEAD")).toBe("codecast/cloud-shared");
  }, 60_000);
});

describe("laptop seed: where a cloud worktree starts (ct-49433)", () => {
  const runner = () => {
    const file = path.join(dir, "workspace-cli.ts");
    fs.writeFileSync(file, `
import { Command } from ${JSON.stringify(import.meta.resolve("commander"))};
import { registerWorkspaceCommand } from ${JSON.stringify(path.resolve(import.meta.dir, "../workspace/cli.ts"))};
const program = new Command();
registerWorkspaceCommand(program);
await program.parseAsync(process.argv);
`);
    process.env.CLOUD_TEST_WS_COMMAND = `${shq(process.execPath)} ${shq(file)}`;
  };
  /** A PreparedHost for seedForHost without a wake: the fields the seed step reads. */
  const prepared = (mainHead: string, seedCwd = laptop): PreparedHost =>
    ({ cloud: { id: "i-test" } as any, host, deviceId: "0123456789abcdef", repoPath: remote, repoRoot: laptop, seedCwd, mainHead });
  const seedRefs = () => spawnSync("git", ["-C", remote, "for-each-ref", "--format=%(refname)", "refs/codecast/cloud"], { encoding: "utf-8" }).stdout.trim().split("\n").filter(Boolean);
  const branches = (repo: string) => git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean);

  beforeEach(() => {
    forgetHostCapabilities();
    fs.mkdirSync(publisher);
    git(dir, "init", "-q", "--bare", "--initial-branch=main", origin);
    git(publisher, "init", "-q", "--initial-branch=main");
    // .codecast/workspaces is deliberately NOT ignored: the exclusion must come from the seed itself.
    commit(publisher, ".gitignore", ".env\nsecrets/\n.codecast/worktrees/\n");
    commit(publisher, "app.txt", "initial main\n");
    commit(publisher, "tracked.txt", "tracked v1\n");
    git(publisher, "remote", "add", "origin", origin);
    git(publisher, "push", "-q", "origin", "main");
    commit(publisher, ".codecast/workspace.toml", '[setup]\ncopy = [".env"]\ninstall = ["true"]\n');
    git(publisher, "push", "-q", "origin", "main");
    git(dir, "clone", "-q", origin, laptop);
    runner();
  }, 30_000);

  /** The laptop on feat/x with an unpushed commit, a modified tracked file, an untracked file, a gitignored secret and a Chrome profile. */
  function dirtyFeatureLaptop(): { head: string } {
    git(laptop, "checkout", "-qb", "feat/x");
    const head = commit(laptop, "feature.txt", "unpushed feature commit\n");
    write(laptop, "tracked.txt", "tracked v2 (uncommitted)\n");
    write(laptop, "new-untracked.txt", "untracked work\n");
    write(laptop, ".env", "SECRET_VALUE\n");
    write(laptop, ".codecast/workspaces/w1/chrome-profile/Cookies", "COOKIE_JAR\n");
    return { head };
  }

  test("seeds the worktree from the laptop checkout: branch, HEAD, uncommitted and untracked files, secrets kept out", async () => {
    const { head } = dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    const before = laptopState();
    const seed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    expect(seed).toMatchObject({ source: "checkout", base: head, branch: "feat/x", dirty: true, laptopRoot: laptop });
    expect(seed.reason).toBeUndefined();
    expect(seed.snapshot).toMatch(/^[0-9a-f]{40}$/);
    const ws = await acquireRemoteWorkspace(host, remote, "cloud-ab12cd", laptop, seed, { onProgress: () => {} });
    expect(ws.branch).toBe("feat/x");
    expect(ws.head).toBe(head);
    expect(ws.seed).toMatchObject({ source: "checkout", base: head, branch: "feat/x", dirty: true, ref: "refs/codecast/cloud/cloud-ab12cd" });
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/x");
    expect(git(ws.path, "log", "-1", "--format=%s")).not.toBe("codecast wip snapshot");
    const status = git(ws.path, "status", "--porcelain").split("\n").map((l) => l.trim()).sort();
    expect(status).toContain("M tracked.txt");
    expect(status).toContain("?? new-untracked.txt");
    expect(fs.readFileSync(path.join(ws.path, "tracked.txt"), "utf8")).toBe("tracked v2 (uncommitted)\n");
    expect(fs.readFileSync(path.join(ws.path, "feature.txt"), "utf8")).toBe("unpushed feature commit\n");
    // The secret arrives through the manifest copy, never through git.
    expect(fs.readFileSync(path.join(ws.path, ".env"), "utf8")).toBe("SECRET_VALUE\n");
    expect(git(ws.path, "ls-files").split("\n")).not.toContain(".env");
    expect(git(remote, "ls-tree", "-r", "--name-only", "refs/codecast/cloud/cloud-ab12cd").split("\n")).not.toContain(".env");
    // The Chrome profile is excluded by the seed, not by any ignore file.
    expect(fs.existsSync(path.join(ws.path, ".codecast/workspaces/w1"))).toBe(false);
    expect(git(remote, "ls-tree", "-r", "--name-only", "refs/codecast/cloud/cloud-ab12cd")).not.toContain("Cookies");
    // Hidden ref: never a branch; the main checkout is untouched; the laptop is untouched.
    expect(git(remote, "ls-remote", "--heads", remote)).not.toContain("refs/codecast");
    expect(seedRefs()).toEqual(["refs/codecast/cloud/cloud-ab12cd"]);
    expect(git(remote, "rev-parse", "HEAD")).toBe(mainHead);
    expect(laptopState()).toEqual(before);
    expect(sshLog().some((l) => l.includes("git-receive-pack"))).toBe(true);
    expect(fs.readFileSync(process.env.CLOUD_TEST_LOG!, "utf-8")).not.toContain("SECRET_VALUE");
    // The state records the seed for the GC and heal.
    const state = readState(remote, ws.name)!;
    expect(state).toMatchObject({ branch: "feat/x", startPoint: "refs/codecast/cloud/cloud-ab12cd", seedBase: head });
    expect(listDanglingSeedRefs(host, remote)).toEqual([]);
  }, 60_000);

  test("the seed ref is pushed only after the name is reserved, and dropped when the acquire fails after the push", async () => {
    dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    const seed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    // A pre-existing worktree dir fails the reservation: nothing was pushed.
    fs.mkdirSync(path.join(remote, ".codecast/worktrees/cloud-taken0"), { recursive: true });
    await expect(acquireRemoteWorkspace(host, remote, "cloud-taken0", laptop, seed)).rejects.toThrow("reserve inputs for workspace cloud-taken0");
    expect(seedRefs()).toEqual([]);
    expect(sshLog().some((l) => l.includes("git-receive-pack"))).toBe(false);
    // The host's acquire fails after the push: the ref is deleted again.
    write(laptop, ".codecast/workspace.toml", '[setup]\ncopy = [".env"]\ninstall = ["exit 7"]\n');
    await expect(acquireRemoteWorkspace(host, remote, "cloud-fail01", laptop, seed)).rejects.toThrow("cast ws acquire cloud-fail01 failed on the host");
    expect(sshLog().some((l) => l.includes("git-receive-pack"))).toBe(true);
    expect(seedRefs()).toEqual([]);
  }, 60_000);

  test("a clean laptop yields a clean worktree at the laptop HEAD; a detached HEAD seeds codecast/<name>; laptop main seeds main-<hex>", async () => {
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    // Clean, on main: the host has a local `main`, so the alternate name lands.
    const cleanSeed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    expect(cleanSeed).toMatchObject({ source: "checkout", base: mainHead, branch: "main", dirty: false });
    const onMain = await acquireRemoteWorkspace(host, remote, "cloud-aaa111", laptop, cleanSeed);
    expect(onMain.branch).toBe("main-aaa111");
    expect(git(onMain.path, "rev-parse", "HEAD")).toBe(mainHead);
    // Only the workspace's own setup log is new; nothing of the laptop's.
    expect(git(onMain.path, "status", "--porcelain").split("\n").filter((l) => l && !l.includes(".codecast/logs/"))).toEqual([]);
    // Detached at a new commit.
    git(laptop, "checkout", "-q", "--detach");
    const detachedHead = commit(laptop, "detached.txt", "detached work\n");
    const detachedSeed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    expect(detachedSeed.branch).toBeUndefined();
    const detached = await acquireRemoteWorkspace(host, remote, "cloud-bbb222", laptop, detachedSeed);
    expect(detached.branch).toBe("codecast/cloud-bbb222");
    expect(git(detached.path, "rev-parse", "HEAD")).toBe(detachedHead);
  }, 90_000);

  test("two sessions from one laptop branch get feat/x then feat/x-<hex>, and re-seeding the same tree is a no-op", async () => {
    const { head } = dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    const seed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    const first = await acquireRemoteWorkspace(host, remote, "cloud-111aaa", laptop, seed);
    const second = await acquireRemoteWorkspace(host, remote, "cloud-222bbb", laptop, seed);
    expect(first.branch).toBe("feat/x");
    expect(second.branch).toBe("feat/x-222bbb");
    expect(git(second.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(remote, "rev-parse", "refs/codecast/cloud/cloud-111aaa")).toBe(git(remote, "rev-parse", "refs/codecast/cloud/cloud-222bbb"));
    // The same laptop tree snapshots to the same commit: a re-run changes nothing.
    const again = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    expect(again.snapshot).toBe(seed.snapshot);
    expect(again.tree).toBe(seed.tree);
  }, 90_000);

  test("two concurrent acquires from one laptop branch both succeed: one lands feat/x, the other the alternate", async () => {
    const { head } = dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    const seed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    const script = path.join(dir, "acquire-one.ts");
    fs.writeFileSync(script, `
import { acquireRemoteWorkspace } from ${JSON.stringify(path.resolve(import.meta.dir, "prepare.ts"))};
const [hostJson, repo, name, seedCwd, seedJson] = process.argv.slice(2);
try {
  const ws = await acquireRemoteWorkspace(JSON.parse(hostJson), repo, name, seedCwd, JSON.parse(seedJson));
  console.log(JSON.stringify(ws));
} catch (err) {
  console.log(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
}
`);
    const run = (name: string) => Bun.spawn([process.execPath, script, JSON.stringify(host), remote, name, laptop, JSON.stringify(seed)], { stdout: "pipe", stderr: "pipe", env: process.env });
    const a = run("cloud-c0ffee");
    const b = run("cloud-dec0de");
    const [outA, outB, errA, errB, codeA, codeB] = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text(), new Response(a.stderr).text(), new Response(b.stderr).text(), a.exited, b.exited]);
    if (codeA !== 0) throw new Error(`child A exit ${codeA}: stdout=${outA.slice(-800)} stderr=${errA.slice(-800)}`);
    if (codeB !== 0) throw new Error(`child B exit ${codeB}: stdout=${outB.slice(-800)} stderr=${errB.slice(-800)}`);
    const wsA = JSON.parse(outA.trim().split("\n").pop()!);
    const wsB = JSON.parse(outB.trim().split("\n").pop()!);
    expect([wsA.branch, wsB.branch].sort()).toEqual(wsA.branch === "feat/x" ? ["feat/x", "feat/x-dec0de"] : ["feat/x", "feat/x-c0ffee"]);
    expect(git(wsA.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(wsB.path, "rev-parse", "HEAD")).toBe(head);
  }, 120_000);

  test("a seed push failure with checkout requested is fatal and never echoes transport output", async () => {
    dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    const seed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    process.env.CLOUD_TEST_FAIL_SEED_PUSH = "1";
    let error: Error | undefined;
    try { await acquireRemoteWorkspace(host, remote, "cloud-push01", laptop, seed); } catch (e) { error = e as Error; }
    expect(error?.message).toBe("push laptop seed for cloud-push01 to cloud checkout failed (exit 128)");
    expect(error?.message).not.toContain("SECRET_VALUE");
    expect(seedRefs()).toEqual([]);
    expect(sshLog().some((l) => l.includes("cast ws acquire cloud-push01"))).toBe(false);
  }, 60_000);

  test("a transport failure on the capability probe is fatal with checkout requested, never a silent origin/main, and is not remembered", async () => {
    dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    process.env.CLOUD_TEST_FAIL_HELP = "1";
    expect(() => hostSupportsStartPoint(host)).toThrow("cannot check whether the host's cast supports seeded worktrees: ssh: connect to host cloud-test.invalid port 22: Connection refused");
    await expect(seedForHost(prepared(mainHead), { startFrom: "checkout" })).rejects.toThrow("cannot check whether the host's cast supports seeded worktrees");
    // origin/main never asks the host.
    fs.rmSync(process.env.CLOUD_TEST_LOG!, { force: true });
    const om = await seedForHost(prepared(mainHead), { startFrom: "origin_main" });
    expect(om.source).toBe("origin_main");
    expect(sshLog().some((l) => l.includes("--help"))).toBe(false);
    // The failure was not cached: the next probe asks again and gets the real answer.
    delete process.env.CLOUD_TEST_FAIL_HELP;
    expect(hostSupportsStartPoint(host)).toBe(true);
  }, 60_000);

  test("a host cast without --start-point downgrades to origin/main with a reason; origin_main never snapshots", async () => {
    dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    process.env.CLOUD_TEST_NO_START_POINT = "1";
    expect(hostSupportsStartPoint(host)).toBe(false);
    const old = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    expect(old).toMatchObject({ source: "origin_main", base: mainHead, reason: "host cast predates seeded worktrees — cast hosts provision i-test" });
    expect(old.snapshot).toBeUndefined();
    delete process.env.CLOUD_TEST_NO_START_POINT;
    forgetHostCapabilities();
    expect(hostSupportsStartPoint(host)).toBe(true);
    const om = await seedForHost(prepared(mainHead), { startFrom: "origin_main" });
    expect(om).toEqual({ source: "origin_main", base: mainHead, deviceId: om.deviceId });
    fs.rmSync(process.env.CLOUD_TEST_LOG!, { force: true });
    const ws = await acquireRemoteWorkspace(host, remote, "cloud-om0001", laptop, om);
    expect(ws.branch).toBe("codecast/cloud-om0001");
    expect(ws.head).toBe(mainHead);
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(mainHead);
    expect(fs.existsSync(path.join(ws.path, "feature.txt"))).toBe(false);
    expect(sshLog().some((l) => l.includes("git-receive-pack"))).toBe(false);
    expect(seedRefs()).toEqual([]);
  }, 90_000);

  test("a non-repo seedCwd downgrades with a reason; a git failure after HEAD resolves is fatal", async () => {
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    const plain = path.join(dir, "not a repo");
    fs.mkdirSync(plain);
    await expect(planLaptopSeed(plain)).rejects.toBeInstanceOf(CloudSeedUnavailable);
    const down = await seedForHost(prepared(mainHead, plain), { startFrom: "checkout" });
    expect(down).toMatchObject({ source: "origin_main", base: mainHead });
    expect(down.reason).toContain("is not a git checkout with commits");
    // HEAD resolves but the snapshot cannot be taken (an unreadable file): fatal, with git's line.
    write(laptop, "locked.txt", "cannot read me\n");
    fs.chmodSync(path.join(laptop, "locked.txt"), 0o000);
    try {
      await expect(seedForHost(prepared(mainHead), { startFrom: "checkout" })).rejects.toThrow(/^seed snapshot failed: /);
    } finally {
      fs.chmodSync(path.join(laptop, "locked.txt"), 0o644);
    }
  }, 60_000);

  test("an invalid refname worktree name is rejected locally before any ssh; finishSeededWorktree refuses a non-sha", async () => {
    dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    const seed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    fs.rmSync(process.env.CLOUD_TEST_LOG!, { force: true });
    for (const name of ["a..b", "x.lock"]) {
      await expect(acquireRemoteWorkspace(host, remote, name, laptop, seed)).rejects.toBeInstanceOf(CloudSeedNameError);
    }
    expect(fs.existsSync(process.env.CLOUD_TEST_LOG!)).toBe(false);
    expect(() => finishSeededWorktree(host, "/x", { ...seed, base: "abc1234", ref: "refs/codecast/cloud/x" } as CloudSeed)).toThrow("missing a full sha");
    expect(() => finishSeededWorktree(host, "/x", { ...seed, ref: undefined } as CloudSeed)).toThrow("missing a full sha");
  }, 60_000);

  test("a linked worktree as cwd: the host repo is named after the MAIN repo and the snapshot/inputs come from the worktree", async () => {
    const { resolveSeedRoots } = await import("./prepare");
    const linked = path.join(dir, "linked-wt");
    git(laptop, "worktree", "add", "-q", "-b", "feat/linked", linked);
    write(linked, ".codecast/workspace.toml", '[setup]\ncopy = [".env"]\ninstall = ["true"]\n');
    write(linked, ".env", "LINKED_SECRET\n");
    write(linked, "only-in-worktree.txt", "from the linked worktree\n");
    const roots = resolveSeedRoots(path.join(linked, "."));
    expect(roots).toEqual({ seedCwd: fs.realpathSync(linked), repoRoot: fs.realpathSync(laptop) });
    const mainHead = refreshRemoteCheckout(host, roots.repoRoot, remote).head;
    const seed = await seedForHost(prepared(mainHead, roots.seedCwd), { startFrom: "checkout" });
    expect(seed.branch).toBe("feat/linked");
    const ws = await acquireRemoteWorkspace(host, remote, "cloud-link01", roots.seedCwd, seed);
    expect(ws.branch).toBe("feat/linked");
    expect(fs.readFileSync(path.join(ws.path, "only-in-worktree.txt"), "utf8")).toBe("from the linked worktree\n");
    expect(fs.readFileSync(path.join(ws.path, ".env"), "utf8")).toBe("LINKED_SECRET\n");
  }, 60_000);

  test("destroying a seeded worktree drops its seed ref and its unchanged branch; `cast hosts ls` sees a leftover ref as dangling", async () => {
    dirtyFeatureLaptop();
    const mainHead = refreshRemoteCheckout(host, laptop, remote).head;
    const seed = await seedForHost(prepared(mainHead), { startFrom: "checkout" });
    const ws = await acquireRemoteWorkspace(host, remote, "cloud-gone01", laptop, seed);
    expect(branches(remote)).toContain("feat/x");
    await releaseWorkspace(remote, ws.name);
    expect(fs.existsSync(ws.path)).toBe(false);
    expect(seedRefs()).toEqual([]);
    expect(branches(remote)).not.toContain("feat/x");
    // A ref with no state dir behind it is what the host list flags.
    git(remote, "update-ref", "refs/codecast/cloud/cloud-orphan", mainHead);
    expect(listDanglingSeedRefs(host, remote)).toEqual(["cloud-orphan"]);
  }, 60_000);
});
