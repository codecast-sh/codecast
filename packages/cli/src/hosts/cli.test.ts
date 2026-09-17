import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AGENT_BRIDGE_SECURITY_NOTE, briefError, EC2_HOURLY_USD, estimateHostCost, forwardAgentRefusal, gitStatusLine,
  GP3_USD_PER_GIB_MONTH, GH_NOT_LOGGED_IN_MESSAGE, grantDeployKey, hostGitReport, KEY_ALREADY_IN_USE_MESSAGE, keyReportLines, markOrphanWorktrees,
  parseDanglingSeeds, parseRemoteWorkspaceList, readRemoteWorktrees, REMOTE_DANGLING_SEEDS_SCRIPT, worktreeGitLabel, REMOTE_WORKSPACE_LIST_SCRIPT, sessionLine, sessionSeed, sessionWhere, worktreeNote, type HostSession, type RemoteWorktree,
} from "./cli.js";
import { execFileSync } from "node:child_process";
import type { CloudHost } from "../browser/cloudHost.js";
import type { HostGitState } from "../cloud/hostGit.js";

function session(worktree: string | null, over: Partial<HostSession> = {}): HostSession {
  return {
    conversation_id: "conv_1", short_id: "abc1234", title: "t", status: "active", work_state: "working",
    worktree_name: worktree, worktree_branch: null, project_path: null, updated_at: 1,
    cloud_workspace: null, cloud_placement: null, cloud_checkout_path: null, session_error: false, ...over,
  };
}

function worktree(name: string): RemoteWorktree {
  return { repo: "codecast", name, state: "ready", branch: `ws/${name}`, path: `/p/${name}` };
}

describe("estimateHostCost", () => {
  test("a sleeping host is billed for its disk and nothing else", () => {
    const c = estimateHostCost({ instanceType: "t3.large", volumeGiB: 30, state: "stopped" });
    expect(c.diskMonthlyUsd).toBeCloseTo(30 * GP3_USD_PER_GIB_MONTH, 6);
    expect(c.line).toBe("asleep: about $2.40/month (disk only)");
    // The hourly rate is still reported for a caller that wants it (--json),
    // but the sentence must not imply the machine is burning it right now.
    expect(c.hourlyUsd).toBe(EC2_HOURLY_USD["t3.large"]);
    expect(c.line).not.toContain("hour");
  });

  test("an awake host shows both the burn and the disk it keeps costing", () => {
    const c = estimateHostCost({ instanceType: "t3.medium", volumeGiB: 20, state: "running" });
    expect(c.line).toBe("awake: about $0.0416/hour running, about $1.60/month disk");
  });

  test("an unpriced instance type says so instead of guessing", () => {
    const c = estimateHostCost({ instanceType: "t4g.nano", volumeGiB: 8, state: "running" });
    expect(c.hourlyUsd).toBeNull();
    expect(c.line).toBe("awake: rate unknown for t4g.nano, about $0.64/month disk");
  });

  test("an unreadable disk is admitted, not assumed to be zero", () => {
    expect(estimateHostCost({ instanceType: "t3.small", state: "running" }).line).toBe(
      "awake: about $0.0208/hour running, disk size unknown",
    );
    expect(estimateHostCost({ state: "stopped" }).line).toBe("asleep: disk size unknown");
  });

  test("a terminated instance bills nothing at all", () => {
    expect(estimateHostCost({ instanceType: "t3.large", volumeGiB: 30, state: "missing" }).line).toBe(
      "gone: nothing left to bill",
    );
  });

  test("a state we cannot read is priced as asleep rather than as a burn", () => {
    expect(estimateHostCost({ instanceType: "t3.large", volumeGiB: 10, state: "unknown" }).line).toContain("asleep");
  });
});

describe("parseRemoteWorkspaceList", () => {
  const out = [
    "## /home/ubuntu/work/codecast/",
    "NAME          STATE       BRANCH                PATH",
    "cloud-1a2b3c  ready       ws/cloud-1a2b3c       /home/ubuntu/work/codecast/.codecast/worktrees/cloud-1a2b3c",
    "fix-auth      broken      ws/fix-auth           /home/ubuntu/work/codecast/.codecast/worktrees/fix-auth",
    "## /home/ubuntu/work/mail/",
    "(no workspaces)",
    "",
  ].join("\n");

  test("reads every worktree and remembers which checkout it belongs to", () => {
    const rows = parseRemoteWorkspaceList(out);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      repo: "codecast",
      name: "cloud-1a2b3c",
      state: "ready",
      branch: "ws/cloud-1a2b3c",
      path: "/home/ubuntu/work/codecast/.codecast/worktrees/cloud-1a2b3c",
    });
    expect(rows[1].state).toBe("broken");
    expect(rows.every((r) => r.repo === "codecast")).toBe(true);
  });

  test("a checkout with no worktrees contributes no rows", () => {
    expect(parseRemoteWorkspaceList("## /home/ubuntu/work/mail/\n(no workspaces)\n")).toEqual([]);
  });

  test("shell noise never becomes a phantom worktree", () => {
    // Anything the remote shell says on the way — a missing binary, a warning,
    // a stray banner — has fewer than four columns and is dropped. Inventing a
    // worktree here would make `ls` claim work exists that does not.
    const noisy = [
      "bash: line 1: cast: command not found",
      "## /home/ubuntu/work/codecast/",
      "warning: something happened",
      "NAME  STATE  BRANCH  PATH",
      "a     ready  ws/a    /home/ubuntu/work/codecast/.codecast/worktrees/a",
    ].join("\n");
    expect(parseRemoteWorkspaceList(noisy).map((r) => r.name)).toEqual(["a"]);
  });

  test("colour codes from a host that thinks it has a terminal are stripped", () => {
    const coloured = `## /home/ubuntu/work/codecast/\n\x1b[2ma\x1b[0m     ready  ws/a    /p/a`;
    expect(parseRemoteWorkspaceList(coloured)[0].name).toBe("a");
  });
});

describe("REMOTE_WORKSPACE_LIST_SCRIPT", () => {
  test("only enters checkouts that codecast actually manages", () => {
    expect(REMOTE_WORKSPACE_LIST_SCRIPT).toContain(".codecast/workspace.toml");
    expect(REMOTE_WORKSPACE_LIST_SCRIPT).toContain("cast ws ls");
    // The `## ` marker is what ties each table back to its checkout.
    expect(REMOTE_WORKSPACE_LIST_SCRIPT).toContain('echo "## $d"');
  });
});

describe("live worktree git state over the host probe", () => {
  let dir: string, saved: NodeJS.ProcessEnv;
  beforeEach(() => {
    saved = { ...process.env };
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cast-hosts-live-")));
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8", stdio: "pipe" }).trim();
  const commitAll = (cwd: string, msg: string) => git(cwd, "-c", "user.name=T", "-c", "user.email=t@test.local", "-c", "commit.gpgsign=false", "commit", "-qam", msg);

  test("one ssh reports each worktree's current branch, HEAD and uncommitted changes, plus the main checkout", () => {
    // The fake host: HOME with ~/work/app (a codecast checkout) and one worktree that moved off its start branch.
    const home = path.join(dir, "home");
    const app = path.join(home, "work", "app");
    const other = path.join(home, "work", "notes");
    fs.mkdirSync(path.join(app, ".codecast"), { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    Object.assign(process.env, { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
    git(app, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(app, ".gitignore"), ".codecast/worktrees/\n");
    fs.writeFileSync(path.join(app, ".codecast", "workspace.toml"), "");
    git(app, "add", ".");
    commitAll(app, "init");
    const mainHead = git(app, "rev-parse", "HEAD");
    const wt = path.join(app, ".codecast", "worktrees", "cloud-1");
    git(app, "worktree", "add", "-q", "-b", "ws/cloud-1", wt);
    git(wt, "checkout", "-q", "-b", "feat/moved");
    fs.writeFileSync(path.join(wt, "work.txt"), "a\n");
    git(wt, "add", "work.txt");
    commitAll(wt, "host work");
    const wtHead = git(wt, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(wt, "work.txt"), "b\n");

    // The host's cast answers `cast ws ls` with its start branch; ssh runs the remote command locally and logs it.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "cast"), `#!/bin/sh\nprintf 'NAME     STATE  BRANCH      PATH\\ncloud-1  ready  ws/cloud-1  %s\\n' ${JSON.stringify(wt)}\n`, { mode: 0o755 });
    const log = path.join(dir, "ssh.log");
    fs.writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\nfor a; do last="$a"; done\necho call >> ${JSON.stringify(log)}\nexec bash -c "$last"\n`, { mode: 0o755 });
    process.env.PATH = `${bin}:${process.env.PATH}`;

    const rows = readRemoteWorktrees({ address: "host.invalid", user: "ubuntu", keyPath: path.join(dir, "key"), remoteBaseDir: dir }, 30_000);
    expect(fs.readFileSync(log, "utf-8")).toBe("call\n");
    expect(rows).toEqual([
      { repo: "app", name: "cloud-1", state: "ready", branch: "ws/cloud-1", path: wt, live: { branch: "feat/moved", head: wtHead, dirty: true } },
      { repo: "app", name: "shared-checkout", state: "", branch: "", path: app, live: { branch: "main", head: mainHead, dirty: false } },
    ]);
    expect(worktreeGitLabel(rows[0].live!)).toBe(`feat/moved@${wtHead.slice(0, 7)}, uncommitted changes`);
    expect(worktreeGitLabel(rows[1].live!)).toBe(`main@${mainHead.slice(0, 7)}`);

    // A detached HEAD and a branch with no commits still read plainly.
    git(wt, "checkout", "-q", "--detach");
    const detached = readRemoteWorktrees({ address: "host.invalid", user: "ubuntu", keyPath: path.join(dir, "key"), remoteBaseDir: dir }, 30_000);
    expect(worktreeGitLabel(detached[0].live!)).toBe(`detached HEAD@${wtHead.slice(0, 7)}, uncommitted changes`);
    expect(worktreeGitLabel({ branch: "main", head: "", dirty: false })).toBe("main, no commits");
  });

  test("a shared-checkout record already naming the main checkout is not listed twice", () => {
    const out = "## /h/work/app/\nNAME  STATE  BRANCH  PATH\nshared-checkout  ready  main  /h/work/app\n@@\t/h/work/app\tmain\tabc1234def\t\n";
    expect(parseRemoteWorkspaceList(out)).toEqual([
      { repo: "app", name: "shared-checkout", state: "ready", branch: "main", path: "/h/work/app", live: { branch: "main", head: "abc1234def", dirty: false } },
    ]);
  });
});

describe("markOrphanWorktrees", () => {
  test("a worktree nobody is sitting in is an orphan", () => {
    const rows = markOrphanWorktrees([worktree("live"), worktree("left-behind")], [session("live")]);
    expect(rows.map((r) => [r.name, r.hasSession])).toEqual([["live", true], ["left-behind", false]]);
  });

  test("sessions with no worktree claim nothing", () => {
    // A session running in the main checkout has no worktree_name. Treating
    // that as a claim would clear the orphan flag off an unrelated worktree.
    const rows = markOrphanWorktrees([worktree("left-behind")], [session(null), session(null)]);
    expect(rows[0].hasSession).toBe(false);
  });

  test("every other column survives the tagging", () => {
    const [row] = markOrphanWorktrees([worktree("a")], [session("a")]);
    expect(row).toEqual({ ...worktree("a"), hasSession: true });
  });

  test("the shared-checkout record is attributed by PATH to the session in the main checkout (ct-49428)", () => {
    const root: RemoteWorktree = { repo: "codecast", name: "shared-checkout", state: "ready", branch: "codecast/cloud-abc123", path: "/home/ubuntu/work/codecast" };
    const shared = session(null, { project_path: "/home/ubuntu/work/codecast", cloud_workspace: "shared", cloud_checkout_path: "/home/ubuntu/work/codecast" });
    expect(markOrphanWorktrees([root], [shared])[0].hasSession).toBe(true);
    // A pending claim names the checkout before project_path moves there.
    const pending = session(null, { project_path: "/Users/me/codecast", cloud_workspace: "shared", cloud_placement: "pending", cloud_checkout_path: "/home/ubuntu/work/codecast" });
    expect(markOrphanWorktrees([root], [pending])[0].hasSession).toBe(true);
    expect(markOrphanWorktrees([root], [session(null, { project_path: "/home/ubuntu/work/other" })])[0].hasSession).toBe(false);
    // An asleep host's synthesized rows carry no path and are never attributed by it.
    expect(markOrphanWorktrees([{ ...root, path: "" }], [session(null, { project_path: "" })])[0].hasSession).toBe(false);
    // Once the shared session ends the record persists (it holds the ports): free, not a leaked worktree.
    expect(worktreeNote({ ...root, hasSession: false })).toBe("main checkout, free");
    expect(worktreeNote({ ...root, hasSession: true })).toBe("");
    expect(worktreeNote({ ...worktree("left-behind"), hasSession: false })).toBe("no session (orphan)");
  });
});

describe("sessionLine — where a session runs (ct-49428)", () => {
  test("a worktree name wins; a shared row says (shared) and (shared, pending); a plain row is its repo", () => {
    expect(sessionWhere(session("cloud-1", { cloud_workspace: "isolated" }))).toBe("cloud-1");
    expect(sessionWhere(session(null, { project_path: "/home/ubuntu/work/codecast", cloud_workspace: "shared", cloud_checkout_path: "/home/ubuntu/work/codecast" }))).toBe("codecast (shared)");
    expect(sessionWhere(session(null, { project_path: "/Users/me/codecast", cloud_workspace: "shared", cloud_placement: "pending", cloud_checkout_path: "/home/ubuntu/work/codecast" }))).toBe("codecast (shared, pending)");
    expect(sessionWhere(session(null, { project_path: "/home/ubuntu/work/codecast" }))).toBe("codecast");
    expect(sessionLine(session(null, { project_path: "/home/ubuntu/work/codecast", cloud_workspace: "shared", cloud_checkout_path: "/home/ubuntu/work/codecast" }))).toContain("codecast (shared)");
  });
});

describe("briefError", () => {
  test("prefers the child's own stderr over execFileSync's echo of the command", () => {
    // execFileSync puts the whole ssh invocation — key path, every -o flag,
    // the remote script — into `message`. Printed next to a field name that is
    // a wall of noise around one useful word.
    const err = {
      message: "Command failed: ssh -i /k -o ControlPath=/tmp/x ubuntu@1.2.3.4 for d in ~/work/*/; do …",
      stderr: "ssh: connect to host 1.2.3.4 port 22: Operation timed out\n",
    };
    expect(briefError(err)).toBe("ssh: connect to host 1.2.3.4 port 22: Operation timed out");
  });

  test("falls back to the first line of the message when there is no stderr", () => {
    expect(briefError(new Error("the aws CLI is not installed\nsecond line"))).toBe(
      "the aws CLI is not installed",
    );
  });

  test("a long reason is cut to fit one line", () => {
    expect(briefError(new Error("x".repeat(400)), 20)).toHaveLength(20);
    expect(briefError(new Error("x".repeat(400)), 20).endsWith("…")).toBe(true);
  });

  test("something thrown with nothing useful still names itself", () => {
    expect(briefError({})).toBe("failed");
  });
});

import { mirrorStatusLine, parseHostMirrorStamp } from "./cli.js";

describe("config mirror line", () => {
  const now = Date.parse("2026-09-06T12:00:00Z");
  test("never, when the host has no stamp", () => {
    expect(mirrorStatusLine(null, "dev-local", now)).toBe("never — cast hosts sync");
    expect(mirrorStatusLine(undefined, "dev-local", now)).toBe("never — cast hosts sync");
  });
  test("a verified host shows on-disk state, apply age, hash8 and file count", () => {
    const mirror = { hash: "a1b2c3d4e5f6", applied_at: "2026-09-06T11:46:00Z", files: 112, source_device_id: "dev-local", complete: true };
    expect(mirrorStatusLine(mirror, "dev-local", now)).toBe("verified on disk; applied 14m ago (a1b2c3d4, 112 files)");
    expect(mirrorStatusLine({ ...mirror, files: 1 }, "dev-local", now)).toBe("verified on disk; applied 14m ago (a1b2c3d4, 1 file)");
  });
  test("another device's stamp carries the take-over hint", () => {
    const mirror = { hash: "a1b2c3d4e5f6", applied_at: "2026-09-06T11:46:00Z", files: 3, source_device_id: "dev-other", complete: true };
    expect(mirrorStatusLine(mirror, "dev-local", now)).toBe("verified on disk; applied 14m ago (a1b2c3d4, 3 files)  (owned by another device — cast hosts sync --take-over)");
  });
  test("legacy and drifted stamps never appear verified", () => {
    const mirror = { hash: "old", applied_at: "t", files: 1, source_device_id: "dev-local" };
    expect(mirrorStatusLine(mirror, "dev-local", now)).toBe("unverified — cast hosts sync");
    expect(mirrorStatusLine({ ...mirror, complete: false, hash: "" }, "dev-local", now)).toBe("incomplete or drifted — cast hosts sync");
    expect(parseHostMirrorStamp(JSON.stringify({ ...mirror, complete: false, files: { active: {}, deleted: { removed: true } } })))
      .toEqual({ ...mirror, complete: false, files: 1 });
  });
  test("a note (asleep, ssh error) wins over everything", () => {
    expect(mirrorStatusLine(null, "dev-local", now, "asleep")).toBe("unknown (asleep)");
  });
  test("parseHostMirrorStamp reads the stamp and tolerates an absent or garbled one", () => {
    expect(parseHostMirrorStamp("")).toBeNull();
    expect(parseHostMirrorStamp("cat: no such file")).toBeNull();
    expect(parseHostMirrorStamp(JSON.stringify({ version: 1, hash: "abc", applied_at: "t", source_device_id: "d", files: { a: {}, b: {} } })))
      .toEqual({ hash: "abc", applied_at: "t", files: 2, source_device_id: "d" });
  });
});

describe("git push access line (`cast hosts ls`)", () => {
  const cloud: CloudHost = { id: "i-1", provider: "aws", region: "us-west-2", user: "ubuntu", keyPath: "/k", address: "1.2.3.4" };
  const now = Date.parse("2026-09-06T12:00:00Z");
  const checkedAt = now - 3 * 60_000;

  test("unknown until a session is placed, when nothing was ever probed", () => {
    const git = hostGitReport(cloud);
    expect(git).toEqual({ pubkey: null, read: null, write: null, forwardAgent: false, path: "none", pathReason: "never probed" });
    expect(gitStatusLine(git, "i-1", now)).toBe("none: unknown until a session is placed — cast hosts key i-1");
  });

  test("push access, read-only key with the re-add hint, needs access with the key command, plus the bridge flag", () => {
    const granted = hostGitReport({ ...cloud, gitPubkey: "ssh-ed25519 AAAA c", gitAccess: { origin: "git@github.com:o/r.git", read: true, write: true, checkedAt } });
    expect(gitStatusLine(granted, "i-1", now)).toBe("device-key: push access to git@github.com:o/r.git, checked 3m ago");
    const ro = hostGitReport({ ...cloud, gitAccess: { origin: "git@github.com:o/r.git", read: true, write: false, readonly: true, checkedAt } });
    expect(gitStatusLine(ro, "i-1", now)).toBe("none: read-only key for git@github.com:o/r.git — re-add it with write access: cast hosts key i-1");
    const denied = hostGitReport({ ...cloud, gitAccess: { origin: "git@github.com:o/r.git", read: false, write: false, checkedAt, error: "Permission denied (publickey)." } });
    expect(gitStatusLine(denied, "i-1", now)).toBe("none: needs access to git@github.com:o/r.git (Permission denied (publickey).) — cast hosts key i-1");
    const bridged = hostGitReport({ ...cloud, forwardAgent: true, gitAccess: { origin: "o", read: true, write: true, checkedAt } });
    expect(bridged.forwardAgent).toBe(true);
    expect(gitStatusLine(bridged, "i-1", now)).toBe("device-key: push access to o, checked 3m ago  agent bridge on");
    // --json carries the same object.
    expect(hostGitReport({ ...cloud, forwardAgent: true, gitPubkey: "k", gitAccess: { origin: "o", read: true, write: false, readonly: true, checkedAt, error: "e" } }))
      .toEqual({ pubkey: "k", read: true, write: false, readonly: true, origin: "o", checkedAt, error: "e", forwardAgent: true, path: "agent-bridge" });
  });

  test("the four access paths, in the order a host prefers them", () => {
    const appOnly = hostGitReport({
      ...cloud,
      gitAccess: { origin: "git@github.com:o/r.git", read: false, write: false, checkedAt, error: "Permission denied (publickey)." },
      gitAppAccess: { origin: "https://github.com/o/r.git", read: true, write: true, checkedAt },
    });
    expect(appOnly.path).toBe("app-token");
    expect(gitStatusLine(appOnly, "i-1", now))
      .toBe("app-token: pushes https://github.com/o/r.git with a codecast GitHub App token — no key needed, checked 3m ago");
    // A granted key and a live App token: the token wins, and no key hint is printed.
    const both = hostGitReport({
      ...cloud,
      gitAccess: { origin: "git@github.com:o/r.git", read: true, write: true, checkedAt },
      gitAppAccess: { origin: "https://github.com/o/r.git", read: true, write: true, checkedAt },
    });
    expect(both.path).toBe("app-token");
    // The App is not installed: the key answers, and the reason stays available.
    const keyOnly = hostGitReport({
      ...cloud,
      gitAccess: { origin: "git@github.com:o/r.git", read: true, write: true, checkedAt },
      gitAppAccess: { origin: "https://github.com/o/r.git", read: false, write: false, checkedAt, error: "not installed" },
    });
    expect(keyOnly.path).toBe("device-key");
    // Neither, but the human has the bridge up: that is what pushes today.
    const bridge = hostGitReport({
      ...cloud,
      forwardAgent: true,
      gitAccess: { origin: "git@github.com:o/r.git", read: true, write: false, checkedAt, error: "push refused" },
      gitAppAccess: { origin: "https://github.com/o/r.git", read: false, write: false, checkedAt, error: "not installed" },
    });
    expect(bridge.path).toBe("agent-bridge");
    expect(gitStatusLine(bridge, "i-1", now)).toContain("agent-bridge: pushes through your laptop's ssh agent");
    // Nothing at all: the reason is the key's, because that is the one a human can fix.
    const none = hostGitReport({
      ...cloud,
      gitAccess: { origin: "git@github.com:o/r.git", read: true, write: false, checkedAt, error: "push refused" },
      gitAppAccess: { origin: "https://github.com/o/r.git", read: false, write: false, checkedAt, error: "not installed" },
    });
    expect(none).toMatchObject({ path: "none", pathReason: "push refused" });
  });

  test("forward-agent refuses on a host whose watchdog predates the bridge", () => {
    expect(forwardAgentRefusal(cloud)).toContain("cast hosts provision i-1");
    expect(forwardAgentRefusal({ ...cloud, watchdogVersion: 1 })).toContain("version 1");
    expect(forwardAgentRefusal({ ...cloud, watchdogVersion: 2 })).toBeNull();
    expect(AGENT_BRIDGE_SECURITY_NOTE).toContain("every key in your laptop's ssh-agent is usable by any process on the host");
  });

  test("the key report recommends a write deploy key, labels the account key broad, and names a key bound to another repo", () => {
    const state: HostGitState = { pubkey: "ssh-ed25519 AAAA c", access: { origin: "git@github.com:o/r.git", read: false, write: false, error: "Permission denied (publickey)." }, identity: "mirrored", knownHosts: "pinned", checkedAt: 1 };
    const lines = keyReportLines({ ...cloud, gitAccess: { origin: "git@github.com:other/repo.git", read: true, write: true, checkedAt: 1 } }, state, "git@github.com:o/r.git").join("\n");
    expect(lines).toContain("has no access to git@github.com:o/r.git yet (Permission denied (publickey).)");
    expect(lines).toContain("this key already grants git@github.com:other/repo.git; one deploy key attaches to one repo");
    expect(lines).toContain("ssh-ed25519 AAAA c");
    expect(lines).toContain("Recommended: add it as a deploy key with WRITE access (one repo): ");
    expect(lines).toContain("https://github.com/o/r/settings/keys/new");
    expect(lines).toContain("Account-level key (broad: every repo you can reach): https://github.com/settings/ssh/new");
    // --check prints the verdict only; a granted key prints nothing to paste.
    expect(keyReportLines(cloud, state, "git@github.com:o/r.git", { check: true }).join("\n")).not.toContain("ssh-ed25519 AAAA c");
    // An https origin was probed as its ssh form: the report says so, once, and only when they differ.
    const https = keyReportLines(cloud, { ...state, access: { origin: "git@github.com:o/r.git", read: false, write: false } }, "https://github.com/o/r.git").join("\n");
    expect(https).toContain("probed as git@github.com:o/r.git — the host's key works over ssh only");
    // …and the "bound to another repo" note compares the probed origin, so the same repo over https is not "another".
    const same = keyReportLines({ ...cloud, gitAccess: { origin: "git@github.com:o/r.git", read: true, write: true, checkedAt: 1 } }, { ...state, access: { origin: "git@github.com:o/r.git", read: false, write: false } }, "https://github.com/o/r.git").join("\n");
    expect(same).not.toContain("this key already grants");
    expect(keyReportLines(cloud, state, "git@github.com:o/r.git").join("\n")).not.toContain("probed as");
    const ok = keyReportLines(cloud, { ...state, access: { origin: "o", read: true, write: true } }, "o").join("\n");
    expect(ok).toContain("has push access to o");
    expect(ok).not.toContain("ssh-ed25519 AAAA c");
    const ro = keyReportLines(cloud, { ...state, identity: "placeholder", access: { origin: "o", read: true, write: false, readonly: true } }, "o").join("\n");
    expect(ro).toContain("key is read-only for o — delete it on GitHub and re-add it with write access");
    expect(ro).toContain("pass --git-identity");
    // With the App token live there is nothing to add, so no key is printed.
    const app = keyReportLines(cloud, { ...state, app: { origin: "https://github.com/o/r.git", read: true, write: true } }, "git@github.com:o/r.git").join("\n");
    expect(app).toContain("pushes https://github.com/o/r.git with a codecast GitHub App token — no key to add");
    expect(app).not.toContain("ssh-ed25519 AAAA c");
  });
});

describe("grantDeployKey through gh", () => {
  let dir: string, savedPath: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-gh-"));
    savedPath = process.env.PATH;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** A gh whose `auth status` passes (unless told otherwise) and whose `repo deploy-key add` runs `body`. */
  function fakeGh(body: string, authStatus = "exit 0"): string {
    const gh = path.join(dir, "gh");
    fs.writeFileSync(gh, `#!/bin/sh\nif [ "$1" = auth ]; then echo "auth $2" >> ${JSON.stringify(path.join(dir, "calls"))}; ${authStatus}; fi\necho "$@" > ${JSON.stringify(path.join(dir, "argv"))}\ncat "$4" > ${JSON.stringify(path.join(dir, "keyfile"))} 2>/dev/null\n${body}\n`, { mode: 0o755 });
    return gh;
  }

  test("adds the key with write access to the origin's repo from a 0600 scratch file that is removed afterwards", () => {
    const gh = fakeGh("exit 0");
    expect(grantDeployKey("ssh-ed25519 AAAA c", "git@github.com:o/r.git", "i-1", gh)).toEqual({ ok: true });
    const argv = fs.readFileSync(path.join(dir, "argv"), "utf-8").trim().split(" ");
    expect(argv.slice(0, 3)).toEqual(["repo", "deploy-key", "add"]);
    expect(argv).toContain("--allow-write");
    expect(argv.slice(-2)).toEqual(["-R", "o/r"]);
    expect(argv[argv.indexOf("--title") + 1]).toBe("codecast-i-1");
    expect(fs.readFileSync(path.join(dir, "keyfile"), "utf-8")).toBe("ssh-ed25519 AAAA c\n");
    expect(fs.existsSync(argv[3]!)).toBe(false);
    // `gh auth status` ran first.
    expect(fs.readFileSync(path.join(dir, "calls"), "utf-8")).toBe("auth status\n");
  });

  test("an unauthenticated gh is the precondition message, and the deploy key is never attempted", () => {
    const gh = fakeGh("exit 0", 'echo "You are not logged into any GitHub hosts." >&2; exit 1');
    expect(grantDeployKey("k", "git@github.com:o/r.git", "i-1", gh)).toEqual({ ok: false, error: GH_NOT_LOGGED_IN_MESSAGE });
    expect(GH_NOT_LOGGED_IN_MESSAGE).toContain("gh auth login");
    expect(fs.existsSync(path.join(dir, "argv"))).toBe(false);
  });

  test("GitHub's 'key is already in use' becomes the account-key alternative", () => {
    const gh = fakeGh('echo "HTTP 422: Validation Failed (https://api.github.com/repos/o/r/keys)\nkey is already in use" >&2; exit 1');
    const r = grantDeployKey("ssh-ed25519 AAAA c", "https://github.com/o/r", "i-1", gh);
    expect(r.ok).toBe(false);
    expect(r.alreadyInUse).toBe(true);
    expect(r.error).toBe(KEY_ALREADY_IN_USE_MESSAGE);
    expect(KEY_ALREADY_IN_USE_MESSAGE).toContain("https://github.com/settings/ssh/new (broad access: every repo you can reach)");
  });

  test("other failures surface gh's last line; a non-GitHub origin and a missing gh are named", () => {
    const gh = fakeGh('echo "HTTP 404: Not Found (https://api.github.com/repos/o/r/keys)" >&2; exit 1');
    expect(grantDeployKey("k", "git@github.com:o/r.git", "i-1", gh)).toEqual({ ok: false, error: "HTTP 404: Not Found (https://api.github.com/repos/o/r/keys)" });
    expect(grantDeployKey("k", "git@gitlab.example:o/r.git", "i-1", gh).error).toContain("not a GitHub repository");
    expect(grantDeployKey("k", "git@github.com:o/r.git", "i-1", path.join(dir, "no-such-gh")).error).toBe("gh is not installed");
  });
});

import { loginsReportLines, toolsStatusLine } from "./cli.js";

describe("tools line and logins lines (`cast hosts ls` / `wake` / `sync-auth`)", () => {
  test("toolsStatusLine: a note wins, no stamp says how to get one, a stamp summarises with its time and the pinned MCP servers", () => {
    expect(toolsStatusLine(undefined, "asleep")).toBe("unknown (asleep)");
    expect(toolsStatusLine(null)).toBe("never checked — cast hosts tools");
    expect(toolsStatusLine({ ok: [{ tool: "node" }], installed: [], missing: [{ tool: "uv" }], unsupported: [], at: "2026-09-07T12:00:00Z" })).toBe("1 ok, 0 installed, 1 missing, 0 unsupported, checked 2026-09-07T12:00:00Z");
    expect(toolsStatusLine({
      ok: [], installed: [], missing: [], unsupported: [],
      mcpOverrides: { version: 1, codex: { computer_use: { enabled: false, reason: "r", source_command: "s", at: "t" } }, claude: {} },
    })).toBe("0 ok, 0 installed, 0 missing, 0 unsupported, 1 MCP server disabled (codex: computer_use)");
  });
  test("loginsReportLines: pushed / not pushed, the claude line, kept files and skipped sources", () => {
    expect(loginsReportLines(undefined)).toEqual(["agent logins: not pushed"]);
    expect(loginsReportLines({ pushed: true, shipped: "codex, grok, 1 env key, trust 1", skipped: [{ id: "gemini", reason: "no refresh token" }], envSkipped: [], kept: ["codex host-fresher"], claude: { pushed: true } }))
      .toEqual(["agent logins: pushed codex, grok, 1 env key, trust 1", "claude credential: pushed", "kept on the host: codex host-fresher", "skipped gemini: no refresh token"]);
    expect(loginsReportLines({ pushed: false, reason: "host holds another user's logins", shipped: "", skipped: [], envSkipped: [], kept: [], claude: { pushed: false, reason: "no credential" } }))
      .toEqual(["agent logins: not pushed (host holds another user's logins)", "claude credential: not pushed (no credential)"]);
  });
});

describe("sessionLine — what the worktree started from (ct-49433)", () => {
  const base = "abc1234def0000000000000000000000000000000";
  test("a dirty checkout seed reads feat/x@abc1234+, an origin seed origin/main@abc1234, no seed leaves the line as today", () => {
    const dirty = session("cloud-1", { cloud_seed: { source: "checkout", base, branch: "feat/x", dirty: true, device_id: "dev1", reason: null } });
    expect(sessionSeed(dirty)).toBe("feat/x@abc1234+");
    expect(sessionLine(dirty)).toContain("cloud-1  feat/x@abc1234+");
    const clean = session("cloud-2", { cloud_seed: { source: "checkout", base, branch: "feat/x", dirty: false, device_id: null, reason: null } });
    expect(sessionSeed(clean)).toBe("feat/x@abc1234");
    const detached = session("cloud-3", { cloud_seed: { source: "checkout", base, branch: null, dirty: true, device_id: null, reason: null } });
    expect(sessionSeed(detached)).toBe("detached HEAD@abc1234+");
    const origin = session("cloud-4", { cloud_seed: { source: "origin_main", base, branch: null, dirty: null, device_id: null, reason: "not a repo" } });
    expect(sessionSeed(origin)).toBe("origin/main@abc1234");
    expect(sessionLine(origin)).toContain("cloud-4  origin/main@abc1234");
    const none = session("cloud-5");
    expect(sessionSeed(none)).toBe("");
    expect(sessionLine(none)).toContain("cloud-5 ");
    expect(sessionLine(none)).not.toContain("@");
  });

  test("dangling seed refs: one per checkout, names only, nothing else becomes a row", () => {
    expect(REMOTE_DANGLING_SEEDS_SCRIPT).toContain("refs/codecast/cloud");
    expect(REMOTE_DANGLING_SEEDS_SCRIPT.endsWith("exit 0")).toBe(true);
    const out = "## /home/ubuntu/work/codecast/\ncloud-aaa111\ncloud-bbb222\n## /home/ubuntu/work/other/\nwarning: something\nbad name\n";
    expect(parseDanglingSeeds(out)).toEqual([{ repo: "codecast", name: "cloud-aaa111" }, { repo: "codecast", name: "cloud-bbb222" }]);
    expect(parseDanglingSeeds("")).toEqual([]);
  });
});
