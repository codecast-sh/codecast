// A workspace's port slots given up and taken back (ct-101923): the change runs' trees that held every slot of a
// laptop on Nov 26, and the acquire that found none.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { acquireWorkspace, validateWorkspace } from "./lifecycle.js";
import { portExhaustion, releaseWorkspacePorts } from "./portRelease.js";
import { readState, setState, writeState } from "./contract.js";

let repoRoot: string;
let codecastDir: string | undefined;
const opts = { skipSetup: true, skipHooks: true, skipPool: true };

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-ports-"));
  codecastDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(repoRoot, "host-state");
  execSync("git init -q -b main", { cwd: repoRoot });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "test\n");
  execSync("git add . && git commit -q -m init", { cwd: repoRoot });
  fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, ".codecast/workspace.toml"), "[ports.web]\nbase = 41000\nrange = 100\n\n[ports.api]\nbase = 41001\nrange = 100\n");
});

afterEach(() => {
  try { execSync("git worktree prune", { cwd: repoRoot, stdio: "ignore" }); } catch { /* ignore */ }
  fs.rmSync(repoRoot, { recursive: true, force: true });
  if (codecastDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = codecastDir;
});

/** A workspace record holding resource index `index`, as an acquire in flight writes it. */
function holdIndex(name: string, index: number) {
  writeState(repoRoot, {
    name,
    path: path.join(repoRoot, ".codecast/worktrees", name),
    branch: `codecast/${name}`,
    resourceIndex: index,
    state: "creating",
    manifest: {
      setup: { copy: [], install: [], generate: [], migrate: [], share: [] },
      ports: { web: { base: 41000, range: 100 }, api: { base: 41001, range: 100 } },
      services: {},
      env: {},
      teardown: { run: [] },
      browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } },
      backend: "local",
    },
    ports: { web: 41000 + index * 100, api: 41001 + index * 100 },
    env: {},
    updatedAt: new Date().toISOString(),
  });
}

describe("workspace ports given up and reclaimed", () => {
  // `cast flow run` acquires with --branch and --skip-pool; dead holders must not exhaust that path either.
  test("a branch acquire whose every index is held by dead workspaces reclaims their slots and takes the first", async () => {
    for (let index = 0; index < 40; index++) {
      holdIndex(`ended-${index}`, index);
      setState(repoRoot, `ended-${index}`, "ready"); // its worktree directory never existed, or is gone
    }
    execSync("git branch pl/change", { cwd: repoRoot });
    const run = await acquireWorkspace(repoRoot, "change-ct-1", { ...opts, branch: "pl/change" });
    expect(run.workspace.resourceIndex).toBe(0);
    expect(run.workspace.branch).toBe("pl/change");
    expect(run.notices?.join("\n")).toContain("reclaimed 40 port slot(s) from workspaces whose worktree is gone");
  }, 15000);

  test("a no-port acquire of a ready workspace gives its ports up in place and says nothing of others' slots", async () => {
    const first = await acquireWorkspace(repoRoot, "worker", opts);
    fs.writeFileSync(path.join(first.workspace.path, "kept.txt"), "work in progress\n");
    holdIndex("gone", 5);
    setState(repoRoot, "gone", "ready");
    const worker = await acquireWorkspace(repoRoot, "worker", { ...opts, noPorts: true });
    expect(worker.created).toBe(false);
    expect(worker.notices ?? []).toEqual([]);
    expect(readState(repoRoot, "worker")).toMatchObject({ noPorts: true, ports: {}, state: "ready" });
    expect(readState(repoRoot, "worker")?.env.PORT_WEB).toBeUndefined();
    expect(fs.readFileSync(path.join(first.workspace.path, "kept.txt"), "utf8")).toBe("work in progress\n");
  });

  test("when every slot is taken, the trees ended runs kept give theirs up and the acquire goes on", async () => {
    for (let index = 0; index < 40; index++) holdIndex(`held-${index}`, index);
    for (let index = 0; index < 40; index++) setState(repoRoot, `held-${index}`, "ready");
    // Their trees and branches stand, so none is stale: only the sweep frees one.
    for (let index = 0; index < 40; index++) {
      fs.mkdirSync(path.join(repoRoot, ".codecast/worktrees", `held-${index}`), { recursive: true });
      execSync(`git branch codecast/held-${index}`, { cwd: repoRoot });
    }
    const sweep = portExhaustion.sweep;
    const swept: string[] = [];
    portExhaustion.sweep = async (root) => { swept.push(root); return (await releaseWorkspacePorts(root, "held-7")) ? ["held-7"] : []; };
    try {
      const late = await acquireWorkspace(repoRoot, "late", opts);
      expect(swept).toEqual([repoRoot]);
      expect(late.workspace.resourceIndex).toBe(7);
      expect(late.notices?.join("\n")).toContain("freed those of 1 tree(s) ended runs kept (held-7)");
      portExhaustion.sweep = async () => [];
      const failure = await acquireWorkspace(repoRoot, "later", opts).catch((error: Error) => error.message);
      expect(failure).toContain("no free port for workspace 'later'");
    } finally {
      portExhaustion.sweep = sweep;
    }
  }, 30000);

  test("releaseWorkspacePorts frees a kept workspace's slot and leaves its tree", async () => {
    const kept = await acquireWorkspace(repoRoot, "kept", opts);
    expect(await releaseWorkspacePorts(repoRoot, "kept")).toBe(true);
    expect(await releaseWorkspacePorts(repoRoot, "kept")).toBe(false);
    expect(fs.existsSync(kept.workspace.path)).toBe(true);
    expect(readState(repoRoot, "kept")).toMatchObject({ noPorts: true, ports: {}, branch: "codecast/kept" });
    const next = await acquireWorkspace(repoRoot, "next", opts);
    expect(next.workspace.ports).toEqual(kept.workspace.ports);
    expect((await validateWorkspace(repoRoot, "kept")).ok).toBe(true);
  });
});
