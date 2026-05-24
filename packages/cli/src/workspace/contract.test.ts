import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  deleteState,
  listStates,
  PersistedWorkspaceState,
  readState,
  setState,
  validateContract,
  WORKSPACES_STATE_DIR,
  writeState,
} from "./contract.js";
import type { Workspace, WorkspaceManifest } from "./types.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-contract-"));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

const baseManifest = (): WorkspaceManifest => ({
  setup: {
    copy: [],
    install: ["bun install"],
    generate: [],
    migrate: [],
  },
  ports: { web: { base: 39000, range: 100 } },
  services: {},
  env: { NODE_ENV: "development" },
  teardown: { run: [] },
  browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } },
  backend: "local",
  detected: "bun",
});

function makeReadyWorkspace(name: string): Workspace {
  // Init a real git worktree on the requested branch so git checks pass.
  const wtPath = path.join(repoRoot, ".codecast/worktrees", name);
  fs.mkdirSync(wtPath, { recursive: true });
  execSync("git init -q", { cwd: wtPath, stdio: ["ignore", "ignore", "ignore"] });
  execSync("git config user.email t@t.t && git config user.name t", {
    cwd: wtPath,
    stdio: ["ignore", "ignore", "ignore"],
  });
  fs.writeFileSync(path.join(wtPath, "x"), "");
  execSync("git add . && git commit -q -m init", {
    cwd: wtPath,
    stdio: ["ignore", "ignore", "ignore"],
  });
  execSync(`git branch -m codecast/${name}`, {
    cwd: wtPath,
    stdio: ["ignore", "ignore", "ignore"],
  });
  // Pretend deps installed
  fs.mkdirSync(path.join(wtPath, "node_modules"), { recursive: true });
  return {
    name,
    path: wtPath,
    branch: `codecast/${name}`,
    resourceIndex: 0,
    manifest: baseManifest(),
    ports: { web: 39000 },
    env: { NODE_ENV: "development", PORT_WEB: "39000" },
    state: "ready",
  };
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

describe("state persistence", () => {
  test("read/write roundtrip", () => {
    const state: PersistedWorkspaceState = {
      name: "feat-x",
      path: "/repo/.codecast/worktrees/feat-x",
      branch: "codecast/feat-x",
      resourceIndex: 2,
      state: "ready",
      manifest: baseManifest(),
      ports: { web: 3200 },
      env: { PORT_WEB: "3200" },
      updatedAt: "2026-05-18T00:00:00.000Z",
    };
    writeState(repoRoot, state);
    expect(readState(repoRoot, "feat-x")).toEqual(state);
  });

  test("write is atomic (no .tmp left behind)", () => {
    writeState(repoRoot, {
      name: "x",
      path: "/x",
      branch: "b",
      resourceIndex: 0,
      state: "ready",
      manifest: baseManifest(),
      ports: {},
      env: {},
      updatedAt: "2026-05-18T00:00:00.000Z",
    });
    const dir = path.join(repoRoot, WORKSPACES_STATE_DIR, "x");
    const files = fs.readdirSync(dir);
    expect(files).toEqual(["state.json"]);
  });

  test("missing state file → null", () => {
    expect(readState(repoRoot, "nope")).toBeNull();
  });

  test("malformed state file → null (doesn't crash)", () => {
    const p = path.join(repoRoot, WORKSPACES_STATE_DIR, "broken", "state.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{ not json");
    expect(readState(repoRoot, "broken")).toBeNull();
  });

  test("listStates returns all persisted workspaces", () => {
    for (const n of ["a", "b", "c"]) {
      writeState(repoRoot, {
        name: n,
        path: "/" + n,
        branch: n,
        resourceIndex: 0,
        state: "ready",
        manifest: baseManifest(),
        ports: {},
        env: {},
        updatedAt: "2026-05-18T00:00:00.000Z",
      });
    }
    const states = listStates(repoRoot).map((s) => s.name).sort();
    expect(states).toEqual(["a", "b", "c"]);
  });

  test("setState transitions state and bumps updatedAt", () => {
    writeState(repoRoot, {
      name: "x",
      path: "/x",
      branch: "b",
      resourceIndex: 0,
      state: "creating",
      manifest: baseManifest(),
      ports: {},
      env: {},
      updatedAt: "2020-01-01T00:00:00.000Z",
    });
    const updated = setState(repoRoot, "x", "ready");
    expect(updated?.state).toBe("ready");
    expect(updated?.updatedAt).not.toBe("2020-01-01T00:00:00.000Z");
  });

  test("setState on missing workspace → null", () => {
    expect(setState(repoRoot, "missing", "broken")).toBeNull();
  });

  test("deleteState removes the workspace directory", () => {
    writeState(repoRoot, {
      name: "x",
      path: "/x",
      branch: "b",
      resourceIndex: 0,
      state: "ready",
      manifest: baseManifest(),
      ports: {},
      env: {},
      updatedAt: "2026-05-18T00:00:00.000Z",
    });
    deleteState(repoRoot, "x");
    expect(readState(repoRoot, "x")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

describe("validateContract", () => {
  test("happy path: every check ok", async () => {
    const ws = makeReadyWorkspace("hp");
    const r = await validateContract(ws);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "worktree-exists")?.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "git-branch")?.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "deps-installed")?.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "env-vars")?.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "port:web")?.ok).toBe(true);
  });

  test("missing worktree → broken with reason", async () => {
    const ws = makeReadyWorkspace("m1");
    fs.rmSync(ws.path, { recursive: true, force: true });
    const r = await validateContract(ws);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "worktree-exists")?.reason).toContain("missing");
  });

  test("wrong branch → broken with reason naming actual + expected", async () => {
    const ws = makeReadyWorkspace("m2");
    execSync("git checkout -q -b wrong-branch", { cwd: ws.path });
    const r = await validateContract(ws);
    const branchCheck = r.checks.find((c) => c.name === "git-branch");
    expect(branchCheck?.ok).toBe(false);
    expect(branchCheck?.reason).toContain("wrong-branch");
    expect(branchCheck?.reason).toContain(ws.branch);
  });

  test("missing node_modules → broken", async () => {
    const ws = makeReadyWorkspace("m3");
    fs.rmSync(path.join(ws.path, "node_modules"), { recursive: true, force: true });
    const r = await validateContract(ws);
    const depCheck = r.checks.find((c) => c.name === "deps-installed");
    expect(depCheck?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  test("missing manifest env var → broken", async () => {
    const ws = makeReadyWorkspace("m4");
    ws.env = { PORT_WEB: "39000" }; // dropped NODE_ENV
    const r = await validateContract(ws);
    const envCheck = r.checks.find((c) => c.name === "env-vars");
    expect(envCheck?.ok).toBe(false);
    expect(envCheck?.reason).toContain("NODE_ENV");
  });

  test("missing PORT_<NAME> env → port check fails", async () => {
    const ws = makeReadyWorkspace("m5");
    ws.env = { NODE_ENV: "development" }; // dropped PORT_WEB
    const r = await validateContract(ws);
    expect(r.checks.find((c) => c.name === "port:web")?.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  test("multiple failures reported together (doesn't short-circuit)", async () => {
    const ws = makeReadyWorkspace("m6");
    fs.rmSync(path.join(ws.path, "node_modules"), { recursive: true, force: true });
    ws.env = {}; // missing all env
    const r = await validateContract(ws);
    expect(r.ok).toBe(false);
    const failed = r.checks.filter((c) => !c.ok && !c.name.startsWith("port-free:"));
    // deps-installed + env-vars + port:web all fail.
    expect(failed.length).toBeGreaterThanOrEqual(3);
  });

  test("port-free check is informational, doesn't fail contract on its own", async () => {
    const ws = makeReadyWorkspace("m7");
    // Bind the port — port-free should report false but ok stays true overall.
    const { createServer } = await import("node:net");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.once("listening", resolve);
      server.listen(39000, "127.0.0.1");
    });
    try {
      const r = await validateContract(ws);
      const freeCheck = r.checks.find((c) => c.name === "port-free:web");
      expect(freeCheck?.ok).toBe(false);
      // But overall contract still valid since port-free is informational.
      expect(r.ok).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
