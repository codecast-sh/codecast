import { describe, expect, test } from "bun:test";
import { descendantPids, findOtherDaemonPids, findStaleTmuxServers, isAgentCommand, isDaemonCommand, parseProcessTable, tmuxServerRows } from "./processTable.js";

const table = parseProcessTable(`
    1     0 /sbin/launchd
 45451     1 tmux new-session -d -x 220 -y 50 -s cc-resume-a -c /Users/x/src/codecast
 90449     1 tmux new-session -d -x 220 -y 50 -s cc-resume-b -c /Users/x/src/codecast
 70000     1 tmux -L other new-session -d -s sidecar
 80000   700 tmux attach -t main
   700   600 -bash
 91000 45451 -bash
 91001 91000 claude --resume abc --model opus
 92000 90449 -bash
 92001 92000 /Users/x/.local/share/claude/versions/2.1.237 --agent-id reader@session-1
 92002 90449 -bash
 92003 92002 node /Users/x/.bin/tsc --noEmit
 92004 92002 /opt/homebrew/bin/codex resume 123
`);

describe("processTable", () => {
  test("parseProcessTable folds a multi-line command back onto its row", () => {
    const procs = parseProcessTable("  10  1 /sbin/launchd\n 41719 53695 /bin/bash -c eval 'cd /a\nnpm run dev' < /dev/null\n 42 10 tail -f x\n");
    expect(procs.map((p) => p.pid)).toEqual([10, 41719, 42]);
    expect(procs[1].command).toBe("/bin/bash -c eval 'cd /a\nnpm run dev' < /dev/null");
  });

  test("descendantPids walks the whole subtree, root excluded", () => {
    expect(descendantPids(table, 90449).sort()).toEqual([92000, 92001, 92002, 92003, 92004].sort());
    expect(descendantPids(table, 92003)).toEqual([]);
  });

  test("tmuxServerRows: daemonized tmux on the default socket only", () => {
    // clients (ppid = a shell) and servers on another socket (-L/-S) are not candidates
    expect(tmuxServerRows(table).map((p) => p.pid)).toEqual([45451, 90449]);
  });

  test("isAgentCommand: registry binaries and claude's versioned binaries, not interpreters", () => {
    expect(isAgentCommand("claude --resume abc")).toBe(true);
    expect(isAgentCommand("/Users/x/.local/share/claude/versions/2.1.237 --agent-id r")).toBe(true);
    expect(isAgentCommand("/opt/homebrew/bin/codex resume 123")).toBe(true);
    expect(isAgentCommand("node /Users/x/.bin/tsc --noEmit")).toBe(false);
    expect(isAgentCommand("-bash")).toBe(false);
  });

  test("findStaleTmuxServers: every default-socket server except the live one, with tree counts", () => {
    expect(findStaleTmuxServers(table, 45451)).toEqual([
      { pid: 90449, command: table.find((p) => p.pid === 90449)!.command, descendants: 5, agents: 2 },
    ]);
    expect(findStaleTmuxServers(table, 90449).map((s) => s.pid)).toEqual([45451]);
  });

  test("findStaleTmuxServers: tmux unreachable reports every server", () => {
    expect(findStaleTmuxServers(table, null).map((s) => s.pid)).toEqual([45451, 90449]);
  });
});

// The split brain sweep kills whatever this matches, so the negatives matter
// as much as the positives. The daemon row is copied from a real ps run on the
// founder's laptop; the rest are the other two install shapes and the
// neighbours that carry the same tokens without being a daemon.
const daemonTable = parseProcessTable(`
 59965     1 /Users/ashot/.bun/bin/bun /Users/ashot/src/codecast/packages/cli/src/daemon.ts _daemon
 59966     1 node /Users/x/.codecast/dist/daemon.js
 59967     1 /Users/x/.local/bin/codecast -- _daemon
 59968     1 /Users/x/.local/bin/cast _daemon
 70001     1 /bin/sh /Users/x/.codecast/daemon-launcher.sh
 70002     1 /Users/x/.local/bin/codecast _watchdog
 70003     1 /Users/x/.local/bin/codecast _worker probe
 70004  1234 bun /Users/x/src/codecast/packages/cli/src/index.ts sessions
 70005  1234 grep _daemon src/daemon.ts
 70006  1234 bun test src/daemon.pid.test.ts
 70007     1 nginx: master process /opt/homebrew/bin/nginx -g daemon off;
 70008     1 /usr/sbin/distnoted daemon
`);

describe("isDaemonCommand", () => {
  test("matches every install shape", () => {
    for (const pid of [59965, 59966, 59967, 59968]) {
      const row = daemonTable.find((p) => p.pid === pid)!;
      expect(isDaemonCommand(row.command)).toBe(true);
    }
  });

  test("rejects the launcher, the watchdog, a worker and look-alikes", () => {
    for (const pid of [70001, 70002, 70003, 70004, 70005, 70006, 70007, 70008]) {
      const row = daemonTable.find((p) => p.pid === pid)!;
      expect(isDaemonCommand(row.command)).toBe(false);
    }
  });

  test("findOtherDaemonPids skips this process", () => {
    expect(findOtherDaemonPids(daemonTable, 59966)).toEqual([59965, 59967, 59968]);
  });
});
