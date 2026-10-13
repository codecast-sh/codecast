import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
for (const enabled of [false, true]) test.skipIf(process.platform === "win32")(`production orphan reaper revalidates live authority workers=${enabled}`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-reap-"));
  const keeper = `orphan-keeper-${crypto.randomUUID()}`;
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMUX_TMPDIR: root, NODE_ENV: "test" };
  delete env.TMUX;
  const socket = path.join(root, `tmux-${process.getuid?.()}`, "default");
  try {
    await run("tmux", ["new-session", "-d", "-s", keeper, "sleep", "120"], { env, timeout: 3000 });
    const result = await run(process.execPath, [path.join(import.meta.dir, "workers/fixtures/orphanReap.ts"), String(enabled), keeper],
      { env, timeout: 60000, killSignal: "SIGKILL" });
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence.enabled).toBe(enabled);
    expect(evidence.stable).toBe(1);
    expect(evidence.execAfterScan).toBe(0);
    expect(evidence.execAfterDescendants).toBe(0);
    expect(evidence.refusals).toEqual(["cancel", "resume", "delivery", "switch", "command", "cache", "pane", "claims", "start", "uid", "descendants"]);
    expect(evidence.actualOwnedSignal).toBe(true);
    expect(evidence.cleaned).toBe(true);
    expect(enabled ? evidence.workerPid > 1 : evidence.workerPid === null).toBe(true);
  } finally {
    await run("tmux", ["-S", socket, "kill-session", "-t", `=${keeper}`], { timeout: 2000 }).catch(() => {});
    if (fs.existsSync(path.join(root, "owned.json"))) {
      const owned = JSON.parse(fs.readFileSync(path.join(root, "owned.json"), "utf8")) as Array<{ pid: number; ids: string[] }>;
      for (const { pid, ids } of owned) {
        const out = await run("ps", ["-ww", "-p", String(pid), "-o", "command="], { timeout: 2000 }).catch(() => null);
        if (out && ids.some(id => out.stdout.includes(id))) {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 65000);
