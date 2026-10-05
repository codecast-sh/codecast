"use client";

// The task's property dropdown (status, priority) as the task page draws it,
// and the status picker on top of it: the team's own statuses, and a move to
// done or dropped through the close guard (a parent with open subtasks asks
// first). The task page and a session's task chip both use the picker, so a
// status reads and moves the same wherever the task shows.

import { useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore } from "../../store/inboxStore";
import { closeTaskWithGuard } from "../../lib/taskActions";
import { statusByKey, statusEntityOptions, statusWriteFields, taskStatusKey, useTeamTaskStatusList } from "../../lib/taskStatuses";

export type DropdownOption = { key: string; icon: any; label: string; color: string };

export function PropertyDropdown({
  value,
  options,
  onChange,
  shortcutHint,
}: {
  value: string;
  options: readonly DropdownOption[];
  onChange: (key: string) => void;
  shortcutHint?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.key === value) || options[0];
  const Icon = current.icon;

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); return; }
      const idx = options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (idx >= 0) { onChange(options[idx].key); setOpen(false); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, options, onChange]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs hover:bg-sol-bg-alt transition-colors"
        title={shortcutHint}
      >
        <Icon className={`w-3.5 h-3.5 ${current.color}`} />
        <span className="text-sol-text-muted">{current.label}</span>
        <ChevronDown className="w-3 h-3 text-sol-text-dim" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-44 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-50 py-1 overflow-hidden">
          {options.map((opt) => {
            const OptIcon = opt.icon;
            return (
              <button
                key={opt.key}
                onClick={() => { onChange(opt.key); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-sol-bg-alt transition-colors ${
                  opt.key === value ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"
                }`}
              >
                <OptIcon className={`w-3.5 h-3.5 ${opt.color}`} />
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function TaskStatusPicker({ task, shortcutHint }: {
  task: { short_id?: string | null; status?: string | null; status_id?: string | null; team_id?: string | null };
  shortcutHint?: string;
}) {
  const statuses = useTeamTaskStatusList(task.team_id ?? undefined);
  const options = useMemo(() => statusEntityOptions(statuses), [statuses]);
  const onChange = (key: string) => {
    if (!task.short_id) return;
    // key is a team status id (the options come from statusEntityOptions).
    const picked = statusByKey(statuses, key);
    if (!picked) return;
    const fields = statusWriteFields(picked);
    if (fields.status === "done" || fields.status === "dropped") {
      closeTaskWithGuard(task.short_id, fields.status, undefined, fields.status_id);
    } else {
      useInboxStore.getState().updateTask(task.short_id, fields);
    }
  };
  return <PropertyDropdown value={taskStatusKey(task as any, statuses)} options={options} onChange={onChange} shortcutHint={shortcutHint} />;
}
