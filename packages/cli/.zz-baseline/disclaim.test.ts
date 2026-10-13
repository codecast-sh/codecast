import { describe, test, expect } from "bun:test";
import * as path from "path";
import { buildDisclaimShellPrefix } from "./disclaim.js";

describe("buildDisclaimShellPrefix", () => {
  test("darwin gets the wrapper prefix", () => {
    expect(buildDisclaimShellPrefix("cast", { platform: "darwin", env: {} })).toBe("cast _disclaimed -- ");
  });

  test("multi-token cast invocations pass through verbatim", () => {
    expect(
      buildDisclaimShellPrefix("/usr/local/bin/bun /repo/src/index.ts", { platform: "darwin", env: {} }),
    ).toBe("/usr/local/bin/bun /repo/src/index.ts _disclaimed -- ");
  });

  test("no wrapper off-macOS", () => {
    expect(buildDisclaimShellPrefix("cast", { platform: "linux", env: {} })).toBe("");
  });

  test("CODECAST_NO_DISCLAIM=1 is the kill switch", () => {
    expect(buildDisclaimShellPrefix("cast", { platform: "darwin", env: { CODECAST_NO_DISCLAIM: "1" } })).toBe("");
  });
});

describe("runDisclaimed (subprocess)", () => {
  const entry = path.join(import.meta.dir, "disclaim.ts");
  const run = (args: string[]) =>
    Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `import { runDisclaimed } from ${JSON.stringify(entry)}; runDisclaimed(${JSON.stringify(args)});`,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });

  test("execs the command and inherits stdout", () => {
    const r = run(["--", "/bin/echo", "ok-disclaimed"]);
    expect(r.stdout.toString().trim()).toBe("ok-disclaimed");
    expect(r.exitCode).toBe(0);
  });

  test("mirrors the command's exit code", () => {
    const r = run(["--", "/bin/sh", "-c", "exit 7"]);
    expect(r.exitCode).toBe(7);
  });

  test("passes the environment through", () => {
    const r = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `import { runDisclaimed } from ${JSON.stringify(entry)}; runDisclaimed(["--", "/bin/sh", "-c", "echo $DISCLAIM_TEST_VAR"]);`,
      ],
      env: { ...process.env, DISCLAIM_TEST_VAR: "carried" },
      stdout: "pipe",
    });
    expect(r.stdout.toString().trim()).toBe("carried");
  });

  test("takes the real disclaim path on macOS (not the fallback)", () => {
    if (process.platform !== "darwin") return;
    const r = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `import { runDisclaimed } from ${JSON.stringify(entry)}; runDisclaimed(["--", "/bin/echo", "via-ffi"]);`,
      ],
      env: { ...process.env, CODECAST_DISCLAIM_DEBUG: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(r.stderr.toString()).toContain("attrs ok, exec'ing /bin/echo disclaimed");
    expect(r.stdout.toString().trim()).toBe("via-ffi");
  });

  test("handles the daemon's real command shape (env prefix with var assignments)", () => {
    const r = run(["--", "env", "-u", "CLAUDECODE", "DISCLAIM_SHAPE=yes", "/bin/sh", "-c", "echo shape=$DISCLAIM_SHAPE claudecode=$CLAUDECODE"]);
    expect(r.stdout.toString().trim()).toBe("shape=yes claudecode=");
    expect(r.exitCode).toBe(0);
  });

  test("empty argv exits 2 with usage", () => {
    const r = run([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("usage");
  });
});
