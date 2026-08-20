import { memo, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import type { ThreadInboxRow } from "../../store/threadTypes";
import { THREAD_KIND_SPECS } from "../../lib/threadKinds";
import type { ThreadCardModel } from "../../lib/threadCards";
import { useThreadsPage } from "./threadsContext";

// One card, whatever the kind: the generic shell — kind tile and object
// label, unread badge, age, caret, and beside them the open-in-place link —
// around the kind's own Root (collapsed body) and Expanded (the thread in
// place). The head is two sibling buttons, never one inside the other: the
// hit area toggles, the tool opens. The kind is looked up in lib/threadKinds;
// nothing here branches on it except the open link for a comment, which lands
// the conversation on its message.

export const ThreadCard = memo(function ThreadCard({
  card,
  expanded,
  frozenReadAt,
}: {
  card: ThreadCardModel;
  expanded: boolean;
  /** The unread boundary as it stood when the card was expanded. */
  frozenReadAt: number;
}) {
  const router = useRouter();
  const { now, present, toggle } = useThreadsPage();
  const spec = THREAD_KIND_SPECS[card.kind];
  const unread = card.unread > 0;

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
  // the card head back wins. The head then stays put: it is sticky while the
  // card is on screen (threads.css), so the reader keeps the thread's name.
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!expanded) return;
    ref.current?.scrollIntoView({ block: "start" });
  }, [expanded]);

  const Glyph = spec.Glyph;
  const Label = spec.Label;
  const Root = spec.Root;
  const Expanded = spec.Expanded;

  return (
    <section ref={ref} className={`th-card th-kind-${card.kind} ${unread ? "th-card-unread" : ""} ${expanded ? "th-card-expanded" : ""}`}>
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
          <span className="th-card-caret" aria-hidden="true">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </span>
        </button>
        <button type="button" className="ch-tool th-card-tool" aria-label="Open" title="Open" onClick={open}>
          <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      <Root card={card} expanded={expanded} />

      {expanded && <Expanded card={card} present={present} frozenReadAt={frozenReadAt} />}
    </section>
  );
});
