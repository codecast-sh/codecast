import Link from "next/link";
import { Bot, Star } from "lucide-react";
import { useInboxStore, type DocItem } from "../../store/inboxStore";
import type { ItemRowState } from "../ListRowShell";
import { DocDates } from "../DocDates";
import { docOrigin, docTypeLabel } from "@codecast/shared/docs";
import { docTypeStyle } from "../../lib/docTypeStyle";
import { getLabelColor } from "../../lib/labelColors";
import { useHostedMode } from "../../lib/surfaces";
import { formatRowTime, sessionCardTitle } from "../../lib/sessionCard";
import { hostedNoteLines } from "../../lib/hostedNoteRow";

export function DocRow({ doc, onStar, timeKey = "updated_at" }: {
  doc: DocItem;
  /** The time the row shows: the list's sort key (created or updated), so
   *  the column agrees with the order. */
  timeKey?: "created_at" | "updated_at";
  /** The list's row state; the doc row draws none of it. */
  state?: ItemRowState;
  /** Star or unstar. Without it the row stars through the store's pinDoc,
   *  which is what the docs list relies on; a caller drawing from fixtures
   *  rather than the store passes its own. */
  onStar?: (doc: DocItem, starred: boolean) => void;
}) {
  const cfg = docTypeStyle(doc.doc_type);
  const title = (doc as any).display_title || doc.title || "Untitled";
  // Hosted mode lists notes as a reader would: the title over a line of what
  // it says and the conversation it came from, with no type dot or tag
  // (every hosted note is a note).
  const hosted = useHostedMode();
  const source = useInboxStore((s) => {
    const id = hosted ? (doc as any).conversation_id : undefined;
    const row = id ? s.sessions[id] ?? s.conversations[id] : undefined;
    return row ? sessionCardTitle(row as any) : null;
  });
  if (hosted) {
    const { title: shownTitle, snippet } = hostedNoteLines(doc as any);
    return (
      <>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sol-text">{shownTitle}</span>
          {(snippet || source) && (
            <span data-cc-note-snippet className="mt-0.5 block truncate text-[12px] text-sol-text-dim">
              {snippet}
              {snippet && source ? " · " : null}
              {source ? <span className="text-sol-text-dim/80">From {source}</span> : null}
            </span>
          )}
        </span>
        {doc.pinned && <Star aria-label="Starred" className="h-3 w-3 shrink-0 fill-current text-sol-yellow" />}
        {/* The rail's time words (formatRowTime), never "31m ago" beside "Mar 26". */}
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-sol-text-dim">{formatRowTime(doc[timeKey] ?? doc.updated_at, true)}</span>
      </>
    );
  }

  return (
    <>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
      {/* The star (stored as `pinned`): a starred doc sits on the shelf and
          sorts first. Hidden until hover on an unstarred row so the list
          stays quiet; always shown once set. */}
      <button
        onClick={(e) => { e.stopPropagation(); if (onStar) onStar(doc, !doc.pinned); else useInboxStore.getState().pinDoc(doc._id, !doc.pinned); }}
        className={`flex-shrink-0 p-0.5 -m-0.5 rounded transition-colors ${doc.pinned ? "text-sol-yellow" : "text-sol-text-dim/50 opacity-0 group-hover:opacity-100 hover:text-sol-yellow"}`}
        title={doc.pinned ? "Unstar" : "Star (keeps it on your shelf)"}
        aria-label={doc.pinned ? "Unstar document" : "Star document"}
      >
        <Star className={`w-3 h-3 ${doc.pinned ? "fill-current" : ""}`} />
      </button>
      <span className="flex-1 text-sol-text truncate min-w-0">{title}</span>
      {docOrigin(doc) === "agent" && (
        <span className="flex-shrink-0 cq-hide-compact" title={`${doc.source} created`}><Bot className="w-3.5 h-3.5 text-sol-text-dim/60" /></span>
      )}
      {doc.plan_short_id && (
        <Link
          href={`/plans/${doc.plan_short_id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] px-1.5 py-0.5 rounded border border-sol-border/30 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/30 transition-colors flex-shrink-0 cq-hide-compact"
        >
          {doc.plan_short_id}
        </Link>
      )}
      {doc.labels && doc.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-shrink min-w-0 overflow-hidden flex-nowrap cq-hide-compact">
          {doc.labels.slice(0, 2).map((l) => {
            const lc = getLabelColor(l);
            return (
              <span key={l} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0 rounded-full border whitespace-nowrap ${lc.bg} ${lc.border} ${lc.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                {l}
              </span>
            );
          })}
          {doc.labels.slice(2).map((l) => {
            const lc = getLabelColor(l);
            return (
              <span key={l} className={`w-2 h-2 rounded-full flex-shrink-0 ${lc.dot}`} title={l} />
            );
          })}
        </div>
      )}
      <span className="text-[10px] text-gray-500 flex-shrink-0 tabular-nums cq-hide-minimal">{docTypeLabel(doc.doc_type)}</span>
      <DocDates doc={doc} className="text-xs text-gray-500 flex-shrink-0 cq-hide-minimal" />
    </>
  );
}
