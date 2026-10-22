import { useRef } from "react";
import { Activity, Clock, FolderKanban, List, Network, Tag, Target, Workflow, Zap } from "lucide-react";
import type { InboxViewMode } from "../store/inboxStore";
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

// The inbox's grouping as a row of tabs under the rail header, spread across
// its width: the current grouping is named, every other one is an icon (named
// on hover) a click away. `modes` is the panel's list, the same one Ctrl+,
// cycles through (setInboxViewModesShown).
export function InboxViewTabs({ value, onChange, modes }: {
  value: InboxViewMode;
  onChange: (value: InboxViewMode) => void;
  modes: readonly InboxViewMode[];
}) {
  const options = modes.map((key) => ({ key, ...VIEW_OPTIONS[key] }));
  const current = options.find((option) => option.key === value) ?? options[0];
  const stripRef = useRef<HTMLDivElement>(null);

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
              className={`flex items-center justify-center gap-1 h-[22px] rounded-[5px] text-[10px] font-medium whitespace-nowrap transition-colors ${
                active ? "px-1.5" : "flex-1 min-w-[22px] px-1"
              } ${
                active
                  ? "bg-sol-cyan/15 text-sol-cyan"
                  : "text-sol-text-dim hover:text-sol-text hover:bg-sol-text/[0.06]"
              }`}
            >
              <Icon className="w-3 h-3 shrink-0" />
              {active && <span>{option.label}</span>}
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
    </div>
  );
}
