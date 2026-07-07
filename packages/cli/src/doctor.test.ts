// Unit tests for the pure pieces of `cast doctor`, plus a real-process test of
// the stand-in agent: the stub's JSONL output is parsed with the SAME parser
// the daemon's sync loop uses, so a drift between the stub's transcript shape
// and what production accepts fails here instead of as a false doctor alarm.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pickDoctorProjectDir, exportHasToken, resolveStubRuntime, STUB_SOURCE } from "./doctor.js";
import { parseSessionFile } from "./parser.js";
import { TEST_SCRATCH_DIRNAME } from "./syncScope.js";
import type { Config } from "./config/types.js";

const baseConfig = { auth_token: "t", convex_url: "https://x.example" } as unknown as Config;

describe("pickDoctorProjectDir", () => {
  test("sync all: defaults to a dir under ~/.codecast/doctor", () => {
    const dir = pickDoctorProjectDir({ ...baseConfig, sync_mode: "all" } as Config, "abc123");
    expect(dir).toBe(path.join(os.homedir(), ".codecast", "doctor", "e2e-abc123"));
  });

  test("selected mode: falls through to a dir under an allowed root", () => {
    const root = path.join(os.tmpdir(), "doctor-root");
    const dir = pickDoctorProjectDir(
      { ...baseConfig, sync_mode: "selected", sync_projects: [root] } as Config,
      "abc123",
    );
    expect(dir).toBe(path.join(root, ".codecast-doctor", "e2e-abc123"));
  });

  test("selected mode with no roots: null (nowhere syncable)", () => {
    const dir = pickDoctorProjectDir({ ...baseConfig, sync_mode: "selected", sync_projects: [] } as Config, "x");
    expect(dir).toBeNull();
  });

  test("excluded_paths knocks out a candidate the allowlist would accept", () => {
    const dir = pickDoctorProjectDir(
      { ...baseConfig, sync_mode: "all", excluded_paths: path.join(os.homedir(), ".codecast") } as unknown as Config,
      "x",
    );
    expect(dir).toBeNull();
  });

  test("override is validated against the same rules, not trusted", () => {
    const bad = path.join(os.tmpdir(), TEST_SCRATCH_DIRNAME, "sub");
    expect(pickDoctorProjectDir({ ...baseConfig, sync_mode: "all" } as Config, "x", bad)).toBeNull();
    const good = path.join(os.tmpdir(), "fine");
    expect(pickDoctorProjectDir({ ...baseConfig, sync_mode: "all" } as Config, "x", good)).toBe(good);
  });
});

describe("exportHasToken", () => {
  const messages = [
    { role: "user", content: "reply with pong-99" },
    { role: "assistant", content: "pong-11" },
  ];
  test("any role", () => {
    expect(exportHasToken(messages, "pong-99")).toBe(true);
  });
  test("role narrows the match", () => {
    // The delivered request contains the token as a USER message; only the
    // agent's own echo proves the round trip, so the assistant filter must
    // not match the request.
    expect(exportHasToken(messages, "pong-99", "assistant")).toBe(false);
    expect(exportHasToken(messages, "pong-11", "assistant")).toBe(true);
  });
});

// The stub is launched as a real child process (pipes instead of a tmux pane)
// and driven the way the daemon's inject drives it: a line on stdin. Skipped
// when no node/bun runtime is available.
const runtime = resolveStubRuntime();

describe.skipIf(!runtime)("doctor stub agent", () => {
  test("bootstraps, echoes an injected token, and writes parser-valid JSONL", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-stub-test-"));
    const jsonlPath = path.join(scratch, "transcript.jsonl");
    const registryPath = path.join(scratch, "registry.json");
    const stubPath = path.join(scratch, "stub.cjs");

    fs.writeFileSync(stubPath, STUB_SOURCE);

    const child = spawn(runtime!, [stubPath, "11111111-2222-3333-4444-555555555555", jsonlPath, registryPath], {
      cwd: scratch,
      env: { ...process.env, DOCTOR_BOOT_TOKEN: "boot-feed" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });

    try {
      // Wait for bootstrap (registry + 2 JSONL lines).
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        if (fs.existsSync(registryPath) && fs.existsSync(jsonlPath)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(fs.existsSync(registryPath)).toBe(true);
      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8"));
      expect(registry.pid).toBe(child.pid);

      // Inject like the daemon does — text then Enter — including the kind of
      // bracketed-paste garnish a tmux paste can carry.
      child.stdin.write("\x1b[200~codecast doctor r1: reply with pong-cafe1234\x1b[201~\r");

      let lines: string[] = [];
      while (Date.now() < deadline + 5000) {
        lines = fs.existsSync(jsonlPath) ? fs.readFileSync(jsonlPath, "utf-8").trim().split("\n") : [];
        if (lines.length >= 4) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(lines.length).toBeGreaterThanOrEqual(4);

      // The production parser must accept every line and see the round trip.
      const messages = parseSessionFile(lines.join("\n") + "\n");
      expect(messages.length).toBe(4);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toContain("boot-feed");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("boot-feed");
      expect(messages[2].role).toBe("user");
      expect(messages[2].content).toBe("codecast doctor r1: reply with pong-cafe1234");
      expect(messages[3].role).toBe("assistant");
      expect(messages[3].content).toBe("pong-cafe1234");

      // Every entry carries the fields the sync loop keys on.
      for (const raw of lines) {
        const entry = JSON.parse(raw);
        expect(entry.sessionId).toBe("11111111-2222-3333-4444-555555555555");
        expect(entry.cwd).toBeTruthy();
        expect(entry.uuid).toBeTruthy();
        expect(entry.timestamp).toBeTruthy();
      }
    } finally {
      child.kill("SIGTERM");
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    expect(stderr).toBe("");
  }, 20_000);
});
