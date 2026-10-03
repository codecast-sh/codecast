import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A child prints 400 KB after touching process.stdout (which leaves a piped
// fd 1 non-blocking under Bun), then exits explicitly; the parent reads the
// pipe late, so the 64 KB pipe buffer is full long before the child is done.
function runChild(body: string): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-stdio-"));
  const script = path.join(dir, "child.ts");
  fs.writeFileSync(script, `import { installSyncStdio } from ${JSON.stringify(path.join(import.meta.dir, "syncStdio.ts"))};\n${body}\n`);
  const out = Bun.spawnSync(["bash", "-c", `bun ${JSON.stringify(script)} | (sleep 0.5; wc -c)`], { stdout: "pipe", stderr: "pipe" });
  fs.rmSync(dir, { recursive: true, force: true });
  return Number(out.stdout.toString().trim());
}

describe("installSyncStdio", () => {
  test("console.log into a slow pipe arrives whole", () => {
    expect(runChild(`installSyncStdio();\nprocess.stdout.isTTY;\nconsole.log("x".repeat(400_000));`)).toBe(400_001);
  });

  test("process.stdout.write followed by process.exit arrives whole", () => {
    expect(runChild(`installSyncStdio();\nprocess.stdout.write("x".repeat(400_000));\nprocess.exit(0);`)).toBe(400_000);
  });

  test("a reader that closes early ends the writes quietly", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-stdio-"));
    const script = path.join(dir, "child.ts");
    fs.writeFileSync(script, `import { installSyncStdio } from ${JSON.stringify(path.join(import.meta.dir, "syncStdio.ts"))};\ninstallSyncStdio();\nfor (let i = 0; i < 20000; i++) console.log("line " + i);\nprocess.stderr.write("done\\n");\n`);
    const out = Bun.spawnSync(["bash", "-c", `set -o pipefail; bun ${JSON.stringify(script)} | head -1`], { stdout: "pipe", stderr: "pipe" });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(out.stdout.toString()).toBe("line 0\n");
    expect(out.stderr.toString()).toBe("done\n");
    expect(out.exitCode).toBe(0);
  });
});
