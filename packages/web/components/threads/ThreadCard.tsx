import { memo, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Bot, Check, ExternalLink } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { relTimeShort } from "../../lib/utils";
import type { ThreadInboxRow } from "../../store/threadTypes";
import { THREAD_KIND_SPECS, isDismissible } from "../../lib/threadKinds";
import type { ThreadCardModel } from "../../lib/threadCards";
import { useThreadsPage } from "./threadsContext";

import { useWatchEffect } from "../../hooks/useWatchEffect";
// One row of the Threads reader, whatever the kind. Collapsed, it is two
// lines: the kind tile and the object's name with the unread count and age,
// then who spoke last and what they said. That is the whole scan — a page of
// rows reads like an inbox, not a wall of threads. The one open row shows the
// kind's Meta line and its Expanded body (the thread in place, composer
// included) under a head that stays put while the body scrolls.
//
// The head is two sibling controls, never one inside the other: the hit area
// selects and opens, the tools act (Done, Open). The page owns the cursor
// (threadsContext.select / toggle) so the keyboard and the mouse move the
// same thing.

/** Open the card's object in place: the task page, the room, the published
 *  page. A comment thread opens ON its message — the conversation view
 *  honors scrollToMessageId and pages it in (the same path the rail's jump
 *  uses). Shared by the row's tool and the page's `o` key. */
export function openCardIn(card: ThreadCardModel, router: { push: (href: string) => void }): void {
  if (card.kind === "comment") {
    const row = card.source as ThreadInboxRow;
    const conversationId = String(row.conversation_id ?? row.root_key.split(":")[0]);
    const st = useInboxStore.getState();
    st.requestNavigate(conversationId, { scrollToMessageId: row.message_id ? String(row.message_id) : undefined, source: "gesture" });
    if (row.message_id) st.openCommentThread(String(row.message_id));
  }
  router.push(card.href);
}

/** Who spoke last: a person by name, an agent by its session. */
function PreviewWho({ who, kind }: { who?: string; kind?: "user" | "agent" }) {
  if (!who) return null;
  return (
    <span className={`th-row-who ${kind === "agent" ? "th-row-who-agent" : ""}`}>
      {kind === "agent" && <Bot className="w-3 h-3" aria-label="Agent" />}
      {who}
    </span>
  );
}

export const ThreadCard = memo(function ThreadCard({
  card,
  index,
  selected,
  open,
  frozenReadAt,
  focusComposer,
}: {
  card: ThreadCardModel;
  /** Position in the list, for the page's keyboard walk (scrollIntoView). */
  index: number;
  /** The cursor is on this row. */
  selected: boolean;
  /** The row is the page's one open row. */
  open: boolean;
  /** The unread boundary as it stood when the row was opened. */
  frozenReadAt: number;
  /** The reader asked for the composer (the `r` key): grab focus once. */
  focusComposer: boolean;
}) {
  const router = useRouter();
  const { now, present, toggle } = useThreadsPage();
  const spec = THREAD_KIND_SPECS[card.kind];
  const unread = card.unread > 0;
  const preview = spec.usePreview(card);

  const dismiss = useCallback(() => {
    const row = card.source as ThreadInboxRow;
    useInboxStore.getState().dismissThread(row.kind, row.root_key);
  }, [card]);

  const openIn = useCallback(() => openCardIn(card, router), [router, card]);

  // An opening row lands with its head at the top of the list, so the body
  // reads from its first line; a cursor moving over collapsed rows only
  // keeps itself in view.
  const ref = useRef<HTMLElement | null>(null);
  useWatchEffect(() => {
    if (!selected) return;
    ref.current?.scrollIntoView({ block: open ? "start" : "nearest" });
  }, [selected, open]);

  const Glyph = spec.Glyph;
  const Label = spec.Label;
  const Meta = spec.Meta;
  const Expanded = spec.Expanded;

  return (
    <section
      ref={ref}
      data-thread-index={index}
      className={`th-row th-kind-${card.kind} ${unread ? "th-row-unread" : ""} ${selected ? "th-row-selected" : ""} ${open ? "th-row-open" : ""}`}
    >
      <div className="th-row-head">
        <button
          type="button"
          className="th-row-hit"
          onClick={() => toggle(card)}
          aria-expanded={open}
        >
          <span className={`th-row-kind th-tone-${spec.tone}`} aria-label={spec.label} title={spec.label}>
            {Glyph ? <Glyph card={card} /> : <spec.icon className="w-3 h-3" />}
          </span>
          <span className="th-row-main">
            <span className="th-row-top">
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
            </span>
            {preview && (preview.who || preview.text) && (
              <span className="th-row-preview">
                <PreviewWho who={preview.who} kind={preview.whoKind} />
                {preview.text && <span className="th-row-text">{preview.text}</span>}
              </span>
            )}
          </span>
        </button>
        <span className="th-row-tools">
          {isDismissible(card) && (
            <button
              type="button"
              className="ch-tool th-row-tool"
              aria-label="Done"
              title="Done — remove from inbox (comes back on new activity)"
              onClick={dismiss}
            >
              <Check className="w-3 h-3" />
            </button>
          )}
          <button type="button" className="ch-tool th-row-tool" aria-label="Open" title="Open" onClick={openIn}>
            <ExternalLink className="w-3 h-3" />
          </button>
        </span>
      </div>

      {open && (
        <div className="th-card-body">
          {Meta && <Meta card={card} />}
          <Expanded
            card={card}
            present={present}
            // The row is open and the reader is here: that is the reading.
            // Each kind still waits for its own content before it marks.
            seen={present}
            frozenReadAt={frozenReadAt}
            focusComposer={focusComposer}
          />
        </div>
      )}
    </section>
  );
});
