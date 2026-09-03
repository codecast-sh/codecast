import { describe, expect, test } from "bun:test";
import { locateWorktree, worktreeEnv, worktreeEnvPrefix } from "./worktreeEnv";

describe("locateWorktree", () => {
  test("finds the repo root and name for a cwd inside a codecast worktree", () => {
    expect(locateWorktree("/home/ubuntu/work/codecast/.codecast/worktrees/cloud-1a2b3c")).toEqual({
      repoRoot: "/home/ubuntu/work/codecast", name: "cloud-1a2b3c",
    });
    expect(locateWorktree("/Users/a/src/x/.codecast/worktrees/fix-auth/packages/web")).toEqual({
      repoRoot: "/Users/a/src/x", name: "fix-auth",
    });
  });
  test("a plain checkout is not a worktree", () => {
    expect(locateWorktree("/home/ubuntu/work/codecast")).toBeNull();
    expect(locateWorktree("/home/ubuntu/work/codecast/.codecast/worktrees/")).toBeNull();
  });
});

describe("worktreeEnv", () => {
  const state = JSON.stringify({
    env: {
      PORT_WEB: "3221", CODECAST_PORT_WEB: 3221, CODECAST_WORKTREE_NAME: "cloud-1", CODECAST_RESOURCE_INDEX: "1",
      SECRET_TOKEN: "no", PATH: "/evil", "PORT_X; rm -rf /": "1",
    },
  });
  test("keeps ports and worktree identity, drops everything else", () => {
    const env = worktreeEnv("/r/.codecast/worktrees/cloud-1", () => state);
    expect(env).toEqual({ PORT_WEB: "3221", CODECAST_PORT_WEB: "3221", CODECAST_WORKTREE_NAME: "cloud-1", CODECAST_RESOURCE_INDEX: "1", AGENT_RESOURCE_INDEX: "1" });
  });
  test("reads the state file of the cwd's worktree", () => {
    const seen: string[] = [];
    worktreeEnv("/r/.codecast/worktrees/cloud-1/pkg", (p) => { seen.push(p); return state; });
    expect(seen).toEqual(["/r/.codecast/workspaces/cloud-1/state.json"]);
  });
  test("no state file, no worktree, or bad JSON → empty", () => {
    expect(worktreeEnv("/r/.codecast/worktrees/gone", () => { throw new Error("ENOENT"); })).toEqual({});
    expect(worktreeEnv("/r", () => state)).toEqual({});
    expect(worktreeEnv("/r/.codecast/worktrees/x", () => "{nope")).toEqual({});
  });
  test("prefix quotes values", () => {
    expect(worktreeEnvPrefix("/nowhere")).toBe("");
  });
});
