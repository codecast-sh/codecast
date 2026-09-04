import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cloudCopyFiles, copyCloudFiles, refreshRemoteCheckout } from "./transfer";
import { acquireRemoteWorkspace, prepareCloudHost } from "./prepare";
import { shq, type RemoteHost } from "../remote/session-move";
import { healWorkspace, releaseWorkspace } from "../workspace/lifecycle";
import { readState } from "../workspace/contract";

let dir: string, origin: string, laptop: string, publisher: string, remote: string, host: RemoteHost;
let savedEnv: NodeJS.ProcessEnv;

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
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cloud-transfer-test-")));
  origin = path.join(dir, "origin.git");
  publisher = path.join(dir, "publisher");
  laptop = path.join(dir, "laptop repo");
  remote = path.join(dir, "remote repo");
  fs.mkdirSync(laptop);
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
if (process.env.CLOUD_TEST_FAIL_ORIGIN && (command.includes("git fetch -q") || (command.startsWith("git clone -q") && !command.includes("main.bundle")))) {
  if (process.env.CLOUD_TEST_OCCUPY) {
    fs.mkdirSync(process.env.CLOUD_TEST_OCCUPY, { recursive: true });
    fs.writeFileSync(process.env.CLOUD_TEST_OCCUPY + "/user-work", "preserve me");
  }
  process.exit(128);
}
if (process.env.CLOUD_TEST_FAIL_TRANSFER && (command.includes("bun -e") || command.includes("git-receive-pack") || command.includes("cat >"))) {
  process.stdout.write("SECRET_VALUE"); process.stderr.write("SECRET_VALUE"); process.exit(9);
}
if (command.includes("cast ws acquire")) {
  if (process.env.CLOUD_TEST_WS_COMMAND) {
    command = command.replace("cast ws acquire", process.env.CLOUD_TEST_WS_COMMAND + " ws acquire");
  } else {
    process.stdout.write(process.env.CLOUD_TEST_ACQUIRE || "{}");
    process.exit(Number(process.env.CLOUD_TEST_ACQUIRE_STATUS || "0"));
  }
}
let input;
if (command.includes('cat > "$stage/main.bundle"')) {
  input = fs.readFileSync(0);
  fs.writeFileSync(process.env.CLOUD_TEST_BUNDLE, input, { mode: 0o600 });
}
const r = spawnSync("/bin/sh", ["-c", command], { stdio: input ? ["pipe", "inherit", "inherit"] : "inherit", input });
process.exit(r.status ?? 1);
`, { mode: 0o700 });
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.CLOUD_TEST_LOG = path.join(dir, "ssh.log");
  process.env.CLOUD_TEST_BUNDLE = path.join(dir, "received.bundle");
  process.env.CODECAST_DIR = path.join(dir, "host-state");
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  fs.rmSync(dir, { recursive: true, force: true });
});

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
      const ws = acquireRemoteWorkspace(host, remote, `cloud-${label}`, laptop);
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
    expect(() => acquireRemoteWorkspace(host, remote, one!.name, laptop)).toThrow("reserve inputs for workspace cloud-one");
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

  test("clones real origin first and ignores laptop HEAD/default branch", () => {
    git(laptop, "checkout", "-qb", "private");
    commit(laptop, "private.txt", "private local branch");
    git(laptop, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/private");
    const head = advanceOrigin();
    const before = laptopState();
    expect(refreshRemoteCheckout(host, laptop, remote)).toEqual({ branch: "main", head, reset: true });
    expect(git(remote, "remote", "get-url", "origin")).toBe(origin);
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
    expect(refreshRemoteCheckout(host, laptop, remote).head).toBe(head);
    expect(git(remote, "rev-parse", "moved-session")).toBe(moved);
    expect(git(remote, "rev-parse", "HEAD")).toBe(head);
    expect(git(remote, "rev-parse", "origin/main")).toBe(head);
    expect(laptopState()).toEqual(before);
  }, 30_000);

  test("missing-repo fallback bundles only fresh main, excluding private branches and tags", () => {
    git(laptop, "checkout", "-qb", "private");
    const privateHead = commit(laptop, "private.txt", "must not transfer");
    git(laptop, "tag", "private-tag");
    const head = advanceOrigin();
    process.env.CLOUD_TEST_FAIL_ORIGIN = "1";
    const before = laptopState();
    expect(refreshRemoteCheckout(host, laptop, remote).head).toBe(head);
    expect(git(dir, "bundle", "list-heads", process.env.CLOUD_TEST_BUNDLE!)).toBe(`${head} refs/heads/main`);
    expect(spawnSync("git", ["-C", remote, "cat-file", "-e", privateHead]).status).not.toBe(0);
    expect(git(remote, "tag", "--list")).toBe("");
    expect(laptopState()).toEqual(before);
  }, 30_000);

  test("refreshes an existing checkout directly from origin without moving its main branch", () => {
    git(dir, "clone", "-q", origin, remote);
    const oldMain = git(remote, "rev-parse", "main");
    const head = advanceOrigin();
    expect(refreshRemoteCheckout(host, laptop, remote).head).toBe(head);
    expect(git(remote, "rev-parse", "main")).toBe(oldMain);
    expect(git(remote, "rev-parse", "origin/main")).toBe(head);
  }, 30_000);

  test("preserves dirty moved worktrees whose .git is a file", () => {
    git(laptop, "worktree", "add", "-qb", "moved-session", remote);
    write(remote, "app.txt", "moved session edits");
    expect(fs.statSync(path.join(remote, ".git")).isFile()).toBe(true);
    expect(() => refreshRemoteCheckout(host, laptop, remote)).toThrow("dirty moved session");
    expect(fs.readFileSync(path.join(remote, "app.txt"), "utf-8")).toBe("moved session edits");
  }, 30_000);

  test.each(["tracked", "staged", "untracked"])("refuses %s moved-session edits without changing files or refs", (kind) => {
    git(dir, "clone", "-q", origin, remote);
    const rel = kind === "untracked" ? "user-work.txt" : "app.txt";
    write(remote, rel, "preserve me");
    if (kind === "staged") git(remote, "add", rel);
    const refs = git(remote, "show-ref");
    const status = git(remote, "status", "--porcelain");
    advanceOrigin();
    expect(() => refreshRemoteCheckout(host, laptop, remote)).toThrow(/uncommitted changes.*dirty moved session/);
    expect(fs.readFileSync(path.join(remote, rel), "utf-8")).toBe("preserve me");
    expect(git(remote, "show-ref")).toBe(refs);
    expect(git(remote, "status", "--porcelain")).toBe(status);
  });

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
    await expect(prepareCloudHost({ hostArg: "must-not-wake", localGitRoot: laptop })).rejects.toThrow("invalid workspace manifest; fix .codecast/workspace.toml before cloud acquire");
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

test.each(["state", "worktree"])("existing %s prevents any input recopy before acquire", (kind) => {
  write(laptop, ".env", "new secret");
  const occupied = path.join(remote, kind === "state" ? ".codecast/workspaces/cloud-1/inputs" : ".codecast/worktrees/cloud-1");
  write(occupied, ".env", "original snapshot");
  expect(() => acquireRemoteWorkspace(host, remote, "cloud-1", laptop)).toThrow("reserve inputs for workspace cloud-1");
  expect(fs.readFileSync(path.join(occupied, ".env"), "utf8")).toBe("original snapshot");
  expect(fs.readFileSync(process.env.CLOUD_TEST_LOG!, "utf8")).not.toContain("cast ws acquire");
});

test("input reservation refuses symlink destinations without copying secrets", () => {
  write(laptop, ".env", "new secret");
  fs.mkdirSync(path.join(remote, ".codecast"), { recursive: true });
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(remote, ".codecast/workspaces"));
  expect(() => acquireRemoteWorkspace(host, remote, "cloud-1", laptop)).toThrow("reserve inputs for workspace cloud-1");
  expect(fs.readdirSync(outside)).toEqual([]);
});

test("unconfirmed input reservation aborts before copy and acquire", () => {
  write(laptop, ".env", "new secret");
  process.env.CLOUD_TEST_UNCONFIRMED = "1";
  expect(() => acquireRemoteWorkspace(host, remote, "cloud-1", laptop)).toThrow("input reservation for workspace cloud-1 was not confirmed");
  expect(fs.existsSync(remote)).toBe(false);
});

test("failed acquisition preserves work and never accepts success JSON from a failed process", () => {
  write(remote, "user-work", "preserve me");
  git(remote, "init", "-q", "-b", "main");
  process.env.CLOUD_TEST_ACQUIRE = JSON.stringify({ name: "cloud-1", state: "ready", contract: { ok: true, failures: [] }, path: remote, ports: {}, branch: "codecast/cloud-1", created: true });
  process.env.CLOUD_TEST_ACQUIRE_STATUS = "2";
  expect(() => acquireRemoteWorkspace(host, remote, "cloud-1", laptop)).toThrow("cast ws acquire cloud-1 failed on the host");
  expect(fs.readFileSync(path.join(remote, "user-work"), "utf-8")).toBe("preserve me");
});
