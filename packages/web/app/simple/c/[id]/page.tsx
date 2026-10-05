// One conversation in the simple lane: the transcript with its steps folded,
// any approval it is waiting on with the actual draft, and the reply box.
import { useRef } from "react";
import { useNavigate, useParams } from "react-router";
import { isConvexId } from "../../../../store/inboxStore";
import { useAckActiveConversation } from "../../../../hooks/useAckActiveConversation";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { ApprovalCard } from "../../../../components/simple/ApprovalCard";
import { Composer } from "../../../../components/simple/Composer";
import { Transcript } from "../../../../components/simple/Transcript";
import { LANE_COPY, conversationPath } from "../../../../components/simple/lane";

const WORDS = LANE_COPY.conversation;
import { useLaneConversation } from "../../../../components/simple/useLane";

const NEAR_BOTTOM_PX = 220;

function nearBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - NEAR_BOTTOM_PX;
}

export default function SimpleConversation() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  // The stub's real id arrived: the address follows it, so a reload or a
  // shared link opens the real conversation.
  const { liveId, approvals, working, loading, items, hasMoreAbove, isLoadingOlder, loadOlder, send: sendText, retry } = useLaneConversation(
    id,
    (realId) => navigate(conversationPath(realId), { replace: true }),
  );
  useAckActiveConversation(isConvexId(liveId) ? liveId : null);

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
    sendText(text);
    requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" }));
  };

  return (
    <main>
      <div className="sl-thread">
        {hasMoreAbove ? (
          <button type="button" className="sl-btn is-no is-small" style={{ alignSelf: "center" }} disabled={isLoadingOlder} onClick={() => loadOlder()}>
            {isLoadingOlder ? WORDS.loadingEarlier : WORDS.earlier}
          </button>
        ) : null}
        {loading ? <p className="sl-muted" style={{ margin: "0.4rem 0.2rem", fontSize: "0.9rem" }} role="status">{WORDS.loading}</p> : null}
        <Transcript items={items} onRetry={retry} />
        {approvals.map((d, n) => <ApprovalCard key={d._id} decision={d} index={n} here />)}
        {working && approvals.length === 0 ? (
          <div className="sl-working" role="status">
            <span className="sl-working-dots" aria-hidden><i /><i /><i /></span>
            {WORDS.working}
          </div>
        ) : null}
      </div>
      <div className="sl-dock">
        <Composer placeholder={approvals.length ? WORDS.change : WORDS.reply} onSend={send} />
      </div>
    </main>
  );
}
