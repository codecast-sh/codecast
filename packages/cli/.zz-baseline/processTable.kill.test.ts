// The identity rules that make a delayed SIGKILL safe (ct-49537).
//
// The killer signals a snapshot: it SIGTERMs a tree it read once, waits, then
// hard kills only what the table still recognises. Every test here is a way the
// pid it is about to SIGKILL can have stopped being the process it SIGTERMed.
import { describe, expect, test } from "bun:test";
import {
  bornBeforeCaptureSecond,
  descendantRows,
  killProcessTree,
  parseProcessTable,
  sameProcess,
  type ProcRow,
} from "./processTable.js";

// `LANG=C ps -axww -o pid=,ppid=,pgid=,uid=,lstart=,command=` on macOS 26.
// Copied verbatim, padding included: ps pads the day of month, so `Sep  6` and
// `Sep 16` differ by an inner space that must not change the parsed identity.
const MACOS_PS = `
    1     0     1     0 Tue Aug 25 05:04:18 2026     /sbin/launchd
45451     1 45451   501 Sat Sep  6 09:12:01 2026     tmux new-session -d -s cc-a
91000 45451 91000   501 Sat Sep  6 09:12:01 2026     -bash
91001 91000 91001   501 Sat Sep 16 21:44:59 2026     claude --resume abc
91002 91001 91002   501 Sat Sep  6 09:13:30 2026     /usr/bin/caffeinate -dimsu
`;

// The same columns from procps on Linux: uid is printed unpadded and the
// command column starts one space after lstart instead of five.
const LINUX_PS = `
    1     0     1     0 Tue Aug 25 05:04:18 2026 /sbin/systemd
45451     1 45451  1000 Sat Sep  6 09:12:01 2026 tmux new-session -d -s cc-a
91000 45451 91000  1000 Sat Sep  6 09:12:01 2026 -bash
91001 91000 91001  1000 Sat Sep 16 21:44:59 2026 claude --resume abc
91002 91001 91002  1000 Sat Sep  6 09:13:30 2026 /usr/bin/caffeinate -dimsu
`;

const CAPTURED_AT = Date.parse("Sat Sep 16 21:45:30 2026");

describe("parseProcessTable identity columns", () => {
  for (const [platform, out] of [["macOS", MACOS_PS], ["Linux", LINUX_PS]] as const) {
    test(`${platform} ps carries pid, ppid, pgid, uid, lstart and the command`, () => {
      const rows = parseProcessTable(out, CAPTURED_AT);
      expect(rows.map((r) => r.pid)).toEqual([1, 45451, 91000, 91001, 91002]);
      const claude = rows.find((r) => r.pid === 91001)!;
      expect(claude).toMatchObject({ ppid: 91000, pgid: 91001, startedAt: "Sat Sep 16 21:44:59 2026" });
      expect(claude.command).toBe("claude --resume abc");
      expect(claude.capturedAtMs).toBe(CAPTURED_AT);
      // The padded day of month must not survive into the compared string, or
      // the same instant read twice would fail its own identity check.
      expect(rows.find((r) => r.pid === 91000)!.startedAt).toBe("Sat Sep 6 09:12:01 2026");
    });
  }

  test("a narrower table still parses, and carries no identity", () => {
    const rows = parseProcessTable(" 42 10 tail -f x\n 43 10 501 grep -r x .\n");
    expect(rows.map((r) => [r.pid, r.command])).toEqual([[42, "tail -f x"], [43, "grep -r x ."]]);
    expect(rows[0].pgid).toBeUndefined();
    expect(rows[1].startedAt).toBeUndefined();
  });

  test("a multi-line command still folds onto its row", () => {
    const rows = parseProcessTable(
      `41719 53695 41719   501 Sat Sep  6 09:12:01 2026     /bin/bash -c eval 'cd /a\nnpm run dev'\n`,
      CAPTURED_AT,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].command).toBe("/bin/bash -c eval 'cd /a\nnpm run dev'");
  });
});

const table = parseProcessTable(MACOS_PS, CAPTURED_AT);
const row = (pid: number): ProcRow => table.find((r) => r.pid === pid)!;

describe("descendantRows", () => {
  test("walks the whole subtree, root excluded, parents before children", () => {
    expect(descendantRows(table, 45451).map((r) => r.pid)).toEqual([91000, 91001, 91002]);
  });

  // The reason the snapshot must be taken BEFORE the root is signalled: a
  // grandchild reparents to pid 1 the moment its parent dies, and the walk
  // that would have found it no longer can.
  test("a grandchild reparented to pid 1 is out of reach of a later walk", () => {
    const after = parseProcessTable(
      `
    1     0     1     0 Tue Aug 25 05:04:18 2026     /sbin/launchd
45451     1 45451   501 Sat Sep  6 09:12:01 2026     tmux new-session -d -s cc-a
91002     1 91002   501 Sat Sep  6 09:13:30 2026     /usr/bin/caffeinate -dimsu
`,
      CAPTURED_AT,
    );
    expect(descendantRows(after, 45451)).toEqual([]);
    // …which is why the pre-kill snapshot holds it.
    expect(descendantRows(table, 45451).map((r) => r.pid)).toContain(91002);
  });

  test("an absent root yields nothing: its ppid links are pid reuse", () => {
    expect(descendantRows(table, 77777)).toEqual([]);
  });

  test("a duplicated root yields nothing: no safe identity to walk from", () => {
    const doubled = [...table, { ...row(45451), startedAt: "Sat Sep  6 21:00:00 2026" }];
    expect(descendantRows(doubled, 45451)).toEqual([]);
  });
});

describe("bornBeforeCaptureSecond", () => {
  test("a process born in the capture second is never identifiable", () => {
    // lstart has one second resolution, so anything the kernel puts in this pid
    // slot during the same second prints the same start time.
    const born = { ...row(91001), startedAt: "Sat Sep 16 21:45:30 2026", capturedAtMs: CAPTURED_AT + 400 };
    expect(bornBeforeCaptureSecond(born)).toBe(false);
    expect(bornBeforeCaptureSecond(row(91001))).toBe(true);
  });

  test("a row with no start time or no capture instant fails closed", () => {
    expect(bornBeforeCaptureSecond({ pid: 1, ppid: 0, command: "x" })).toBe(false);
    expect(bornBeforeCaptureSecond({ ...row(91001), capturedAtMs: undefined })).toBe(false);
    expect(bornBeforeCaptureSecond({ ...row(91001), startedAt: "not a date" })).toBe(false);
  });
});

describe("sameProcess", () => {
  test("the same pid, start time and process group is the same process", () => {
    expect(sameProcess(row(91001), { ...row(91001) })).toBe(true);
  });

  test("a recycled pid has a different start time", () => {
    expect(sameProcess(row(91001), { ...row(91001), startedAt: "Sat Sep 16 21:45:10 2026" })).toBe(false);
  });

  test("a survivor that changed process group is not the process we signalled", () => {
    expect(sameProcess(row(91001), { ...row(91001), pgid: 99999 })).toBe(false);
  });

  test("a table with no identity columns can never license a kill", () => {
    const bare = { pid: 91001, ppid: 91000, command: "claude --resume abc" };
    expect(sameProcess(bare, row(91001))).toBe(false);
    expect(sameProcess(row(91001), bare)).toBe(false);
  });
});

/** A killer wired to a scripted world: `aliveAfterTerm` are the pids that ignore
 *  SIGTERM, `afterGrace` is the table read once the grace window is over. */
function runKill(
  targets: ProcRow[],
  aliveAfterTerm: number[],
  afterGrace: ProcRow[],
): Promise<{ result: Awaited<ReturnType<typeof killProcessTree>>; sent: string[] }> {
  const sent: string[] = [];
  const live = new Set(aliveAfterTerm);
  return killProcessTree(targets, 0, {
    sendSignal: (pid, signal) => sent.push(`${signal} ${pid}`),
    isAlive: (pid) => live.has(pid),
    readTable: async () => afterGrace,
  }).then((result) => ({ result, sent }));
}

describe("killProcessTree", () => {
  const tree = [row(91002), row(91001), row(91000)];

  test("SIGTERMs the whole snapshot at once, leaves first", async () => {
    const { sent } = await runKill(tree, [], []);
    expect(sent).toEqual(["SIGTERM 91002", "SIGTERM 91001", "SIGTERM 91000"]);
  });

  test("a survivor whose identity still matches takes the SIGKILL", async () => {
    const { result, sent } = await runKill(tree, [91001], [row(91001)]);
    expect(sent).toContain("SIGKILL 91001");
    expect(result).toEqual({ terminated: 2, killed: 1, unverified: 0 });
  });

  test("a recycled pid is never hard killed", async () => {
    // Same slot, a new program: `process.kill(pid, 0)` says alive, and only the
    // start time says it is somebody else's.
    const recycled = { ...row(91001), startedAt: "Sat Sep 16 21:45:20 2026", command: "vim notes.md" };
    const { result, sent } = await runKill(tree, [91001], [recycled]);
    expect(sent.filter((s) => s.startsWith("SIGKILL"))).toEqual([]);
    expect(result).toEqual({ terminated: 2, killed: 0, unverified: 1 });
  });

  test("a pid the table reports twice is left alone", async () => {
    const { result, sent } = await runKill(tree, [91001], [row(91001), { ...row(91001) }]);
    expect(sent.filter((s) => s.startsWith("SIGKILL"))).toEqual([]);
    expect(result.unverified).toBe(1);
  });

  test("a survivor born in the capture second is left alone", async () => {
    const fresh = { ...row(91001), startedAt: "Sat Sep 16 21:45:30 2026", capturedAtMs: CAPTURED_AT + 100 };
    const { result, sent } = await runKill([fresh], [fresh.pid], [fresh]);
    expect(sent).toEqual(["SIGTERM 91001"]);
    expect(result).toEqual({ terminated: 0, killed: 0, unverified: 1 });
  });

  test("a child born during the grace window is never signalled", async () => {
    // It is not in the snapshot, so it is not a target — and its parent's pid
    // slot is the only thing the two have in common.
    const newborn: ProcRow = {
      pid: 91003, ppid: 91001, pgid: 91003, uid: 501,
      startedAt: "Sat Sep 16 21:45:31 2026", capturedAtMs: CAPTURED_AT + 1_000,
      command: "npx some-mcp-server",
    };
    const { sent } = await runKill(tree, [91001], [row(91001), newborn]);
    expect(sent.some((s) => s.endsWith(" 91003"))).toBe(false);
  });

  test("a survivor that exited between the last poll and the read counts as terminated", async () => {
    const { result } = await runKill(tree, [91001], []);
    expect(result).toEqual({ terminated: 3, killed: 0, unverified: 0 });
  });

  test("this process is never a target, whatever a caller passes", async () => {
    const self: ProcRow = { ...row(91001), pid: process.pid };
    const { result, sent } = await runKill([self, { ...row(91001), pid: 1 }], [process.pid, 1], []);
    expect(sent).toEqual([]);
    expect(result).toEqual({ terminated: 0, killed: 0, unverified: 0 });
  });
});
