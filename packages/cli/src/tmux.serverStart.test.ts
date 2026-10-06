import { describe, expect, test } from "bun:test";
import { parseProcessTable } from "./processTable.js";
import { refusedTmuxServerIsLive, startTmuxGuarded, startTmuxGuardedSync, startsTmuxServer, TmuxServerBusyError, tmuxNoStartFailure } from "./tmux.js";

const REFUSED = "error connecting to /private/tmp/tmux-501/default (Connection refused)\n";
const ABSENT = "error connecting to /private/tmp/tmux-501/default (No such file or directory)\n";

// Records each argv and fails the `-N` attempt with `stderr`, the way execFile does.
function fakeTmux(stderr: string) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "-N") throw Object.assign(new Error("Command failed"), { stderr });
    return "started";
  };
  return { calls, run };
}

describe("starting a tmux session never replaces a live server", () => {
  test("only the commands that can start a server are guarded", () => {
    expect(startsTmuxServer(["new-session", "-d", "-s", "x"])).toBe(true);
    expect(startsTmuxServer(["start-server"])).toBe(true);
    expect(startsTmuxServer(["has-session", "-t", "x"])).toBe(false);
    expect(startsTmuxServer(["send-keys", "-t", "x", "new-session"])).toBe(false);
  });

  test("a failed -N attempt is read off tmux's own words", () => {
    expect(tmuxNoStartFailure(ABSENT)).toBe("absent");
    expect(tmuxNoStartFailure("no server running on /tmp/tmux-501/default")).toBe("absent");
    expect(tmuxNoStartFailure(REFUSED)).toBe("refused");
    expect(tmuxNoStartFailure("tmux: unknown option -- N\nusage: tmux [-2CDlNuvV]")).toBe("unsupported");
    expect(tmuxNoStartFailure("duplicate session: x")).toBe("other");
  });

  test("a reachable server takes the session on the -N attempt alone", () => {
    const calls: string[][] = [];
    expect(startTmuxGuardedSync(["new-session", "-d"], (args) => { calls.push(args); return "ok"; })).toBe("ok");
    expect(calls).toEqual([["-N", "new-session", "-d"]]);
  });

  // The 2026-10-06 shape: the socket refuses, the server behind it is alive.
  test("a refusing socket whose server is alive is never started over", async () => {
    const sync = fakeTmux(REFUSED);
    expect(() => startTmuxGuardedSync(["new-session", "-d"], sync.run, () => true)).toThrow(TmuxServerBusyError);
    expect(sync.calls).toEqual([["-N", "new-session", "-d"]]);
    const later = fakeTmux(REFUSED);
    await expect(startTmuxGuarded(["new-session", "-d"], async (a) => later.run(a), async () => true)).rejects.toThrow(TmuxServerBusyError);
    expect(later.calls).toEqual([["-N", "new-session", "-d"]]);
  });

  test("a refusing socket left by a dead server, or no socket at all, starts one", async () => {
    for (const [stderr, live] of [[REFUSED, false], [ABSENT, true]] as const) {
      const sync = fakeTmux(stderr);
      expect(startTmuxGuardedSync(["new-session", "-d"], sync.run, () => live)).toBe("started");
      expect(sync.calls).toEqual([["-N", "new-session", "-d"], ["new-session", "-d"]]);
      const later = fakeTmux(stderr);
      expect(await startTmuxGuarded(["new-session", "-d"], async (a) => later.run(a), async () => live)).toBe("started");
    }
  });

  test("a failure of the command itself is not retried", () => {
    const tmux = fakeTmux("duplicate session: x");
    expect(() => startTmuxGuardedSync(["new-session", "-d"], tmux.run, () => false)).toThrow("Command failed");
    expect(tmux.calls).toHaveLength(1);
  });

  test("liveness comes from the process table, and a failed ps is no proof of absence", () => {
    const uid = process.getuid?.() ?? 501;
    const withServer = parseProcessTable(` 1897     1   ${uid} tmux new-session -d -s cc-resume-a\n`);
    const privateOnly = parseProcessTable(` 1613     1   ${uid} tmux -S /tmp/x/default start-server\n`);
    expect(refusedTmuxServerIsLive(withServer, {})).toBe(true);
    expect(refusedTmuxServerIsLive(privateOnly, {})).toBe(false);
    expect(refusedTmuxServerIsLive([], {})).toBe(true);
    // A private socket cannot be matched to a process, so it keeps the plain start.
    expect(refusedTmuxServerIsLive(withServer, { TMUX_TMPDIR: "/tmp/private" })).toBe(false);
  });
});
