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
import { stillRunning } from "./test-helpers/processLiveness.js";
import { sessionSocketName } from "./tmuxRoute.js";

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

    // Still RUNNING, not merely holding a pid: an unreaped zombie answers
    // `kill(pid, 0)` and would read as a survivor forever.
    expect(await stillRunning([panePid, ...tree])).toEqual([]);
    await expect(tmux(["has-session", "-t", session])).rejects.toThrow();
  }, 90_000);

  // What leaked on 2026-10-09. The agent's session has a tmux server of its
  // own, and from inside its pane it opened another tmux session there for a
  // dev server; `next dev` forked `next-server` and exited, so the server ran
  // with ppid 1 in the group of the job that launched it. Killing the agent's
  // session reached neither.
  test("kills everything on the session's own server, including what left the tree", async () => {
    fs.writeFileSync(ownScriptPath, OWN_SERVER_SCRIPT, { mode: 0o755 });
    await ownTmux(["new-session", "-d", "-s", ownSession, "-x", "80", "-y", "24", ownScriptPath]);
    const serverPid = parseInt((await ownTmux(["display-message", "-p", "-t", ownSession, "#{pid}"])).stdout.trim(), 10);
    const panePid = parseInt((await ownTmux(["list-panes", "-t", ownSession, "-F", "#{pane_pid}"])).stdout.trim(), 10);

    let detached: number[] = [];
    let side: number[] = [];
    for (let i = 0; i < 40 && (detached.length === 0 || side.length === 0); i++) {
      await new Promise((r) => setTimeout(r, 250));
      const procs = await snapshotProcessTableAsync({ timeout: 10_000 });
      const tree = new Set(descendantRows(procs, panePid).map((p) => p.pid));
      detached = procs.filter((p) => p.ppid === 1 && p.command.startsWith("sleep 401") && tree.has(p.pgid!)).map((p) => p.pid);
      side = descendantRows(procs, serverPid).filter((p) => p.command.startsWith("sleep 402")).map((p) => p.pid);
    }
    // The shape that escaped: one process outside every pane's tree, one in a
    // session the kill was not asked about.
    expect(detached.length).toBe(1);
    expect(side.length).toBe(1);

    await killTmuxSessionAndTree(ownSession);

    expect(await stillRunning([...detached, ...side, panePid, serverPid])).toEqual([]);
  }, 90_000);
});

// `set -m` makes the launcher a job with its own group; inside it, job control
// is off, so the subshell's `sleep 401` keeps that group after the subshell
// exits and it reparents to pid 1, the way next-server keeps `bun run dev`'s.
// `exec` keeps the group's leader alive under the same pid, as the dev script
// that started next-server was. The bare `tmux` reaches this pane's own server.
const OWN_SERVER_SCRIPT = `#!/bin/bash
set -m
bash -c '(sleep 401 &); exec sleep 400' &
tmux new-session -d -s side-$$ 'sleep 402'
sleep 400
`;

const ownSession = `cc-reap-own-${process.pid}`;
const ownSocket = sessionSocketName(ownSession);
const ownScriptPath = path.join(os.tmpdir(), `${ownSession}.sh`);
const ownTmux = (args: string[]) => tmux(["-L", ownSocket, ...args]);

afterAll(async () => {
  await ownTmux(["kill-server"]).catch(() => {});
  fs.rmSync(ownScriptPath, { force: true });
});
