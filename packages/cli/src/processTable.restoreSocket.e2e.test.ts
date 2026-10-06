import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { liveTmuxServerPid, restoreTmuxServerSocket } from "./processTable.js";
import { tmuxRunAsync } from "./tmux.js";

// A private socket directory of this test's own: it replaces and restores a
// server socket, which the suite's shared isolated server must never see.
let dir: string;
let priorTmpdir: string | undefined;
const pids: number[] = [];

beforeEach(() => {
  priorTmpdir = process.env.TMUX_TMPDIR;
  dir = fs.mkdtempSync("/tmp/cc-sock-");
  fs.chmodSync(dir, 0o700);
  process.env.TMUX_TMPDIR = dir;
});

afterEach(() => {
  for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  process.env.TMUX_TMPDIR = priorTmpdir;
  fs.rmSync(dir, { recursive: true, force: true });
});

async function startServer(session: string): Promise<number> {
  expect((await tmuxRunAsync(["new-session", "-d", "-s", session])).status).toBe(0);
  const pid = (await liveTmuxServerPid())!;
  pids.push(pid);
  return pid;
}

test("an orphaned server retakes its socket with its sessions, and the newcomer loses it", async () => {
  const fleet = await startServer("fleet");
  // What a `new-session` against a refusing server does: the socket file is
  // replaced and a second server answers from the same path.
  fs.unlinkSync(path.join(dir, `tmux-${process.getuid!()}`, "default"));
  const newcomer = await startServer("newcomer");
  expect(newcomer).not.toBe(fleet);
  expect(await liveTmuxServerPid()).toBe(newcomer);

  expect(await restoreTmuxServerSocket(fleet)).toBe(true);
  expect(await liveTmuxServerPid()).toBe(fleet);
  expect((await tmuxRunAsync(["list-sessions", "-F", "#S"])).stdout.trim()).toBe("fleet");
}, 60_000);

test("a pid that is gone restores nothing", async () => {
  expect(await restoreTmuxServerSocket(2 ** 22 - 3, 500)).toBe(false);
});
