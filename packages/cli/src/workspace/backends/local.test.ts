import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LocalBackend } from "./local.js";
import { defaultRegistry, getBackend } from "./registry.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "backend-local-"));
  execSync("git init -q -b main", { cwd: repoRoot });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "x\n");
  execSync("git add . && git commit -q -m init", { cwd: repoRoot });
});

afterEach(() => {
  try { execSync("git worktree prune", { cwd: repoRoot, stdio: "ignore" }); } catch {}
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("registry", () => {
  test("default registry contains 'local'", () => {
    expect(defaultRegistry.has("local")).toBe(true);
    expect(defaultRegistry.list()).toContain("local");
  });

  test("getBackend() with no arg returns local", () => {
    expect(getBackend().name).toBe("local");
  });

  test("get() on unknown backend throws with helpful message", () => {
    expect(() => defaultRegistry.get("modal-pretend")).toThrow(/unknown backend 'modal-pretend'/);
  });

  test("registering a new backend makes it discoverable", () => {
    const fake = {
      name: "fake-test-only",
      acquire: async () => { throw new Error("not impl"); },
      release: async () => {},
      heal: async () => { throw new Error("not impl"); },
      validate: async () => ({ ok: true, checks: [] }),
      list: async () => [],
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0, durationMs: 0 }),
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => {},
    };
    defaultRegistry.register(fake);
    try {
      expect(defaultRegistry.has("fake-test-only")).toBe(true);
      expect(getBackend("fake-test-only").name).toBe("fake-test-only");
    } finally {
      // No unregister method by design; clean up by re-registering local
      // to assert the fake exists alongside, then leave it (test isolation
      // is via afterEach not registry isolation — this is intentional, the
      // registry is process-wide).
    }
  });
});

describe("LocalBackend — interface conformance + parity", () => {
  test("name is 'local'", () => {
    expect(LocalBackend.name).toBe("local");
  });

  test("acquire returns a ready Workspace", async () => {
    const ws = await LocalBackend.acquire(repoRoot, "feat-x");
    expect(ws.name).toBe("feat-x");
    expect(ws.state).toBe("ready");
    expect(fs.existsSync(ws.path)).toBe(true);
    await LocalBackend.release(repoRoot, "feat-x");
  });

  test("exec runs a shell command in workspace CWD with env", async () => {
    await LocalBackend.acquire(repoRoot, "feat-exec");
    const r = await LocalBackend.exec(repoRoot, "feat-exec", "pwd && echo $FOO", {
      env: { FOO: "bar" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("feat-exec");
    expect(r.stdout).toContain("bar");
    await LocalBackend.release(repoRoot, "feat-exec");
  });

  test("exec respects opts.cwd (relative to workspace root)", async () => {
    await LocalBackend.acquire(repoRoot, "feat-cwd");
    // Create a subdir
    await LocalBackend.exec(repoRoot, "feat-cwd", "mkdir -p sub && echo here > sub/here.txt");
    const r = await LocalBackend.exec(repoRoot, "feat-cwd", "cat here.txt", { cwd: "sub" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("here");
    await LocalBackend.release(repoRoot, "feat-cwd");
  });

  test("exec returns non-zero exitCode on command failure (no throw)", async () => {
    await LocalBackend.acquire(repoRoot, "feat-fail");
    const r = await LocalBackend.exec(repoRoot, "feat-fail", "exit 17");
    expect(r.exitCode).toBe(17);
    await LocalBackend.release(repoRoot, "feat-fail");
  });

  test("readFile/writeFile roundtrip", async () => {
    await LocalBackend.acquire(repoRoot, "feat-fs");
    await LocalBackend.writeFile(repoRoot, "feat-fs", "nested/sub/file.txt", "hello\n");
    const got = await LocalBackend.readFile(repoRoot, "feat-fs", "nested/sub/file.txt");
    expect(got.toString("utf-8")).toBe("hello\n");
    await LocalBackend.release(repoRoot, "feat-fs");
  });

  test("validate matches lifecycle.validateWorkspace", async () => {
    await LocalBackend.acquire(repoRoot, "feat-v");
    const direct = await (await import("../lifecycle.js")).validateWorkspace(repoRoot, "feat-v");
    const viaBackend = await LocalBackend.validate(repoRoot, "feat-v");
    expect(viaBackend.ok).toBe(direct.ok);
    await LocalBackend.release(repoRoot, "feat-v");
  });

  test("list returns workspaces created via backend acquire", async () => {
    await LocalBackend.acquire(repoRoot, "feat-a");
    await LocalBackend.acquire(repoRoot, "feat-b");
    const all = await LocalBackend.list(repoRoot);
    const names = all.map((w) => w.name).sort();
    expect(names).toEqual(["feat-a", "feat-b"]);
    await LocalBackend.release(repoRoot, "feat-a");
    await LocalBackend.release(repoRoot, "feat-b");
  });

  test("missing workspace: exec/readFile/writeFile throw clear error", async () => {
    await expect(LocalBackend.exec(repoRoot, "nope", "true")).rejects.toThrow(/not found/);
    await expect(LocalBackend.readFile(repoRoot, "nope", "x")).rejects.toThrow(/not found/);
    await expect(LocalBackend.writeFile(repoRoot, "nope", "x", "y")).rejects.toThrow(/not found/);
  });
});
