// One conversation in the simple lane: the transcript with its steps folded,
// any approval it is waiting on with the actual draft, and the reply box.
import { useMemo, useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { isConvexId, useInboxStore } from "../../../../store/inboxStore";
import { useConversationMessages } from "../../../../hooks/useConversationMessages";
import { useAckActiveConversation } from "../../../../hooks/useAckActiveConversation";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { ApprovalCard } from "../../../../components/simple/ApprovalCard";
import { Composer } from "../../../../components/simple/Composer";
import { Transcript } from "../../../../components/simple/Transcript";
import { buildTranscript, conversationPath, conversationState, type LaneMessage, type TranscriptItem } from "../../../../components/simple/lane";
import { useOpenApprovals } from "../../../../components/simple/useLane";
import { useRetryConversationStart } from "../../../../components/simple/startConversation";

const NEAR_BOTTOM_PX = 220;

function nearBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM_PX;
}

export default function SimpleConversation() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const liveId = useInboxStore((s) => s.resolveLiveSessionId(id));
  const row = useInboxStore((s) => s.sessions[liveId]);
  const { conversation, hasMoreAbove, isLoadingOlder, loadOlder } = useConversationMessages(id);
  useAckActiveConversation(isConvexId(liveId) ? liveId : null);
  const retryStart = useRetryConversationStart();

  // The stub's real id arrived: the address follows it, so a reload or a
  // shared link opens the real conversation.
  useWatchEffect(() => {
    if (liveId !== id && isConvexId(liveId)) navigate(conversationPath(liveId), { replace: true });
  }, [liveId, id, navigate]);

  const ids = useMemo(() => new Set([String(liveId)]), [liveId]);
  const approvals = useOpenApprovals(ids);
  const state = row ? conversationState(row, approvals.length) : "done";
  const messages = (conversation?.messages ?? []) as LaneMessage[];
  const unsent = messages.some((m) => m._isOptimistic || m._isQueued);
  const working = state === "working" || (unsent && approvals.length === 0);
  const items = useMemo(() => buildTranscript(messages, working), [messages, working]);

  // Open at the newest line, and follow new lines while the reader is at the bottom.
  const seen = useRef(0);
  useWatchEffect(() => {
    const count = items.length + approvals.length + (working ? 1 : 0);
    const first = seen.current === 0;
    if (count > seen.current && (first || nearBottom())) {
      requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: first ? "auto" : "smooth" }));
    }
    seen.current = count;
  }, [items.length, approvals.length, working]);

  const send = (text: string) => {
    const s = useInboxStore.getState();
    const clientId = s.addOptimisticMessage(liveId, text);
    s.sendMessageWhenReady(liveId, text, undefined, clientId);
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
  };

  const retry = (item: Extract<TranscriptItem, { kind: "you" }>) => {
    if (isConvexId(liveId)) void useInboxStore.getState().retryPendingMessage(liveId, { clientId: item.id }).catch(() => {});
    else retryStart(liveId, item.id, item.text);
  };

  return (
    <main>
      <div className="sl-thread">
        {hasMoreAbove ? (
          <button type="button" className="sl-btn is-no is-small" style={{ alignSelf: "center" }} disabled={isLoadingOlder} onClick={() => loadOlder()}>
            {isLoadingOlder ? "Loading" : "Show earlier"}
          </button>
        ) : null}
        <Transcript items={items} onRetry={retry} />
        {approvals.map((d, n) => <ApprovalCard key={d._id} decision={d} index={n} />)}
        {working && approvals.length === 0 ? (
          <div className="sl-working" role="status">
            <span className="sl-working-dots" aria-hidden><i /><i /><i /></span>
            On it
          </div>
        ) : null}
      </div>
      <div className="sl-dock">
        <Composer placeholder={approvals.length ? "Or tell me what to change" : "Reply"} onSend={send} />
      </div>
    </main>
  );
}
