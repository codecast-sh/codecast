// Daemon commands a store action asked for, read from the one sessionCommands
// collection: hibernate, restart/repair, device move, account switch. The
// action paints a row keyed by its request id on the click; the server echo
// (sessionCommands.results / forConversation) settles it. Every surface reads
// in-flight state, progress and outcome from these rows, and a command a dead
// daemon never answers expires here, at read time, from when it was asked.

import { useInboxStore, type AccountSwitchArgs } from "../store/inboxStore";
import { isParkedDispatchError, isRefusedDispatchError } from "../store/mutativeMiddleware";
import { MACHINE_SWITCH_TIMEOUT_MS } from "./machineAccountSwitch";

export type SessionCommandKind = "restart" | "repair" | "move" | "switch" | "line_edit";

export type SessionCommandRow = {
  _id: string;
  command_id?: string;
  conversation_id?: string | null;
  command: string;
  device_id?: string | null;
  requested_at: number;
  executed_at: number | null;
  result: string | null;
  error: string | null;
  // Local intent the echo never carries (registry preserveFields).
  kind?: SessionCommandKind;
  started_at?: number;
  confirmed_at?: number;
  to_device_id?: string;
  to_remote?: boolean;
  to_label?: string;
  profile?: string;
  email?: string;
  // A line edit (store/lineSlice.ts): the project, the edits and the keys they touch.
  project_id?: string;
  edits?: unknown[];
  keys?: string[];
};

// The store actions whose first argument is a sessionCommands request id.
export const SESSION_COMMAND_ACTIONS = new Set(["hibernateSession", "restartSession", "moveSessionToDevice", "requestAccountSwitch", "editLineProfile"]);

// Marks a row the server refused outright (no daemon will ever answer it).
export const DISPATCH_REFUSED = "dispatch_refused";

// How long the resume ladder gets before a restart escalates to a repair.
export const RESTART_ESCALATE_AFTER_MS = 45_000;
// The whole restart (resume window + rebuild window + slack), from the click.
export const RESTART_GIVE_UP_AFTER_MS = RESTART_ESCALATE_AFTER_MS * 2 + 30_000;
// A local re-home is a quick resume; a remote move transfers the worktree.
export const MOVE_GIVE_UP_LOCAL_MS = 2 * 60_000;
export const MOVE_GIVE_UP_REMOTE_MS = 10 * 60_000;
// A request no daemon has stamped after this long usually means the owning
// device is offline: the one failure the command rows cannot report.
export const COMMAND_UNCLAIMED_WARN_MS = 20_000;

/** A request id the server accepts (1-128 of [A-Za-z0-9_-]). */
export function newRequestId(): string {
  const uuid = (globalThis as any).crypto?.randomUUID?.();
  return uuid ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/** When the gesture began: a repair carries its restart's click. */
export function sessionCommandStartedAt(row: SessionCommandRow): number {
  return row.started_at ?? row.requested_at;
}

/** When a row that never settled stops counting as in flight. */
export function sessionCommandDeadline(row: SessionCommandRow): number {
  const budget =
    row.kind === "restart" || row.kind === "repair" ? RESTART_GIVE_UP_AFTER_MS
    : row.kind === "move" ? (row.to_remote ? MOVE_GIVE_UP_REMOTE_MS : MOVE_GIVE_UP_LOCAL_MS)
    : row.kind === "switch" ? MACHINE_SWITCH_TIMEOUT_MS
    : Infinity;
  return sessionCommandStartedAt(row) + budget;
}

export function sessionCommandTimedOut(row: SessionCommandRow, now: number): boolean {
  return now >= sessionCommandDeadline(row);
}

/** The newest gesture row matching `pred` (rows an action painted carry a kind). */
export function latestSessionCommand(
  rows: Record<string, SessionCommandRow> | SessionCommandRow[] | undefined | null,
  pred: (row: SessionCommandRow) => boolean,
): SessionCommandRow | undefined {
  let best: SessionCommandRow | undefined;
  for (const row of Array.isArray(rows) ? rows : Object.values(rows ?? {})) {
    if (!row?.kind || !pred(row)) continue;
    if (!best || sessionCommandStartedAt(row) > sessionCommandStartedAt(best)) best = row;
  }
  return best;
}

export const isRestartRow = (row: SessionCommandRow) => row.kind === "restart" || row.kind === "repair";

/** One conversation's restart/move pipeline rows since `since` (10s
 *  of client/server clock skew allowed), oldest first. */
export function conversationCommandRows(
  rows: Record<string, SessionCommandRow> | undefined | null,
  conversationId: string,
  since = 0,
): SessionCommandRow[] {
  return Object.values(rows ?? {})
    .filter((row) => row.conversation_id === conversationId && row.requested_at >= since - 10_000)
    .sort((a, b) => a.requested_at - b.requested_at);
}

/** A restart still waiting on its daemon (the inbox row's "restarting"):
 *  asked, not yet reported, not refused, not past its deadline. */
export function restartPending(row: SessionCommandRow | undefined, now: number): boolean {
  return !!row && isRestartRow(row) && !row.executed_at && !sessionCommandTimedOut(row, now);
}

/**
 * A request the server refused for good, or that no transport will ever send:
 * no daemon answers it, so settle its row as failed rather than leave it
 * spinning. A parked or transient failure stays in flight; the outbox
 * re-drives it and the echo settles it.
 */
export function recordSessionCommandDispatchError(requestId: string, error: unknown) {
  if (!isRefusedDispatchError(error)) return;
  settleSessionCommand(requestId, { error: String(error), result: DISPATCH_REFUSED });
}

/** Settle a row no daemon will report on (refused, or nothing was queued). */
export function settleSessionCommand(requestId: string, outcome: { result: string; error?: string | null }) {
  const store = useInboxStore.getState();
  const row = store.sessionCommands[requestId];
  if (row && !row.executed_at) {
    store.syncRecord("sessionCommands", requestId, { ...row, error: outcome.error ?? null, result: outcome.result, executed_at: Date.now() });
  }
}

// ── Restarts ─────────────────────────────────────────────────────────────────

/**
 * Restart a session (kill + resume ladder), or with `repair` force the rebuild
 * from history: paints the restart's row and dispatches it. Every restart
 * surface calls this, so the inbox row and the header see any of them. A
 * refusal ends the row failed; the promise still rejects for the caller.
 */
export function requestSessionRestart(conversationId: string, ghost?: Record<string, unknown>, repair = false): Promise<any> {
  const requestId = newRequestId();
  return useInboxStore.getState().restartSession(requestId, conversationId, ghost, repair).catch((error: unknown) => {
    if (!isParkedDispatchError(error)) recordSessionCommandDispatchError(requestId, error);
    throw error;
  });
}

/** The conversation's newest restart/repair row. */
export function latestRestartRow(rows: Record<string, SessionCommandRow> | undefined | null, conversationId: string | undefined) {
  return conversationId ? latestSessionCommand(rows, (r) => r.conversation_id === conversationId && isRestartRow(r)) : undefined;
}

// ── Device moves ─────────────────────────────────────────────────────────────

/** Destination of a move: a device by id + the display name to narrate with. */
export type MoveTarget = { device_id: string; is_remote: boolean; label: string };

/**
 * "Run here" / "Move to <device>": paints the move's row and dispatches it. A
 * refusal ends the row failed (and, on web, raises the dispatch-failure
 * toast); the promise is the caller's to toast on a platform without it.
 */
export function requestSessionMove(conversationId: string, target: MoveTarget): Promise<unknown> {
  // On a fork/new-session stub page the id is the client-minted session UUID
  // until the create resolves; follow the stub→real mapping when it exists.
  // The server accepts any ref, so an unmapped UUID still resolves later.
  const store = useInboxStore.getState();
  const convId = store.getConvexId(conversationId) ?? conversationId;
  const requestId = newRequestId();
  return store.moveSessionToDevice(requestId, convId, target.device_id, target.is_remote, target.label).catch((error: unknown) => {
    if (isParkedDispatchError(error)) return;
    recordSessionCommandDispatchError(requestId, error);
    throw error;
  });
}

// How long a confirmed move's green line and a failed move's retry stay up.
const MOVE_RESTORED_LINGER_MS = 5_000;
const MOVE_FAILED_LINGER_MS = 5 * 60_000;

export type DeviceMovePhase = "idle" | "restarting" | "restored" | "failed";

/**
 * Where a move stands, from its row and the conversation's pipeline rows: the
 * same phase/stage vocabulary as a restart, so the header renders both alike.
 * `resumed` is the destination's resume, stamped clean: the move landed.
 */
export function deviceMoveStatusOf(
  gesture: SessionCommandRow | undefined,
  rows: SessionCommandRow[],
  now: number,
): { phase: DeviceMovePhase; stage: { label: string; tone: "active" | "warn" | "error" } | null; failure: string | null; resumed?: SessionCommandRow } {
  const idle = { phase: "idle" as const, stage: null, failure: null };
  if (!gesture) return idle;
  const dest = gesture.to_label ?? gesture.to_device_id ?? "the other device";
  const failed = (failure: string) =>
    now < sessionCommandDeadline(gesture) + MOVE_FAILED_LINGER_MS ? { phase: "failed" as const, stage: null, failure } : idle;
  if (gesture.confirmed_at) return now - gesture.confirmed_at < MOVE_RESTORED_LINGER_MS ? { phase: "restored", stage: null, failure: null } : idle;
  if (gesture.result === DISPATCH_REFUSED) return failed(gesture.error ?? "Move failed");
  const since = conversationCommandRows(Object.fromEntries(rows.map((r) => [r._id, r])), gesture.conversation_id ?? "", gesture.requested_at);
  const last = [...since].reverse();
  const resume = last.find((c) => c.command === "resume_session");
  const mv = last.find((c) => c.command === "move_to_device");
  if (resume?.executed_at) {
    if (resume.error) return failed(`Move failed: ${resume.error}`);
    return { phase: "restarting", stage: { label: `Starting on ${dest}…`, tone: "active" }, failure: null, resumed: resume };
  }
  if (mv?.executed_at && mv.error) return failed(`Move failed: ${mv.error}`);
  if (sessionCommandTimedOut(gesture, now)) return failed("Move didn't finish — a device may be offline. Check its daemon, or try again.");
  const age = now - gesture.requested_at;
  const stage =
    mv?.executed_at
      ? { label: `Transferred — starting on ${dest}…`, tone: "active" as const }
      : !since.some((c) => c.executed_at) && age > COMMAND_UNCLAIMED_WARN_MS
        ? { label: "Waiting for the daemon to pick this up — is the source device online?", tone: "warn" as const }
        : mv
          ? { label: `Transferring session to ${dest} — this can take a few minutes…`, tone: "active" as const }
          : resume
            ? { label: `Starting on ${dest}…`, tone: "active" as const }
            : { label: `Moving session to ${dest}…`, tone: "active" as const };
  return { phase: "restarting", stage, failure: null };
}

// ── Account switches ─────────────────────────────────────────────────────────

/** A switch row still waiting: asked, not reported, not past its deadline. */
export function switchPending(row: SessionCommandRow | undefined, now: number): boolean {
  return !!row && row.kind === "switch" && !row.executed_at && !sessionCommandTimedOut(row, now);
}

/**
 * Switch a machine's account, or revive blocked sessions on one: paints the
 * switch's row and dispatches it. The row binds to the swapping machine's
 * command; a revive that queued no command at all (every session took a
 * plain continue) settles on the reply, since no daemon will report it. A
 * swap nobody queued is a failure. The reply is the caller's for its toast.
 */
export function requestAccountSwitchCommand(args: AccountSwitchArgs, intent: { profile?: string; email?: string } = {}): Promise<any> {
  const requestId = newRequestId();
  return useInboxStore.getState().requestAccountSwitch(requestId, args, { profile: intent.profile ?? args.profile, email: intent.email ?? args.email })
    .then((res: any) => {
      if (!res?.command_ids?.length) {
        if (args.profile || args.email) settleSessionCommand(requestId, { result: "no_command", error: "No daemon accepted the account switch" });
        else settleSessionCommand(requestId, { result: "continued" });
      }
      return res;
    }, (error: unknown) => {
      if (!isParkedDispatchError(error)) recordSessionCommandDispatchError(requestId, error);
      throw error;
    });
}
