import { Clock, PencilLine } from "lucide-react";
import {
  type DatedRow,
  describeDatesFull,
  formatDateFull,
  formatDateSmart,
  wasEdited,
} from "@codecast/shared/time";
import { useCoarseNow } from "../hooks/useCoarseNow";

// The one way a doc's created/updated dates render. Every doc surface — the
// docs list, the doc page, the share page, related-doc rows on tasks, projects
// and profiles, embeds, hover cards — mounts this, so a doc's age reads the
// same everywhere and the tooltip always carries both full dates.
//
// `compact` is one stamp for a tight row: the last edit's age (or creation,
// when never edited), with created + updated in the tooltip. `full` spells
// both out for a header: "Created Aug 2 · Updated 3h ago".
//
// All stamps age off useCoarseNow so a list of N rows costs one timer, and a
// row that crosses a threshold ("59m ago" → "1h ago") re-renders on its own.

type Props = {
  doc: DatedRow;
  variant?: "compact" | "full";
  className?: string;
};

export function DocDates({ doc, variant = "compact", className = "" }: Props) {
  const now = useCoarseNow(30_000);
  const edited = wasEdited(doc);

  if (variant === "compact") {
    const ts = edited ? doc.updated_at! : doc.created_at;
    return (
      <span className={`tabular-nums whitespace-nowrap ${className}`} title={describeDatesFull(doc)}>
        {formatDateSmart(ts, now)}
      </span>
    );
  }

  return (
    <span className={`inline-flex items-center gap-3 whitespace-nowrap ${className}`}>
      <span className="inline-flex items-center gap-1" title={formatDateFull(doc.created_at)}>
        <Clock className="w-3 h-3" />
        Created {formatDateSmart(doc.created_at, now)}
      </span>
      {edited && (
        <span className="inline-flex items-center gap-1" title={formatDateFull(doc.updated_at!)}>
          <PencilLine className="w-3 h-3" />
          Updated {formatDateSmart(doc.updated_at!, now)}
        </span>
      )}
    </span>
  );
}
