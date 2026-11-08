/**
 * The `rewind_files` daemon command (contracts/rewindFiles.ts): the web's
 * "Rewind to here", answered on the machine that holds the session's checkout.
 * The daemon resolves the checkout and the agent's state; everything else is
 * here, so it runs the same under a test.
 */

import { REWIND_FILES_LIST_CAP, type RewindFilesArgs, type RewindFilesReply, type RewindFilesStaged } from "@codecast/shared/contracts";
import { RewindRefused, diffRewind, keepRewind, planRewind, putBackRewind, readStaged, stageRewind, type RewindPlan, type RewindRow, type StagedRewind } from "./rewindTree.js";

export type RewindFilesDeps = {
  /** The checkout's root. */
  root: string;
  /** The session's working folder (relative edited paths resolve against it). */
  cwd?: string;
  /** The session's turn snapshot rows in this checkout (treeSnapshots.listForConversation), and whether the server's row cap cut older ones. */
  rows: () => Promise<{ rows: RewindRow[]; truncated: boolean }>;
  /** Files the session's own tool calls changed after a moment (treeSnapshots.editedPaths); null when the backend cannot say. */
  edited: (after: number) => Promise<{ edits: Array<{ path: string; at: number[] }>; complete: boolean; others?: Array<{ path: string; at: number[] }>; others_complete?: boolean; synced_at?: number } | null>;
  /** When the session's last turn ended (ms), to tell a snapshot still being recorded from none. */
  lastTurnEnd?: number;
  /** Snapshot the tree now and record it as the last turn's end, for a turn whose own snapshot never landed. */
  recordLastTurn?: () => Promise<void>;
  /** Turn snapshots are switched off on this machine (wip_snapshots_enabled). */
  snapshotsOff?: boolean;
  /** An agent working in this checkout is mid-turn. */
  busy: boolean;
  /** Asks again right before files are written: a turn may have started while the plan was made. */
  busyNow?: () => Promise<boolean>;
};

function stagedView(s: StagedRewind | null): RewindFilesStaged | null {
  if (!s) return null;
  return { id: s.id, conversation_id: s.conversation_id, at: s.at, staged_at: s.staged_at, count: s.files.length, files: s.files.slice(0, REWIND_FILES_LIST_CAP).map((f) => ({ path: f.path, action: f.action })) };
}

function planView(plan: RewindPlan): Partial<RewindFilesReply> {
  const n = (pred: (f: RewindPlan["files"][number]) => boolean) => plan.files.filter(pred).length;
  return {
    files: plan.files.slice(0, REWIND_FILES_LIST_CAP).map((f) => ({ path: f.path, action: f.action, conflict: f.conflict })),
    counts: {
      restore: n((f) => f.action === "restore"),
      delete: n((f) => f.action === "delete"),
      recreate: n((f) => f.action === "recreate"),
      conflict: n((f) => f.conflict),
      total: plan.files.length,
    },
    fingerprint: plan.fingerprint,
    turns: plan.turns,
    head_moved: plan.head_moved,
    from_prompt: plan.from_prompt,
    left_alone: plan.left_alone.length,
    left_alone_paths: plan.left_alone.slice(0, REWIND_FILES_LIST_CAP),
  };
}

/** Longer than a turn snapshot's coalescing and record ever take. */
const MISSING_TURN_GRACE_MS = 30_000;
/** How long after a turn's end its edits get to reach the server. */
const SYNC_WAIT_MS = 60_000;

export async function runRewindFilesCommand(args: RewindFilesArgs, deps: RewindFilesDeps): Promise<RewindFilesReply> {
  const { op } = args;
  const base = { op, root: deps.root, busy: deps.busy } as const;
  let plan: RewindPlan | null = null;
  try {
    if (op === "put_back") {
      // Put back writes files: not under an agent that is writing them.
      if (deps.busy) return { ...base, refused: "an agent is working in this checkout: wait for its turn to end", ...withStaged(await readStaged(deps.root)) };
      const out = await putBackRewind(deps.root, { force: args.overwrite, expectId: args.staged_id, discard: args.discard });
      return { ...base, restored: out.restored, staged: null, staged_conversation_id: out.staged.conversation_id, cleared_id: out.staged.id };
    }
    if (op === "keep") {
      const kept = await keepRewind(deps.root, { expectId: args.staged_id });
      return { ...base, staged: null, staged_conversation_id: kept.conversation_id, cleared_id: kept.id };
    }
    if (typeof args.message_ts !== "number") return { ...base, refused: "no message time to rewind to" };
    if (deps.snapshotsOff) return { ...base, refused: "turn snapshots are off on this machine, so there is no record to rewind from" };
    let { rows, truncated } = await deps.rows();
    const lastRecorded = Math.max(0, ...rows.map((r) => r.turn_completed_at ?? 0));
    if (deps.lastTurnEnd && deps.lastTurnEnd > args.message_ts && lastRecorded < deps.lastTurnEnd - 1_000) {
      // Still within the daemon's own delay: it will land. Long past it (a
      // slow checkout parked, a failed record): take it now, or the session
      // could never be rewound until another turn ends.
      if (Date.now() - deps.lastTurnEnd < MISSING_TURN_GRACE_MS || !deps.recordLastTurn) {
        return { ...base, refused: "the last turn's snapshot is not recorded yet: try again in a moment" };
      }
      await deps.recordLastTurn();
      ({ rows, truncated } = await deps.rows());
    }
    const edited = await deps.edited(args.message_ts);
    if (!edited) return { ...base, refused: "the server can't say which files this session edited yet" };
    if (!edited.complete) return { ...base, refused: "this session edited too many files since that message to list: rewind to a later one" };
    if (edited.others_complete === false) return { ...base, refused: "your other sessions in this checkout edited too much since that message to check: rewind to a later one" };
    // The last turn's edits reach the server with its messages; until they do,
    // its files would look like someone else's. Bounded: the final message can
    // be written well before the Stop hook, and no later message may come.
    if (deps.lastTurnEnd && edited.synced_at !== undefined && edited.synced_at < deps.lastTurnEnd - 2_000 && Date.now() - deps.lastTurnEnd < SYNC_WAIT_MS) {
      return { ...base, refused: "the last turn's edits are still syncing: try again in a moment" };
    }
    plan = await planRewind(deps.root, args.conversation_id, rows, args.message_ts, edited.edits, { cwd: deps.cwd, others: edited.others, truncated });
    if (op === "diff") return { ...base, ...(await diffRewind(plan, args.path)) };
    if (op === "plan") return { ...base, ...planView(plan), ...withStaged(await readStaged(deps.root)) };
    // stage: every answer carries the fresh plan, so a refusal for a stale review is also the new review.
    if (deps.busy) return { ...base, ...planView(plan), refused: "an agent is working in this checkout: wait for its turn to end", ...withStaged(await readStaged(deps.root)) };
    if (await deps.busyNow?.()) return { ...base, ...planView(plan), busy: true, refused: "an agent is working in this checkout: wait for its turn to end", ...withStaged(await readStaged(deps.root)) };
    const staged = await stageRewind(plan, { fingerprint: args.fingerprint ?? "", overwrite: args.overwrite });
    return { ...base, ...planView(plan), ...withStaged(staged) };
  } catch (e) {
    // Every failure still says what is staged, so the Put back chip appears even after a step that broke.
    const refused = e instanceof RewindRefused ? e.message : `rewind failed: ${(e as Error)?.message?.split("\n")[0] ?? String(e)}`;
    return {
      ...base,
      ...(plan ? planView(plan) : {}),
      refused,
      paths: e instanceof RewindRefused ? e.paths.slice(0, REWIND_FILES_LIST_CAP) : [],
      ...(e instanceof RewindRefused && e.blocked ? { blocked: true } : {}),
      ...withStaged(await readStaged(deps.root).catch(() => null)),
      ...(args.staged_id ? { cleared_id: args.staged_id } : {}),
    };
  }
}

/** The checkout's staged rewind as a reply carries it, with the conversation whose state it is. */
function withStaged(s: StagedRewind | null): Pick<RewindFilesReply, "staged" | "staged_conversation_id"> {
  return s ? { staged: stagedView(s), staged_conversation_id: s.conversation_id } : { staged: null };
}
