import { describe, expect, test } from "bun:test";
import { locateRootWorkspace, locateWorktree, worktreeEnv, worktreeEnvPrefix } from "./worktreeEnv";

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
  test("cloud installs and resumed shells use private dependency caches", () => {
    const env = worktreeEnv("/r/.codecast/worktrees/cloud-1", () => JSON.stringify({
      env: { CODECAST_CLOUD_WORKSPACE: "1", BUN_INSTALL_CACHE_DIR: "/shared", BUN_INSTALL_GLOBAL_STORE: "1" },
    }));
    expect(env.BUN_INSTALL_GLOBAL_STORE).toBe("0");
    expect(env.BUN_INSTALL_CACHE_DIR).toBe("/r/.codecast/workspaces/cloud-1/bun-cache");
  });
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
  test("derives identity and port aliases from persisted workspace fields", () => {
    const stored = JSON.stringify({
      name: "cloud-2", path: "/r/.codecast/worktrees/cloud-2", branch: "codecast/cloud-2",
      resourceIndex: 2, ports: { web: 3241 }, env: { PORT_WEB: "1", SECRET_TOKEN: "no" },
    });
    expect(worktreeEnv("/r/.codecast/worktrees/cloud-2", () => stored)).toEqual({
      PORT_WEB: "3241", CODECAST_PORT_WEB: "3241", CODECAST_RESOURCE_INDEX: "2",
      AGENT_RESOURCE_INDEX: "2", CODECAST_WORKTREE_NAME: "cloud-2",
      CODECAST_WORKTREE_PATH: "/r/.codecast/worktrees/cloud-2", CODECAST_BRANCH: "codecast/cloud-2",
    });
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

describe("the shared-checkout record: a cloud session in the main checkout (ct-49428)", () => {
  const rootState = JSON.stringify({
    name: "shared-checkout", path: "/r", branch: "codecast/cloud-abc123", resourceIndex: 3, ports: { web: 45400 },
    env: { PORT_WEB: "45400", CODECAST_CLOUD_WORKSPACE: "1", BUN_INSTALL_GLOBAL_STORE: "0", SECRET: "no" },
  });
  const files = new Set(["/r/.codecast/workspaces/shared-checkout/state.json", "/r/.codecast/workspaces/cloud-1/state.json"]);
  const exists = (p: string) => files.has(p);

  test("locateRootWorkspace walks up from a nested cwd to the repo root", () => {
    expect(locateRootWorkspace("/r/packages/web", exists)).toEqual({ repoRoot: "/r", name: "shared-checkout" });
    expect(locateRootWorkspace("/r", exists)).toEqual({ repoRoot: "/r", name: "shared-checkout" });
    expect(locateRootWorkspace("/elsewhere/x", exists)).toBeNull();
  });

  test("worktreeEnv(root) exports ports, the root path and the index from the root state, never BUN_INSTALL_*", () => {
    const seen: string[] = [];
    const env = worktreeEnv("/r/packages/web", (p) => { seen.push(p); return rootState; }, exists);
    expect(seen).toEqual(["/r/.codecast/workspaces/shared-checkout/state.json"]);
    expect(env).toEqual({
      PORT_WEB: "45400", CODECAST_PORT_WEB: "45400", CODECAST_WORKTREE_NAME: "shared-checkout", CODECAST_WORKTREE_PATH: "/r",
      CODECAST_BRANCH: "codecast/cloud-abc123", CODECAST_RESOURCE_INDEX: "3", AGENT_RESOURCE_INDEX: "3",
    });
    expect(env.BUN_INSTALL_GLOBAL_STORE).toBeUndefined();
    expect(env.BUN_INSTALL_CACHE_DIR).toBeUndefined();
  });

  test("a record whose path is not that root exports nothing; a worktree cwd still prefers its own state", () => {
    expect(worktreeEnv("/r", () => JSON.stringify({ ...JSON.parse(rootState), path: "/somewhere/else" }), exists)).toEqual({});
    const seen: string[] = [];
    const env = worktreeEnv("/r/.codecast/worktrees/cloud-1/pkg", (p) => { seen.push(p); return JSON.stringify({ name: "cloud-1", path: "/r/.codecast/worktrees/cloud-1", ports: { web: 1 }, env: { CODECAST_CLOUD_WORKSPACE: "1" } }); }, exists);
    expect(seen).toEqual(["/r/.codecast/workspaces/cloud-1/state.json"]);
    expect(env.PORT_WEB).toBe("1");
    expect(env.BUN_INSTALL_CACHE_DIR).toBe("/r/.codecast/workspaces/cloud-1/bun-cache");
  });
});
