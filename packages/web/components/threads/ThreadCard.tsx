import { memo, useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, ExternalLink } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import type { ThreadInboxRow } from "../../store/threadTypes";
import { THREAD_KIND_SPECS, isDismissible } from "../../lib/threadKinds";
import type { ThreadCardModel } from "../../lib/threadCards";
import { openCardIn } from "../../lib/threadRows";
import { useThreadsPage } from "./threadsContext";
import { useMountEffect } from "../../hooks/useMountEffect";

// One thread on the Threads page, whatever the kind, always open: a head
// naming the object (room, task, session, page) and under it the body with
// enough of the conversation to read and answer without leaving the page.
// Nothing scrolls inside a thread; a body folds its older items behind a
// button instead (threads/readerFold).
//
// Every body mounts with the page, so the list has its full height from the
// start and nothing changes size as the reader scrolls. A thread is read when
// it is on screen while the reader is here: the kind's own read-mark effect
// follows `seen`.

/** How much of a card must be in view before it counts as read: half of the
 *  card, or half the viewport for a card taller than the screen. A card
 *  peeking in at the bottom edge has not been read. */
const READ_SHARE = 0.5;
const THRESHOLDS = Array.from({ length: 21 }, (_, i) => i / 20);

/** Whether enough of the card is in the viewport to have been read. */
function useOnScreen(ref: React.RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useMountEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setOnScreen(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => {
      const viewport = e.rootBounds?.height ?? window.innerHeight;
      const need = Math.min(e.boundingClientRect.height, viewport) * READ_SHARE;
      setOnScreen(e.isIntersecting && e.intersectionRect.height >= need);
    }, { threshold: THRESHOLDS });
    io.observe(el);
    return () => io.disconnect();
  });
  return onScreen;
}

export const ThreadCard = memo(function ThreadCard({
  card,
  index,
  selected,
  frozenReadAt,
  focusComposer,
}: {
  card: ThreadCardModel;
  /** Position in the list: the keyboard walk scrolls to it. */
  index: number;
  /** The keyboard cursor is on this thread. */
  selected: boolean;
  /** The unread boundary as the visit first saw it. */
  frozenReadAt: number;
  /** The reader asked for the composer (the `r` key): grab focus once. */
  focusComposer: boolean;
}) {
  const router = useRouter();
  const { now, present, select } = useThreadsPage();
  const spec = THREAD_KIND_SPECS[card.kind];
  const unread = card.unread > 0;

  const dismiss = useCallback(() => {
    const row = card.source as ThreadInboxRow;
    useInboxStore.getState().dismissThread(row.kind, row.root_key);
  }, [card]);
  const openIn = useCallback(() => openCardIn(card, router), [router, card]);

  const ref = useRef<HTMLElement | null>(null);
  const onScreen = useOnScreen(ref);

  const Glyph = spec.Glyph;
  const Label = spec.Label;
  const Meta = spec.Meta;
  const Expanded = spec.Expanded;

  return (
    <section
      ref={ref}
      data-thread-index={index}
      className={`th-row th-kind-${card.kind} ${unread ? "th-row-unread" : ""} ${selected ? "th-row-selected" : ""}`}
      onMouseDown={selected ? undefined : () => select(card)}
    >
      <div className="th-row-head">
        <span className={`th-row-kind th-tone-${spec.tone}`} aria-label={spec.label} title={spec.label}>
          {Glyph ? <Glyph card={card} /> : <spec.icon className="w-3 h-3" />}
        </span>
        <span className="th-row-title">
          <Label card={card} />
        </span>
        {unread && (
          <span className="th-row-badge" aria-label={`${card.unread} new`}>
            {card.unread}{card.unreadCapped ? "+" : ""} new
          </span>
        )}
        <span className="th-row-age" title={new Date(card.activityAt).toLocaleString()}>
          {relTimeShort(card.activityAt, now)}
        </span>
        <span className="th-row-tools">
          {isDismissible(card) && (
            <button type="button" className="ch-tool th-row-tool" aria-label="Done" title="Done: archive (comes back on new activity)" onClick={dismiss}>
              <Check className="w-3 h-3" />
            </button>
          )}
          <button type="button" className="ch-tool th-row-tool" aria-label="Open" title="Open" onClick={openIn}>
            <ExternalLink className="w-3 h-3" />
          </button>
        </span>
      </div>

      <div className="th-card-body">
        {Meta && <Meta card={card} />}
        <Expanded
          card={card}
          present={present}
          seen={present && onScreen}
          frozenReadAt={frozenReadAt}
          focusComposer={focusComposer}
        />
      </div>
    </section>
  );
});
