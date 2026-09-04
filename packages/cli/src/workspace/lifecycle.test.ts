import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  acquireWorkspace,
  healWorkspace,
  listWorkspaces,
  releaseWorkspace,
  validateWorkspace,
} from "./lifecycle.js";
import { readState, setState, writeState } from "./contract.js";

let repoRoot: string;
let codecastDir: string | undefined;
const extraRepos: string[] = [];

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-lifecycle-"));
  codecastDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = path.join(repoRoot, "host-state");
  // Init a git repo with one commit so worktrees work.
  execSync("git init -q -b main", { cwd: repoRoot });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "test\n");
  execSync("git add . && git commit -q -m init", { cwd: repoRoot });
});

afterEach(() => {
  // git worktree references can survive in main repo; force-prune.
  try {
    execSync("git worktree prune", { cwd: repoRoot, stdio: "ignore" });
  } catch {
    /* ignore */
  }
  fs.rmSync(repoRoot, { recursive: true, force: true });
  for (const repo of extraRepos.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
  if (codecastDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = codecastDir;
});

describe("workspace port reservations", () => {
  const opts = { skipSetup: true, skipHooks: true, skipBrowser: true, skipPool: true };

  function manifest(root = repoRoot, portName = "web") {
    fs.mkdirSync(path.join(root, ".codecast"), { recursive: true });
    fs.writeFileSync(path.join(root, ".codecast/workspace.toml"), `
[ports.${portName}]
base = 41000
range = 100

[ports.api]
base = 41001
range = 100
`);
  }

  async function acquireInProcess(root: string, name: string) {
    const child = Bun.spawn([process.execPath, "-e", `
      import { acquireWorkspace } from ${JSON.stringify(path.join(import.meta.dir, "lifecycle.ts"))};
      const result = await acquireWorkspace(${JSON.stringify(root)}, ${JSON.stringify(name)}, ${JSON.stringify(opts)});
      console.log(JSON.stringify(result));
    `], { stdout: "pipe", stderr: "pipe", env: process.env });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.length).toBeGreaterThan(0);
    return JSON.parse(stdout) as Awaited<ReturnType<typeof acquireWorkspace>>;
  }

  test("three concurrent acquires reserve distinct ports before any listener, then release and reuse", async () => {
    manifest();
    const results = await Promise.all(["one", "two", "three"].map((name) => acquireWorkspace(repoRoot, name, opts)));
    expect(results.flatMap(({ workspace }) => workspace.contract?.checks.filter((check) => !check.ok) ?? [])).toEqual([]);
    const ports = results.flatMap(({ workspace }) => Object.values(workspace.ports));
    expect(new Set(ports).size).toBe(6);
    expect(results.map(({ workspace }) => workspace.resourceIndex).sort()).toEqual([0, 1, 2]);
    const first = results.find(({ workspace }) => workspace.resourceIndex === 0)!.workspace;
    const attached = await acquireWorkspace(repoRoot, first.name, { ...opts, resourceIndex: 8 });
    expect(attached.created).toBe(false);
    expect(attached.workspace.ports).toEqual(first.ports);
    expect(attached.workspace.resourceIndex).toBe(first.resourceIndex);
    const fourth = await acquireWorkspace(repoRoot, "four", opts);
    expect(fourth.workspace.resourceIndex).toBe(3);
    await releaseWorkspace(repoRoot, first.name);
    const replacement = await acquireWorkspace(repoRoot, "replacement", opts);
    expect(replacement.workspace.ports).toEqual(first.ports);
    expect(replacement.workspace.resourceIndex).toBe(0);
  });

  test("three separate processes reserve ports durably across repositories and port names", async () => {
    manifest();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ws-ports-other-"));
    extraRepos.push(other);
    execSync(`git clone -q ${JSON.stringify(repoRoot)} ${JSON.stringify(other)}`);
    manifest(other, "frontend");
    const results = await Promise.all([
      acquireInProcess(repoRoot, "one"),
      acquireInProcess(repoRoot, "two"),
      acquireInProcess(other, "three"),
    ]);
    expect(new Set(results.flatMap(({ workspace }) => Object.values(workspace.ports))).size).toBe(6);
    const fourth = await acquireInProcess(other, "four");
    expect(fourth.workspace.resourceIndex).toBe(3);
    const attached = await acquireInProcess(repoRoot, "one");
    expect(attached.created).toBe(false);
    expect(attached.workspace.ports).toEqual(results[0]!.workspace.ports);
    await releaseWorkspace(repoRoot, "one");
    const reused = await acquireInProcess(other, "reused");
    expect(reused.workspace.resourceIndex).toBe(results[0]!.workspace.resourceIndex);
  }, 15000);

  test("respects pre-existing and broken workspace states and retains their resource index", async () => {
    manifest();
    const original = (await acquireWorkspace(repoRoot, "original", { ...opts, resourceIndex: 4 })).workspace;
    fs.rmSync(path.join(process.env.CODECAST_DIR!, "workspace-ports"), { recursive: true, force: true });
    setState(repoRoot, "original", "broken");
    const next = await acquireWorkspace(repoRoot, "next", { ...opts, resourceIndex: 4 });
    expect(next.workspace.resourceIndex).toBe(5);
    const repaired = await acquireWorkspace(repoRoot, "original", opts);
    expect(repaired.workspace.resourceIndex).toBe(4);
    expect(repaired.workspace.ports).toEqual(original.ports);
  });

  test("release removes the final reservation and reacquiring the same name reuses its ports", async () => {
    manifest();
    const first = await acquireWorkspace(repoRoot, "one", opts);
    await releaseWorkspace(repoRoot, "one");
    const index = path.join(process.env.CODECAST_DIR!, "workspace-ports", "repositories.json");
    expect(JSON.parse(fs.readFileSync(index, "utf8"))).toEqual([]);
    const reused = await acquireWorkspace(repoRoot, "one", opts);
    expect(reused.created).toBe(true);
    expect(reused.workspace.ports).toEqual(first.workspace.ports);
  });

  test("pool claim transfers the reservation and release makes the ports reusable", async () => {
    manifest();
    const { maintainPool, waitForReadySlot } = await import("./pool/manager.js");
    await maintainPool(repoRoot, 1);
    expect(await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 50 })).not.toBeNull();
    const pooled = readState(repoRoot, "pool-0")!;
    const claimed = await acquireWorkspace(repoRoot, "claimed", { ...opts, skipPool: false });
    expect(claimed.workspace.ports).toEqual(pooled.ports);
    expect(readState(repoRoot, "pool-0")).toBeNull();
    const next = await acquireWorkspace(repoRoot, "next", opts);
    expect(next.workspace.resourceIndex).toBe(1);
    await releaseWorkspace(repoRoot, "claimed");
    const reused = await acquireWorkspace(repoRoot, "reuse", opts);
    expect(reused.workspace.ports).toEqual(pooled.ports);
  }, 20000);

  test("ignores nonlocal workspace states when reserving local ports", async () => {
    manifest();
    await acquireWorkspace(repoRoot, "remote-record", opts);
    const state = readState(repoRoot, "remote-record")!;
    writeState(repoRoot, { ...state, manifest: { ...state.manifest, backend: "e2b" } });
    const local = await acquireWorkspace(repoRoot, "local", opts);
    expect(local.workspace.resourceIndex).toBe(0);
  });

  test("prunes reservations when a registered repository disappears", async () => {
    manifest();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "ws-ports-stale-"));
    extraRepos.push(other);
    execSync(`git clone -q ${JSON.stringify(repoRoot)} ${JSON.stringify(other)}`);
    manifest(other);
    const first = await acquireWorkspace(other, "gone", opts);
    fs.rmSync(other, { recursive: true, force: true });
    const reused = await acquireWorkspace(repoRoot, "reuse", opts);
    expect(reused.workspace.ports).toEqual(first.workspace.ports);
  });
});

describe("acquireWorkspace — minimal repo (no manifest, no package.json)", () => {
  test("creates worktree, no install needed, persists ready state", async () => {
    const r = await acquireWorkspace(repoRoot, "feat-1");
    expect(r.created).toBe(true);
    expect(r.workspace.contract?.checks.filter((check) => !check.ok)).toEqual([]);
    expect(r.workspace.state).toBe("ready");
    expect(r.workspace.branch).toBe("codecast/feat-1");
    expect(fs.existsSync(r.workspace.path)).toBe(true);
    // No install commands → deps-installed check is auto-pass.
    expect(r.workspace.contract?.ok).toBe(true);

    const persisted = readState(repoRoot, "feat-1");
    expect(persisted?.state).toBe("ready");
  });

  test("acquire again with same name attaches to existing (created=false)", async () => {
    await acquireWorkspace(repoRoot, "feat-1");
    const r2 = await acquireWorkspace(repoRoot, "feat-1");
    expect(r2.created).toBe(false);
    expect(r2.workspace.state).toBe("ready");
  });
});

describe("acquireWorkspace — with manifest, ports, and after-create hook", () => {
  test("runs full pipeline: copy + setup + hook + contract", async () => {
    // Set up a manifest + a thing to copy + a hook.
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, ".codecast/hooks"), { recursive: true });

    fs.writeFileSync(
      path.join(repoRoot, ".codecast/workspace.toml"),
      `
[setup]
copy = [".env"]
install = ["echo INSTALL > install-ran.txt"]

[ports.web]
base = 39500
range = 100

[env]
NODE_ENV = "test"
`,
    );
    fs.writeFileSync(path.join(repoRoot, ".env"), "FROM_MAIN=1\n");
    fs.writeFileSync(
      path.join(repoRoot, ".codecast/hooks/after-create.sh"),
      `#!/usr/bin/env bash\necho "$CODECAST_WORKTREE_NAME $PORT_WEB" > hook-out.txt\n`,
    );

    const r = await acquireWorkspace(repoRoot, "feat-full");
    expect(r.created).toBe(true);
    expect(r.workspace.state).toBe("ready");
    expect(r.workspace.ports.web).toBe(39500);

    // Copy happened
    expect(fs.readFileSync(path.join(r.workspace.path, ".env"), "utf-8")).toContain(
      "FROM_MAIN=1",
    );
    // Install happened (in worktree CWD)
    expect(
      fs.readFileSync(path.join(r.workspace.path, "install-ran.txt"), "utf-8").trim(),
    ).toBe("INSTALL");
    // Hook happened with env injection
    expect(
      fs.readFileSync(path.join(r.workspace.path, "hook-out.txt"), "utf-8").trim(),
    ).toBe("feat-full 39500");
  });

  test("setup failure marks workspace broken and rethrows", async () => {
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".codecast/workspace.toml"),
      `[setup]\ninstall = ["exit 9"]\n`,
    );

    let err: unknown;
    try {
      await acquireWorkspace(repoRoot, "feat-fail");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(readState(repoRoot, "feat-fail")?.state).toBe("broken");
  });
});

describe("healWorkspace", () => {
  test("re-runs setup on a broken workspace", async () => {
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".codecast/workspace.toml"),
      `[setup]\ninstall = ["touch healed.txt"]\n`,
    );
    await acquireWorkspace(repoRoot, "feat-heal");
    const wsPath = readState(repoRoot, "feat-heal")!.path;
    // Simulate breakage: delete the install marker file.
    fs.rmSync(path.join(wsPath, "healed.txt"));

    const healed = await healWorkspace(repoRoot, "feat-heal");
    expect(healed.state).toBe("ready");
    expect(fs.existsSync(path.join(wsPath, "healed.txt"))).toBe(true);
  });

  test("healing a non-existent workspace throws", async () => {
    await expect(healWorkspace(repoRoot, "missing")).rejects.toThrow(/not found/);
  });
});

describe("validateWorkspace", () => {
  test("happy path returns ok=true contract result", async () => {
    await acquireWorkspace(repoRoot, "feat-v");
    const r = await validateWorkspace(repoRoot, "feat-v");
    expect(r.ok).toBe(true);
  });

  test("unknown workspace throws", async () => {
    await expect(validateWorkspace(repoRoot, "missing")).rejects.toThrow(/not found/);
  });
});

describe("listWorkspaces", () => {
  test("returns all tracked workspaces", async () => {
    await acquireWorkspace(repoRoot, "a");
    await acquireWorkspace(repoRoot, "b");
    const all = listWorkspaces(repoRoot).map((w) => w.name).sort();
    expect(all).toEqual(["a", "b"]);
  });

  test("empty repo → empty list", () => {
    expect(listWorkspaces(repoRoot)).toEqual([]);
  });
});

describe("acquireWorkspace — with browser enabled", () => {
  test("launches Chrome and exposes CDP port; releaseWorkspace stops it", async () => {
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".codecast/workspace.toml"),
      `
[browser]
enabled = true
headless = true

[browser.cdp_port]
base = 39700
range = 100
`,
    );

    const r = await acquireWorkspace(repoRoot, "feat-browser");
    expect(r.workspace.state).toBe("ready");
    expect(r.workspace.chrome).toBeDefined();
    const chrome = r.workspace.chrome!;
    expect(chrome.pid).toBeGreaterThan(0);
    expect(chrome.cdpPort).toBe(39700);

    // CDP /json/version is reachable.
    const ver = (await fetch(`http://127.0.0.1:${chrome.cdpPort}/json/version`).then((res) =>
      res.json(),
    )) as { Browser?: string };
    expect(typeof ver.Browser).toBe("string");

    // PID is alive prior to release.
    let alive = false;
    try {
      process.kill(chrome.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(true);

    // Release stops Chrome.
    await releaseWorkspace(repoRoot, "feat-browser");
    // Give the OS a moment to reap.
    await new Promise((res) => setTimeout(res, 300));
    let stillAlive = false;
    try {
      process.kill(chrome.pid, 0);
      stillAlive = true;
    } catch {
      stillAlive = false;
    }
    expect(stillAlive).toBe(false);
  }, 25000);
});

describe("acquireWorkspace + warm pool integration", () => {
  test("pre-warmed slot is consumed by acquireWorkspace fast path", async () => {
    const { maintainPool, waitForReadySlot } = await import("./pool/manager.js");

    // Pre-warm one slot
    await maintainPool(repoRoot, 1);
    const ready = await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });
    expect(ready).not.toBeNull();

    // Acquire — should claim from pool, returning fast
    const start = Date.now();
    const r = await acquireWorkspace(repoRoot, "feat-from-pool");
    const elapsed = Date.now() - start;

    expect(r.workspace.state).toBe("ready");
    expect(r.workspace.name).toBe("feat-from-pool");
    expect(r.workspace.branch).toBe("codecast/feat-from-pool");

    // Pool-fed acquires should be fast — usually under 500ms since no
    // git worktree add + setup run. (Real codecast bun install takes ~3s.)
    // We assert generously to avoid CI flakiness.
    expect(elapsed).toBeLessThan(3000);

    // The renamed workspace exists in state.
    const list = listWorkspaces(repoRoot);
    expect(list.map((w) => w.name)).toContain("feat-from-pool");
  }, 30000);

  test("acquire with skipPool=true bypasses pool even when slot is ready", async () => {
    const { maintainPool, waitForReadySlot } = await import("./pool/manager.js");
    await maintainPool(repoRoot, 1);
    await waitForReadySlot(repoRoot, { timeoutMs: 15000, pollMs: 100 });

    const r = await acquireWorkspace(repoRoot, "fresh-feat", { skipPool: true });
    expect(r.workspace.name).toBe("fresh-feat");
    // Pool slot still ready since we didn't claim it.
    const { readPoolState } = await import("./pool/state.js");
    const ps = readPoolState(repoRoot)!;
    expect(ps.slots.some((s) => s.state === "ready")).toBe(true);
  }, 30000);
});

describe("releaseWorkspace", () => {
  test("removes worktree + state, runs teardown commands", async () => {
    fs.mkdirSync(path.join(repoRoot, ".codecast"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, ".codecast/workspace.toml"),
      `
[setup]
install = ["true"]

[teardown]
run = ["touch ${repoRoot}/tornDown.txt"]
`,
    );
    const r = await acquireWorkspace(repoRoot, "feat-rel");
    const wsPath = r.workspace.path;
    expect(fs.existsSync(wsPath)).toBe(true);

    await releaseWorkspace(repoRoot, "feat-rel");
    expect(fs.existsSync(wsPath)).toBe(false);
    expect(readState(repoRoot, "feat-rel")).toBeNull();
    expect(fs.existsSync(path.join(repoRoot, "tornDown.txt"))).toBe(true);
  });

  test("releasing an unknown workspace is a no-op (doesn't throw)", async () => {
    await releaseWorkspace(repoRoot, "never-existed");
    // no throw
  });
});
