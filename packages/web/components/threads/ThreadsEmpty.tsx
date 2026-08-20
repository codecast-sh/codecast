import { MessagesSquare, SquarePen } from "lucide-react";
import { ALL_EMPTY_COPY, THREAD_KIND_META, type ChipKey } from "../../lib/threadCards";

// The empty state per chip. Each says, in one line, how a thread of that kind
// reaches the page. The DMs chip offers the way in.

export function ThreadsEmpty({
  chip,
  sessionsOn,
  onNewMessage,
}: {
  chip: ChipKey;
  /** The Sessions toggle is on (only meaningful under All). */
  sessionsOn: boolean;
  onNewMessage?: () => void;
}) {
  const Icon = chip === "all" ? MessagesSquare : THREAD_KIND_META[chip].icon;
  const title =
    chip === "all" ? "No threads yet"
    : chip === "chat" ? "No channel threads yet"
    : chip === "dm" ? "No direct messages yet"
    : chip === "comment" ? "No comment threads yet"
    : chip === "page" ? "No page discussions yet"
    : chip === "question" ? "No open questions"
    : "No task threads yet";
  // The default view holds every kind, so it keeps one title and one sentence.
  // The Sessions switch adds a source; it does not replace the others.
  const copy =
    chip === "all" ? (sessionsOn ? `${ALL_EMPTY_COPY} Your inbox sessions show here too.` : ALL_EMPTY_COPY)
    : THREAD_KIND_META[chip].emptyCopy;
  return (
    <div className="ch-empty">
      <div className="ch-empty-icon th-empty-icon" aria-hidden="true">
        <Icon className="w-5 h-5" />
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
