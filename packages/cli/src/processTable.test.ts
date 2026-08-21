import { describe, expect, test } from "bun:test";
import { descendantPids, findStaleTmuxServers, isAgentCommand, parseProcessTable, tmuxServerRows } from "./processTable.js";

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
