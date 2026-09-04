import { getLabelColor } from "../lib/labelColors";

/** How many labels may spell out their name, most rows carrying 3-4 of them. */
const MAX_NAMED = 2;

/**
 * Labels in a dense list row. A label is a color dot by default and spells out
 * its name only where the list is wide enough to pay for it: the first name at
 * one container width, the second at a wider one, the rest stay dots at every
 * size (see .cq-label-t1 / .cq-label-t2 in globals.css). Every chip in the row is
 * flex-shrink-0, so the width a name takes comes out of the row's title — which
 * is why the widths, not the row's own content, decide.
 *
 * A chip is ONE element at both sizes, so the dot never moves: the name grows
 * out of it and folds back in.
 */
export function LabelChips({
  labels,
  dotClass = "w-2 h-2",
  className = "",
  onLabelClick,
}: {
  labels: string[];
  dotClass?: string;
  className?: string;
  onLabelClick?: (label: string) => void;
}) {
  if (!labels || labels.length === 0) return null;
  return (
    <div className={`flex items-center gap-1 flex-shrink-0 ${className}`}>
      {labels.map((l, i) => {
        const lc = getLabelColor(l);
        const tier = i < MAX_NAMED ? `cq-label-t${i + 1} ${lc.bg} ${lc.border} ${lc.text}` : "";
        const Chip = onLabelClick ? "button" : "span";
        return (
          <Chip
            key={l}
            type={onLabelClick ? "button" : undefined}
            title={onLabelClick ? `Filter by label: ${l}` : l}
            aria-label={onLabelClick ? `Filter by label: ${l}` : undefined}
            onClick={onLabelClick ? (e) => { e.stopPropagation(); onLabelClick(l); } : undefined}
            className={`inline-flex items-center gap-1 flex-shrink-0 rounded-full py-0 text-[10px] leading-4 whitespace-nowrap ${tier} ${onLabelClick ? "hover:brightness-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-cyan" : ""}`}
          >
            <span className={`${dotClass} rounded-full flex-shrink-0 ${lc.dot}`} />
            {i < MAX_NAMED && <span className="cq-label-name max-w-[10rem] truncate">{l}</span>}
          </Chip>
        );
      })}
    </div>
  );
}
