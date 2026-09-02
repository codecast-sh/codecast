// The daemon's main event loop never runs a synchronous child process or a
// synchronous filesystem walk. One Bun process serves the loopback HTTP
// server, the Convex subscriptions, delivery and tmux injection, the
// watchdog tick and the heartbeat; a sync spawn or a sync tree walk on any
// periodic tick or request handler stalls all of them at once (36ms idle,
// 42s with a build contending for the disk, LOOP-FREEZE 2026-09-02).
//
// This guard extracts the body of every hot path by name and fails on a
// forbidden call inside it. When it fails on your code, move the call off
// the loop: fs.promises, execFileAsync, tmuxExec or tmuxRunAsync, or a
// walker from fsWalk.ts. Do not widen the allowlist. An entry needs a reason
// the loop cannot avoid, and a stale entry (one that no longer matches)
// fails the guard too.
//
// Bodies are matched by direct tokens, not transitively: a callee that walks
// is caught when its own row is in the table. Add a row rather than a regex.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { blockAt, codeLines, functionBlock, intervalBlocks, sliceBetween, type SourceBlock } from "./test-helpers/sourceRegion.js";

const SRC = path.dirname(fileURLToPath(import.meta.url));
const sources = new Map<string, string>();
const load = (rel: string): string => {
  let s = sources.get(rel);
  if (!s) {
    s = fs.readFileSync(path.join(SRC, rel), "utf8");
    sources.set(rel, s);
  }
  return s;
};

type Row = {
  file: string;
  name: string;
  kind: "function" | "method" | "intervals" | "slice" | "call";
  /** For a call block: the text to search for when it differs from the name. */
  find?: string;
  /** For nested functions: search from this anchor. */
  from?: string;
  /** For a slice: the end anchor. */
  to?: string;
  minLines: number;
  mustContain: string;
  /** For intervals: the least number of setInterval calls expected. */
  minCount?: number;
};

const D = "daemon.ts";
const MAIN = "async function main(";
const ROWS: Row[] = [
  { file: D, name: "sendHeartbeat", kind: "function", minLines: 40, mustContain: "has_tmux" },
  { file: D, name: "collectResourceSnapshot", kind: "function", minLines: 30, mustContain: "classifySharedPidSessions" },
  { file: D, name: "runHeartbeatMaintenance", kind: "function", minLines: 20, mustContain: "reconcileStatusFromTranscript" },
  { file: D, name: "reconcileStatusFromTranscript", kind: "function", minLines: 20, mustContain: "primeOpenTaskScan" },
  { file: D, name: "startWatchdog", kind: "function", minLines: 40, mustContain: "findStaleSessionFiles" },
  { file: D, name: "logHealthSummary", kind: "function", minLines: 10, mustContain: "getSystemMetrics" },
  { file: D, name: "ensureWatchdogSupervised", kind: "function", minLines: 10, mustContain: "watchdogSupervisionAction" },
  { file: D, name: "startHookServer", kind: "function", minLines: 40, mustContain: "handleTerminalHttp" },
  { file: D, name: "startEventLoopMonitor", kind: "function", minLines: 10, mustContain: "saveDaemonState" },
  { file: D, name: "startLoopFreezeProbe", kind: "function", minLines: 10, mustContain: "loopFreezes.record" },
  { file: D, name: "startVersionChecker", kind: "function", minLines: 8, mustContain: "checkForForcedUpdate" },
  { file: D, name: "startReconciliation", kind: "function", minLines: 10, mustContain: "performReconciliation" },
  { file: D, name: "flushManagedHeartbeats", kind: "function", minLines: 10, mustContain: "runHeartbeatFlush" },
  { file: D, name: "pollDaemonCommands", kind: "function", minLines: 20, mustContain: "syncHealthFields" },
  { file: D, name: "healSqueezedAgentWindows", kind: "function", minLines: 8, mustContain: "planLeadPaneHeal" },
  { file: D, name: "reconcileSessionLiveness", kind: "function", minLines: 20, mustContain: "list-panes" },
  { file: D, name: "prewarmRecentlyActiveSessions", kind: "function", minLines: 20, mustContain: "readAgentStatusFiles" },
  { file: D, name: "checkDiskVersionMismatch", kind: "function", minLines: 10, mustContain: "restartDaemonProcess" },
  { file: D, name: "saveDaemonState", kind: "function", minLines: 5, mustContain: "STATE_FILE" },
  { file: D, name: "readDaemonState", kind: "function", minLines: 5, mustContain: "STATE_FILE" },
  { file: D, name: "resolveTurnEndStatus", kind: "function", minLines: 15, mustContain: "declaredSettleVerdict" },
  // Nested in main().
  { file: D, name: "handleStatusData", kind: "function", from: MAIN, minLines: 100, mustContain: "resolveTurnEndStatus" },
  { file: D, name: "handleStatusFile", kind: "function", from: MAIN, minLines: 5, mustContain: "handleStatusData" },
  { file: D, name: "persistHookStatus", kind: "function", from: MAIN, minLines: 5, mustContain: "lastHookStatus" },
  { file: D, name: "handlePlanFile", kind: "function", from: MAIN, minLines: 15, mustContain: "syncPlanFromPlanMode" },
  { file: D, name: "findMostRecentSessionId", kind: "function", from: MAIN, minLines: 5, mustContain: "listFilesByMtime" },
  { file: D, name: 'watcher.on("session")', find: 'watcher.on("session"', kind: "call", from: MAIN, minLines: 40, mustContain: "chooseSessionTranscript" },
  { file: D, name: "hookServer = startHookServer(", kind: "call", from: MAIN, minLines: 15, mustContain: "processSessionFile" },
  { file: D, name: "main setInterval", kind: "intervals", from: MAIN, minLines: 1, mustContain: "", minCount: 14 },
  { file: D, name: "module setInterval", kind: "intervals", from: "", to: MAIN, minLines: 1, mustContain: "", minCount: 1 },
  { file: D, name: "boot slice", kind: "slice", from: 'logLifecycle("daemon_start"', to: "hookServer = startHookServer(", minLines: 500, mustContain: "waitForConfig" },
  // Loopback server routes.
  { file: "terminal/terminalServer.ts", name: "handleTerminalHttp", kind: "function", minLines: 20, mustContain: "listTerminalSessions" },
  { file: "terminal/terminalServer.ts", name: "listTerminalSessions", kind: "function", minLines: 3, mustContain: "tmuxRunAsync" },
  { file: "terminal/terminalServer.ts", name: "killTerminalSession", kind: "function", minLines: 5, mustContain: "kill-session" },
  { file: "terminal/terminalServer.ts", name: "reapStaleTerminalSessions", kind: "function", minLines: 5, mustContain: "staleTerminalSessions" },
  { file: "terminal/terminalServer.ts", name: "handleConnection", kind: "function", minLines: 60, mustContain: "has-session" },
  { file: "vault/vaultServer.ts", name: "handleVaultHttp", kind: "function", minLines: 20, mustContain: "handleOp" },
  { file: "vault/vaultServer.ts", name: "handleScan", kind: "function", minLines: 5, mustContain: "sendJson" },
  { file: "vault/vaultServer.ts", name: "handleGetFile", kind: "function", minLines: 5, mustContain: "sendJson" },
  { file: "vault/vaultServer.ts", name: "handlePutFile", kind: "function", minLines: 5, mustContain: "writeVaultFile" },
  { file: "vault/vaultServer.ts", name: "handleOp", kind: "function", minLines: 30, mustContain: "moveToTrash" },
  { file: "browser/focusHttp.ts", name: "handleBrowserFocusHttp", kind: "function", minLines: 10, mustContain: "focusBrowserTab" },
  { file: "browser/watchServer.ts", name: "attachWatchServer", kind: "function", minLines: 10, mustContain: "onWsUpgrade" },
  { file: "browser/watchServer.ts", name: "handleConnection", kind: "function", minLines: 60, mustContain: "ownerCandidates" },
  { file: "browser/watchServer.ts", name: "ownerCandidates", kind: "function", minLines: 5, mustContain: "paneIdFor" },
  { file: "browser/watchServer.ts", name: "tmuxPaneId", kind: "function", minLines: 3, mustContain: "display-message" },
  // The panel detach path; closeSync is the daemon shutdown path and stays sync.
  { file: "terminal/controlClient.ts", name: "close", kind: "method", minLines: 10, mustContain: "verifyRestore" },
  { file: "terminal/controlClient.ts", name: "verifyRestore", kind: "method", minLines: 5, mustContain: "restoreRepairs" },
  // Timers outside daemon.ts.
  { file: "browser/focusSentinel.ts", name: "startFocusSentinel", kind: "function", minLines: 20, mustContain: "frontAsnAsync" },
  { file: "browser/focusSentinel.ts", name: "commandOfPidAsync", kind: "function", minLines: 3, mustContain: "execFileAsync" },
  { file: "cursorWatcher.ts", name: "pollWorkspaces", kind: "method", minLines: 5, mustContain: "pollWorkspacesOnce" },
  { file: "cursorWatcher.ts", name: "pollWorkspacesOnce", kind: "method", minLines: 20, mustContain: "dbMtimes" },
  { file: "cursorWatcher.ts", name: "checkWorkspaceForChanges", kind: "method", minLines: 10, mustContain: "readChatMaxRowId" },
  { file: "cursorWatcher.ts", name: "getWorkspaceFolderPath", kind: "method", minLines: 10, mustContain: "workspace.json" },
  { file: "recursiveWatcher.ts", name: "start", kind: "method", minLines: 5, mustContain: "watch" },
  { file: "recursiveWatcher.ts", name: "probe", kind: "method", minLines: 5, mustContain: "stat" },
  { file: "recursiveWatcher.ts", name: "runRescan", kind: "method", minLines: 5, mustContain: "walkTree" },
  { file: "recursiveWatcher.ts", name: "walkTree", kind: "method", minLines: 5, mustContain: "walkFiles" },
];

// Sync spawns and sync filesystem reads. readFileSync is forbidden outright:
// the hot paths read transcripts, and a "small" read grows with the file.
const FORBIDDEN = /\b(spawnSync|execSync|execFileSync|tmuxRun|tmuxExecSync|readdirSync|statSync|lstatSync|readFileSync|openSync|readSync)\s*\(/;
// A single existence check is cheap; one per entry of a loop is a walk.
const EXISTS = /\bexistsSync\s*\(/;
const LOOP_OPENER = /\b(for|while)\s*\(|\.(forEach|map)\s*\(/;

// key: `file:block:token:lineSubstring`; value: why the loop cannot avoid it.
const ALLOWLIST = new Map<string, string>([
  [
    "daemon.ts:readDaemonState:readFileSync:STATE_FILE",
    "The event loop monitor's tick stamp is what the launchd watchdog reads (supervision.ts daemonTickStale). " +
      "The merge must read the current file and land in the same tick even when the loop is starved; the file is under 1KB. " +
      "Every other reader takes a one second memo, so a burst of watcher events pays this read once.",
  ],
  [
    'daemon.ts:watcher.on("session"):statSync:projectExists',
    "One stat of a project directory, memoized per path. The handler must stay synchronous up to " +
      "chooseSessionTranscript so two events for one session cannot interleave and both register.",
  ],
]);

function extract(row: Row): SourceBlock[] {
  const src = load(row.file);
  const from = row.from ? src.indexOf(row.from) : 0;
  if (row.from && from < 0) throw new Error(`${row.file}: anchor ${row.from} not found`);
  switch (row.kind) {
    case "function":
      return [functionBlock(src, row.name, { from })];
    case "method":
      return [functionBlock(src, row.name, { from, method: true })];
    case "call": {
      const i = src.indexOf(row.find ?? row.name, from);
      if (i < 0) throw new Error(`${row.file}: ${row.name} not found`);
      return [blockAt(src, i)];
    }
    case "intervals": {
      const to = row.to ? src.indexOf(row.to) : src.length;
      return intervalBlocks(src, from, to);
    }
    case "slice":
      return [sliceBetween(src, row.from!, row.to!, 0)];
  }
}

const extracted = ROWS.map((row) => ({ row, blocks: extract(row) }));

type Hit = { at: string; text: string; allowed: boolean };

// One hit per forbidden call on a code line of the block, marked allowed
// when an allowlist entry for this block names it; the keys that matched
// come back through `matched`.
function hitsIn(row: Row, block: SourceBlock, matched: Set<string>): Hit[] {
  const out: Hit[] = [];
  let depth = 0;
  const loopDepths: number[] = [];
  for (const { line, n } of codeLines(block.text)) {
    const fileLine = block.startLine + n - 1;
    const opensLoop = LOOP_OPENER.test(line);
    const hits: string[] = [];
    const m = FORBIDDEN.exec(line);
    if (m) hits.push(m[1]);
    if (EXISTS.test(line) && (opensLoop || loopDepths.length > 0)) hits.push("existsSync");
    for (const token of hits) {
      const entry = [...ALLOWLIST.keys()].find((key) => {
        const [file, blockName, tok, sub] = splitKey(key);
        return file === row.file && blockName === row.name && tok === token && line.includes(sub);
      });
      if (entry) matched.add(entry);
      out.push({ at: `${row.file}:${fileLine}`, text: line.trim(), allowed: !!entry });
    }
    const opens = (line.match(/{/g) ?? []).length;
    const closes = (line.match(/}/g) ?? []).length;
    if (opensLoop && opens > closes) loopDepths.push(depth);
    depth += opens - closes;
    while (loopDepths.length && depth <= loopDepths[loopDepths.length - 1]) loopDepths.pop();
  }
  return out;
}

// The block name may itself contain a quoted string with no colon; split on
// the LAST three colons so `watcher.on("session")` survives.
function splitKey(key: string): [string, string, string, string] {
  const parts = key.split(":");
  const sub = parts.pop()!;
  const tok = parts.pop()!;
  const file = parts.shift()!;
  return [file, parts.join(":"), tok, sub];
}

describe("daemon loop budget guard", () => {
  test("every hot path block extracts non trivially", () => {
    for (const { row, blocks } of extracted) {
      expect(blocks.length, `${row.file}:${row.name} found no block`).toBeGreaterThan(0);
      if (row.minCount) expect(blocks.length, `${row.file}:${row.name} count`).toBeGreaterThanOrEqual(row.minCount);
      for (const b of blocks) {
        const lines = b.text.split("\n").length;
        expect(lines, `${row.file}:${row.name}@${b.startLine} has ${lines} lines`).toBeGreaterThanOrEqual(row.minLines);
        if (row.mustContain) expect(b.text, `${row.file}:${row.name}@${b.startLine}`).toContain(row.mustContain);
      }
    }
  });

  test("main() registers its periodic timers where the guard can see them", () => {
    const main = extracted.find((e) => e.row.name === "main setInterval")!;
    expect(main.blocks.length).toBeGreaterThanOrEqual(14);
  });

  // Blocks overlap (the boot slice holds the nested handlers), so a line is
  // judged once: allowed when any block that contains it allowlists it.
  function scan(): { offenders: string[]; matched: Set<string> } {
    const matched = new Set<string>();
    const byLine = new Map<string, Hit>();
    for (const { row, blocks } of extracted) {
      for (const b of blocks) {
        for (const hit of hitsIn(row, b, matched)) {
          const prev = byLine.get(hit.at);
          if (!prev || hit.allowed) byLine.set(hit.at, hit);
        }
      }
    }
    const offenders = [...byLine.values()].filter((h) => !h.allowed).map((h) => `${h.at}: ${h.text}`);
    return { offenders, matched };
  }

  test("no sync spawn or sync filesystem walk on a hot path", () => {
    expect(scan().offenders).toEqual([]);
  });

  test("every allowlist entry still matches a line (a fixed call must drop its entry)", () => {
    const { matched } = scan();
    expect([...ALLOWLIST.keys()].filter((k) => !matched.has(k))).toEqual([]);
  });
});
