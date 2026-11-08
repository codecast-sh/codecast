"use client";
// The project page's quick way to narrow the inbox beside it to this project
// (session-projects.md SP5): the project's own chip on the folder chip axis,
// pressed from here. Pressed again it clears; the inbox chip row shows the
// same chip lit, so both places tell the same state.
import { Filter } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { clickProjectChip } from "../../store/chipFilterClicks";
import { workProjectChipKey } from "../../store/workProjects";
import { cn } from "../../lib/utils";

export function ProjectInboxFilter({ projectId }: { projectId: string }) {
  const key = workProjectChipKey(projectId);
  const on = useInboxStore((s) => s.activeProjectFilter === key && !s.chipFilterExclude && !(s.extraProjectFilters?.length));
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={(e) => clickProjectChip(key, null, e.altKey, e.shiftKey)}
      title={on ? "Inbox shows this project only. Click to show everything" : "Show only this project's sessions in the inbox"}
      data-project-inbox-filter={on ? "on" : "off"}
      className={cn(
        "inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] transition-colors",
        on ? "bg-sol-cyan/15 text-sol-cyan" : "text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60",
      )}
    >
      <Filter className="w-3 h-3" />
      Inbox
    </button>
  );
}
