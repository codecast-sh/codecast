import { memo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, ExternalLink } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import type { ThreadInboxRow } from "../../store/threadTypes";
import { THREAD_KIND_SPECS } from "../../lib/threadKinds";
import type { ThreadCardModel } from "../../lib/threadCards";
import { ghostHeight, useBodyMeasure, useNearViewport, useOnScreen } from "./cardWindow";
import { useThreadsPage } from "./threadsContext";

import { useWatchEffect } from "../../hooks/useWatchEffect";
// One card, whatever the kind: the generic shell — kind tile and object
// label, unread badge, age, caret, and beside them the open-in-place link —
// around the kind's own Root (collapsed body) and Expanded (the thread in
// place). The head is two sibling buttons, never one inside the other: the
// hit area toggles, the tool opens. The kind is looked up in lib/threadKinds;
// nothing here branches on it except the open link for a comment, which lands
// the conversation on its message.
//
// Many cards are expanded at once (unread opens by default), so the shell
// owns two viewport judgments the kinds inherit:
//  - the mount window: the heavy body exists only near the viewport; far
//    cards hold their place with a measured-height ghost (cardWindow.ts);
//  - the read law's witness: `seen` is true only while the reader is present
//    AND the card's tail — the newest content, since bodies pin to their
//    tail — has actually been in the viewport. Kinds mark read on `seen`,
//    never on mount, so a card expanded below the fold stays unread.

export const ThreadCard = memo(function ThreadCard({
  card,
  expanded,
  expandedBy,
  frozenReadAt,
  defaultNear,
}: {
  card: ThreadCardModel;
  expanded: boolean;
  /** Who expanded it: the default rule, or the user's click. Only a user's
   *  click may steal scroll and focus. */
  expandedBy: "auto" | "user";
  /** The unread boundary as it stood when the card was expanded. */
  frozenReadAt: number;
  /** First-screenful cards mount their bodies on the first frame, before the
   *  viewport observer has answered. */
  defaultNear: boolean;
}) {
  const router = useRouter();
  const { now, present, toggle } = useThreadsPage();
  const spec = THREAD_KIND_SPECS[card.kind];
  const unread = card.unread > 0;

  // "Done" archives the follow: only the thread_reads-backed kinds have a row
  // to archive. DM, session and question cards are projections of other state
  // with their own lifecycles.
  const dismissible = card.kind === "chat" || card.kind === "comment" || card.kind === "task" || card.kind === "page";
  const dismiss = useCallback(() => {
    const row = card.source as ThreadInboxRow;
    useInboxStore.getState().dismissThread(row.kind, row.root_key);
  }, [card]);

  const open = useCallback(
    () => {
      if (card.kind === "comment") {
        // A comment thread opens ON its message: the conversation view honors
        // scrollToMessageId and pages it in (the same path the rail's jump uses).
        const row = card.source as ThreadInboxRow;
        const conversationId = String(row.conversation_id ?? row.root_key.split(":")[0]);
        const st = useInboxStore.getState();
        st.requestNavigate(conversationId, { scrollToMessageId: row.message_id ? String(row.message_id) : undefined, source: "gesture" });
        if (row.message_id) st.openCommentThread(String(row.message_id));
      }
      router.push(card.href);
    },
    [router, card],
  );

  // Opening a long thread mounts a composer that focuses itself, and the
  // browser scrolls that focus into view — which pushes the card's own head off
  // the top of the page. This effect runs after the child's focus, so bringing
  // the card head back wins. Only a USER's expand may move the page (and never
  // the mount itself): default-open cards and revisits must not scroll-fight
  // over a list where most cards are expanded.
  const ref = useRef<HTMLElement | null>(null);
  // True only on the commit where the user's own click expanded the card —
  // NOT on mount (a persisted user entry on a revisit), and NOT when a
  // windowed-out body of a user-expanded card mounts again later: an
  // autofocus on that late mount would yank the page scroll to a card the
  // reader long since walked away from. The composer inherits this window
  // (focusComposer below), so focus rides the gesture, never the mount.
  const prevExpandedRef = useRef(expanded);
  const justUserExpanded = expanded && !prevExpandedRef.current && expandedBy === "user";
  useWatchEffect(() => {
    prevExpandedRef.current = expanded;
    if (!justUserExpanded) return;
    ref.current?.scrollIntoView({ block: "start" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  // The mount window and the read law's witness (see the header comment).
  const near = useNearViewport(ref, defaultNear);
  const mountBody = expanded && near;
  const measureRef = useBodyMeasure(card.id);
  const tailRef = useRef<HTMLDivElement | null>(null);
  const tailSeen = useOnScreen(tailRef, mountBody);
  const seen = present && mountBody && tailSeen;

  const Glyph = spec.Glyph;
  const Label = spec.Label;
  const Root = spec.Root;
  const Expanded = spec.Expanded;

  return (
    <section ref={ref} className={`th-card th-kind-${card.kind} ${unread ? "th-card-unread" : ""} ${expanded ? "th-card-expanded" : ""} ${expanded && expandedBy === "auto" ? "th-card-auto" : ""}`}>
      <div className="th-card-head">
        <button type="button" className="th-card-hit" onClick={() => toggle(card)} aria-expanded={expanded}>
          <span className={`th-card-kind th-tone-${spec.tone}`} aria-label={spec.label} title={spec.label}>
            {Glyph ? <Glyph card={card} /> : <spec.icon className="w-3 h-3" />}
          </span>
          <span className="th-card-chan">
            <Label card={card} />
          </span>
          {unread && (
            <span className="th-card-badge" aria-label={`${card.unread} new`}>
              {card.unread}{card.unreadCapped ? "+" : ""} new
            </span>
          )}
          <span className="th-card-spacer" />
          <span className="th-card-age" title={new Date(card.activityAt).toLocaleString()}>
            {relTimeShort(card.activityAt, now)}
          </span>
          <span className={`th-card-caret ${expanded ? "th-card-caret-open" : ""}`} aria-hidden="true">
            <ChevronRight className="w-3.5 h-3.5" />
          </span>
        </button>
        {dismissible && (
          <button
            type="button"
            className="ch-tool th-card-tool"
            aria-label="Done"
            title="Done — remove from inbox (comes back on new activity)"
            onClick={dismiss}
          >
            <Check className="w-3 h-3" />
          </button>
        )}
        <button type="button" className="ch-tool th-card-tool" aria-label="Open" title="Open" onClick={open}>
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      <Root card={card} expanded={expanded} />

      {expanded && (mountBody ? (
        <div ref={measureRef} className="th-card-body">
          <Expanded
            card={card}
            present={present}
            seen={seen}
            frozenReadAt={frozenReadAt}
            focusComposer={justUserExpanded}
          />
          <div ref={tailRef} className="th-card-tail" aria-hidden="true" />
        </div>
      ) : (
        <div className="th-card-body th-card-body-ghost" style={{ height: ghostHeight(card.id) }} aria-hidden="true" />
      ))}
    </section>
  );
});
