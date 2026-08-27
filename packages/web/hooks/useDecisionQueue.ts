import { createContext, useMemo } from "react";
import { useTrackedStore, sessionsWakeSig, filterInboxScope } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import {
  decisionQueueItems,
  sessionHasOpenQuestion,
  sortQueue,
  type QueueItem,
} from "../lib/decisionQueue";
import { SYNTHETIC_POLL_OPTION, type PollQuestion } from "../lib/pollPayload";

// Structural signature for the decision collection: everything the queue
// branches on, nothing that churns. Rows only change on ask/answer, so this
// is cheap, but it keeps the queue from re-rendering on unrelated store work.
const decisionsWakeSig = makeCollectionSig<any>(
  (d) => `${d._id}:${d.status}:${d.created_at}:${d.updated_at ?? 0}:${d.options?.length ?? 0}`
);

// listMessages pages newest-first; every other caller works oldest-first.
// Normalize once here so "the last X" means the same thing in both worlds.
function chronological(messages: any[]): any[] {
  return [...messages].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

/** The last AskUserQuestion tool_use in a conversation that has no result yet. */
export function openQuestionFromMessages(raw: any[] | undefined): {
  question: PollQuestion;
  toolUseId: string;
  createdAt: number;
} | null {
  if (!raw?.length) return null;
  const messages = chronological(raw);
  const resultIds = new Set<string>();
  for (const m of messages) {
    for (const r of m.tool_results ?? []) if (r.tool_use_id) resultIds.add(r.tool_use_id);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    for (const tc of m.tool_calls ?? []) {
      if (tc.name !== "AskUserQuestion") continue;
      if (resultIds.has(tc.id)) continue;
      let parsed: any = {};
      try { parsed = JSON.parse(tc.input); } catch { continue; }
      const q = parsed?.questions?.[0];
      if (!q?.question || !Array.isArray(q.options)) continue;
      return { question: q as PollQuestion, toolUseId: tc.id, createdAt: m.timestamp ?? 0 };
    }
  }
  return null;
}

/** The most recent assistant prose — context for a poll with no authored payload. */
export function lastAssistantText(raw: any[] | undefined): string | undefined {
  if (!raw?.length) return undefined;
  const messages = chronological(raw);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = (m.content ?? "").trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * The unified queue: authored `cast decide` rows plus sessions parked on a
 * Claude Code poll or permission prompt. Ordering comes from sortQueue —
 * see lib/decisionQueue.ts for the ranking rule and why it is this one.
 *
 * Poll cards carry no options here: the question payload lives in the
 * conversation's messages, which the queue view loads only for the card it is
 * showing (one at a time, so one extra subscription, not N).
 */
// "Blocked since" for a poll-sourced card.
//
// The obvious field, `updated_at`, is WRONG here: liveness heartbeats move it,
// so a card's age — and therefore its rank — would drift on every tick, and
// the queue would quietly reshuffle under the reader. That defeats the whole
// reason the ranking sorts by age (see lib/decisionQueue).
//
// The honest value is the server's `agent_status_updated_at` (when the session
// entered permission_blocked), but listInboxSessions does not carry it to the
// web today. Until it does, we stamp the first moment THIS client saw the
// session blocked. That is monotone and never churns; it resets on reload,
// which reorders equal-tier cards once rather than continuously.
const blockedSince = new Map<string, number>();

function blockedSinceFor(conversationId: string, updatedAt: number | undefined): number {
  const seen = blockedSince.get(conversationId);
  if (seen !== undefined) return seen;
  // First sighting: trust the row's own timestamp if it is in the past, so a
  // session already blocked before this tab opened does not sort as brand new.
  const stamp = Math.min(updatedAt ?? Date.now(), Date.now());
  blockedSince.set(conversationId, stamp);
  return stamp;
}

/** Drop the stamp when a session stops asking, so a later ask is timed fresh. */
function forgetBlocked(conversationId: string): void {
  blockedSince.delete(conversationId);
}

export function useDecisionQueue(): QueueItem[] {
  const s = useTrackedStore([
    (st: any) => decisionsWakeSig(st.sessionDecisions),
    (st: any) => sessionsWakeSig(st.sessions),
    (st: any) => st.questionResolutions,
    (st: any) => st.currentUser?._id,
  ]);

  return useMemo(() => {
    const meId = s.currentUser?._id;
    const mine = filterInboxScope(s.sessions, "mine", meId);
    const items = decisionQueueItems(s.sessionDecisions, s.sessions);

    // A session that has an authored decision open is already represented;
    // its AUQ row would be the same interruption counted twice.
    const authored = new Set(items.map((i) => i.conversationId));

    for (const row of Object.values(mine) as any[]) {
      if (authored.has(row._id)) continue;
      // questionResolutions: answered/dismissed HERE — same predicate the rail
      // section renders with, so the queue and the rail agree in every render.
      if (!sessionHasOpenQuestion(row, s.questionResolutions)) {
        // No longer asking — forget the stamp so a future question is timed
        // from when it actually appeared, not from this tab's first boot.
        forgetBlocked(row._id);
        continue;
      }
      items.push({
        key: `ask:${row._id}`,
        source: row.awaiting_input ? "ask" : "permission",
        conversationId: row._id,
        session: row,
        // Filled in by the card once the conversation's messages load.
        question: row.title || "Waiting on you",
        options: [],
        blocking: true,
        createdAt: blockedSinceFor(row._id, row.updated_at),
      });
    }
    return sortQueue(items);
  }, [s.sessionDecisions, s.sessions, s.questionResolutions, s.currentUser?._id]);
}

/** Options minus Claude Code's synthetic affordance rows, keeping true indices. */
export function visibleOptions(q: PollQuestion): Array<{ label: string; description?: string; index: number }> {
  return q.options
    .map((o, index) => ({ label: o.label, description: o.description, index }))
    .filter((o) => !SYNTHETIC_POLL_OPTION.test(o.label.trim()));
}

// The queue (/questions) renders the real conversation pane and only adds a
// stepper through this context: position, advance, skip, leave. Lives here —
// not in SessionDecisionCard — so the component module exports only
// components (Fast Refresh boundary).
export type DecisionStepper = {
  position: number;
  total: number;
  onDone: () => void;
  onSkip: () => void;
  onExit?: () => void;
  // A Claude Code poll / permission prompt has no authored row in the store;
  // the queue hands the card its model this way.
  item?: QueueItem;
};

export const DecisionStepperContext = createContext<DecisionStepper | null>(null);

// The oldest pending `cast decide` row for a conversation, as a queue item.
// Signature-gated: rows change only on ask/answer.
export function usePendingDecisionItem(conversationId: string | null | undefined): QueueItem | null {
  const s = useTrackedStore([
    (st: any) => {
      if (!conversationId) return "";
      let sig = "";
      for (const d of Object.values(st.sessionDecisions) as any[]) {
        if (d.conversation_id === conversationId && d.status === "pending") sig += `${d._id}:${d.created_at}:${d.updated_at ?? 0}|`;
      }
      return sig;
    },
    (st: any) => {
      const row = conversationId ? st.sessions[conversationId] : undefined;
      return row ? `${row.title}|${row.project_path}|${row.is_idle}|${row.agent_status}|${row.is_unresponsive}|${row.inbox_killed_at}` : "";
    },
  ]);
  return useMemo(() => {
    if (!conversationId) return null;
    const mine: Record<string, any> = {};
    for (const d of Object.values(s.sessionDecisions) as any[]) {
      if (d.conversation_id === conversationId) mine[d._id] = d;
    }
    // A blocking ask parks the session, so it outranks an advisory one that
    // happened to be posted earlier; otherwise oldest first, as in the queue.
    const items = decisionQueueItems(mine, s.sessions).sort(
      (a, b) => Number(b.blocking) - Number(a.blocking) || a.createdAt - b.createdAt
    );
    return items[0] ?? null;
  }, [conversationId, s.sessionDecisions, s.sessions]);
}
