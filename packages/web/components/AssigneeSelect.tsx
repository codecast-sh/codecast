"use client";
import { useState, useRef } from "react";
import { CreateChipCaret, createChipClass, createMenuItemClass, CREATE_MENU_CLASS, CREATE_MENU_SEARCH_CLASS, CREATE_MENU_SECTION_CLASS } from "./CreateDialog";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { Bot, User, Search, Check, X } from "lucide-react";
import type { AssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import { useRolesAndPeopleOptions } from "../hooks/useRolesAndPeopleOptions";
import { AssigneeFace } from "./identity/AssigneeFace";

type AssigneeOption = {
  id: string;
  name: string;
  type: "user" | "agent";
  /** Who the row names (a person, a role); an agent option has none. */
  info?: AssigneeInfo;
  section?: string;
};

const NO_MEMBERS: any[] = [];

// The assignee picker of the create task modal. People and roles come from
// the one list every picker shares (hooks/useRolesAndPeopleOptions), so a
// role's bot user never shows as a person and roles are offered under their
// own heading.
export function AssigneeSelect({
  value,
  valueInfo,
  onChange,
  teamMembers,
  currentUser,
}: {
  value: string | null;
  valueInfo: AssigneeInfo | null;
  onChange: (id: string | null, info: AssigneeInfo | null) => void;
  teamMembers?: any[] | null;
  currentUser?: any;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useWatchEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const agentOptions: AssigneeOption[] = [
    { id: "agent:claude_code", name: "Claude Code", type: "agent", section: "Agents" },
    { id: "agent:codex", name: "Codex", type: "agent", section: "Agents" },
    { id: "agent:gemini", name: "Gemini", type: "agent", section: "Agents" },
  ];

  const { people, roles } = useRolesAndPeopleOptions(teamMembers ?? NO_MEMBERS);
  const memberOptions: AssigneeOption[] = [...people, ...roles].map((o) => ({
    id: o.key,
    name: currentUser && o.key === currentUser._id ? `${o.label} (you)` : o.hint ? `${o.label} ${o.hint}` : o.label,
    type: "user" as const,
    info: o.info,
    section: o.section,
  }));

  const allOptions: AssigneeOption[] = [...agentOptions, ...memberOptions];

  const filtered = search.trim()
    ? allOptions.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : allOptions;

  const select = (opt: AssigneeOption | null) => {
    onChange(opt?.id ?? null, opt ? (opt.info ?? { name: opt.name }) : null);
    setOpen(false);
    setSearch("");
  };

  const agentColor = (id: string) =>
    id === "agent:codex" ? "text-blue-400" : id === "agent:gemini" ? "text-amber-400" : "text-sol-violet";

  const renderAvatar = (opt: { id?: string; name: string; info?: AssigneeInfo; type?: string }) => {
    if (opt.type === "agent") return <Bot className={`w-4 h-4 ${agentColor(opt.id || "")}`} />;
    return <AssigneeFace info={opt.info ?? { name: opt.name.replace(" (you)", "") }} size={16} hover={false} />;
  };

  const currentOpt = value
    ? allOptions.find((o) => o.id === value) || (valueInfo ? { id: value, name: valueInfo.name, info: valueInfo, type: "user" as const } : null)
    : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={createChipClass(!!value, open)}
        aria-expanded={open}
      >
        {currentOpt
          ? renderAvatar({ ...currentOpt, id: currentOpt.id, type: value?.startsWith("agent:") ? "agent" : "user" })
          : <User className="w-3.5 h-3.5" />
        }
        <span className="max-w-[10rem] truncate">{currentOpt ? currentOpt.name.replace(" (you)", "") : "Assignee"}</span>
        <CreateChipCaret open={open} />
      </button>
      {open && (
        <div className={`${CREATE_MENU_CLASS} w-56`}>
          <div className={CREATE_MENU_SEARCH_CLASS}>
            <Search className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people and agents"
              className="flex-1 text-xs bg-transparent text-sol-text placeholder:text-sol-text-dim outline-none"
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {value && (
              <button
                type="button"
                onClick={() => select(null)}
                className={createMenuItemClass()}
              >
                <X className="w-3.5 h-3.5" />
                Clear assignee
              </button>
            )}
            {filtered.map((opt, i) => (
              <div key={opt.id}>
                {opt.section && filtered[i - 1]?.section !== opt.section && (
                  <div className={CREATE_MENU_SECTION_CLASS}>{opt.section}</div>
                )}
                <button
                  type="button"
                  onClick={() => select(opt)}
                  className={createMenuItemClass(opt.id === value)}
                >
                  {renderAvatar(opt)}
                  <span className="flex-1 text-left truncate">{opt.name}</span>
                  {opt.id === value && <Check className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />}
                </button>
              </div>
            ))}
            {filtered.length === 0 && (
              <div className="px-2 py-2 text-xs text-sol-text-dim">Nobody matches</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
