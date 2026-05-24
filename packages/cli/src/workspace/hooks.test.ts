import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildHookEnv, HookError, HOOKS_DIR, runHook, type HookContext } from "./hooks.js";

let wtDir: string;

beforeEach(() => {
  wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-hooks-"));
});

afterEach(() => {
  fs.rmSync(wtDir, { recursive: true, force: true });
});

function writeHook(name: string, body: string): void {
  const hooksDir = path.join(wtDir, HOOKS_DIR);
  fs.mkdirSync(hooksDir, { recursive: true });
  const p = path.join(hooksDir, `${name}.sh`);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(p, 0o755);
}

const baseCtx = (): HookContext => ({
  worktreePath: wtDir,
  worktreeName: "feat-x",
  branch: "codecast/feat-x",
  resourceIndex: 2,
  ports: { web: 3200, api: 3201 },
  parentBranch: "main",
  extraEnv: { NODE_ENV: "development" },
});

// ---------------------------------------------------------------------------
// buildHookEnv (pure)
// ---------------------------------------------------------------------------

describe("buildHookEnv", () => {
  test("sets CODECAST_* canonical vars", () => {
    const env = buildHookEnv(baseCtx(), "after-create");
    expect(env.CODECAST_HOOK).toBe("after-create");
    expect(env.CODECAST_WORKTREE_PATH).toBe(wtDir);
    expect(env.CODECAST_WORKTREE_NAME).toBe("feat-x");
    expect(env.CODECAST_BRANCH).toBe("codecast/feat-x");
    expect(env.CODECAST_RESOURCE_INDEX).toBe("2");
    expect(env.CODECAST_PARENT_BRANCH).toBe("main");
  });

  test("sets CODECAST_PORT_<NAME> AND bare PORT_<NAME>", () => {
    const env = buildHookEnv(baseCtx(), "after-create");
    expect(env.CODECAST_PORT_WEB).toBe("3200");
    expect(env.PORT_WEB).toBe("3200");
    expect(env.CODECAST_PORT_API).toBe("3201");
    expect(env.PORT_API).toBe("3201");
  });

  test("dmux compatibility env exported (DMUX_WORKTREE_PATH etc)", () => {
    const env = buildHookEnv(baseCtx(), "before-merge");
    expect(env.DMUX_WORKTREE_PATH).toBe(wtDir);
    expect(env.DMUX_SLUG).toBe("feat-x");
    expect(env.DMUX_BRANCH).toBe("codecast/feat-x");
    expect(env.DMUX_TARGET_BRANCH).toBe("main");
  });

  test("manifest [env] vars are layered with CODECAST_* taking precedence", () => {
    const ctx = baseCtx();
    ctx.extraEnv = { NODE_ENV: "development", CODECAST_WORKTREE_NAME: "shouldnt-override" };
    const env = buildHookEnv(ctx, "after-create");
    expect(env.NODE_ENV).toBe("development");
    // CODECAST_* canonical wins over extraEnv attempt to spoof it.
    expect(env.CODECAST_WORKTREE_NAME).toBe("feat-x");
  });
});

// ---------------------------------------------------------------------------
// runHook
// ---------------------------------------------------------------------------

describe("runHook", () => {
  test("returns ran=false when no script exists", async () => {
    const r = await runHook("after-create", baseCtx());
    expect(r.ran).toBe(false);
  });

  test("touches a file when hook runs", async () => {
    writeHook("after-create", "touch hook-ran.txt");
    const r = await runHook("after-create", baseCtx());
    expect(r.ran).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(fs.existsSync(path.join(wtDir, "hook-ran.txt"))).toBe(true);
  });

  test("hook receives CODECAST_* env vars", async () => {
    writeHook(
      "after-create",
      `echo "$CODECAST_HOOK $CODECAST_WORKTREE_NAME $CODECAST_BRANCH $CODECAST_PORT_WEB" > env.out`,
    );
    await runHook("after-create", baseCtx());
    expect(fs.readFileSync(path.join(wtDir, "env.out"), "utf-8").trim()).toBe(
      "after-create feat-x codecast/feat-x 3200",
    );
  });

  test("hook receives DMUX_* compatibility env vars", async () => {
    writeHook(
      "before-merge",
      `echo "$DMUX_SLUG $DMUX_WORKTREE_PATH $DMUX_TARGET_BRANCH" > dmux.out`,
    );
    await runHook("before-merge", baseCtx());
    const out = fs.readFileSync(path.join(wtDir, "dmux.out"), "utf-8").trim();
    expect(out).toBe(`feat-x ${wtDir} main`);
  });

  test("non-zero exit throws HookError carrying exit code + captured output", async () => {
    writeHook(
      "after-agent",
      `echo "broken thing" >&2; exit 13`,
    );
    let err: unknown;
    try {
      await runHook("after-agent", baseCtx());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HookError);
    const he = err as HookError;
    expect(he.hook).toBe("after-agent");
    expect(he.exitCode).toBe(13);
    expect(he.output).toContain("broken thing");
  });

  test("hook CWD is the worktree", async () => {
    writeHook("after-create", "pwd > where.txt");
    await runHook("after-create", baseCtx());
    expect(fs.readFileSync(path.join(wtDir, "where.txt"), "utf-8").trim()).toBe(
      fs.realpathSync(wtDir),
    );
  });

  test("hooksRoot override resolves hooks from a different directory", async () => {
    // Put the hook in a separate directory and point hooksRoot at it.
    const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ws-hooks-ext-"));
    try {
      const extHookDir = path.join(extRoot, HOOKS_DIR);
      fs.mkdirSync(extHookDir, { recursive: true });
      fs.writeFileSync(path.join(extHookDir, "after-create.sh"), "touch from-external.txt\n");
      const ctx = baseCtx();
      ctx.hooksRoot = extRoot;
      const r = await runHook("after-create", ctx);
      expect(r.ran).toBe(true);
      // Script ran in worktree CWD even though it lived in extRoot.
      expect(fs.existsSync(path.join(wtDir, "from-external.txt"))).toBe(true);
    } finally {
      fs.rmSync(extRoot, { recursive: true, force: true });
    }
  });
});
