import { useEffect } from "react";
import { PanelRight } from "lucide-react";
import { useInboxStore, type InboxSession } from "../../../store/inboxStore";
import { summaryCount, type ThreadCardModel } from "../../../lib/threadCards";
import { threadStateView } from "../../../lib/threadState";
import { sessionLabel } from "../../../lib/notificationTypes";
import { AgentIcon } from "../../ConversationList";
import { useThreadsPage } from "../threadsContext";

// The session kind: the viewer's own inbox sessions, shown as cards only when
// the Sessions toggle is on (off by default — their queue already lives in
// the Inbox). Membership is the Inbox's own: categorizeSessions over
// filterInboxScope, derived in hooks/useSessionThreadCards. Expanding a card
// opens the session in the side panel and marks it seen the way leaving a
// session does.

function sessionOf(card: ThreadCardModel): InboxSession {
  return card.source as InboxSession;
}

/** The label leads with the session's agent mark, the way an Inbox row does;
 *  the kind tile keeps the kind's own icon. */
export function SessionLabel({ card }: { card: ThreadCardModel }) {
  const session = sessionOf(card);
  return (
    <>
      <AgentIcon agentType={session.agent_type || "claude_code"} className="w-3 h-3" />
      {sessionLabel(session) ?? "Session"}
    </>
  );
}

export function SessionRoot({ card, expanded }: { card: ThreadCardModel; expanded: boolean }) {
  const session = sessionOf(card);
  const { now, toggle } = useThreadsPage();
  const state = threadStateView(session as any, session.message_count ?? 0, now);
  const line = state?.cardLine ?? session.subtitle ?? "";
  const count = session.message_count ?? 0;
  return (
    <>
      {line && <div className="th-card-root th-card-session-line">{line}</div>}
      {!expanded && (
        <button type="button" className="th-card-summary" onClick={() => toggle(card)}>
          <span className="th-card-count">{summaryCount(count, "message")}</span>
          {session.idle_summary && <span className="th-card-preview">{session.idle_summary}</span>}
        </button>
      )}
    </>
  );
}

export function SessionExpanded({ card }: { card: ThreadCardModel; present: boolean; frozenReadAt: number }) {
  const id = sessionOf(card)._id;
  // Expanding IS opening: the session shows in the side panel beside the page,
  // and it is marked seen the way leaving a session marks it.
  useEffect(() => {
    const st = useInboxStore.getState();
    st.openSidePanel(id);
    st.markSessionSeen(id);
  }, [id]);
  return (
    <div className="th-card-open th-card-note">
      <PanelRight className="w-3 h-3" /> Open in the side panel
    </div>
  );
}
