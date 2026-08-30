// The decision queue's model: what counts as a question, and what order the
// human answers them in.
//
// Two sources feed ONE queue:
//   1. `cast decide` rows (session_decisions) — an agent wrote a real payload:
//      question, options, context, sometimes a published HTML report.
//   2. Claude Code's own AskUserQuestion / permission prompts — no authored
//      payload, so the card renders what we have (the last assistant message
//      and the session's pinned thread state) instead.
//
// RANKING — the failure mode that kills this feature is mis-ordering, because
// the queue's order silently becomes the founder's priorities. The rule:
//
//   Tier 1  BLOCKED, and the session is still reachable — parked on you and
//           able to receive the answer. Nothing else is being produced by that
//           session until you answer, so your answer buys back idle machine
//           time immediately. Worth the most.
//   Tier 2  BLOCKED, but the session is unresponsive or stopped. Still real
//           work, but answering does not restart anything by itself — someone
//           has to revive the session first.
//   Tier 3  ADVISORY (`cast decide --advisory`). The agent declared a default
//           and kept working. Your answer can still redirect it, so it is
//           worth reading, but it is never urgent.
//
// WITHIN a tier: OLDEST FIRST. Deliberately not newest-first, and not any
// cleverness about "importance". Two reasons. First, an agent parked on a
// question is idle, so the cost of a pending decision grows with its age —
// oldest-first minimizes total fleet idle time, and it is the same argument
// that makes FIFO right for a work queue. Second, a queue that reorders
// itself while you are in it is unusable: newest-first means a decision you
// are about to answer gets pushed down by an unrelated agent, and no
// prioritization heuristic survives the founder disagreeing with it once.
// Age is the one signal that is monotone, legible, and never surprises you.
//
// What is deliberately NOT in the ranking: any per-session or per-project
// weighting, any model-guessed urgency score, and any "this looks important"
// text heuristic. Those all fail the same way — the moment the ranking is
// wrong once, the founder stops trusting the order, and an untrusted queue is
// worse than a list, because a list at least admits it is unsorted.
import { BLOCKED_BANNER_KINDS } from "@codecast/shared/contracts";
import { nestParentIdOf } from "@codecast/convex/convex/ccAccountsShared";
import type { InboxSession, SessionDecisionItem } from "../store/inboxStore";

export type QueueItemSource = "decide" | "ask" | "permission";

export type QueueItem = {
  key: string;
  source: QueueItemSource;
  conversationId: string;
  session?: InboxSession;
  question: string;
  // Authored payload (source "decide") — otherwise recovered context.
  contextMd?: string;
  options: Array<{ label: string; description?: string }>;
  reportSlug?: string;
  blocking: boolean;
  defaultOption?: number;
  createdAt: number;
  // conversation.message_count at ask time (source "decide") — with the live
  // session row's count, "messages since the ask".
  askedMessageCount?: number;
  decisionId?: string;
  // AskUserQuestion answers ride poll keys; a confirmation dialog maps its
  // two options to Enter/Escape rather than 1/2.
  toolUseId?: string;
  isConfirmation?: boolean;
};

// "Reachable" is deliberately NOT isAgentActive. An agent parked on a question
// is by definition not producing tokens — its status is permission_blocked or
// idle — so the busy-set would rank every genuinely blocked agent as dead,
// which is exactly backwards. What matters here is whether an answer would
// LAND: the session is still alive and someone is listening.
function isReachable(s: InboxSession | undefined): boolean {
  if (!s) return false;
  // Torn down: whatever live-looking fields the row still carries are no longer
  // believable, so an answer has nothing to land in. A `cast decide` row on a
  // killed session reaches here — sessionHasOpenQuestion already drops the
  // AskUserQuestion side.
  if (s.inbox_killed_at) return false;
  if (s.is_unresponsive) return false;
  if (s.agent_status === "stopped") return false;
  return true;
}

// Tier 1 = blocked and the session can still receive the answer, 2 = blocked
// but the session is dead or unresponsive, 3 = advisory. Lower sorts first.
export function queueTier(item: QueueItem): 1 | 2 | 3 {
  if (!item.blocking) return 3;
  return isReachable(item.session) ? 1 : 2;
}

// Keyboard routing for the decision card. Pure so the claim/stand-down rules
// are testable: the card's listener runs on window in CAPTURE phase (it must
// beat the global shortcut layer), which means every key in the app passes
// through it first — the rules about which keys it may claim are the actual
// safety surface. A non-null action means the card claims the key
// (preventDefault + stopPropagation); null means the key was never ours.
export type QueueKeyAction =
  | { kind: "commit-free-text" }
  | { kind: "close-free-text" }
  | { kind: "answer"; option: number }
  | { kind: "open-session" }
  | { kind: "skip" }
  | { kind: "dismiss" }
  | { kind: "open-free-text" }
  | { kind: "peek" }
  | { kind: "full" }
  | { kind: "restore-question" }
  | { kind: "exit-queue" };

export function routeQueueKey(
  e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  ctx: {
    /** An aria-modal layer (new-session compose, settings) sits above the queue. */
    modalOpen: boolean;
    /** Focus is in an input/textarea/contenteditable. */
    editing: boolean;
    /** …specifically the card's own free-text "Other" box. */
    inOwnFreeTextBox: boolean;
    isPermissionCard: boolean;
    optionCount: number;
    sheet: "full" | "peek";
  }
): QueueKeyAction | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  // A modal owns the keyboard entirely; the queue behind it must not answer,
  // skip, or swallow anything (a capture listener eating the compose dialog's
  // Enter is exactly how "enter stopped working" presents).
  if (ctx.modalOpen) return null;
  if (ctx.editing) {
    // Only the card's own box is the queue's to claim. Typing in any other
    // input — search, a composer in the thread behind — belongs to that surface.
    if (!ctx.inOwnFreeTextBox) return null;
    if (e.key === "Escape") return { kind: "close-free-text" };
    if (e.key === "Enter" && !e.shiftKey) return { kind: "commit-free-text" };
    return null;
  }
  // Digits answer a QUESTION. A permission card is never answerable this way:
  // it carries no options, and the whole hazard of putting approvals in a
  // queue that advances on a keystroke is that the digit meant for the
  // previous card lands on "approve this command". y/n (PermissionStack's own
  // binding) is the only way in, and it requires reading the card.
  if (!ctx.isPermissionCard && e.key >= "1" && e.key <= "9") {
    const n = Number(e.key) - 1;
    return n < ctx.optionCount ? { kind: "answer", option: n } : null;
  }
  if (e.key === "o" || e.key === "O") return { kind: "open-session" };
  if (e.key === "s" || e.key === "S") return { kind: "skip" };
  // Dismiss = "I am not going to answer this": the card leaves the queue for
  // good (a `cast decide` row resolves as dismissed), the session is not told.
  if (e.key === "x" || e.key === "X") return { kind: "dismiss" };
  if (e.key === "t" || e.key === "T") return { kind: "open-free-text" };
  // Up moves into the thread, down brings the question back. Escape leaves the
  // queue from full, but from peek it first restores the question — otherwise
  // the key that means "back" would skip a step.
  if (e.key === "ArrowUp" || e.key === "k") return { kind: "peek" };
  if (e.key === "ArrowDown" || e.key === "j") return { kind: "full" };
  if (e.key === "Escape") return ctx.sheet === "peek" ? { kind: "restore-question" } : { kind: "exit-queue" };
  return null;
}

export type TranscriptMessageLite = {
  _id: string;
  content?: string;
  timestamp?: number;
  tool_calls?: Array<{ id?: string; name: string; input: string }>;
  tool_results?: Array<{ tool_use_id?: string; content: string }>;
};

/**
 * The transcript message where the ask happened. The `cast decide` run prints
 * the decision id (`id: …`) into its tool result, so the FIRST message
 * carrying the id — in a tool result, a tool call's argv, or plain content —
 * locates the ask; later `cast decide edit <id>` runs repeat it, hence first
 * match wins. A hit inside a tool RESULT resolves to the message carrying the
 * matching tool CALL: the result rides a content-less carrier row that renders
 * folded into the call's row, so only the call's message is scrollable. A
 * message whose result hasn't synced yet still matches on the Bash command
 * plus the question; Bash-only, because an Edit call's file content can quote
 * both strings without being the ask (it happened).
 */
export function findDecisionAnchorMessage(
  messages: readonly TranscriptMessageLite[] | undefined,
  decisionId: string | undefined,
  question: string,
): TranscriptMessageLite | null {
  if (!messages) return null;
  const callMessageFor = (toolUseId: string | undefined) =>
    toolUseId ? messages.find((m) => m.tool_calls?.some((tc) => tc.id === toolUseId)) : undefined;
  if (decisionId) {
    for (const m of messages) {
      if (m.content?.includes(decisionId)) return m;
      if (m.tool_calls?.some((tc) => tc.input?.includes(decisionId))) return m;
      const hit = m.tool_results?.find((r) => r.content?.includes(decisionId));
      if (hit) return callMessageFor(hit.tool_use_id) ?? m;
    }
  }
  if (question) {
    for (const m of messages) {
      if (m.tool_calls?.some((tc) => tc.name === "Bash" && tc.input?.includes("cast decide") && tc.input?.includes(question))) return m;
    }
  }
  return null;
}

/**
 * How far the session has run past the ask, in messages. The server snapshot
 * delta (asked_message_count vs the live session row) is right even when the
 * client never loaded that far back; the loaded-window scan covers rows from
 * before the snapshot existed.
 */
export function messagesSinceAsk(
  item: Pick<QueueItem, "createdAt" | "askedMessageCount">,
  session: Pick<InboxSession, "message_count"> | undefined,
  messages: readonly TranscriptMessageLite[] | undefined,
): number {
  if (item.askedMessageCount !== undefined && session?.message_count !== undefined) {
    return Math.max(0, session.message_count - item.askedMessageCount);
  }
  let n = 0;
  for (const m of messages ?? []) if ((m.timestamp ?? 0) > item.createdAt) n++;
  return n;
}

export function sortQueue(items: QueueItem[]): QueueItem[] {
  return [...items].sort((a, b) => {
    const t = queueTier(a) - queueTier(b);
    if (t !== 0) return t;
    return a.createdAt - b.createdAt;
  });
}

/** `cast decide` rows still awaiting an answer, newest-authored payload wins. */
export function decisionQueueItems(
  decisions: Record<string, SessionDecisionItem>,
  sessions: Record<string, InboxSession>
): QueueItem[] {
  const out: QueueItem[] = [];
  for (const d of Object.values(decisions)) {
    if (d.status !== "pending") continue;
    out.push({
      key: `decide:${d._id}`,
      source: "decide",
      conversationId: d.conversation_id,
      session: sessions[d.conversation_id],
      question: d.question,
      contextMd: d.context_md,
      options: d.options,
      reportSlug: d.report_slug,
      blocking: d.blocking,
      defaultOption: d.default_option,
      createdAt: d.created_at,
      askedMessageCount: d.asked_message_count,
      decisionId: d._id,
    });
  }
  return out;
}

/**
 * Local marks that a session's open question was handled HERE — answered,
 * dismissed, or evicted (an infra dialog, a permission resolved elsewhere).
 * The server's `awaiting_input` / permission_blocked truth takes a round-trip
 * to flip, and every question surface (the queue, the rail's QUESTIONS
 * section, the nav order, the badge) must drop the card in the same render
 * the user acted in — so they all consult this map through the ONE predicate
 * below, and none can disagree with another.
 *
 * `message_count` is the expiry: the entry covers the ask as it stood when
 * the user acted. Answering sends one message (the answer itself must not
 * expire its own mark — hence the +sends slack recorded by the store action);
 * anything the AGENT says after that means the world moved — either the ask
 * resolved server-side too, or there is a genuinely new ask that deserves to
 * surface. Either way the mark expires and server truth takes over.
 */
export type QuestionResolutions = Record<string, { at: number; message_count: number }>;

export function questionResolvedLocally(
  s: Pick<InboxSession, "_id" | "message_count">,
  resolutions: QuestionResolutions | undefined,
): boolean {
  const r = resolutions?.[s._id];
  if (!r) return false;
  return (s.message_count ?? 0) <= r.message_count;
}

/**
 * Sessions carrying an unanswered AskUserQuestion or permission prompt, with
 * no authored payload. The caller supplies the parsed question; this only
 * decides WHICH sessions qualify, so the same predicate drives the inbox
 * Questions section and the queue.
 *
 * `awaiting_input` is the server's "newest message is an open AUQ tool_use"
 * flag, and it is only set when the row was not already idle — so a poll left
 * open long enough to settle reports false. Union it with the
 * permission_blocked status, which is what the AUQ-as-permission-row path
 * sets and which survives the idle transition.
 */
export function sessionHasOpenQuestion(
  s: InboxSession,
  resolutions?: QuestionResolutions,
): boolean {
  if (s.inbox_killed_at) return false;
  // An infrastructure park is not a decision. A session sitting on a usage
  // limit, an expired login, a dropped connection or a dead API request is
  // blocked on plumbing, not on a judgment call — the inbox already badges
  // those and offers continue-all/switch-account, and routing them here would
  // bury the real questions under noise the queue cannot resolve anyway.
  // BLOCKED_BANNER_KINDS is the same set that drives those badges, so the two
  // surfaces can never disagree about what counts as parked.
  if (s.pending_api_error_kind && BLOCKED_BANNER_KINDS.has(s.pending_api_error_kind)) return false;
  if (questionResolvedLocally(s, resolutions)) return false;
  return !!s.awaiting_input || s.agent_status === "permission_blocked";
}

/** Conversation ids with a pending `cast decide` row. */
export function pendingDecisionConvIds(decisions: Record<string, SessionDecisionItem>): Set<string> {
  const ids = new Set<string>();
  for (const d of Object.values(decisions)) if (d.status === "pending") ids.add(d.conversation_id);
  return ids;
}

/**
 * The inbox rail's QUESTIONS section — ONE rule for what it holds, shared by
 * the render (GlobalSessionPanel) and the keyboard order (visualOrderSessions),
 * so Ctrl+J/K walks exactly what is on screen.
 *
 * A session that has asked you something files under Questions whatever its
 * pin or rest verdict: a pending `cast decide` row, or an open AskUserQuestion
 * / permission prompt (sessionHasOpenQuestion). The ask outranks placement —
 * "who acts next" is you, explicitly — so every row lifted here must leave the
 * section it would otherwise sit in (callers filter with `isQuestion`).
 *
 * `sections` are the rail's rows as scoped for display (mine/team, workspace,
 * the old-session window, chip filter). The decision queue is user-scoped and
 * workspace-blind, so a question on a session that scope hides is still your
 * question: `mine` (the viewer's own sessions, unscoped) supplies those rows,
 * which keeps the section's count equal to the queue badge. Killed rows are
 * the exception — they render in the hidden Killed bucket, and a question on
 * a dead session is the queue's tier-2 case, not a rail row.
 *
 * Nested subagents ride their parent and are never lifted loose — a question
 * on one lifts the PARENT instead, whose card renders the asking child row.
 * Without this a permission prompt on a subagent of a settled parent sits
 * buried in Done while the queue badge counts it.
 */
export function liftQuestions(
  sections: InboxSession[][],
  decisions: Record<string, SessionDecisionItem>,
  mine: Record<string, InboxSession>,
  resolutions?: QuestionResolutions,
): { questions: InboxSession[]; isQuestion: (s: InboxSession) => boolean } {
  const pending = pendingDecisionConvIds(decisions);
  const asks = (s: InboxSession) => pending.has(s._id) || sessionHasOpenQuestion(s, resolutions);
  const askingChildParents = new Set<string>();
  for (const s of Object.values(mine)) {
    if (s.inbox_killed_at) continue;
    const parent = nestParentIdOf(s);
    if (!parent || !asks(s)) continue;
    // A nested child's ask bits are only truthful while the feed maintains the
    // row, and the feed stops emitting children the moment their parent is
    // stashed or dismissed (never for a killed one) — the liveness overlay
    // skips subagent rows entirely. A locally-held child past that point is a
    // frozen snapshot that can claim permission_blocked forever, which lifted
    // its parent into QUESTIONS as a phantom card with no answerable question
    // behind it. Only lift parents the feed still stands behind.
    const parentRow = mine[parent];
    if (!parentRow || parentRow.inbox_stashed_at || parentRow.inbox_dismissed_at || parentRow.inbox_killed_at) continue;
    askingChildParents.add(parent);
  }
  const isQuestion = (s: InboxSession) => asks(s) || askingChildParents.has(s._id);
  const questions: InboxSession[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const s of section) {
      if (seen.has(s._id) || !isQuestion(s)) continue;
      seen.add(s._id);
      questions.push(s);
    }
  }
  for (const s of Object.values(mine)) {
    if (seen.has(s._id) || !isQuestion(s)) continue;
    if (s.inbox_killed_at || s.inbox_dismissed_at) continue;
    if (nestParentIdOf(s)) continue;
    seen.add(s._id);
    questions.push(s);
  }
  return { questions, isQuestion };
}
