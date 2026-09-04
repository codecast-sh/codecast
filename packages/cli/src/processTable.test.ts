import { describe, expect, test } from "bun:test";
import { descendantPids, findOtherDaemonPids, findStaleTmuxServers, isAgentCommand, isDaemonCommand, liveTmuxServerPid, parseProcessTable, snapshotProcessTableAsync, staleTmuxServerKillPlan, tmuxServerRows } from "./processTable.js";
import { hasTmux } from "./tmux.js";

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

// `ps -o pid=,ppid=,uid=,command=` since the daemon started killing stale
// servers unattended: on a shared agent box another account's server on the
// default socket is not this daemon's to touch.
const ownedTable = parseProcessTable(`
 45451     1   501 tmux new-session -d -s cc-resume-a
 90449     1   501 tmux new-session -d -s cc-resume-b
 91500     1   502 tmux new-session -d -s someone-elses
 91501 91500   502 claude --resume zzz
`);

describe("process owners", () => {
  test("parseProcessTable reads the owner column when ps carries it", () => {
    expect(ownedTable.map((p) => [p.pid, p.ppid, p.uid])).toEqual([
      [45451, 1, 501], [90449, 1, 501], [91500, 1, 502], [91501, 91500, 502],
    ]);
    expect(ownedTable[3].command).toBe("claude --resume zzz");
  });

  test("parseProcessTable still reads a table with no owner column", () => {
    expect(table.find((p) => p.pid === 45451)!.uid).toBeUndefined();
    expect(table.find((p) => p.pid === 91001)!.command).toBe("claude --resume abc --model opus");
  });

  test("tmuxServerRows: an owner filters the list; no owner reports every server", () => {
    expect(tmuxServerRows(ownedTable, 501).map((p) => p.pid)).toEqual([45451, 90449]);
    expect(tmuxServerRows(ownedTable, 502).map((p) => p.pid)).toEqual([91500]);
    expect(tmuxServerRows(ownedTable).map((p) => p.pid)).toEqual([45451, 90449, 91500]);
  });

  test("a row with no owner is never a kill candidate for an owned sweep", () => {
    // Fail closed: the unattended sweep kills process trees, so a table that
    // cannot say who owns a server must not produce one.
    expect(tmuxServerRows(table, 501)).toEqual([]);
  });
});

describe("staleTmuxServerKillPlan", () => {
  test("no live pid kills nothing, whatever the table holds", () => {
    const plan = staleTmuxServerKillPlan(ownedTable, null, 501);
    expect(plan.kill).toEqual([]);
    expect(plan.refused).toBe("tmux-unreachable");
  });

  test("with a live pid it kills the other servers this user owns", () => {
    const plan = staleTmuxServerKillPlan(ownedTable, 45451, 501);
    expect(plan.refused).toBeNull();
    expect(plan.kill.map((s) => s.pid)).toEqual([90449]);
  });

  test("another user's stale server is not in the plan", () => {
    // 91500 is a server on the default socket, is not the live one, and holds
    // an agent — everything the detector looks for except the owner.
    expect(staleTmuxServerKillPlan(ownedTable, 45451, 501).kill.map((s) => s.pid)).not.toContain(91500);
    expect(staleTmuxServerKillPlan(ownedTable, 45451, 502).kill.map((s) => s.pid)).toEqual([91500]);
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
 70009  1234 /Users/x/.local/bin/cast send jx7c6zk restart the _daemon now
 70010  1234 /Users/x/.local/bin/cast task create fix _daemon crash
 70011  1234 /Users/x/.local/bin/cast blame packages/cli/src/daemon.ts
`);

// Interpreter flags before the entry point are normal, so they must not hide
// a daemon from the sweep.
const flaggedDaemonTable = parseProcessTable(`
 80001     1 /Users/x/.bun/bin/bun --smol /Users/x/src/codecast/packages/cli/src/daemon.ts _daemon
 80002     1 node --enable-source-maps /Users/x/.codecast/dist/daemon.js
 80003     1 /Users/x/.bun/bin/bun run /Users/x/src/codecast/packages/cli/src/daemon.ts _daemon
`);

// `bun run x` is a package script, not a daemon, unless x is the daemon file.
const bunRunScriptTable = parseProcessTable(`
 80101  1234 /Users/x/.bun/bin/bun run daemon
 80102  1234 /Users/x/.bun/bin/bun run scripts/stamp-daemon-build-id.ts
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

  // ps flattens quoting, so a message body arrives as bare argv tokens. Before
  // the argv position test these three matched and the sweep killed them.
  test("rejects a cast command whose own arguments mention the daemon", () => {
    for (const pid of [70009, 70010, 70011]) {
      const row = daemonTable.find((p) => p.pid === pid)!;
      expect(isDaemonCommand(row.command)).toBe(false);
    }
  });

  // `bun run file.ts` executes the file in this process, so it is a daemon like
  // any other shape; `run` just sits where the entry point normally does.
  test("matches through interpreter flags and bun run", () => {
    for (const row of flaggedDaemonTable) {
      expect(isDaemonCommand(row.command)).toBe(true);
    }
  });

  test("rejects a bun run of anything else", () => {
    for (const row of bunRunScriptTable) {
      expect(isDaemonCommand(row.command)).toBe(false);
    }
  });

  test("findOtherDaemonPids skips this process", () => {
    expect(findOtherDaemonPids(daemonTable, 59966)).toEqual([59965, 59967, 59968]);
  });
});

// The daemon's hourly stale-generation sweep kills every process under a server
// this does not name, so "which server is live" has to be a real answer on a
// real machine, not just a parse.
describe.skipIf(!hasTmux())("liveTmuxServerPid", () => {
  test("names a running server, and that server is not reported stale", async () => {
    const pid = await liveTmuxServerPid();
    if (pid === null) return; // no server running on this machine right now
    expect(pid).toBeGreaterThan(0);
    const procs = await snapshotProcessTableAsync({ timeout: 30_000 });
    expect(findStaleTmuxServers(procs, pid).map((s) => s.pid)).not.toContain(pid);
  }, 60_000);
});
