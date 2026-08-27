import { CheckCircle2, MessagesSquare, SquarePen } from "lucide-react";
import { ALL_EMPTY_COPY, THREAD_KIND_META, type ChipKey } from "../../lib/threadCards";

// The empty state per chip. Each says, in one line, how a thread of that kind
// reaches the page — over a small drawn stack of ghost cards in the page's
// own grammar (kind tile, cyan unread rule), so the empty view teaches what
// will appear. The DMs chip offers the way in. The question chip's empty is
// good news — nothing waits on you — so it wears the check, not its alert
// tone.

export function ThreadsEmpty({
  chip,
  sessionsOn,
  caughtUp,
  onNewMessage,
}: {
  chip: ChipKey;
  /** The Sessions toggle is on (only meaningful under All). */
  sessionsOn: boolean;
  /** The viewer HAS threads under this chip, just nothing unread — good news,
   *  not an empty page. */
  caughtUp?: boolean;
  onNewMessage?: () => void;
}) {
  const goodNews = chip === "question" || !!caughtUp;
  const Icon = goodNews ? CheckCircle2 : chip === "all" ? MessagesSquare : THREAD_KIND_META[chip].icon;
  const tone = goodNews ? "green" : chip === "all" ? "blue" : THREAD_KIND_META[chip].tone;
  const title =
    caughtUp ? "All caught up"
    : chip === "all" ? "No threads yet"
    : chip === "chat" ? "No channel threads yet"
    : chip === "dm" ? "No direct messages yet"
    : chip === "comment" ? "No comment threads yet"
    : chip === "page" ? "No page discussions yet"
    : chip === "question" ? "No open questions"
    : "No task threads yet";
  // The default view holds every kind, so it keeps one title and one sentence.
  // The Sessions switch adds a source; it does not replace the others.
  const copy =
    caughtUp ? "Nothing here is unread for you. A thread comes back when someone replies."
    : chip === "all" ? (sessionsOn ? `${ALL_EMPTY_COPY} Your inbox sessions show here too.` : ALL_EMPTY_COPY)
    : THREAD_KIND_META[chip].emptyCopy;
  return (
    <div className="ch-empty">
      <div className="th-empty-art" aria-hidden="true">
        <div className="th-empty-ghost th-empty-ghost-front">
          <span className={`th-card-kind th-tone-${tone}`}>
            <Icon className="w-3 h-3" />
          </span>
          <span className="th-empty-lines">
            <i />
            <i />
          </span>
        </div>
        <div className="th-empty-ghost" />
        <div className="th-empty-ghost" />
      </div>
      <div className="ch-empty-title">{title}</div>
      <div className="ch-empty-sub">{copy}</div>
      {chip === "dm" && onNewMessage && (
        <button type="button" className="ch-empty-action" onClick={onNewMessage}>
          <SquarePen className="w-3 h-3" />
          New message
        </button>
      )}
    </div>
  );
}
