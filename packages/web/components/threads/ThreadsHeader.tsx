import { CheckCheck, MessagesSquare } from "lucide-react";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";
import { summaryCount } from "../../lib/threadCards";

// The page head: title, the count for the view on screen (the default view
// counts what waits on you, a kind's view every unread thread; else the
// total), and Mark all read scoped to that view. Same chrome as the chat
// page's head (ch-head) so the two pages sit in the titlebar the same way.

export function ThreadsHeader({
  unread,
  forYou,
  anyUnread,
  total,
  onMarkAllRead,
}: {
  /** The view's count (sessions never count): waiting on you in the default
   *  view, every unread card in a kind's view. */
  unread: number;
  /** The count is the default view's: threads waiting on you. */
  forYou: boolean;
  /** Any card in the view has unread, counted or not: Mark all read shows. */
  anyUnread: boolean;
  /** Cards in the view on screen. */
  total: number;
  onMarkAllRead: () => void;
}) {
  const headTitlebarRef = useTitlebarHead<HTMLElement>();
  return (
    <header ref={headTitlebarRef} className="ch-head">
      <span className="ch-head-name">
        <span className="ch-head-hash" aria-hidden="true">
          <MessagesSquare className="w-3 h-3 inline-block" />
        </span>
        Threads
      </span>
      <span className="ch-head-topic">
        {unread > 0 ? (
          `${summaryCount(unread, "thread")} ${forYou ? "waiting on you" : "with new replies"}`
        ) : total > 0 && !anyUnread ? (
          // Every thread in the view is read: say so, quietly, where the
          // unread count would have been.
          <span className="th-head-done">
            <CheckCheck className="w-3 h-3" aria-hidden="true" />
            All caught up · {summaryCount(total, "thread")}
          </span>
        ) : ""}
      </span>
      {anyUnread && (
        <button type="button" className="th-markall" onClick={onMarkAllRead} title="Mark every thread in this view read">
          <CheckCheck className="w-3 h-3" />
          Mark all read
        </button>
      )}
    </header>
  );
}
