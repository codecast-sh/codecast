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
//   Tier 1  BLOCKED, and the agent is alive and parked on you.
//           Nothing else is being produced by that session until you answer.
//           Your answer buys back idle machine time, so it is worth the most.
//   Tier 2  BLOCKED, but the session has gone unresponsive/dead.
//           Still real work, but answering does not immediately restart
//           anything — someone has to revive it first.
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
import type { InboxSession, SessionDecisionItem } from "../store/inboxStore";
import { isAgentActive } from "../store/inboxStore";

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
  decisionId?: string;
  // AskUserQuestion answers ride poll keys; a confirmation dialog maps its
  // two options to Enter/Escape rather than 1/2.
  toolUseId?: string;
  isConfirmation?: boolean;
};

// Tier 1 = live and blocked, 2 = blocked but the session is not running,
// 3 = advisory. Lower sorts first.
export function queueTier(item: QueueItem): 1 | 2 | 3 {
  if (!item.blocking) return 3;
  const s = item.session;
  const live = !!s && isAgentActive(s) && !s.is_unresponsive;
  return live ? 1 : 2;
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
      decisionId: d._id,
    });
  }
  return out;
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
export function sessionHasOpenQuestion(s: InboxSession): boolean {
  if (s.inbox_killed_at) return false;
  return !!s.awaiting_input || s.agent_status === "permission_blocked";
}
