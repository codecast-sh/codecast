import "./test-helpers/isolatedTmuxServer.js";
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "./proc.js";
import { tmuxRun, tmuxRunAsync } from "./tmux.js";
import { sessionServerSockets, tmuxSocketDir, withTmuxSession } from "./tmuxRoute.js";

// Real tmux servers on this process's private TMUX_TMPDIR (the preload), each
// agent session on its own, started as a launchd job on macOS.
const run = Math.random().toString(36).slice(2, 8);
const own = `cc-claude-e2e${run}`;
const second = `cx-resume-e2e${run}`;
const shared = `cast-term-e2e${run}`;
const on = { env: { CODECAST_TMUX_PER_SESSION: "1" } };
const socketPath = (session: string) => path.join(tmuxSocketDir(), `cast-${session}`);

afterAll(() => {
  for (const s of [own, second]) spawnSync("tmux", ["-L", `cast-${s}`, "kill-server"], { stdio: "ignore" });
  tmuxRun(["kill-session", "-t", shared]);
});

describe("one tmux server per agent session", () => {
  test("an agent session's new-session starts a server of its own", async () => {
    const r = await tmuxRunAsync(["new-session", "-d", "-s", own, "-x", "80", "-y", "20"], on);
    expect(r.status).toBe(0);
    expect(fs.existsSync(socketPath(own))).toBe(true);
    expect(sessionServerSockets()).toContain(`cast-${own}`);
    // The shared server does not hold it.
    expect(spawnSync("tmux", ["has-session", "-t", `=${own}`], { stdio: "ignore" }).status).not.toBe(0);
  });

  test("the launchd job that started it is gone, and the server outlived it", () => {
    if (process.platform !== "darwin") return;
    const label = `sh.codecast.tmux.${own}`;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && spawnSync("/bin/launchctl", ["print", `gui/${process.getuid!()}/${label}`], { stdio: "ignore" }).status === 0) Bun.sleepSync(200);
    expect(spawnSync("/bin/launchctl", ["print", `gui/${process.getuid!()}/${label}`], { stdio: "ignore" }).status).not.toBe(0);
    expect(tmuxRun(["has-session", "-t", own]).status).toBe(0);
  });

  test("calls naming the session reach its server", () => {
    expect(tmuxRun(["send-keys", "-t", own, "-l", "echo routed-ok"]).status).toBe(0);
    expect(tmuxRun(["send-keys", "-t", own, "Enter"]).status).toBe(0);
    const deadline = Date.now() + 10_000;
    let screen = "";
    while (Date.now() < deadline && !/^routed-ok$/m.test(screen)) {
      screen = tmuxRun(["capture-pane", "-p", "-t", `${own}:0.0`]).stdout;
      Bun.sleepSync(100);
    }
    expect(screen).toMatch(/^routed-ok$/m);
    expect(tmuxRun(["display-message", "-p", "-t", own, "#{socket_path}"]).stdout.trim()).toBe(fs.realpathSync(socketPath(own)));
  });

  test("a fleet listing names sessions on every server", async () => {
    expect(tmuxRun(["new-session", "-d", "-s", shared], on).status).toBe(0);
    expect((await tmuxRunAsync(["new-session", "-d", "-s", second], on)).status).toBe(0);
    for (const list of [tmuxRun(["list-sessions", "-F", "#{session_name}"]), await tmuxRunAsync(["list-sessions", "-F", "#{session_name}"])]) {
      const names = list.stdout.trim().split("\n");
      expect(list.status).toBe(0);
      expect(names).toEqual(expect.arrayContaining([own, second, shared]));
    }
  });

  test("in a session's scope a pane id reaches that session's pane, though every server has a %0", async () => {
    const ids = await withTmuxSession(second, () => tmuxRunAsync(["list-panes", "-a", "-F", "#{pane_id}|#{session_name}"]));
    expect(ids.stdout.trim().split("\n").every((l) => l.endsWith(`|${second}`))).toBe(true);
    const pane = ids.stdout.trim().split("|")[0];
    const named = await withTmuxSession(second, () => tmuxRunAsync(["display-message", "-p", "-t", pane, "#{session_name}"]));
    expect(named.stdout.trim()).toBe(second);
  });

  test("a socket no server listens on is dropped from listings, not fatal to them", () => {
    const stale = `cc-claude-stale${run}`;
    const sock = socketPath(stale);
    const srv = spawnSync("python3", ["-I", "-c", `import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.close()`, sock]);
    expect(srv.status).toBe(0);
    expect(fs.existsSync(sock)).toBe(true);
    const list = tmuxRun(["list-sessions", "-F", "#{session_name}"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(own);
    expect(fs.existsSync(sock)).toBe(false);
  });

  test("killing the session ends its server and its socket", () => {
    expect(tmuxRun(["kill-session", "-t", second]).status).toBe(0);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && fs.existsSync(socketPath(second))) Bun.sleepSync(100);
    expect(fs.existsSync(socketPath(second))).toBe(false);
    expect(sessionServerSockets()).not.toContain(`cast-${second}`);
  });

  test("with the switch off an agent session stays on the shared server", () => {
    const plain = `cc-claude-plain${run}`;
    expect(tmuxRun(["new-session", "-d", "-s", plain], { env: { CODECAST_TMUX_PER_SESSION: "0" } }).status).toBe(0);
    expect(fs.existsSync(socketPath(plain))).toBe(false);
    expect(spawnSync("tmux", ["has-session", "-t", `=${plain}`], { stdio: "ignore" }).status).toBe(0);
    tmuxRun(["kill-session", "-t", plain]);
  });
});
