import type { InboxSession } from "../../../store/inboxStore";
import type { ThreadCardModel } from "../../../lib/threadCards";
import { sessionLabel } from "../../../lib/notificationTypes";
import { SessionIdentityLine, SessionMark } from "../../identity";
import { SessionInlineThread } from "../../conversation/SessionInlineThread";

// The session kind: the viewer's own inbox sessions, shown as rows only when
// the Sessions toggle is on (off by default — their queue already lives in
// the Inbox). Membership is the Inbox's own: placeInboxRows over
// filterInboxScope, derived in hooks/useSessionThreadCards. Open, a row is
// the DM kind's shape: the newest messages of the session inline and the
// app's own composer sending into it; the side panel is a secondary button.

function sessionOf(card: ThreadCardModel): InboxSession {
  return card.source as InboxSession;
}

/** The label leads with the session's agent mark, the way an Inbox row does;
 *  the kind tile keeps the kind's own icon. */
export function SessionLabel({ card }: { card: ThreadCardModel }) {
  const session = sessionOf(card);
  return (
    <>
      <SessionMark session={session as any} size={14} iconClassName="w-3 h-3" />
      <SessionIdentityLine row={session as any} title={sessionLabel(session) ?? "Session"} />
    </>
  );
}

export function SessionExpanded({ card, seen, focusComposer }: { card: ThreadCardModel; present: boolean; seen: boolean; frozenReadAt: number; focusComposer: boolean }) {
  return <SessionInlineThread session={sessionOf(card)} seen={seen} focusComposer={focusComposer} />;
}
