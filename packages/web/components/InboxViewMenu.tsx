import { useState } from "react";
import { Activity, ChevronDown, Clock, List, Tag, Workflow, Zap } from "lucide-react";
import type { InboxViewMode } from "../store/inboxStore";
import { FilterOptionList } from "./FilterDropdown";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function InboxViewMenu({ value, onChange, hasLabels, hasPlans, hasTriggers }: {
  value: InboxViewMode;
  onChange: (value: InboxViewMode) => void;
  hasLabels: boolean;
  hasPlans: boolean;
  hasTriggers: boolean;
}) {
  const [open, setOpen] = useState(false);
  const options = [
    { key: "grouped", label: "By status", icon: List },
    { key: "recent", label: "By updated", icon: Activity },
    { key: "time", label: "By created", icon: Clock },
    ...(hasLabels ? [{ key: "bucket", label: "By label", icon: Tag }] : []),
    ...(hasPlans ? [{ key: "plan", label: "By plan", icon: Workflow }] : []),
    ...(hasTriggers ? [{ key: "trigger", label: "By trigger", icon: Zap }] : []),
  ];
  const current = options.find((option) => option.key === value) ?? options[0];
  const CurrentIcon = current.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <ShortcutTooltip eager label={current.label} action="inbox.toggleFlatView" hint="cycles" side="bottom">
        <PopoverTrigger asChild>
          <button
            aria-label={`Inbox view: ${current.label}`}
            className={`flex items-center px-1 py-[3px] rounded-[5px] transition-colors ${
              open ? "bg-sol-cyan/15 text-sol-cyan" : "text-sol-text-dim/70 hover:text-sol-text"
            }`}
          >
            <CurrentIcon className="w-3 h-3" />
            <ChevronDown className="w-2 h-2 opacity-60" />
          </button>
        </PopoverTrigger>
      </ShortcutTooltip>
      <PopoverContent
        aria-label="Inbox view"
        align="end"
        collisionPadding={8}
        className="z-[250] w-48 max-h-[var(--radix-popover-content-available-height)] overflow-y-auto bg-sol-bg border-sol-border rounded-lg shadow-xl px-0 py-1"
      >
        <FilterOptionList
          options={options}
          value={value}
          onChange={(mode) => onChange(mode as InboxViewMode)}
          onPicked={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
