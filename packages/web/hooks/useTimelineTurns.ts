import { useMemo, useCallback } from "react";
import { isCommandMessage, isHiddenSystemNotice, initialSubagentPromptId } from "../lib/conversationProcessor";
import { isModelSwitchStdout } from "@codecast/shared/contracts";
import { sentToRef } from "../components/roleWake";
import { isToolResultCarrier, foldNudgeRuns, nudgeLabel, type NudgeRow } from "../components/sessionMessage";
import { sameMessageAuthor } from "../lib/messageAuthors";
import { FOLD_KEPT_USER_KINDS, classifyUserMessage, isAlwaysVisibleToolCall, isHiddenStubMessage, parseCastCommand, stripSystemTags } from "../components/conversation/classify";
import type { Message, ReceiptEntry, TimelineItem, UserMessageKind } from "../components/conversation/types";
import type { ConversationData } from "../components/conversation/types";

export function useTimelineTurns({ messages, conversation, hasMoreAbove, timeline, messageAuthors, hasMoreBelow, foldWorkingTurns }: {
  messages: Message[];
  conversation: ConversationData | null | undefined;
  hasMoreAbove: boolean | undefined;
  timeline: TimelineItem[];
  messageAuthors: Map<string, string | undefined>;
  hasMoreBelow: boolean | undefined;
  foldWorkingTurns: boolean;
}) {
  const userMsgKindMap = useMemo(() => {
    const map = new Map<string, UserMessageKind>();
    const initialPromptId = initialSubagentPromptId(messages, conversation?.parent_conversation_id, hasMoreAbove);
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      let immediatePrev: Message | null = null;
      for (let j = i - 1; j >= 0; j--) {
        if (timeline[j].type === 'message') { immediatePrev = timeline[j].data as Message; break; }
      }
      let contextPrev: Message | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const p = timeline[j];
        if (p.type !== 'message') continue;
        const pm = p.data as Message;
        if (isToolResultCarrier(pm)) continue;
        if (pm.role === 'user' && pm.content && isCommandMessage(pm.content)) continue;
        contextPrev = pm;
        break;
      }
      const kind = classifyUserMessage(msg, conversation?.agent_type, immediatePrev, contextPrev);
      map.set(msg._id, msg._id === initialPromptId && kind.kind === "normal"
        ? { kind: "session_message", from: conversation!.parent_conversation_id!.slice(0, 7), body: msg.content || "" }
        : kind);
    }
    return map;
  }, [timeline, messages, conversation?.agent_type, conversation?.parent_conversation_id, hasMoreAbove]);

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
  const turnAggregates = useMemo(() => {
    const TURN_BOUNDARY_KINDS = new Set(['normal', 'direct_user', 'command', 'plan', 'session_handoff', 'session_message', 'chat_wake', 'role_wake', 'agent_switch', 'machine_move']);
    const turnKeyOf = new Map<string, string>();      // msgId -> turn key
    const firstAssistOf = new Map<string, string>();  // turn key -> first assistant msgId
    const lastTextOf = new Map<string, string>();     // turn key -> last text-bearing msgId
    const statsOf = new Map<string, { messages: number; tools: number; preview: string }>();
    const receiptOf = new Map<string, ReceiptEntry[]>(); // owner msgId -> folded hideable tools, per source message
    const absorbed = new Set<string>();                // msgId folded into an earlier receipt
    // Where a turn's message went (roleWake.ts, scopes-and-feed.md F4.2), keyed
    // by the boundary user message that opened the turn: when the next turn
    // began (so a wake card claims only the hands started inside its window),
    // and the sessions the agent ran `cast send` to. A window that runs off
    // the loaded page closes at the page's last message, never at "forever".
    const routingOf = new Map<string, { until: number | null; sentTo: string[] }>();
    let curBoundary: string | null = null;
    let lastLoadedAt = 0;
    let curKey: string | null = null;
    let ownerId: string | null = null;                 // current segment's receipt owner
    let previousAssistant: Message | null = null;
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.timestamp > lastLoadedAt) lastLoadedAt = msg.timestamp;
      if (msg.role === 'user') {
        // Only a genuine new prompt ends the current turn; tool-result carriers,
        // interrupts, notifications, etc. are part of the ongoing response.
        if (TURN_BOUNDARY_KINDS.has(userMsgKindMap.get(msg._id)?.kind ?? 'normal')) {
          curKey = null;
          ownerId = null;
          if (curBoundary) routingOf.get(curBoundary)!.until = msg.timestamp;
          curBoundary = msg._id;
          routingOf.set(msg._id, { until: null, sentTo: [] });
        }
        continue;
      }
      if (msg.role !== 'assistant') continue;
      if (isHiddenStubMessage(msg)) continue;
      const hasText = !!(msg.content && stripSystemTags(msg.content).trim().length > 0);
      const tools = msg.tool_calls ?? [];
      if (curBoundary) {
        const routing = routingOf.get(curBoundary)!;
        for (const tc of tools) {
          const ref = sentToRef(parseCastCommand(tc));
          if (ref && !routing.sentTo.includes(ref)) routing.sentTo.push(ref);
        }
      }
      const hasVisible = hasText || tools.length > 0 || (!!msg.images?.length);
      if (!hasVisible) continue;
      if (previousAssistant && !sameMessageAuthor(previousAssistant, msg, messageAuthors)) {
        curKey = null;
        ownerId = null;
      }
      previousAssistant = msg;
      if (curKey === null) {
        curKey = msg._id;
        firstAssistOf.set(curKey, msg._id);
        statsOf.set(curKey, { messages: 0, tools: 0, preview: "" });
      }
      turnKeyOf.set(msg._id, curKey);
      const stats = statsOf.get(curKey)!;
      if (hasText) { stats.messages += 1; lastTextOf.set(curKey, msg._id); }
      stats.tools += tools.length;
      if (!stats.preview && hasText) {
        stats.preview = stripSystemTags(msg.content || "").trim().split("\n")[0].slice(0, 140);
      }
      const hideable = tools.filter(tc => !isAlwaysVisibleToolCall(tc));
      const entry: ReceiptEntry = { messageId: msg._id, messageUuid: msg.message_uuid, timestamp: msg.timestamp, tools: hideable };
      // Segment ownership: a text message opens a new segment and owns its own
      // tools; a tool-only message folds into the current owner (or becomes one).
      if (hasText) {
        ownerId = msg._id;
        receiptOf.set(msg._id, hideable.length ? [entry] : []);
      } else if (ownerId) {
        if (hideable.length) receiptOf.get(ownerId)!.push(entry);
        // A message carrying an always-visible block (poll, plan write) must
        // still render that block — fold its hideable tools into the receipt but
        // don't absorb the message itself.
        if (!tools.some(isAlwaysVisibleToolCall)) absorbed.add(msg._id);
      } else {
        ownerId = msg._id;
        receiptOf.set(msg._id, hideable.length ? [entry] : []);
      }
    }
    if (curBoundary && hasMoreBelow) routingOf.get(curBoundary)!.until = lastLoadedAt;
    return { turnKeyOf, firstAssistOf, lastTextOf, statsOf, receiptOf, absorbed, routingOf };
  }, [timeline, userMsgKindMap, messageAuthors, hasMoreBelow]);

  // The turn the agent is in or just finished (the last assistant message's)
  // and where its last answer sits. Fold mode keeps an ask card only while
  // it is open: in the live turn, with no user row after it. An answered
  // prompt (a poll reply already sent, even one still delivering) is a
  // dangling permission prompt to the reader and folds with the turn.
  const liveTurn = useMemo(() => {
    if (!foldWorkingTurns) return { key: null as string | null, lastUserIndex: -1 };
    let key: string | null = null;
    let lastUserIndex = -1;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const m = item.data as Message;
      if (m.role === 'user' && lastUserIndex < 0) lastUserIndex = i;
      if (m.role !== 'assistant' || key) continue;
      key = turnAggregates.turnKeyOf.get(m._id) ?? null;
    }
    return { key, lastUserIndex };
  }, [foldWorkingTurns, timeline, turnAggregates]);
  const liveTurnKey = liveTurn.key;
  const openAsk = useCallback((msg: Message, index: number, turnKey: string | undefined) =>
    turnKey === liveTurn.key && index > liveTurn.lastUserIndex && !!msg.tool_calls?.some(isAlwaysVisibleToolCall),
  [liveTurn]);

  // Pair each slash-command invocation with its expansion (the body of the command's
  // .md file, emitted by Claude Code as the next user message). They render as one
  // command block, so the expansion message is suppressed. Applied only in the full
  // (non-collapsed) view; collapsed keeps its compact one-pill behavior.
  const commandExpansionMap = useMemo(() => {
    const byCommand = new Map<string, string>(); // command msg _id -> expansion content
    const consumed = new Set<string>();          // expansion msg _ids
    // Same pairing for `!` bash mode: input msg _id -> the output msg's parsed streams.
    const bashByInput = new Map<string, { stdout: string; stderr: string }>();
    const machineMoveExtra = new Map<string, string>();
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (item.type !== 'message') continue;
      const msg = item.data as Message;
      if (msg.role !== 'user') continue;
      const kind = userMsgKindMap.get(msg._id)?.kind;
      if (kind !== 'command' && kind !== 'bash_input' && kind !== 'agent_switch' && kind !== 'machine_move') continue;
      if (kind === 'machine_move') {
        if (consumed.has(msg._id)) continue;
        const extras: string[] = [];
        for (let j = i + 1; j < timeline.length; j++) {
          if (timeline[j].type !== 'message') continue;
          const later = timeline[j].data as Message;
          if (later.role !== 'user') break;
          if (userMsgKindMap.get(later._id)?.kind !== 'machine_move') break;
          consumed.add(later._id);
          if (later.content) extras.push(later.content);
        }
        if (extras.length) machineMoveExtra.set(msg._id, extras.join("\n\n"));
        continue;
      }
      let next: Message | null = null;
      for (let j = i + 1; j < timeline.length; j++) {
        if (timeline[j].type === 'message') { next = timeline[j].data as Message; break; }
      }
      if (!next || next.role !== 'user' || !next.content) continue;
      const nextKind = userMsgKindMap.get(next._id);
      if (kind === 'command' && nextKind?.kind === 'skill_expansion') {
        byCommand.set(msg._id, next.content);
        consumed.add(next._id);
      } else if (kind === 'agent_switch' && nextKind?.kind === 'agent_switch' && isModelSwitchStdout(next.content)) {
        // /model command + "Set model to …" stdout: keep the prettier stdout divider.
        consumed.add(msg._id);
      } else if (kind === 'bash_input' && nextKind?.kind === 'bash_output') {
        bashByInput.set(msg._id, { stdout: nextKind.stdout, stderr: nextKind.stderr });
        consumed.add(next._id);
      }
    }
    return { byCommand, consumed, bashByInput, machineMoveExtra };
  }, [timeline, userMsgKindMap]);

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
        const isNudge = kind === 'normal' && !msg._isOptimistic && !msg._isQueued && !msg.images?.length;
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

  return { userMsgKindMap, turnAggregates, openAsk, commandExpansionMap, nudgeRuns, isThinking, isWaitingForResponse };
}
