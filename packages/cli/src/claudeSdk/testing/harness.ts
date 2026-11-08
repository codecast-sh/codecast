// Test harness: a scratch directory, a fake `claude` replaying recordings
// (fakeClaude.ts), and a spec pointing a host at it. Shared by the host tests.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SdkLaunchSpec } from "../options.js";

export interface FakeWorld {
  dir: string;
  hostDir: string;
  logFile: string;
  spec: (o?: Partial<SdkLaunchSpec>) => SdkLaunchSpec;
  fakeLog: () => string[];
  cleanup: () => void;
}

/** A scratch world whose claude replays `recordings` in order, one per process started. */
export function fakeWorld(recordings: string[], extraEnv: Record<string, string> = {}, tag = ""): FakeWorld {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `csdk-${tag}`));
  const hostDir = path.join(dir, "h");
  fs.mkdirSync(hostDir);
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd);
  const exe = path.join(dir, "claude");
  fs.writeFileSync(exe, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(import.meta.dir, "fakeClaude.ts"))} "$@"\n`, { mode: 0o755 });
  const logFile = path.join(dir, "fake.log");
  const sessionId = crypto.randomUUID();
  return {
    dir,
    hostDir,
    logFile,
    spec: (o = {}) => ({
      conversationId: "conv1",
      sessionId,
      resume: false,
      cwd,
      executable: exe,
      args: ["--permission-mode", "default", "--model", "haiku"],
      env: {
        FAKE_CLAUDE_RECORDINGS: recordings.join(","),
        FAKE_CLAUDE_COUNTER: path.join(dir, "counter"),
        FAKE_CLAUDE_LOG: logFile,
        ...extraEnv,
      },
      ...o,
    }),
    fakeLog: () => {
      try { return fs.readFileSync(logFile, "utf-8").trim().split("\n"); } catch { return []; }
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

export function until<T>(fn: () => T | undefined | null | false, ms = 30_000, what = "condition"): Promise<T> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = fn();
      if (v) return resolve(v as T);
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}
