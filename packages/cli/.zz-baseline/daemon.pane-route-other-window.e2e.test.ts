import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// A user's agent ran in littlebird:2.1 while they looked at window 1. The route
// check listed only the current window's panes, called the agent orphaned, and
// delivery resumed the session a second time beside the live one.
test.skipIf(process.platform === "win32")("a pane in a window that is not showing still routes to its agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pane-route-"));
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, TMUX_TMPDIR: root, NODE_ENV: "test" };
  delete env.TMUX;
  const tmux = (...args: string[]) => run("tmux", args, { env, timeout: 3000 });
  const s = `route-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await tmux("new-session", "-d", "-s", s, "sleep 120");
    await tmux("new-window", "-t", s, "sleep 120");
    await tmux("new-window", "-t", s, "sleep 120");
    await tmux("split-window", "-t", `${s}:2`, "sh -c 'sleep 120; :'");
    await tmux("select-window", "-t", `${s}:0`);
    const paneShell = Number((await tmux("display-message", "-p", "-t", `${s}:2.1`, "#{pane_pid}")).stdout.trim());
    const agent = Number((await run("pgrep", ["-P", String(paneShell)])).stdout.trim().split("\n")[0]);
    const elsewhere = Number((await tmux("display-message", "-p", "-t", `${s}:1.0`, "#{pane_pid}")).stdout.trim());
    expect(agent).toBeGreaterThan(1);

    const verdict = async (target: string, pid: number) => (await run(process.execPath,
      [path.join(import.meta.dir, "workers/fixtures/paneVerdicts.ts"), target, String(pid)],
      { env, timeout: 30000, killSignal: "SIGKILL" })).stdout.trim().split("\n").at(-1);

    expect(await verdict(`${s}:2.1`, agent)).toBe("live");
    expect(await verdict(`${s}:2.1`, elsewhere)).toBe("exited");
  } finally {
    await tmux("kill-server").catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);
