import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { E2bBackend } from "./e2b.js";
import { MacMiniBackend } from "./mac-mini.js";
import { defaultRegistry, ensureCloudBackendsLoaded } from "./registry.js";

let repoRoot: string;

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-backend-"));
  execSync("git init -q -b main", { cwd: repoRoot });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, "README.md"), "x\n");
  execSync("git add . && git commit -q -m init", { cwd: repoRoot });
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe("cloud backend registration", () => {
  test("both cloud backends register in the default registry", async () => {
    await ensureCloudBackendsLoaded();
    expect(defaultRegistry.has("e2b")).toBe(true);
    expect(defaultRegistry.has("mac")).toBe(true);
    // local always there too
    expect(defaultRegistry.has("local")).toBe(true);
  });

  test("backend names are stable identifiers", () => {
    expect(E2bBackend.name).toBe("e2b");
    expect(MacMiniBackend.name).toBe("mac");
  });
});

describe("E2bBackend — credential + SDK guards", () => {
  test("acquire without E2B_API_KEY throws a clear setup error", async () => {
    const oldKey = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      await expect(E2bBackend.acquire(repoRoot, "feat-x")).rejects.toThrow(
        /E2B_API_KEY env var is not set|requires the 'e2b' npm package/,
      );
    } finally {
      if (oldKey !== undefined) process.env.E2B_API_KEY = oldKey;
    }
  });

  test("exec on missing workspace throws not-found", async () => {
    await expect(E2bBackend.exec(repoRoot, "nope", "ls")).rejects.toThrow(/not found/);
  });

  test("readFile/writeFile on missing workspace throw not-found", async () => {
    await expect(E2bBackend.readFile(repoRoot, "nope", "x")).rejects.toThrow(/not found/);
    await expect(E2bBackend.writeFile(repoRoot, "nope", "x", "y")).rejects.toThrow(/not found/);
  });

  test("release of unknown workspace is a no-op", async () => {
    await E2bBackend.release(repoRoot, "never-existed"); // no throw
  });

  test("validate on missing workspace throws not-found", async () => {
    await expect(E2bBackend.validate(repoRoot, "nope")).rejects.toThrow(/not found/);
  });
});

describe("MacMiniBackend — credential guards", () => {
  test("acquire without Scaleway secret throws a clear setup error", async () => {
    const oldToken = process.env.SCALEWAY_API_TOKEN;
    const oldSecret = process.env.SCALEWAY_SECRET_KEY;
    const oldProj = process.env.SCALEWAY_PROJECT_ID;
    delete process.env.SCALEWAY_API_TOKEN;
    delete process.env.SCALEWAY_SECRET_KEY;
    delete process.env.SCALEWAY_PROJECT_ID;
    try {
      await expect(MacMiniBackend.acquire(repoRoot, "feat-x")).rejects.toThrow(
        /SCALEWAY_SECRET_KEY \(or SCALEWAY_API_TOKEN\) env var is not set/,
      );
    } finally {
      if (oldToken !== undefined) process.env.SCALEWAY_API_TOKEN = oldToken;
      if (oldSecret !== undefined) process.env.SCALEWAY_SECRET_KEY = oldSecret;
      if (oldProj !== undefined) process.env.SCALEWAY_PROJECT_ID = oldProj;
    }
  });

  test("acquire with secret but no project throws project error", async () => {
    const oldToken = process.env.SCALEWAY_API_TOKEN;
    const oldSecret = process.env.SCALEWAY_SECRET_KEY;
    const oldProj = process.env.SCALEWAY_PROJECT_ID;
    process.env.SCALEWAY_SECRET_KEY = "fake-secret-for-test";
    delete process.env.SCALEWAY_API_TOKEN;
    delete process.env.SCALEWAY_PROJECT_ID;
    try {
      await expect(MacMiniBackend.acquire(repoRoot, "feat-x")).rejects.toThrow(
        /SCALEWAY_PROJECT_ID env var is not set/,
      );
    } finally {
      if (oldToken !== undefined) process.env.SCALEWAY_API_TOKEN = oldToken;
      else delete process.env.SCALEWAY_API_TOKEN;
      if (oldSecret !== undefined) process.env.SCALEWAY_SECRET_KEY = oldSecret;
      else delete process.env.SCALEWAY_SECRET_KEY;
      if (oldProj !== undefined) process.env.SCALEWAY_PROJECT_ID = oldProj;
    }
  });

  test("exec/readFile/writeFile on missing workspace throw not-found", async () => {
    await expect(MacMiniBackend.exec(repoRoot, "nope", "ls")).rejects.toThrow(/not found/);
    await expect(MacMiniBackend.readFile(repoRoot, "nope", "x")).rejects.toThrow(/not found/);
    await expect(MacMiniBackend.writeFile(repoRoot, "nope", "x", "y")).rejects.toThrow(/not found/);
  });

  test("release of unknown workspace is a no-op", async () => {
    await MacMiniBackend.release(repoRoot, "never-existed"); // no throw
  });
});
