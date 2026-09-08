// The gate that decides whether a real-tmux suite runs. Three outcomes, and the
// third one is the whole point: a probe that could not run must be loud, or a
// suite skips itself and its "0 pass 0 fail" reads as green (ct-49770).

import { describe, expect, test, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasBinary, resetBinaryProbeCache, type ProbeResult } from "./binaryProbe.js";

const found = (): ProbeResult => ({ status: 0, stdout: "/usr/bin/tmux\n" });
const absent = (): ProbeResult => ({ status: 1, stdout: "" });
const spawnFailed = (code: string): ProbeResult => ({
  status: null,
  stdout: "",
  error: Object.assign(new Error(`spawn which ${code}`), { code }),
});

describe("hasBinary", () => {
  beforeEach(() => resetBinaryProbeCache());

  test("a binary `which` resolves is present", () => {
    expect(hasBinary("tmux", { spawn: found })).toBe(true);
  });

  test("a binary `which` cannot find is absent — the skip CI depends on", () => {
    // Every CI runner today has no agent client installed. That path must stay
    // a quiet false, not a failure.
    expect(hasBinary("claude", { spawn: absent })).toBe(false);
  });

  test("a real absent binary is absent, and a real present one is present", () => {
    expect(hasBinary("codecast-no-such-binary-ab12cd")).toBe(false);
    expect(hasBinary("sh")).toBe(true);
  });

  test("a transient spawn failure is retried, not read as absence", () => {
    let attempt = 0;
    const spawn = (): ProbeResult => (++attempt < 3 ? spawnFailed("EAGAIN") : found());
    expect(hasBinary("tmux", { spawn, sleep: () => {} })).toBe(true);
    expect(attempt).toBe(3);
  });

  test("a persistent spawn failure throws with the errno instead of skipping", () => {
    let attempt = 0;
    const spawn = (): ProbeResult => { attempt++; return spawnFailed("EAGAIN"); };
    expect(() => hasBinary("claude", { spawn, sleep: () => {} }))
      .toThrow(/cannot tell whether `claude` is installed[\s\S]*EAGAIN/);
    expect(attempt).toBe(4);
  });

  test("a probe killed by a signal is could-not-ask, not absence", () => {
    const spawn = (): ProbeResult => ({ status: null, stdout: "", signal: "SIGKILL" });
    expect(() => hasBinary("tmux", { spawn, attempts: 2, sleep: () => {} }))
      .toThrow(/killed by SIGKILL/);
  });

  test("an answered probe is resolved once per binary", () => {
    let calls = 0;
    const spawn = (): ProbeResult => { calls++; return found(); };
    expect(hasBinary("tmux", { spawn })).toBe(true);
    expect(hasBinary("tmux", { spawn })).toBe(true);
    expect(calls).toBe(1);
  });

  // The end-to-end shape of the bug: a real `bun test` run whose gate is
  // evaluated at module scope, with a `which` the OS refuses to execute. The
  // file must FAIL and name the errno. Before the fix this exact run reported
  // one skipped test and exit 0 — a broken gate that looked green.
  test("a suite whose gate cannot probe fails loudly instead of skipping", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "binary-probe-loud-"));
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    // A `which` that cannot be executed (mode 644) on a PATH holding nothing
    // else: the spawn fails at the OS, which is the "could not ask" class.
    fs.writeFileSync(path.join(bin, "which"), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const probe = path.resolve(import.meta.dir, "binaryProbe.ts");
    fs.writeFileSync(path.join(dir, "gate.test.ts"), [
      `import { describe, test, expect } from "bun:test";`,
      `import { hasBinary } from ${JSON.stringify(probe)};`,
      `describe.skipIf(!hasBinary("claude"))("real claude suite", () => {`,
      `  test("runs", () => { expect(1).toBe(1); });`,
      `});`,
    ].join("\n"));

    // bun by absolute path, because PATH holds only the broken `which`.
    const run = Bun.spawnSync([process.execPath, "test", "gate.test.ts"], {
      cwd: dir,
      env: { PATH: bin, HOME: process.env.HOME ?? "" },
    });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`;
    fs.rmSync(dir, { recursive: true, force: true });

    expect(run.exitCode).not.toBe(0);
    expect(output).toContain("cannot tell whether `claude` is installed");
    expect(output).toMatch(/ENOENT|EACCES/);
    expect(output).not.toMatch(/1 skip/);
  }, 30_000);
});
