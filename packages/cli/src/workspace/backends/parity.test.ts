/**
 * Backend parity test suite.
 *
 * Runs the SAME scenarios against EVERY registered SandboxBackend. The
 * scenarios capture the cross-backend contract — every implementation must
 * behave identically here. When we add cloud backends, no test duplication:
 * register the new backend and flip CODECAST_TEST_BACKENDS to include it.
 *
 * Which backends are tested:
 *   - Default: just "local" (always cheap, always available).
 *   - Env: CODECAST_TEST_BACKENDS=local,modal includes additional registered
 *     backends. Cloud-only backends are EXPECTED to fail when run without
 *     credentials; that's why we gate via env.
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultRegistry, ensureCloudBackendsLoaded } from "./registry.js";
import type { SandboxBackend } from "./types.js";

const TESTED_BACKENDS = (process.env.CODECAST_TEST_BACKENDS ?? "local")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Cloud backends register asynchronously; if any non-local backend is
// requested, wait for registration to finish before the suites run.
beforeAll(async () => {
  if (TESTED_BACKENDS.some((b) => b !== "local")) {
    await ensureCloudBackendsLoaded();
  }
});

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-parity-"));
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "README.md"), "parity\n");
  execSync("git add . && git commit -q -m init", { cwd: dir });
  return dir;
}

function cleanupRepo(dir: string) {
  try { execSync("git worktree prune", { cwd: dir, stdio: "ignore" }); } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
}

for (const backendName of TESTED_BACKENDS) {
  describe(`parity — backend='${backendName}'`, () => {
    let backend: SandboxBackend;
    let repoRoot: string;
    let created: string[] = [];

    beforeEach(() => {
      if (!defaultRegistry.has(backendName)) {
        // We can't gracefully skip a describe-level conditional in bun:test
        // without bun:test.it.if; instead, throw a clear error so the user
        // sees what's missing.
        throw new Error(
          `backend '${backendName}' from CODECAST_TEST_BACKENDS not registered`,
        );
      }
      backend = defaultRegistry.get(backendName);
      repoRoot = makeRepo();
      created = [];
    });

    afterEach(async () => {
      for (const name of created) {
        try { await backend.release(repoRoot, name); } catch {}
      }
      cleanupRepo(repoRoot);
    });

    async function acquire(name: string) {
      created.push(name);
      return backend.acquire(repoRoot, name);
    }

    // ----------------------------------------------------------------------
    // Acquire / release
    // ----------------------------------------------------------------------

    test("acquire returns ready Workspace with correct name", async () => {
      const ws = await acquire("p-acq");
      expect(ws.name).toBe("p-acq");
      expect(ws.state).toBe("ready");
    }, 30000);

    test("release of unknown workspace is a no-op", async () => {
      // Should not throw.
      await backend.release(repoRoot, "p-never-existed");
    });

    // ----------------------------------------------------------------------
    // Exec
    // ----------------------------------------------------------------------

    test("exec returns exit=0 + stdout for successful command", async () => {
      await acquire("p-exec-ok");
      const r = await backend.exec(repoRoot, "p-exec-ok", "echo parity-stdout");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("parity-stdout");
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }, 30000);

    test("exec returns non-zero exit + stderr on failure (no throw)", async () => {
      await acquire("p-exec-fail");
      const r = await backend.exec(repoRoot, "p-exec-fail", "echo oops >&2; exit 42");
      expect(r.exitCode).toBe(42);
      expect(r.stderr).toContain("oops");
    }, 30000);

    test("exec respects opts.env", async () => {
      await acquire("p-exec-env");
      const r = await backend.exec(repoRoot, "p-exec-env", "echo $MY_VAR", {
        env: { MY_VAR: "parity-value" },
      });
      expect(r.stdout).toContain("parity-value");
    }, 30000);

    // ----------------------------------------------------------------------
    // File I/O
    // ----------------------------------------------------------------------

    test("writeFile then readFile roundtrips correctly", async () => {
      await acquire("p-fs");
      await backend.writeFile(repoRoot, "p-fs", "parity.txt", "hello-parity\n");
      const got = await backend.readFile(repoRoot, "p-fs", "parity.txt");
      expect(got.toString("utf-8")).toBe("hello-parity\n");
    }, 30000);

    test("writeFile creates intermediate directories", async () => {
      await acquire("p-fs-deep");
      await backend.writeFile(
        repoRoot, "p-fs-deep", "a/b/c/deep.txt", "deep\n",
      );
      const got = await backend.readFile(repoRoot, "p-fs-deep", "a/b/c/deep.txt");
      expect(got.toString("utf-8")).toBe("deep\n");
    }, 30000);

    // ----------------------------------------------------------------------
    // Validate
    // ----------------------------------------------------------------------

    test("validate returns ok=true for a fresh acquire", async () => {
      await acquire("p-val");
      const r = await backend.validate(repoRoot, "p-val");
      expect(r.ok).toBe(true);
    }, 30000);

    // ----------------------------------------------------------------------
    // List
    // ----------------------------------------------------------------------

    test("list returns workspaces created via this backend", async () => {
      await acquire("p-list-a");
      await acquire("p-list-b");
      const names = (await backend.list(repoRoot)).map((w) => w.name).sort();
      expect(names).toContain("p-list-a");
      expect(names).toContain("p-list-b");
    }, 45000);
  });
}
