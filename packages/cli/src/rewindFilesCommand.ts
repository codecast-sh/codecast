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
  /** The session's turn snapshot rows (treeSnapshots.listForConversation). */
  rows: () => Promise<RewindRow[]>;
  /** Files the session's own tool calls changed after a moment (treeSnapshots.editedPaths); null when the backend cannot say. */
  edited: (after: number) => Promise<{ paths: string[]; complete: boolean } | null>;
  /** When the session's last turn ended (ms), to tell a snapshot still being recorded from none. */
  lastTurnEnd?: number;
  /** Turn snapshots are switched off on this machine (wip_snapshots_enabled). */
  snapshotsOff?: boolean;
  /** An agent working in this checkout is mid-turn. */
  busy: boolean;
};

function stagedView(s: StagedRewind | null): RewindFilesStaged | null {
  if (!s) return null;
  return { id: s.id, conversation_id: s.conversation_id, at: s.at, staged_at: s.staged_at, files: s.files.slice(0, REWIND_FILES_LIST_CAP).map((f) => ({ path: f.path, action: f.action })) };
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

export async function runRewindFilesCommand(args: RewindFilesArgs, deps: RewindFilesDeps): Promise<RewindFilesReply> {
  const { op } = args;
  const base = { op, root: deps.root, busy: deps.busy } as const;
  let plan: RewindPlan | null = null;
  try {
    if (op === "put_back") {
      // Put back writes files: not under an agent that is writing them.
      if (deps.busy) return { ...base, refused: "an agent is working in this checkout: wait for its turn to end", ...withStaged(await readStaged(deps.root)) };
      const out = await putBackRewind(deps.root, { force: args.overwrite });
      return { ...base, restored: out.restored, staged: null, staged_conversation_id: out.staged.conversation_id };
    }
    if (op === "keep") {
      const kept = await keepRewind(deps.root);
      return { ...base, staged: null, staged_conversation_id: kept.conversation_id };
    }
    if (typeof args.message_ts !== "number") return { ...base, refused: "no message time to rewind to" };
    if (deps.snapshotsOff) return { ...base, refused: "turn snapshots are off on this machine, so there is no record to rewind from" };
    const rows = await deps.rows();
    const lastRecorded = Math.max(0, ...rows.map((r) => r.turn_completed_at ?? 0));
    if (deps.lastTurnEnd && deps.lastTurnEnd > args.message_ts && lastRecorded < deps.lastTurnEnd - 1_000) {
      return { ...base, refused: "the last turn's snapshot is not recorded yet: try again in a moment" };
    }
    const edited = await deps.edited(args.message_ts);
    if (!edited) return { ...base, refused: "the server can't say which files this session edited yet" };
    if (!edited.complete) return { ...base, refused: "this session edited too many files since that message to list: rewind to a later one" };
    plan = await planRewind(deps.root, args.conversation_id, rows, args.message_ts, edited.paths, deps.cwd);
    if (op === "diff") return { ...base, ...(await diffRewind(plan, args.path)) };
    if (op === "plan") return { ...base, ...planView(plan), ...withStaged(await readStaged(deps.root)) };
    // stage: every answer carries the fresh plan, so a refusal for a stale review is also the new review.
    if (deps.busy) return { ...base, ...planView(plan), refused: "an agent is working in this checkout: wait for its turn to end", ...withStaged(await readStaged(deps.root)) };
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
      ...withStaged(await readStaged(deps.root).catch(() => null)),
    };
  }
}

/** The checkout's staged rewind as a reply carries it, with the conversation whose state it is. */
function withStaged(s: StagedRewind | null): Pick<RewindFilesReply, "staged" | "staged_conversation_id"> {
  return s ? { staged: stagedView(s), staged_conversation_id: s.conversation_id } : { staged: null };
}
