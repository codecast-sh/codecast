import { forwardRef } from "react";
import { CalendarPlus, Check, ChevronDown, FolderKanban, History, List, Network, Tag, Target, Workflow, Zap } from "lucide-react";
import type { InboxViewMode } from "../store/inboxStore";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "./ui/dropdown-menu";

type ViewOption = { key: InboxViewMode; label: string; icon: typeof List };

const VIEW_OPTIONS: Record<InboxViewMode, Omit<ViewOption, "key">> = {
  grouped: { label: "Status", icon: List },
  recent: { label: "Updated", icon: History },
  time: { label: "Created", icon: CalendarPlus },
  bucket: { label: "Label", icon: Tag },
  plan: { label: "Plan", icon: Workflow },
  project: { label: "Project", icon: FolderKanban },
  goal: { label: "Goal", icon: Target },
  reports: { label: "Reports", icon: Network },
  trigger: { label: "Trigger", icon: Zap },
};

type PickerButtonProps = { option: ViewOption } & React.ComponentPropsWithoutRef<"button">;

/** The picker's face: the current grouping's icon and name, and a caret. */
const PickerButton = forwardRef<HTMLButtonElement, PickerButtonProps>(function PickerButton({ option, ...rest }, ref) {
  const Icon = option.icon;
  return (
    <button
      ref={ref}
      type="button"
      data-inbox-view-picker
      aria-label={`Grouped by ${option.label.toLowerCase()}`}
      className="flex flex-shrink-0 items-center gap-1 h-[22px] px-1.5 rounded-[5px] text-[10px] font-medium text-sol-text-secondary hover:text-sol-text hover:bg-sol-text/[0.06] data-[state=open]:bg-sol-text/[0.06] transition-colors"
      {...rest}
    >
      <Icon className="w-3 h-3 shrink-0" />
      <span>{option.label}</span>
      <ChevronDown className="w-2.5 h-2.5 shrink-0 opacity-60" />
    </button>
  );
});

/** The picker as a picture, for the marketing hero, which takes no clicks or keys. */
export function InboxViewPickerStill({ value }: { value: InboxViewMode }) {
  return <PickerButton option={{ key: value, ...VIEW_OPTIONS[value] }} tabIndex={-1} aria-hidden />;
}

// The inbox's grouping as one control at the start of the rail header: it
// names the current grouping and opens the list of the others. `modes` is the
// panel's list, the same one Ctrl+, cycles through (setInboxViewModesShown).
export function InboxViewPicker({ value, onChange, modes }: {
  value: InboxViewMode;
  onChange: (value: InboxViewMode) => void;
  modes: readonly InboxViewMode[];
}) {
  const options = modes.map((key) => ({ key, ...VIEW_OPTIONS[key] }));
  const current = options.find((option) => option.key === value) ?? options[0];
  if (!current) return null;
  return (
    <DropdownMenu>
      <ShortcutTooltip label="Group by" action="inbox.toggleFlatView" hint="cycles" side="bottom">
        <DropdownMenuTrigger asChild>
          <PickerButton option={current} />
        </DropdownMenuTrigger>
      </ShortcutTooltip>
      <DropdownMenuContent align="start" className="w-40">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">Group by</DropdownMenuLabel>
        {options.map((option) => {
          const OptionIcon = option.icon;
          const active = option.key === current.key;
          return (
            <DropdownMenuItem key={option.key} data-view-option={option.key} onSelect={() => onChange(option.key)} className="text-xs">
              <OptionIcon className="w-3 h-3 mr-1.5 shrink-0" />
              <span className="flex-1">{option.label}</span>
              {active && <Check className="w-3 h-3 text-sol-cyan" />}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
