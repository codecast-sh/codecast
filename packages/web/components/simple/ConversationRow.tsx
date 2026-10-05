// A conversation in a list: a state dot, its name, one line of where it
// stands, and when it last moved.
import { Link } from "react-router";
import type { InboxSession } from "../../store/inboxStore";
import { formatRelativeTime } from "../../lib/conversationFormat";
import { conversationPath, conversationSubline, conversationTitle, type ConversationState } from "./lane";

export function ConversationRow({ row, state, now }: { row: InboxSession; state: ConversationState; now: number }) {
  const sub = conversationSubline(row, state);
  return (
    <Link to={conversationPath(String(row._id))} className="sl-row">
      <span className={`sl-dot is-${state}`} aria-hidden />
      <span className="sl-row-main">
        <span className="sl-row-title" style={{ display: "block" }}>{conversationTitle(row)}</span>
        {sub ? <span className="sl-row-sub" style={{ display: "block" }}>{sub}</span> : null}
      </span>
      <span className="sl-row-aside">{formatRelativeTime(row.updated_at, now)}</span>
    </Link>
  );
}
