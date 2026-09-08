// Real processes, real tmux: the leak this teardown exists to stop.
//
// `tmux kill-session` only SIGHUPs the pane's foreground process group, so a
// child that called setpgid — an MCP server, `caffeinate`, a tool subprocess —
// survives it and reparents to pid 1. The pane here reproduces exactly that:
// two backgrounded jobs under job control, each in its own process group, one
// of them with a child of its own. Nothing may outlive the teardown (ct-49537,
// memory kill_session_leaks_process_tree).
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { descendantRows, snapshotProcessTableAsync } from "./processTable.js";
import { killTmuxSessionAndTree } from "./daemon.js";

const run = promisify(execFile);
const tmux = (args: string[]): Promise<{ stdout: string }> => run("tmux", args, { timeout: 10_000 });
const hasTmux = await tmux(["-V"]).then(() => true, () => false);

// `set -m` turns on job control, so each `&` job leads its OWN process group —
// which is what puts it out of reach of the pane's SIGHUP. The inner
// `sleep …; true` stops bash from exec'ing sleep in place, so there is a real
// grandchild to lose.
const PANE_SCRIPT = `#!/bin/bash
set -m
sleep 400 &
bash -c 'sleep 400; true' &
sleep 400
`;

const session = `cc-reap-e2e-${process.pid}`;
const scriptPath = path.join(os.tmpdir(), `${session}.sh`);

const isAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

afterAll(async () => {
  await tmux(["kill-session", "-t", session]).catch(() => {});
  fs.rmSync(scriptPath, { force: true });
});

describe.skipIf(!hasTmux)("killTmuxSessionAndTree", () => {
  test("kills the pane's whole tree, including a detached process group", async () => {
    fs.writeFileSync(scriptPath, PANE_SCRIPT, { mode: 0o755 });
    await tmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24", scriptPath]);

    const { stdout } = await tmux(["list-panes", "-t", session, "-F", "#{pane_pid}"]);
    const panePid = parseInt(stdout.trim(), 10);
    expect(panePid).toBeGreaterThan(1);

    // Wait for the whole shape to exist: both jobs plus the grandchild.
    let tree: number[] = [];
    for (let i = 0; i < 40 && tree.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 250));
      tree = descendantRows(await snapshotProcessTableAsync({ timeout: 10_000 }), panePid).map((p) => p.pid);
    }
    expect(tree.length).toBeGreaterThanOrEqual(3);

    // The leak this guards: at least one descendant leads a process group of
    // its own, so the pane's SIGHUP never reaches it.
    const rows = descendantRows(await snapshotProcessTableAsync({ timeout: 10_000 }), panePid);
    expect(rows.filter((p) => p.pgid === p.pid).length).toBeGreaterThanOrEqual(1);

    await killTmuxSessionAndTree(session);

    const survivors = [panePid, ...tree].filter(isAlive);
    expect(survivors).toEqual([]);
    await expect(tmux(["has-session", "-t", session])).rejects.toThrow();
  }, 90_000);
});
