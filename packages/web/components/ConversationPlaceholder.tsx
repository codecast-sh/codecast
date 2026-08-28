"use client";
/**
 * The conversation pane while its data is still on the way. It paints the same
 * 32px header the loaded view will: same rule, same type, the same action icons
 * at the right edge, only inert. The session's name is already in place when
 * the store knows it, so opening a session reads as its header appearing and
 * the buttons coming alive, not as one bar giving way to another.
 *
 * The id may be anything a conversation link carries: the Convex id, the short
 * id, or the CLI's own session id. None of those is a name, so an unknown id
 * leaves a quiet bar in the title slot rather than printing the handle.
 */
import { AlignJustify, Link2, MoreVertical, Search } from "lucide-react";
import { useInboxStore, isConvexId, type InboxSession } from "../store/inboxStore";
import { cleanTitle } from "../lib/conversationProcessor";
import { AppLoader } from "./AppLoader";

function knownTitle(
  sessions: Record<string, InboxSession>,
  conversations: Record<string, { title?: string } | undefined>,
  id: string | undefined,
): string | undefined {
  if (!id) return undefined;
  const direct = sessions[id]?.title ?? conversations[id]?.title;
  if (direct) return direct;
  // A handle that isn't a row key names the session some other way; the scan
  // only runs while a row is missing, which is the whole time this is on screen.
  if (isConvexId(id)) return undefined;
  const row = Object.values(sessions).find(
    (s) => s.session_id === id || (s as { short_id?: string }).short_id === id,
  );
  return row?.title;
}

const ACTION_CLASS = "p-1 rounded text-sol-text-dim";

export function ConversationPlaceholder({ id }: { id?: string }) {
  const rawTitle = useInboxStore((s) => knownTitle(s.sessions, s.conversations, id));
  const title = rawTitle ? cleanTitle(rawTitle) : "";

  return (
    <div className="cc-panel h-full">
      <header className="cq-container shrink-0">
        <div className="cc-panel__head cc-panel__head--flow gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0 overflow-hidden flex-1">
            {title ? (
              <h1 className="cc-panel__title truncate flex-1 min-w-0 cursor-default">
                {title.length > 60 ? title.slice(0, 57) + "..." : title}
              </h1>
            ) : (
              <span aria-hidden className="h-2.5 w-40 rounded bg-sol-text-dim/15 animate-pulse" />
            )}
            <div className="flex items-center gap-1 flex-shrink-0 ml-auto opacity-40" aria-hidden>
              <span className="w-px h-3.5 bg-sol-border/60 mx-0.5 flex-shrink-0" />
              <button disabled className={ACTION_CLASS}><Search className="w-3.5 h-3.5" /></button>
              <button disabled className={ACTION_CLASS}><AlignJustify className="w-3.5 h-3.5" /></button>
              <button disabled className={ACTION_CLASS}><Link2 className="w-3.5 h-3.5" /></button>
              <button disabled className={ACTION_CLASS}><MoreVertical className="w-3.5 h-3.5" /></button>
            </div>
          </div>
        </div>
      </header>
      <AppLoader className="min-h-0 flex-1 bg-transparent" size={32} />
    </div>
  );
}
