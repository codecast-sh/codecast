import Link from "next/link";
import { Bot, Star } from "lucide-react";
import { useInboxStore, type DocItem } from "../../store/inboxStore";
import type { ItemRowState } from "../ListRowShell";
import { DocDates } from "../DocDates";
import { docOrigin, docTypeLabel } from "@codecast/shared/docs";
import { DocTypeMark } from "./DocTypeMark";
import { getLabelColor } from "../../lib/labelColors";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { modernPill, modernPillShape } from "../ui/modernLook";

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
  // Modern adds its looks; Classic's class strings stay as they were.
  const m = useIsModernStyle();
  const title = (doc as any).display_title || doc.title || "Untitled";
  return (
    <>
      <DocTypeMark type={doc.doc_type} size={14} />
      {/* The star (stored as `pinned`): a starred doc sits on the shelf and
          sorts first. Hidden until hover on an unstarred row so the list
          stays quiet; always shown once set. */}
      <button
        onClick={(e) => { e.stopPropagation(); if (onStar) onStar(doc, !doc.pinned); else useInboxStore.getState().pinDoc(doc._id, !doc.pinned); }}
        className={`flex-shrink-0 p-0.5 -m-0.5 rounded transition-colors ${doc.pinned ? "text-sol-yellow" : "text-sol-text-dim/50 opacity-0 group-hover:opacity-100 hover:text-sol-yellow"}${m ? " modern:-m-1.5 modern:rounded-control modern:p-1.5 modern:hover:bg-sol-text/[0.06]" : ""}`}
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
          className={`text-meta px-1.5 py-0.5 rounded border border-sol-border/30 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/30 transition-colors flex-shrink-0 cq-hide-compact${m ? ` ${modernPill({}, "modern:font-mono modern:font-normal modern:hover:text-sol-cyan")}` : ""}`}
        >
          {doc.plan_short_id}
        </Link>
      )}
      {doc.labels && doc.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-shrink min-w-0 overflow-hidden flex-nowrap cq-hide-compact">
          {doc.labels.slice(0, 2).map((l) => {
            const lc = getLabelColor(l);
            return (
              <span key={l} className={`inline-flex items-center gap-1 text-meta px-1.5 py-0 rounded-full border whitespace-nowrap ${lc.bg} ${lc.border} ${lc.text}${m ? ` ${modernPillShape()}` : ""}`}>
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
      <span className="text-meta text-sol-text-dim flex-shrink-0 tabular-nums cq-hide-minimal">{docTypeLabel(doc.doc_type)}</span>
      <DocDates doc={doc} className="text-xs text-sol-text-dim flex-shrink-0 cq-hide-minimal" />
    </>
  );
}
