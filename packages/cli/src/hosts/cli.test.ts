import { describe, expect, test } from "bun:test";
import {
  briefError, EC2_HOURLY_USD, estimateHostCost, GP3_USD_PER_GIB_MONTH, markOrphanWorktrees,
  parseRemoteWorkspaceList, REMOTE_WORKSPACE_LIST_SCRIPT, type HostSession, type RemoteWorktree,
} from "./cli.js";

function session(worktree: string | null): HostSession {
  return {
    short_id: "abc1234", title: "t", status: "active", work_state: "working",
    worktree_name: worktree, worktree_branch: null, project_path: null, updated_at: 1,
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
