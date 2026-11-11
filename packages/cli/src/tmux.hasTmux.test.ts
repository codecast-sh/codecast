// hasTmux answers from the PATH, never by spawning tmux. Dozens of daemon
// paths ask it on the event loop, and under load a synchronous `tmux -V` held
// the loop for up to 146s a call (890s in one stretch, daemon.log 2026-11-10).
//
// tmux.ts reads PATH when it loads, so each scenario runs in a child bun
// with a stub `tmux` first on PATH.

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const TMUX_TS = path.join(path.dirname(fileURLToPath(import.meta.url)), "tmux.ts");

type Probe = { first: boolean; second: boolean; firstMs: number; secondMs: number; spawns: number };

// Runs hasTmux twice against a stub tmux whose behavior is `body` (a shell
// snippet); every invocation of the stub appends a line to a log so the
// test can count the spawns.
function probe(body: string): Probe {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-hastmux-"));
  try {
    const log = path.join(dir, "calls.log");
    const stub = path.join(dir, "tmux");
    fs.writeFileSync(stub, `#!/bin/sh\necho call >> ${JSON.stringify(log)}\n${body}\n`, { mode: 0o755 });
    const script = path.join(dir, "probe.ts");
    fs.writeFileSync(
      script,
      `import { hasTmux } from ${JSON.stringify(TMUX_TS)};
const t0 = Date.now(); const first = hasTmux(); const t1 = Date.now(); const second = hasTmux(); const t2 = Date.now();
console.log(JSON.stringify({ first, second, firstMs: t1 - t0, secondMs: t2 - t1 }));`,
    );
    const out = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
      timeout: 30_000,
    });
    const parsed = JSON.parse(out.trim().split("\n").pop()!) as Omit<Probe, "spawns">;
    const spawns = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
    return { ...parsed, spawns };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("hasTmux", () => {
  test("finds tmux on PATH without running it, however slow it would be", () => {
    const r = probe("sleep 30");
    expect(r.first).toBe(true);
    expect(r.second).toBe(true);
    expect(r.spawns).toBe(0);
    expect(r.firstMs).toBeLessThan(500);
  }, 30_000);
});
