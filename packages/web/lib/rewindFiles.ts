// "Rewind to here" on a user message: the files the session's turns since
// that message changed go back to how they stood before it, on the session's
// own machine (cli/src/rewindTree.ts), and the conversation continues in a
// fork from the message before. Every step is a sessionCommands row (one
// home: lib/sessionCommands), painted on the press and settled by the daemon's
// reply; this file reads those rows and builds the review's ledger from them.

import type { RewindFilesOp, RewindFilesReply, RewindStagedMark } from "@codecast/shared/contracts";
import type { SwitchLedger, SwitchRow } from "../components/consequential/ConsequentialSwitch";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { COMMAND_UNCLAIMED_WARN_MS, DISPATCH_REFUSED, newRequestId, recordSessionCommandDispatchError, type SessionCommandRow } from "./sessionCommands";

/** Ask the session's machine for one rewind step; returns the request id its row is keyed by. */
export function requestRewind(conversationId: string, op: RewindFilesOp, opts: { message_ts?: number; fingerprint?: string; overwrite?: boolean; path?: string } = {}): string {
  const requestId = newRequestId();
  useInboxStore.getState().rewindFiles(requestId, conversationId, op, opts).catch((error: unknown) => {
    if (!isParkedDispatchError(error)) recordSessionCommandDispatchError(requestId, error);
  });
  return requestId;
}

/** The daemon's reply on a settled row, or null while it is in flight or failed. */
export function rewindReply(row: SessionCommandRow | undefined | null): RewindFilesReply | null {
  if (!row?.executed_at || !row.result || row.result === DISPATCH_REFUSED) return null;
  try {
    return JSON.parse(row.result) as RewindFilesReply;
  } catch {
    return null;
  }
}

/** Why a row failed outright (no reply to read), in words for the review; null when it did not. */
export function rewindFailure(row: SessionCommandRow | undefined | null): string | null {
  if (!row?.executed_at) return null;
  if (row.result === DISPATCH_REFUSED) {
    return /Unknown dispatch action|Could not find public function/i.test(row.error ?? "") ? "The server can't do this yet" : (row.error ?? "").match(/Uncaught (?:Convex)?Error: ([^\n]+)/)?.[1] ?? "The server refused";
  }
  if (row.error) return /Unknown command/i.test(row.error) ? "Update codecast on that machine" : row.error.replace(/^Rewind failed: /, "");
  return rewindReply(row) ? null : "No answer from the machine";
}

export type StagedRewindView = RewindStagedMark & { conversationId: string };

/**
 * The checkout's staged rewind: the mark its daemon reported on the session's
 * row (conversations.rewind_staged), on any of `conversationIds` (a fork and
 * the session it came from share a checkout), read from the inbox row
 * (`sessions`, live for every session in the inbox), else the conversation row.
 */
export function stagedRewindOf(sessions: Record<string, any>, conversationIds: ReadonlyArray<string | undefined | null>, conversations: Record<string, any> = {}): StagedRewindView | null {
  for (const id of conversationIds) {
    if (!id) continue;
    // A dismissed or stashed session has no inbox row; its conversation row (opened here) carries the same field.
    const mark: RewindStagedMark | null | undefined = (sessions[id] ?? conversations[id])?.rewind_staged;
    if (mark) return { ...mark, conversationId: id };
  }
  return null;
}

/** What the review shows: a stage reply that carries a fresh plan (it was refused for a stale or busy tree) replaces the first plan. */
export function reviewedPlan(plan: SessionCommandRow | undefined, stage: SessionCommandRow | undefined): RewindFilesReply | null {
  const fresh = rewindReply(stage);
  return fresh?.counts ? fresh : rewindReply(plan);
}

const SHOWN = 8;
function listOf(paths: string[]): string[] {
  return paths.length > SHOWN ? [...paths.slice(0, SHOWN), `+${paths.length - SHOWN} more`] : paths;
}
const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

export const OVERWRITE_OPTIONS = ["Stop", "Overwrite"] as const;

/**
 * The review of a rewind, from its plan row and (once confirmed) its stage row.
 * Every state is in the ledger: waiting on the machine, a refusal, nothing to
 * do, an agent mid-turn, others' edits that need an explicit overwrite.
 */
export function rewindLedger(r: {
  subject: string;
  plan: SessionCommandRow | undefined;
  stage?: SessionCommandRow | undefined;
  overwrite: boolean;
  now: number;
  onDiff: () => void;
  /** Open the session whose rewind is staged in this checkout. */
  onOpen: (conversationId: string) => void;
  /** The conversation the review is for. */
  conversationId: string;
  /** Settle a rewind already staged in this checkout, from the review itself. */
  onSettle: (op: "put_back" | "keep") => void;
  /** That settle step, while it runs and once it answers. */
  settle?: SessionCommandRow | undefined;
}): SwitchLedger {
  const base = { name: "Rewind to here", subject: r.subject, shift: ["Now", "Before this turn"] as [string, string], keep: "Cancel" };
  const reply = reviewedPlan(r.plan, r.stage);
  const failed = rewindFailure(r.plan);
  const waiting = (row: SessionCommandRow | undefined) =>
    row && !row.executed_at && r.now - row.requested_at > COMMAND_UNCLAIMED_WARN_MS ? "Waiting for the machine" : null;
  const pendingFigures = [{ value: "…", label: "files" }, { value: "…", label: "turns undone" }];

  if (!reply) {
    return {
      ...base,
      ...(failed ? { alert: failed } : {}),
      figures: pendingFigures,
      rows: [{ k: "Reads", v: "The session's turn snapshots" }],
      confirm: "Rewind",
      blocked: failed ? "Can't rewind" : waiting(r.plan) ?? "Reading the files…",
    };
  }
  if (reply.staged) {
    // Settled right here, whatever the headers show: a dismissed or stashed session carries no chip.
    const settling = !!r.settle && !r.settle.executed_at;
    const settleReply = rewindReply(r.settle);
    const settleFailed = rewindFailure(r.settle) ?? settleReply?.refused ?? null;
    return {
      ...base,
      alert: settleFailed ?? "A rewind is already staged",
      figures: [{ value: String(reply.staged.count), label: "files rewound" }],
      rows: [
        { k: "Staged", v: files(reply.staged.count), list: listOf(reply.staged.files.map((f) => f.path)) },
        { k: "Put back", v: "Restore them", act: { label: settling ? "Working…" : "Put back", press: () => { if (!settling) r.onSettle("put_back"); } } },
        { k: "Keep", v: "Drop the way back", tone: "warn", act: { label: settling ? "Working…" : "Keep", press: () => { if (!settling) r.onSettle("keep"); } } },
        ...(reply.staged.conversation_id !== r.conversationId
          ? [{ k: "Staged by", v: "Another session here", act: { label: "Open it", press: () => r.onOpen(reply.staged!.conversation_id) } }]
          : []),
      ],
      confirm: "Rewind",
      blocked: "Put back or keep it first",
    };
  }
  if (reply.refused && !reply.counts) {
    return { ...base, alert: reply.refused, figures: pendingFigures, rows: [], confirm: "Rewind", blocked: "Can't rewind" };
  }

  const c = reply.counts ?? { restore: 0, delete: 0, recreate: 0, conflict: 0, total: 0 };
  const list = reply.files ?? [];
  const paths = (pred: (f: (typeof list)[number]) => boolean) => list.filter(pred).map((f) => f.path);
  const rows: SwitchRow[] = [];
  if (c.restore) rows.push({ k: "Restored", v: files(c.restore), list: listOf(paths((f) => f.action === "restore")) });
  if (c.delete) rows.push({ k: "Deleted", v: files(c.delete), list: listOf(paths((f) => f.action === "delete")) });
  if (c.recreate) rows.push({ k: "Brought back", v: files(c.recreate), list: listOf(paths((f) => f.action === "recreate")) });
  if (c.conflict) rows.push({ k: "Edited since", v: r.overwrite ? `${files(c.conflict)} overwritten` : files(c.conflict), tone: "warn", list: listOf(paths((f) => f.conflict)) });
  if (c.total) rows.push({ k: "Diff", v: files(c.total), act: { label: "Show diff", press: r.onDiff } });
  // Known only as "not named by its edit tools": a person, another session, or its own shell commands.
  if (reply.left_alone) rows.push({ k: "Kept as is", v: `${files(reply.left_alone)} its edit tools didn't name`, list: listOf(reply.left_alone_paths ?? []) });
  if (reply.head_moved) rows.push({ k: "Commits", v: "Kept, only files move", tone: "warn" });
  if (reply.from_prompt === false) rows.push({ k: "Starts at", v: "End of the turn before", tone: "warn" });
  rows.push({ k: "Continues", v: "In a fork from here" }, { k: "Undo", v: "Put back, in the header" });

  // The stage's own failure, when it brought no fresh plan with it (a dropped or unknown command).
  const stageFailed = rewindFailure(r.stage) ?? rewindReply(r.stage)?.refused ?? null;
  const staging = !!r.stage && !r.stage.executed_at;
  const blocked =
    c.total === 0 ? "Files already match"
    : c.conflict && !r.overwrite ? `${files(c.conflict)} changed by someone else`
    : staging ? waiting(r.stage) ?? "Rewinding…"
    : undefined;
  const alert = stageFailed ?? (reply.busy ? "An agent is working in this checkout" : c.conflict ? `${files(c.conflict)} changed by someone else` : null);
  return {
    ...base,
    ...(alert ? { alert } : {}),
    figures: [
      { value: String(c.total), label: "files change" },
      { value: String(reply.turns ?? 0), label: `turn${reply.turns === 1 ? "" : "s"} undone` },
      ...(c.conflict ? [{ value: String(c.conflict), label: "edited by others", tone: "warn" as const }] : []),
    ],
    rows,
    ...(c.conflict ? { pick: { k: "Their edits", options: OVERWRITE_OPTIONS, value: r.overwrite ? "Overwrite" : "Stop" } } : {}),
    confirm: c.conflict && r.overwrite ? `Overwrite and rewind ${files(c.total)}` : `Rewind ${files(c.total)}`,
    ...(blocked ? { blocked } : {}),
  };
}

/** Keeping drops the only copy of what the rewind replaced, so it is a deliberate press. */
export function keepLedger(r: { files: number }): SwitchLedger {
  return {
    name: "Keep rewound files",
    subject: `${files(r.files)} rewound`,
    shift: null,
    figures: [{ value: String(r.files), label: "files stay as they are" }],
    rows: [{ k: "Drops", v: "The copy Put back restores", tone: "warn" }, { k: "Undo", v: "Not possible", tone: "warn" }],
    confirm: "Keep and drop the copy",
    keep: "Cancel",
  };
}

/** The review of a put back that found files edited after the rewind: going on discards those edits. */
export function putBackLedger(r: { paths: string[]; total: number }): SwitchLedger {
  return {
    name: "Put back anyway",
    subject: `${files(r.total)} rewound`,
    shift: null,
    alert: `${files(r.paths.length)} edited since the rewind`,
    figures: [{ value: String(r.paths.length), label: "edits discarded", tone: "warn" }, { value: String(r.total), label: "files put back" }],
    rows: [{ k: "Discards", v: files(r.paths.length), tone: "warn", list: listOf(r.paths) }],
    confirm: "Discard and put back",
    keep: "Cancel",
  };
}

/** One file's patch in a rewind diff (the daemon writes `diff <path>` before each). */
export function splitRewindDiff(diff: string): Array<{ path: string; patch: string }> {
  const out: Array<{ path: string; patch: string }> = [];
  for (const part of diff.split(/^diff (?=\S)/m)) {
    if (!part.trim()) continue;
    const nl = part.indexOf("\n");
    out.push({ path: part.slice(0, nl), patch: part.slice(nl + 1).replace(/\n+$/, "\n") });
  }
  return out;
}
