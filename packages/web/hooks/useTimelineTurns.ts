import { useMemo } from "react";
import { isHiddenSystemNotice } from "../lib/conversationProcessor";
import { isRecoveryContinueClientId } from "@codecast/shared/contracts";
import { foldNudgeRuns, nudgeLabel, type NudgeRow } from "../components/sessionMessage";
import { FOLD_KEPT_USER_KINDS, isHiddenStubMessage, stripSystemTags } from "../components/conversation/classify";
import type { Message, TimelineItem } from "../components/conversation/types";
import { classifyUserRows, pairCommandExpansions } from "../lib/userRowKinds";
import { buildCleanThread } from "../lib/cleanThread";
import { buildTurnAggregates } from "../lib/turnAggregates";
import type { ConversationData } from "../components/conversation/types";

export { foldMachineMove } from "../lib/userRowKinds";
export { sentToRef } from "../lib/turnAggregates";

export function useTimelineTurns({ messages, conversation, hasMoreAbove, timeline, messageAuthors, hasMoreBelow, foldWorkingTurns }: {
  messages: Message[];
  conversation: ConversationData | null | undefined;
  hasMoreAbove: boolean | undefined;
  timeline: TimelineItem[];
  messageAuthors: Map<string, string | undefined>;
  hasMoreBelow: boolean | undefined;
  foldWorkingTurns: boolean;
}) {
  const userMsgKindMap = useMemo(
    () => classifyUserRows(timeline, messages, { agentType: conversation?.agent_type, parentConversationId: conversation?.parent_conversation_id, hasMoreAbove }),
    [timeline, messages, conversation?.agent_type, conversation?.parent_conversation_id, hasMoreAbove],
  );

  // Aggregation for the condensed/compact feeds. Built once per timeline; O(n).
  //
  // A "turn" is one assistant response. Its boundary is a REAL user prompt — NOT
  // every user-role message: in agentic transcripts assistant messages are
  // separated by user-role tool-result carriers, so resetting on those would
  // split one turn into one-per-message (the stacked-cards bug). We reset only on
  // the user-message kinds that actually start a new exchange.
  //
  // CONDENSED works at SEGMENT granularity: a contiguous run of tool activity
  // between two pieces of assistant text folds into ONE receipt rendered inline
  // where it happened. The run's tools attach to its "owner" (the text message
  // that opens the run, or the first tool-only message); the rest are "absorbed".
  // A receipt keeps one entry per source message (owner first) so an opened
  // group can render each tool under its real message identity — results,
  // comments and share selection stay attributed to the message that ran it.
  //
  // COMPACT works at TURN granularity (one collapsed card per assistant run), so
  // we also track each message's turn key, first/last message, and stats.
  const turnAggregates = useMemo(
    () => buildTurnAggregates({ timeline, messages, userKindOf: (id) => userMsgKindMap.get(id)?.kind, messageAuthors, hasMoreBelow }),
    [timeline, messages, userMsgKindMap, messageAuthors, hasMoreBelow],
  );

  // Fold mode's agent rows: what it said, and the cards waiting on the person.
  const cleanThread = useMemo(() => foldWorkingTurns
    ? buildCleanThread({ timeline, userKindOf: (id) => userMsgKindMap.get(id)?.kind, resultOf: (id) => turnAggregates.setupResults.get(id) })
    : null, [foldWorkingTurns, timeline, userMsgKindMap, turnAggregates]);

  const commandExpansionMap = useMemo(() => pairCommandExpansions(timeline, userMsgKindMap), [timeline, userMsgKindMap]);

  // Bare nudges ("continue") render as one compact line, and a run of the same
  // nudge folds into its first row with a count. Rows that render nothing sit
  // between two nudges without breaking the run. A nudge still pending or
  // queued keeps the full bubble, so its delivery state stays visible.
  const nudgeRuns = useMemo(() => {
    const HIDDEN_USER_KINDS = new Set(['tool_results_only', 'compaction_prompt', 'noise', 'empty', 'poll_response', 'task_prompt']);
    const rows: NudgeRow[] = timeline.map((item) => {
      if (item.type !== 'message') return { id: String(item.data._id), nudge: null };
      const msg = item.data as Message;
      if (msg.role === 'system') return { id: msg._id, nudge: null, invisible: isHiddenSystemNotice(msg.content, msg.subtype) };
      if (msg.role === 'user') {
        const kind = userMsgKindMap.get(msg._id)?.kind ?? 'normal';
        // A recovery's continue renders as its own line and never folds with the person's.
        const isNudge = kind === 'normal' && !msg._isOptimistic && !msg._isQueued && !msg.images?.length && !isRecoveryContinueClientId(msg.client_id);
        return {
          id: msg._id,
          nudge: isNudge ? nudgeLabel(msg.content) : null,
          invisible: HIDDEN_USER_KINDS.has(kind) || commandExpansionMap.consumed.has(msg._id) || (foldWorkingTurns && !FOLD_KEPT_USER_KINDS.has(kind)),
        };
      }
      const empty = !msg.content?.trim() && !msg.tool_calls?.length && !msg.images?.length && !msg.thinking?.trim();
      return { id: msg._id, nudge: null, invisible: empty || isHiddenStubMessage(msg) };
    });
    return foldNudgeRuns(rows);
  }, [timeline, userMsgKindMap, commandExpansionMap, foldWorkingTurns]);

  const isWaitingForResponse = useMemo(() => {
    if (!conversation || conversation.status !== "active" || timeline.length === 0 || hasMoreBelow) return false;
    const last = timeline[timeline.length - 1];
    if (last.type !== 'message') return false;
    const msg = last.data as Message;
    if (msg.role !== 'user') return false;
    const kind = userMsgKindMap.get(msg._id);
    if (kind?.kind === 'interrupt') return false;
    return true;
  }, [conversation, timeline, hasMoreBelow, userMsgKindMap]);

  const isThinking = useMemo(() => {
    if (!conversation || conversation.status !== "active" || timeline.length === 0 || hasMoreBelow) return false;
    const last = timeline[timeline.length - 1];
    if (last.type !== 'message') return false;
    const msg = last.data as Message;
    if (msg.role !== 'assistant') return false;
    const hasThinkingContent = msg.thinking && msg.thinking.trim().length > 0;
    const hasVisibleContent = (msg.content && stripSystemTags(msg.content).trim().length > 0) || (msg.tool_calls && msg.tool_calls.length > 0);
    return !!(hasThinkingContent && !hasVisibleContent);
  }, [conversation, timeline, hasMoreBelow]);

  return { userMsgKindMap, turnAggregates, cleanRows: cleanThread?.rows ?? null, awaitingReplyTo: cleanThread?.awaitingReplyTo ?? null, commandExpansionMap, nudgeRuns, isThinking, isWaitingForResponse };
}
