"use client";

import { memo } from "react";
import { useConvexAuth } from "convex/react";
import { usePresenceRows, type PresenceRow } from "../../hooks/useDocPresence";
import { composeDocId, isSuggestion, typingRows } from "../../lib/composerPresence";
import { useAcceptSuggestion } from "../../hooks/useJointComposer";
import { PresenceAvatar } from "../PresenceFacepile";
import "../chat/chat.css";

// Each other person's draft, whole and live, at the end of the transcript:
// the place it will land when they send. A ghost of a message, in their name,
// muted and in italics, so the room reads what is coming before it arrives and
// two people steering one session see an overlap while there is still time to
// fold it into one turn. The composer's strip keeps its one line summary; this
// is the full text. It reads the same presence rows the composer broadcasts
// on (compose:<id>), so it costs no writes and a solo session renders nothing.

export const GhostDrafts = memo(function GhostDrafts({
  conversationId,
  populate,
}: {
  conversationId: string;
  /** The viewer's composer, when they may send: a suggestion then offers to be taken. */
  populate?: (text: string, opts?: { append?: boolean }) => void;
}) {
  const { isAuthenticated } = useConvexAuth();
  const ghosts = typingRows(usePresenceRows(composeDocId(conversationId), isAuthenticated));
  const accept = useAcceptSuggestion(conversationId, populate ?? (() => {}));
  if (ghosts.length === 0) return null;
  return (
    <div data-cc-ghost-drafts className="conv-col mx-auto px-4 sm:px-5 md:px-6 pt-1">
      {ghosts.map((row) => (
        <GhostDraft
          key={row.user_id}
          row={row}
          actions={populate && isSuggestion(row) ? (
            <>
              <button type="button" data-sv-accept-suggestion="session" onClick={() => accept(row, "session")} className="inline-flex items-center h-6 px-2.5 rounded-full text-[11px] font-medium not-italic border border-sol-violet/50 bg-sol-violet/15 text-sol-violet hover:bg-sol-violet/25 transition-colors">
                Send as {row.user_name.split(/[\s@]/)[0]}
              </button>
              <button type="button" data-sv-accept-suggestion="composer" onClick={() => accept(row, "composer")} className="inline-flex items-center h-6 px-2.5 rounded-full text-[11px] font-medium not-italic border border-sol-border text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt transition-colors">
                Add to my draft
              </button>
            </>
          ) : undefined}
        />
      ))}
    </div>
  );
});

function GhostDraft({ row, actions }: { row: PresenceRow; actions?: React.ReactNode }) {
  const suggested = row.can_send === false;
  return (
    <div
      data-cc-ghost-draft={row.user_id}
      className={`relative -mx-4 px-4 py-3.5 mb-6 rounded-lg border border-dashed animate-message-in ${suggested ? "border-sol-violet/35 bg-sol-violet/[0.04]" : "border-sol-blue/30 bg-sol-blue/[0.04]"}`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <PresenceAvatar person={row} size={24} ring={false} />
        <span className={`text-xs font-medium ${suggested ? "text-sol-violet/80" : "text-sol-blue/80"}`}>{row.user_name}</span>
        {suggested ? (
          <span className="text-[10px] font-medium uppercase tracking-wide px-1.5 py-px rounded border border-sol-violet/40 text-sol-violet">Suggested</span>
        ) : (
          <span className="text-[11px] text-sol-text-dim">is writing</span>
        )}
        <span className="ch-typing-dots" aria-hidden="true"><span /><span /><span /></span>
      </div>
      <div className="pl-8 text-sm italic text-sol-text-muted whitespace-pre-wrap break-words">
        {row.draft_text}
        <span aria-hidden="true" className="inline-block w-px h-[1.05em] align-[-0.15em] ml-px bg-sol-text-muted/70 animate-pulse" />
      </div>
      {actions && <div className="pl-8 mt-2.5 flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
