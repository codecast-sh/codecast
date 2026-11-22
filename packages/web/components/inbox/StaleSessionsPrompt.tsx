import { useState, type ReactNode } from "react";
import { ChevronRight, X } from "lucide-react";
import { formatShortDate } from "../../lib/utils";
import { cleanTitle } from "../../lib/conversationProcessor";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { dismissStaleLedger } from "../consequential/ledgers";
import { dismissStaleSessions } from "../../store/undoActions";
import { isSessionHidden, type InboxSession } from "../../store/inboxStore";

type StaleSession = { _id: string; title?: string | null };

/** The sessions the prompt counts and "Dismiss all N" dismisses: idle since
 *  `cutoff`, not hidden, pinned or snoozed, and never the one on screen.
 *  Newest first, so the borderline ones lead the review list. */
export function staleSessionsOf(sessions: InboxSession[], activeSessionId: string | null | undefined, cutoff: number): InboxSession[] {
  return sessions
    .filter(
      (sess) =>
        !isSessionHidden(sess) &&
        !sess.is_pinned &&
        !sess.inbox_snoozed_until &&
        sess._id !== activeSessionId &&
        // An unstamped row is unknown, not ancient: never offer it for dismissal.
        !!sess.updated_at && sess.updated_at < cutoff,
    )
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
}

/**
 * The inbox's "Clear out your working set?" prompt. "Dismiss all N" opens the
 * shared confirm review of exactly the N sessions counted here, and only its
 * confirm dismisses them: one undoable gesture whose toast offers Undo
 * (ct-98161). `list` draws the same sessions as inbox cards for "Show them".
 */
export function StaleSessionsPrompt({
  sessions,
  since,
  onSnooze,
  list,
}: {
  sessions: StaleSession[];
  since: number;
  onSnooze: () => void;
  list: () => ReactNode;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const count = sessions.length;

  const dismiss = () => {
    setReviewing(false);
    setListOpen(false);
    onSnooze();
    dismissStaleSessions(sessions.map((sess) => sess._id));
  };

  return (
    <div className="m-2 rounded-md border border-sol-yellow/30 bg-sol-yellow/[0.06]" data-stale-prompt>
      <div className="px-3 py-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-sol-text">Clear out your working set?</div>
            <div className="mt-0.5 text-meta leading-snug text-sol-text-muted">
              <span className="font-semibold text-sol-yellow">{count}</span> sessions have had
              no activity since {formatShortDate(since)}. Dismissing them clears the inbox; they stay
              searchable and open by link. Pinned sessions are kept.
            </div>
          </div>
          <button
            onClick={onSnooze}
            className="shrink-0 rounded p-0.5 text-sol-text-dim hover:bg-sol-bg-alt hover:text-sol-text"
            title="Not now"
            aria-label="Dismiss this prompt"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            onClick={() => setListOpen((v) => !v)}
            className="flex items-center gap-1 text-meta font-semibold text-sol-yellow transition-colors hover:text-sol-yellow/80"
            aria-expanded={listOpen}
          >
            <ChevronRight className={`h-3 w-3 transition-transform ${listOpen ? "rotate-90" : ""}`} />
            {listOpen ? "Hide them" : "Show them"}
          </button>
          <button
            onClick={() => setReviewing(true)}
            aria-haspopup="dialog"
            aria-expanded={reviewing}
            data-stale-dismiss-all
            className="rounded bg-sol-yellow/15 px-2.5 py-1 text-meta font-semibold text-sol-yellow transition-colors hover:bg-sol-yellow/25 modern:h-6 modern:rounded-control modern:bg-sol-yellow/10 modern:py-0 modern:font-medium modern:hover:bg-sol-yellow/15"
          >
            {`Dismiss all ${count}`}
          </button>
          {reviewing && (
            <SwitchReview
              ledger={dismissStaleLedger({
                titles: sessions.map((sess) => cleanTitle(sess.title || "") || "Untitled session"),
                since: formatShortDate(since),
              })}
              onClose={() => setReviewing(false)}
              onConfirm={dismiss}
            />
          )}
          <button onClick={onSnooze} className="text-meta text-sol-text-dim transition-colors hover:text-sol-text">
            Not now
          </button>
        </div>
      </div>
      {/* The review list: the exact dismiss set, rendered as the same cards as
          the rest of the inbox (flat, so a nested subagent that would be
          dismissed shows as its own row). Each card's idle age says how long it
          has sat; pin a card to hold it out of the sweep. */}
      {listOpen && <div className="border-t border-sol-yellow/20">{list()}</div>}
    </div>
  );
}
