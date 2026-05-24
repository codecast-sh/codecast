import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runSetup, SetupError } from "./setup.js";
import type { WorkspaceManifest } from "./types.js";

let wtDir: string;

beforeEach(() => {
  wtDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-setup-"));
});

afterEach(() => {
  fs.rmSync(wtDir, { recursive: true, force: true });
});

function manifest(setup: Partial<WorkspaceManifest["setup"]>): WorkspaceManifest {
  return {
    setup: {
      copy: setup.copy ?? [],
      install: setup.install ?? [],
      generate: setup.generate ?? [],
      migrate: setup.migrate ?? [],
    },
    ports: {},
    services: {},
    env: {},
    teardown: { run: [] },
    browser: { enabled: false, headless: true, cdpPort: { base: 9222, range: 100 } },
  backend: "local",
  };
}

describe("runSetup", () => {
  test("runs install commands in worktree CWD and captures log", async () => {
    const r = await runSetup(
      manifest({ install: ["pwd > pwd.out", "echo hello > greet.out"] }),
      wtDir,
      { stream: null },
    );
    expect(r.ran.length).toBe(2);
    expect(r.ran[0]!.phase).toBe("install");
    expect(fs.readFileSync(path.join(wtDir, "pwd.out"), "utf-8").trim()).toBe(
      fs.realpathSync(wtDir),
    );
    expect(fs.readFileSync(path.join(wtDir, "greet.out"), "utf-8").trim()).toBe("hello");
    expect(fs.existsSync(r.logPath)).toBe(true);
    const log = fs.readFileSync(r.logPath, "utf-8");
    expect(log).toContain("--- install: pwd > pwd.out ---");
    expect(log).toContain("=== setup complete ===");
  });

  test("runs phases in order: install → generate → migrate", async () => {
    const r = await runSetup(
      manifest({
        install: ["echo i >> trace.txt"],
        generate: ["echo g >> trace.txt"],
        migrate: ["echo m >> trace.txt"],
      }),
      wtDir,
      { stream: null },
    );
    expect(r.ran.map((x) => x.phase)).toEqual(["install", "generate", "migrate"]);
    expect(fs.readFileSync(path.join(wtDir, "trace.txt"), "utf-8")).toBe("i\ng\nm\n");
  });

  test("env vars are injected into the command shell", async () => {
    const r = await runSetup(
      manifest({ install: ["echo $WORKSPACE_NAME > name.out"] }),
      wtDir,
      { stream: null, env: { WORKSPACE_NAME: "feat-x" } },
    );
    expect(fs.readFileSync(path.join(wtDir, "name.out"), "utf-8").trim()).toBe("feat-x");
    expect(r.ran.length).toBe(1);
  });

  test("non-zero exit halts execution and throws SetupError with phase + command", async () => {
    const m = manifest({
      install: ["echo before-fail > marker.txt", "exit 7", "echo after-fail >> marker.txt"],
      generate: ["echo generate-ran >> marker.txt"],
    });
    let err: unknown;
    try {
      await runSetup(m, wtDir, { stream: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SetupError);
    const se = err as SetupError;
    expect(se.phase).toBe("install");
    expect(se.command).toBe("exit 7");
    expect(se.exitCode).toBe(7);
    expect(fs.existsSync(se.logPath)).toBe(true);

    // Subsequent commands in the same phase MUST NOT run.
    const marker = fs.readFileSync(path.join(wtDir, "marker.txt"), "utf-8");
    expect(marker).toBe("before-fail\n");
    // Subsequent phases MUST NOT run.
    expect(marker).not.toContain("generate-ran");

    // Log contains failure marker.
    const log = fs.readFileSync(se.logPath, "utf-8");
    expect(log).toContain("FAILED with exit 7");
  });

  test("skipPhases option lets caller skip phases (e.g., during heal)", async () => {
    const r = await runSetup(
      manifest({
        install: ["echo INSTALL > i.txt"],
        generate: ["echo GENERATE > g.txt"],
      }),
      wtDir,
      { stream: null, skipPhases: ["install"] },
    );
    expect(fs.existsSync(path.join(wtDir, "i.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(wtDir, "g.txt"), "utf-8").trim()).toBe("GENERATE");
    expect(r.ran.map((x) => x.phase)).toEqual(["generate"]);
  });

  test("empty manifest is a no-op with a log file", async () => {
    const r = await runSetup(manifest({}), wtDir, { stream: null });
    expect(r.ran).toEqual([]);
    const log = fs.readFileSync(r.logPath, "utf-8");
    expect(log).toContain("=== setup complete ===");
  });

  test("custom logDir is honored", async () => {
    const customLog = fs.mkdtempSync(path.join(os.tmpdir(), "ws-setup-customlog-"));
    try {
      const r = await runSetup(
        manifest({ install: ["true"] }),
        wtDir,
        { stream: null, logDir: customLog },
      );
      expect(r.logPath.startsWith(customLog)).toBe(true);
    } finally {
      fs.rmSync(customLog, { recursive: true, force: true });
    }
  });
});
