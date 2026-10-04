import { useCallback, useMemo } from "react";
import { isUsageLimitDialog } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { usePendingPermissions } from "./useSyncPendingPermissions";
import { openQuestionFromMessages, lastAssistantText, visibleOptions } from "./useDecisionQueue";
import { buildSingleAnswerPayload, buildFreeTextPayload } from "../lib/pollPayload";
import { PERMISSION_SKIP_TOOLS } from "../components/PermissionCard";
import type { QueueItem } from "../lib/decisionQueue";

// What a queue item asks and the three gestures that settle it: answer an
// option, answer in words, or dismiss. One model for every surface that
// answers an agent (the decision card in a conversation, the agent dock on
// the screen's edge), so a poll answered from either lands as the same
// payload on the same send path.
//
// A poll card has no authored payload: its question and options come from the
// conversation's messages, which the caller keeps loaded. A permission card
// carries a tool name and an argument preview instead, answered by
// PermissionStack's own Approve/Deny.
export function useDecisionAnswer(item: QueueItem | null) {
  const answerDecision = useInboxStore((s) => s.answerDecision);
  const addOptimisticMessage = useInboxStore((s) => s.addOptimisticMessage);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const resolveSessionQuestion = useInboxStore((s) => s.resolveSessionQuestion);

  const conversationId = item?.conversationId ?? null;
  const needsMessages = !!item && item.source !== "decide";
  const messages = useInboxStore((s) => (conversationId ? s.messages[conversationId] : undefined));

  const permissionsRaw = usePendingPermissions(item?.source === "permission" ? conversationId : null);
  const permissions = useMemo(
    () => (permissionsRaw ?? []).filter((p: any) => !PERMISSION_SKIP_TOOLS.has(p.tool_name)),
    [permissionsRaw]
  );
  const isPermissionCard = item?.source === "permission" && permissions.length > 0;

  const poll = useMemo(() => (needsMessages ? openQuestionFromMessages(messages as any[]) : null), [needsMessages, messages]);
  const recentText = useMemo(() => (needsMessages ? lastAssistantText(messages as any[]) : undefined), [needsMessages, messages]);

  // The session title is WHO is asking, never WHAT: a poll card shows no
  // question until the poll is readable from the transcript.
  const question = poll?.question.question ?? (item?.source === "decide" ? item.question : "");
  const options = useMemo(() => {
    if (!item) return [];
    if (item.source === "decide") return item.options.map((o, index) => ({ label: o.label, description: o.description, index }));
    return poll ? visibleOptions(poll.question) : [];
  }, [item, poll]);

  // A usage/billing interstitial is not a decision about the work, and its
  // options commit real money: rendered un-answerable everywhere.
  const isInfraDialog = !!item && item.source !== "decide" && isUsageLimitDialog(options.map((o) => o.label));

  const answer = useCallback((index: number) => {
    if (!item) return;
    if (item.source === "decide" && item.decisionId) {
      answerDecision(item.decisionId, { index });
    } else if (poll) {
      const content = buildSingleAnswerPayload(poll.question, index);
      const clientId = addOptimisticMessage(item.conversationId, content);
      sendMessage(item.conversationId, content, undefined, clientId);
    }
  }, [item, poll, answerDecision, addOptimisticMessage, sendMessage]);

  const answerFreeText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!item || !trimmed) return;
    if (item.source === "decide" && item.decisionId) {
      answerDecision(item.decisionId, { text: trimmed });
    } else {
      // No parsed poll needed: the free-text payload is the decline-then-type
      // form, which the daemon can drive at any AskUserQuestion menu — this is
      // how a buffered question (present in no transcript yet) gets answered.
      const content = buildFreeTextPayload(trimmed);
      const clientId = addOptimisticMessage(item.conversationId, content);
      sendMessage(item.conversationId, content, undefined, clientId);
    }
  }, [item, answerDecision, addOptimisticMessage, sendMessage]);

  // "I am not going to answer this." A `cast decide` row resolves as dismissed
  // (the agent is not told); a poll/permission card is marked resolved in the
  // store — it leaves the queue AND the rail's QUESTIONS section together, and
  // returns only if the agent speaks again (the session itself keeps waiting).
  const dismiss = useCallback(() => {
    if (!item) return;
    if (item.source === "decide" && item.decisionId) answerDecision(item.decisionId, { dismiss: true });
    else resolveSessionQuestion(item.conversationId);
  }, [item, answerDecision, resolveSessionQuestion]);

  return { messages, needsMessages, poll, recentText, question, options, permissions, isPermissionCard, isInfraDialog, answer, answerFreeText, dismiss };
}
