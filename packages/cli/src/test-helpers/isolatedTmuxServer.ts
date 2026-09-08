// A private tmux server for every test in this process.
//
// The real-tmux suites spawn dozens of panes and kill sessions in teardown. On
// the machine's default tmux server those panes sit beside the agent panes the
// daemon is driving for real work, and one wedged client or crashed server
// takes the whole fleet with it. So every tmux client in the process — the
// harness's own `tmuxRun` calls AND the daemon's, since injectViaTmux offers no
// way to name a socket — is pointed at a server of this process's own.
//
// THIS MODULE MUST BE EVALUATED BEFORE daemon.js. The daemon snapshots
// `process.env` into SAFE_ENV at module load and every tmux call it makes uses
// that snapshot, so an env var set after daemon.js has been evaluated never
// reaches it — hence the side effect on import rather than a function the
// caller remembers to run.
//
// A first-line `import "./isolatedTmuxServer.js"` in each real-tmux suite is
// NOT enough to guarantee that, and relying on it cost a day (ct-49907). It
// orders the imports inside its own file, but `bun test src/` loads every test
// file into one process sharing one module registry, and ~74 unit-test files
// import daemon.js for reasons unrelated to tmux. Whichever of those bun loads
// first freezes SAFE_ENV for the whole run, and the daemon then addresses the
// machine's default tmux server while the harness panes sit on this private
// one. Nothing errors: the two halves just never see each other, so a pane is
// spawned successfully and then reported absent, and suites fail far from the
// cause. So the ordering is imposed by `packages/cli/bunfig.toml`, which
// preloads this module ahead of every test module; the per-file import stays
// as documentation and for anyone running a file with preload disabled.
// messagingHarness.ts checks at pane spawn that the daemon really did land on
// this server.
//
// tmux derives its socket path from TMUX_TMPDIR (<dir>/tmux-<uid>/default), so
// setting that one variable moves clients, the server they start, and every
// process inside a pane. TMUX is deleted as well: a test run started from
// inside a tmux pane would otherwise inherit the outer server's address.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";
import { defaultConfigDir } from "../config/configDir.js";

// A unix socket path is capped at ~104 bytes, and tmux adds `tmux-<uid>/default`
// under TMUX_TMPDIR. macOS's os.tmpdir() is already a 50-character
// /var/folders/… path, so a temp dir there overflows the cap and every spawn
// fails with "File name too long". Prefer the codecast dir, which is short on
// any machine, and fall back to /tmp when a long $HOME would overflow it too.
function begin(): { dir: string; socket: string } {
  const run = `run-${process.pid}-${Date.now().toString(36)}`;
  const tail = path.join(run, `tmux-${process.getuid?.() ?? 0}`, "default");
  const codecastDir = defaultConfigDir();
  const base = [path.join(codecastDir, "test-tmux"), "/tmp/codecast-test-tmux"]
    .find((candidate) => path.join(candidate, tail).length < 100);
  if (!base) throw new Error("no directory short enough to hold a private tmux socket");

  const dir = path.join(base, run);
  // tmux puts its socket at <TMUX_TMPDIR>/tmux-<uid>/default and creates that
  // inner directory itself — but only when it is finding the socket through the
  // environment. A `tmux -S <path>` client does NOT create the path's parent, so
  // the inner directory is made here as well, or every -S call in this file
  // (arming the server, killing it) fails silently against a path that does not
  // exist. 0700 on both: tmux refuses a socket directory anyone else can read.
  const socketDir = path.join(dir, `tmux-${process.getuid?.() ?? 0}`);
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  process.env.TMUX_TMPDIR = dir;
  // This process may itself be running inside one of the human's tmux panes, and
  // an inherited $TMUX would point new clients back at that server.
  delete process.env.TMUX;
  sweepDeadServers(base);

  return { dir, socket: path.join(socketDir, "default") };
}

// Under bun, mutating process.env does NOT change what a child spawned with the
// inherited environment sees, so every tmux call in this file passes the socket
// explicitly and hands the child an env built from process.env. (tmuxRun and the
// daemon's tmuxExec both build their env the same way, which is what carries
// TMUX_TMPDIR into the calls under test.)
function tmuxOnSocket(socket: string, args: string[]): void {
  spawnSync("tmux", ["-S", socket, ...args], {
    timeout: 5_000,
    killSignal: "SIGKILL",
    stdio: "ignore",
    env: { ...process.env },
  });
}

// Start the server and tell it to outlive its sessions. A tmux server exits by
// default the moment its last session ends, which on the machine's shared
// server never happens — the human's own panes hold it open. Here the tests are
// the only sessions, so every teardown started the server shutting down and the
// next spawn raced it: the session appeared, the dying server took it with it,
// and the delivery under test failed with "no server running".
// Both commands ride ONE client: a server started with no sessions and
// exit-empty still at its default exits before a second invocation can turn the
// option off, so `start-server` alone leaves nothing running.
function armServer(socket: string): void {
  tmuxOnSocket(socket, ["start-server", ";", "set-option", "-s", "exit-empty", "off"]);
}

/**
 * Reap the socket directories of runs whose process is gone. A test run killed
 * outright (SIGKILL, a crashed harness) never reaches its exit hook, so without
 * this the directory grows a stale server per killed run — each one holding a
 * tmux server and whatever panes it had.
 */
function sweepDeadServers(base: string): void {
  let entries: string[];
  try { entries = fs.readdirSync(base); } catch { return; }
  for (const name of entries) {
    const pid = Number(name.match(/^run-(\d+)-/)?.[1]);
    if (!pid || pid === process.pid) continue;
    try {
      process.kill(pid, 0);
      continue; // still running: its server is its own business
    } catch {}
    tmuxOnSocket(path.join(base, name, `tmux-${process.getuid?.() ?? 0}`, "default"), ["kill-server"]);
    try { fs.rmSync(path.join(base, name), { recursive: true, force: true }); } catch {}
  }
}

const server = begin();
armServer(server.socket);

/**
 * Kill this process's tmux server and every pane on it, then arm a fresh empty
 * one so a test file that runs after this one is not left racing a dying
 * server. Safe to call repeatedly. Addressed by socket path, not by env, so it
 * reaps the right server even if something changed TMUX_TMPDIR since.
 */
export function killIsolatedTmuxServer(): void {
  tmuxOnSocket(server.socket, ["kill-server"]);
  armServer(server.socket);
}

/**
 * Guard for pane spawners: a pane must never land on the machine's default
 * server. Fails loudly rather than leaking a client TUI into the human's tmux.
 */
export function assertIsolatedTmux(): void {
  if (process.env.TMUX_TMPDIR !== server.dir) {
    throw new Error(
      `refusing to spawn a tmux pane outside the test server: TMUX_TMPDIR is ` +
      `${process.env.TMUX_TMPDIR ?? "(unset)"}, expected ${server.dir}`,
    );
  }
}

// A test that throws hard enough to end the process still gets its server
// reaped; afterAll hooks handle the ordinary path. The socket directory goes
// only here, so a shutdown between test files leaves the next spawn a place to
// put its server.
process.once("exit", () => {
  tmuxOnSocket(server.socket, ["kill-server"]);
  try { fs.rmSync(server.dir, { recursive: true, force: true }); } catch {}
});
