import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { clickProjectChip } from "../store/chipFilterClicks";
import type { ProjectFilterTerm } from "../store/inboxStore";
import { getLabelColor } from "../lib/labelColors";
import { axisKeyShowsCount, projectAxisNoun } from "../store/workProjects";
import { folderShortList, type FolderActivity } from "../lib/railFolderFilter";

/**
 * The chip row popover's project-axis lists, each under its heading: projects
 * (Codecast projects, store/workProjects), folders (where a session ran),
 * machines (the device running it, owner_device_id) and the viewer's Top N
 * priorities. A row filters on click (⌥ hides, ⇧ adds) and opens the chip
 * menu on right-click. Folders show the five worked in most
 * (lib/railFolderFilter) plus any in the filter, the rest behind "N more
 * folders", so a long folder list never pushes machines and priorities out of
 * reach; the fold closes with the popover, which unmounts this.
 */
export function ProjectAxisPopoverSections({
  sections,
  folderActivity,
  chipLabel,
  projectFilters,
  projectPathByName,
  onPick,
  onContextMenu,
}: {
  sections: Array<[string, Array<[string, number]>]>;
  folderActivity?: Record<string, FolderActivity>;
  chipLabel: (name: string) => string;
  projectFilters: readonly ProjectFilterTerm[];
  projectPathByName: Record<string, string>;
  /** After a pick; `shift` keeps the popover open for another term. */
  onPick: (shift: boolean) => void;
  onContextMenu: (e: React.MouseEvent, name: string) => void;
}) {
  const [foldersOpen, setFoldersOpen] = useState(false);
  const folderRows = sections.find(([heading]) => heading === "Folders")?.[1] ?? [];
  const shortFolders = useMemo(() => {
    const keep = new Set(folderShortList(folderRows, folderActivity));
    for (const t of projectFilters) if (projectAxisNoun(t.id) === "folder") keep.add(t.id);
    return folderRows.filter(([name]) => keep.has(name));
  }, [folderRows, folderActivity, projectFilters]);
  const foldedAway = folderRows.length - shortFolders.length;
  const shown = sections
    .map(([heading, rows]): [string, Array<[string, number]>] => [heading, heading === "Folders" && !foldersOpen ? shortFolders : rows])
    .filter(([heading, rows]) => rows.length > 0 || (heading === "Folders" && foldedAway > 0));
  return (
    <>
      {shown.map(([heading, rows], i) => (
        <div key={heading}>
          <div className={`px-3 pb-1 text-mark font-semibold uppercase tracking-widest text-sol-text-dim/70 modern:text-meta modern:font-medium modern:normal-case modern:tracking-normal modern:text-sol-text-dim ${i === 0 ? "pt-1.5" : "mt-0.5 border-t border-sol-border/40 pt-2"}`}>
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
                data-popover-axis-row={name}
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
                {axisKeyShowsCount(name) && <span className="text-meta tabular-nums text-sol-text-dim/70">{count}</span>}
              </div>
            );
          })}
          {heading === "Folders" && foldedAway > 0 && (
            <button
              type="button"
              data-popover-axis-fold={heading}
              onClick={() => setFoldersOpen((v) => !v)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-meta text-sol-text-dim/70 hover:text-sol-text hover:bg-sol-bg-alt/60"
            >
              <ChevronRight className={`w-3 h-3 transition-transform ${foldersOpen ? "rotate-90" : ""}`} />
              <span className="tabular-nums">{foldersOpen ? "Fewer folders" : `${foldedAway} more folders`}</span>
            </button>
          )}
        </div>
      ))}
    </>
  );
}
