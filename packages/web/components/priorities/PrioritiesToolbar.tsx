// /priorities' one row of view controls: a chip per workspace (filled when
// shown, dashed when turned off), Group by (a field like the inbox's group-by
// picker) and Compact. Which of them show is lib/prioritySections
// pageControls; the choices ride clientState.ui.priorities_view, so they
// follow the person to every device. On a phone the chips scroll sideways
// under an edge fade, and Group by and Compact fold to their icons.
import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, Layers, Rows3, User } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { workspaceMarkOf } from "../../store/priorityOrder";
import { GROUP_BY_LABEL, type GroupBy, type PageControls } from "../../lib/prioritySections";
import type { PrioritiesViewPrefs, usePrioritiesView } from "../../hooks/usePriorities";
import { TOUCH_AREA, type ListLayout } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { sameEdges, scrollEdges, type ScrollEdges } from "../../lib/scrollEdges";
import { TeamIcon } from "../TeamIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { modernButton } from "../ui/modernLook";

/** A workspace's mark: the person icon for the viewer's own, else its team's icon in its colour. */
export function WorkspaceMark({ workspace, className }: { workspace: string; className?: string }) {
  const teams = useInboxStore((s) => s.teams);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const mark = workspaceMarkOf(workspace, teams, viewerId);
  if (!mark || mark.personal) return <User aria-hidden className={cn("text-sol-text-muted", className)} />;
  return <TeamIcon icon={mark.icon} color={mark.color} className={className} />;
}

export function PrioritiesToolbar({ controls, view, groupBy, onChange, layout }: {
  controls: PageControls;
  view: PrioritiesViewPrefs;
  /** The grouping the page draws (lib/prioritySections effectiveGroupBy). */
  groupBy: GroupBy;
  onChange: ReturnType<typeof usePrioritiesView>[1];
  layout: ListLayout;
}) {
  const phone = layout === "phone";
  const [edges, setEdges] = useState<ScrollEdges>({ left: false, right: false });
  const measureChips = useCallback((el: HTMLElement) => {
    const next = scrollEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setEdges((e) => (sameEdges(e, next) ? e : next));
  }, []);
  // Measured again whenever the row or its chips change size (a resize, a chip turned off).
  const observer = useRef<ResizeObserver | null>(null);
  const chipsRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    measureChips(el);
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(() => measureChips(el));
    observer.current.observe(el);
    for (const chip of el.children) observer.current.observe(chip);
  }, [measureChips]);
  const toggle = (key: string) => onChange({ hidden: view.hidden.includes(key) ? view.hidden.filter((k) => k !== key) : [...view.hidden, key] });
  return (
    <div data-priorities-toolbar className="flex min-w-0 items-center gap-2 pb-1 pt-3">
      {controls.showChips && (
        // A 24px fade on each edge with chips past it: the right while more lie that way, the left once scrolled.
        <div
          ref={chipsRef}
          onScroll={(e) => measureChips(e.currentTarget)}
          data-workspace-chips
          data-fade-left={edges.left || undefined}
          data-fade-right={edges.right || undefined}
          style={{ maskImage: fadeMask(edges), WebkitMaskImage: fadeMask(edges) }}
          className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none] [@media(pointer:coarse)]:py-2 [&::-webkit-scrollbar]:hidden"
        >
          {controls.workspaces.map((w) => {
            const on = !view.hidden.includes(w.key);
            return (
              <button
                key={w.key}
                type="button"
                data-workspace-chip={w.key}
                aria-pressed={on}
                title={on ? `Hide ${w.name}` : `Show ${w.name}`}
                onClick={() => toggle(w.key)}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-meta font-medium transition-colors",
                  TOUCH_AREA,
                  on
                    ? "border-sol-border bg-sol-bg-alt text-sol-text hover:bg-sol-bg-highlight"
                    : "border-dashed border-sol-border text-sol-text-dim hover:text-sol-text-muted",
                )}
              >
                <WorkspaceMark workspace={w.key} className={cn("size-3.5 shrink-0", !on && "opacity-50")} />
                {w.name}
              </button>
            );
          })}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {controls.showGroupBy && <GroupByPicker value={groupBy} options={controls.groupByOptions} onChange={(g) => onChange({ group_by: g })} phone={phone} />}
        <button
          type="button"
          data-compact-toggle
          aria-pressed={view.compact}
          aria-label="Compact"
          title={view.compact ? "Show milestones" : "One line per priority"}
          onClick={() => onChange({ compact: !view.compact })}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-control text-meta font-medium transition-colors",
            phone ? "size-11 justify-center" : cn("h-7 px-2", TOUCH_AREA),
            view.compact ? "bg-sol-text/[0.08] text-sol-text" : "text-sol-text-muted hover:bg-sol-text/[0.06] hover:text-sol-text",
          )}
        >
          <Rows3 className="size-3.5 shrink-0" aria-hidden />
          {!phone && "Compact"}
        </button>
      </div>
    </div>
  );
}

const FADE = "24px";
/** The chips' mask: opaque but for a fade on each edge with more chips past it. */
const fadeMask = ({ left, right }: ScrollEdges) =>
  `linear-gradient(to right, ${left ? "transparent" : "black"}, black ${FADE}, black calc(100% - ${FADE}), ${right ? "transparent" : "black"})`;

/** Group by, drawn as the inbox's group-by picker draws its field (components/InboxViewPicker). */
function GroupByPicker({ value, options, onChange, phone }: { value: GroupBy; options: GroupBy[]; onChange: (g: GroupBy) => void; phone: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-group-by-picker
          aria-label={`Grouped by ${GROUP_BY_LABEL[value].toLowerCase()}`}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-[5px] text-meta font-medium text-sol-text-secondary transition-colors hover:bg-sol-text/[0.06] hover:text-sol-text data-[state=open]:bg-sol-text/[0.06]",
            modernButton({ variant: "ghost", size: "xs" }, "modern:text-sol-text modern:data-[state=open]:bg-sol-text/[0.06]"),
            // After the Modern look, whose xs size would otherwise make the phone's 44px square 24px tall.
            phone ? "size-11 justify-center modern:size-11" : cn("h-7 px-1.5", TOUCH_AREA),
          )}
        >
          <Layers className="size-3.5 shrink-0" aria-hidden />
          {!phone && <span>{GROUP_BY_LABEL[value]}</span>}
          <ChevronDown className="size-2.5 shrink-0 opacity-60" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">Group by</DropdownMenuLabel>
        {options.map((g) => (
          <DropdownMenuItem key={g} data-group-by-option={g} onSelect={() => onChange(g)} className="text-xs [@media(pointer:coarse)]:min-h-11">
            <span className="flex-1 whitespace-nowrap">{GROUP_BY_LABEL[g]}</span>
            {g === value && <Check className="size-3 text-sol-cyan" aria-hidden />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
