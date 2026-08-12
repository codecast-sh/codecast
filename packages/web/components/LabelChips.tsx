import { getLabelColor } from "../lib/labelColors";

/**
 * Labels in a dense list row. A label is a color dot by default and spells out
 * its name only inside a wide list container (see .cq-label-chip in globals.css)
 * — every chip in the row is flex-shrink-0, so the width a name takes comes out
 * of the row's title, and the name is only worth that trade where the title
 * still has room. It stays ONE element at both widths, so the dot never moves:
 * the name grows out of it and folds back in.
 *
 * A row carrying more than `max` labels keeps dots at every width — a fistful of
 * names crowds the title whatever the container is doing.
 */
export function LabelChips({
  labels,
  max = 2,
  dotClass = "w-2 h-2",
  className = "",
}: {
  labels: string[];
  /** Above this many labels the row stays dots-only. */
  max?: number;
  dotClass?: string;
  className?: string;
}) {
  if (!labels || labels.length === 0) return null;
  const expandable = labels.length <= max;
  return (
    <div className={`flex items-center gap-1 flex-shrink-0 ${className}`}>
      {labels.map((l) => {
        const lc = getLabelColor(l);
        return (
          <span
            key={l}
            title={l}
            className={`inline-flex items-center gap-1 flex-shrink-0 rounded-full py-0 text-[10px] leading-4 whitespace-nowrap ${
              expandable ? `cq-label-chip ${lc.bg} ${lc.border} ${lc.text}` : ""
            }`}
          >
            <span className={`${dotClass} rounded-full flex-shrink-0 ${lc.dot}`} />
            {expandable && <span className="cq-label-text">{l}</span>}
          </span>
        );
      })}
    </div>
  );
}
