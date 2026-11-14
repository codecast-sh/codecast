// Headless agent runs (`codex exec`, `claude -p`) and the inbox.
//
// A headless run has no composer: nobody can type into it, and whatever
// started it reads its output. So it is never an inbox card, whether or not
// the daemon could name the session that started it (a detached run whose
// process is gone names nobody). ONE rule for every client's create path, and
// for the repair of the rows created before the rule existed.

import * as fs from "node:fs";
import * as path from "node:path";
import { extractCodexSessionMetadata, isCodexProgramLaunch } from "./codexSessionMeta.js";
import { headlessAgentOfCommand } from "./sessionProcessMatcher.js";

/** The conversation a headless run inherited, from its `ps eww -o command=`
 *  line (the command, then the process's environment). A session's Bash passes
 *  CODECAST_CONVERSATION_ID to everything it starts, and the variable survives
 *  `nohup … &`, where the run's parent process becomes init and the ancestor
 *  walk finds nobody. Only a headless run is read: an interactive session the
 *  daemon launched carries its OWN conversation in that variable. The last
 *  match wins, because the environment follows the arguments and a prompt in
 *  the arguments can quote the variable's name. */
export function inheritedConversationOfHeadless(commandWithEnv: string): string | null {
  if (!headlessAgentOfCommand(commandWithEnv)) return null;
  const matches = [...commandWithEnv.matchAll(/(?:^|\s)CODECAST_CONVERSATION_ID=([A-Za-z0-9]+)(?=\s|$)/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/** Whether a fresh headless run is created outside the inbox (a subagent row,
 *  with or without a parent). A trigger's run keeps the placement its schedule
 *  gives it, and a fork, plan handoff or agent-team teammate keeps its own
 *  link: none of those is a loose run. */
export function headlessRunStaysOutOfInbox(run: {
  headless: boolean;
  triggerRun?: boolean;
  forkOrHandoff?: boolean;
  teammate?: boolean;
}): boolean {
  return run.headless && !run.triggerRun && !run.forkOrHandoff && !run.teammate;
}

const REPAIR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
// A mark can fail for good (a session its owner deleted), so the repair stops
// asking after this many starts rather than repeating on every one.
const REPAIR_MAX_STARTS = 3;

function* transcriptsUnder(dir: string, since: number): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* transcriptsUnder(full, since);
    else if (entry.name.endsWith(".jsonl")) {
      try {
        if (fs.statSync(full).mtimeMs >= since) yield full;
      } catch {}
    }
  }
}

type RepairMarker = { done?: boolean; starts?: number; marked?: number; ts?: number };

function readRepairMarker(file: string): RepairMarker {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RepairMarker;
  } catch {
    return {};
  }
}

/** Once per machine: mark the `codex exec` runs that became top-level inbox
 *  cards before headlessRunStaysOutOfInbox existed. Only runs this machine has
 *  a conversation for are marked, and `mark` is the server's own create call,
 *  which on an existing row sets the subagent flag and touches nothing else.
 *  A start where a mark failed runs again on the next start, up to
 *  REPAIR_MAX_STARTS. Returns how many rows it marked. */
export async function repairLeakedHeadlessCodexRuns(opts: {
  sessionsDir: string;
  markerFile: string;
  conversations: Record<string, string>;
  readHead: (file: string) => string;
  mark: (sessionId: string) => Promise<void>;
  now?: number;
}): Promise<number> {
  const before = readRepairMarker(opts.markerFile);
  if (before.done) return 0;
  const now = opts.now ?? Date.now();
  let marked = 0;
  let failed = 0;
  for (const file of transcriptsUnder(opts.sessionsDir, now - REPAIR_WINDOW_MS)) {
    // A yield per file: a boot-time walk must not starve the event loop.
    await new Promise((resolve) => setImmediate(resolve));
    let metadata;
    try {
      metadata = extractCodexSessionMetadata(opts.readHead(file));
    } catch {
      continue;
    }
    if (!metadata?.id || !isCodexProgramLaunch(metadata) || !opts.conversations[metadata.id]) continue;
    try {
      await opts.mark(metadata.id);
      marked++;
    } catch {
      failed++;
    }
  }
  const starts = (before.starts ?? 0) + 1;
  try {
    fs.mkdirSync(path.dirname(opts.markerFile), { recursive: true });
    fs.writeFileSync(opts.markerFile, JSON.stringify({ done: failed === 0 || starts >= REPAIR_MAX_STARTS, starts, marked, ts: now } satisfies RepairMarker));
  } catch {}
  return marked;
}
