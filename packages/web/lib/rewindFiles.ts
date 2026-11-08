// "Rewind to here" on a user message: the files the session's turns since
// that message changed go back to how they stood before it, on the session's
// own machine (cli/src/rewindTree.ts), and the conversation continues in a
// fork from the message before. Every step is a sessionCommands row (one
// home: lib/sessionCommands), painted on the press and settled by the daemon's
// reply; this file reads those rows and builds the review's ledger from them.

import type { RewindFilesOp, RewindFilesReply } from "@codecast/shared/contracts";
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

export type StagedRewindView = { conversationId: string; files: number; stagedAt: number; at: number };

/**
 * The checkout's staged rewind as this window last heard it: the newest settled
 * rewind reply for any of `conversationIds` (the session and the one it was
 * forked from share a checkout) that says what is staged.
 */
export function stagedRewindOf(rows: Record<string, SessionCommandRow> | null | undefined, conversationIds: ReadonlyArray<string | undefined | null>): StagedRewindView | null {
  const ids = new Set(conversationIds.filter(Boolean) as string[]);
  let best: { at: number; reply: RewindFilesReply } | null = null;
  for (const row of Object.values(rows ?? {})) {
    if (row?.kind !== "rewind" || !row.conversation_id || !ids.has(row.conversation_id)) continue;
    const reply = rewindReply(row);
    if (!reply || reply.staged === undefined) continue;
    if (!best || row.requested_at > best.at) best = { at: row.requested_at, reply };
  }
  const s = best?.reply.staged;
  return s ? { conversationId: s.conversation_id, files: s.files.length, stagedAt: s.staged_at, at: s.at } : null;
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
 * do, the agent mid-turn, others' edits that need an explicit overwrite.
 */
export function rewindLedger(r: {
  subject: string;
  plan: SessionCommandRow | undefined;
  stage?: SessionCommandRow | undefined;
  overwrite: boolean;
  now: number;
  onDiff: () => void;
  onPutBack: () => void;
}): SwitchLedger {
  const base = { name: "Rewind to here", subject: r.subject, shift: ["Now", "Before this turn"] as [string, string], keep: "Cancel" };
  const reply = rewindReply(r.plan);
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
  if (reply.refused) {
    return { ...base, alert: reply.refused, figures: pendingFigures, rows: [], confirm: "Rewind", blocked: "Can't rewind" };
  }
  if (reply.staged) {
    return {
      ...base,
      alert: "A rewind is already staged",
      figures: [{ value: String(reply.staged.files.length), label: "files rewound" }],
      rows: [{ k: "Staged", v: files(reply.staged.files.length), act: { label: "Put back", press: r.onPutBack } }],
      confirm: "Rewind",
      blocked: "Put back or keep it first",
    };
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
  if (reply.head_moved) rows.push({ k: "Commits", v: "Kept, only files move", tone: "warn" });
  if (reply.shared) rows.push({ k: "Checkout", v: `Shared with ${reply.shared} session${reply.shared === 1 ? "" : "s"}`, tone: "warn" });
  if (reply.left_alone) rows.push({ k: "Left alone", v: `${files(reply.left_alone)} in the shared checkout` });
  rows.push({ k: "Continues", v: "In a fork from here" }, { k: "Undo", v: "Put back, from the header" });

  const stageReply = rewindReply(r.stage);
  const stageFailed = rewindFailure(r.stage) ?? stageReply?.refused ?? null;
  const staging = !!r.stage && !r.stage.executed_at;
  const blocked =
    c.total === 0 ? "Files already match"
    : reply.busy ? "The agent is working"
    : c.conflict && !r.overwrite ? `${files(c.conflict)} changed by someone else`
    : staging ? waiting(r.stage) ?? "Rewinding…"
    : undefined;
  return {
    ...base,
    ...(stageFailed ? { alert: stageFailed } : c.conflict ? { alert: `${files(c.conflict)} changed by someone else` } : {}),
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
