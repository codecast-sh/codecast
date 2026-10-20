import { useLayoutEffect, useRef, useState } from "react";
import { Activity, Clock, FolderKanban, List, Network, Tag, Target, Workflow, Zap } from "lucide-react";
import type { InboxViewMode, OrgLensMode } from "../store/inboxStore";
import { inboxViewModes } from "../store/inboxViewModes";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";

type ViewOption = { key: InboxViewMode; label: string; icon: typeof List };

const VIEW_OPTIONS: Record<InboxViewMode, Omit<ViewOption, "key">> = {
  grouped: { label: "Status", icon: List },
  recent: { label: "Updated", icon: Activity },
  time: { label: "Created", icon: Clock },
  bucket: { label: "Label", icon: Tag },
  plan: { label: "Plan", icon: Workflow },
  project: { label: "Project", icon: FolderKanban },
  goal: { label: "Goal", icon: Target },
  reports: { label: "Reports", icon: Network },
  trigger: { label: "Trigger", icon: Zap },
};

// The inbox's grouping as a row of tabs under the rail header: the current
// grouping is named, every other one is a click away. When the rail is too
// narrow for every name, the other tabs fold to their icons (named on hover)
// and only the current one keeps its word.
export function InboxViewTabs({ value, onChange, hasLabels, hasPlans, orgLenses = [], hasTriggers }: {
  value: InboxViewMode;
  onChange: (value: InboxViewMode) => void;
  hasLabels: boolean;
  hasPlans: boolean;
  /** The org lenses with something to group by, in tab order. */
  orgLenses?: readonly OrgLensMode[];
  hasTriggers: boolean;
}) {
  const options = inboxViewModes({ hasLabels, hasPlans, orgLenses, hasTriggers }).map((key) => ({ key, ...VIEW_OPTIONS[key] }));
  const current = options.find((option) => option.key === value) ?? options[0];
  const stripRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);

  // Compact when the fully labeled row (an invisible twin) is wider than the
  // strip. Measuring the twin, not the strip, keeps the answer stable: the
  // strip's own width changes with the mode it picks.
  const optionsSig = options.map((o) => o.key).join(",");
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const full = fullRef.current;
    if (!strip || !full) return;
    const measure = () => setCompact(full.scrollWidth > strip.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [optionsSig]);

  const pick = (index: number) => {
    const next = options[(index + options.length) % options.length];
    onChange(next.key);
    stripRef.current?.querySelector<HTMLButtonElement>(`[data-view-tab="${next.key}"]`)?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = options.indexOf(current);
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (step) pick(index + step);
    else if (e.key === "Home") pick(0);
    else if (e.key === "End") pick(options.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div data-inbox-view-tabs className="relative flex-shrink-0 border-b border-sol-border/40 bg-sol-bg">
      <div
        ref={stripRef}
        role="tablist"
        aria-label="Group inbox by"
        onKeyDown={onKeyDown}
        className="flex items-center gap-px px-1.5 py-1 overflow-x-auto [scrollbar-width:none]"
      >
        {options.map((option) => {
          const active = option.key === current.key;
          const Icon = option.icon;
          const tab = (
            <button
              role="tab"
              data-view-tab={option.key}
              aria-selected={active}
              aria-label={`By ${option.label.toLowerCase()}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(option.key)}
              className={`flex items-center gap-1 h-[22px] rounded-[5px] text-[10px] font-medium whitespace-nowrap transition-colors ${
                compact && !active ? "flex-1 justify-center min-w-[22px] px-1" : "px-1.5"
              } ${
                active
                  ? "bg-sol-cyan/15 text-sol-cyan"
                  : "text-sol-text-dim hover:text-sol-text hover:bg-sol-text/[0.06]"
              }`}
            >
              <Icon className="w-3 h-3 shrink-0" />
              {(active || !compact) && <span>{option.label}</span>}
            </button>
          );
          return (
            // Eager: a lazy tooltip remounts its button on first focus, and
            // arrow keys move focus from tab to tab.
            <ShortcutTooltip
              eager
              key={option.key}
              label={`Group by ${option.label.toLowerCase()}`}
              action="inbox.toggleFlatView"
              hint="cycles"
              side="bottom"
            >
              {tab}
            </ShortcutTooltip>
          );
        })}
      </div>
      <div ref={fullRef} aria-hidden className="invisible absolute left-0 top-0 w-max flex items-center gap-px px-1.5 pointer-events-none">
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <span key={option.key} className="flex items-center gap-1 px-1.5 text-[10px] font-medium whitespace-nowrap">
              <Icon className="w-3 h-3 shrink-0" />
              {option.label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
