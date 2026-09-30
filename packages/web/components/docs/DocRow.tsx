import Link from "next/link";
import { Bot, Star } from "lucide-react";
import { useInboxStore, type DocItem } from "../../store/inboxStore";
import type { ItemRowState } from "../ListRowShell";
import { DocDates } from "../DocDates";
import { docOrigin, docTypeLabel, type DocType } from "@codecast/shared/docs";
import { getLabelColor } from "../../lib/labelColors";

// Styling only; the type list and labels come from @codecast/shared/docs.
// Typed by DocType so a type added there without a style here fails to compile.
export const DOC_TYPE_STYLE: Record<DocType, { color: string; dot: string }> = {
  note: { color: "text-gray-400", dot: "bg-gray-400" },
  plan: { color: "text-sol-blue", dot: "bg-sol-blue" },
  design: { color: "text-sol-violet", dot: "bg-sol-violet" },
  spec: { color: "text-sol-cyan", dot: "bg-sol-cyan" },
  investigation: { color: "text-sol-yellow", dot: "bg-sol-yellow" },
  handoff: { color: "text-sol-orange", dot: "bg-sol-orange" },
  decision: { color: "text-sol-red", dot: "bg-sol-red" },
  charter: { color: "text-sol-magenta", dot: "bg-sol-magenta" },
  brief: { color: "text-sol-green", dot: "bg-sol-green" },
};
export const docTypeStyle = (docType: string) => DOC_TYPE_STYLE[docType as DocType] ?? DOC_TYPE_STYLE.note;

export function DocRow({ doc, onStar }: {
  doc: DocItem;
  /** The list's row state; the doc row draws none of it. */
  state?: ItemRowState;
  /** Star or unstar; the docs list writes the store's pinDoc. */
  onStar?: (doc: DocItem, starred: boolean) => void;
}) {
  const cfg = docTypeStyle(doc.doc_type);
  const title = (doc as any).display_title || doc.title || "Untitled";

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
