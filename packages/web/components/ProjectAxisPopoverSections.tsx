import { clickProjectChip } from "../store/chipFilterClicks";
import type { ProjectFilterTerm } from "../store/inboxStore";
import { getLabelColor } from "../lib/labelColors";

/**
 * The chip row popover's project-axis lists, each under its heading: folders
 * (where a session ran), projects (Codecast projects, store/workProjects) and
 * machines (the device running it, owner_device_id). A row filters on click
 * (⌥ hides, ⇧ adds) and opens the chip menu on right-click.
 */
export function ProjectAxisPopoverSections({
  sections,
  chipLabel,
  projectFilters,
  projectPathByName,
  onPick,
  onContextMenu,
}: {
  sections: Array<[string, Array<[string, number]>]>;
  chipLabel: (name: string) => string;
  projectFilters: readonly ProjectFilterTerm[];
  projectPathByName: Record<string, string>;
  /** After a pick; `shift` keeps the popover open for another term. */
  onPick: (shift: boolean) => void;
  onContextMenu: (e: React.MouseEvent, name: string) => void;
}) {
  return (
    <>
      {sections.map(([heading, rows]) => rows.length > 0 && (
        <div key={heading}>
          <div className="mt-0.5 border-t border-sol-border/40 px-3 pt-2 pb-1 text-mark font-semibold uppercase tracking-widest text-sol-text-dim/70 modern:text-meta modern:font-medium modern:normal-case modern:tracking-normal modern:text-sol-text-dim">
            {heading}
          </div>
          {rows.map(([name, count]) => {
            const label = chipLabel(name);
            const pc = getLabelColor(label);
            const term = projectFilters.find((t) => t.id === name);
            const active = !!term;
            const excluded = !!term?.exclude;
            return (
              <div
                key={name}
                onClick={(e) => {
                  clickProjectChip(name, projectPathByName[name] || null, e.altKey, e.shiftKey);
                  onPick(e.shiftKey);
                }}
                onContextMenu={(e) => onContextMenu(e, name)}
                className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors modern:mx-1 modern:min-h-control-sm modern:rounded-control modern:px-2 modern:py-1 modern:text-ui ${
                  active ? "bg-sol-cyan/10 text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt/60"
                }`}
                title={excluded ? "Hidden — click to clear" : active ? "Filtering — click to clear" : "Click to filter — right-click for more"}
              >
                <span className="w-3" />
                <span className={`w-2 flex-shrink-0 ${excluded ? `h-[2px] rounded-full ${pc.dot}` : `h-2 rounded-full ${pc.dot}`}`} />
                <span className={`flex-1 truncate ${active ? "font-medium" : ""} ${excluded ? "opacity-75" : ""}`}>{label}</span>
                <span className="text-meta tabular-nums text-sol-text-dim/70">{count}</span>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
