"use client";
import { useState, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { Bot, User, ChevronDown, Search, Check, X } from "lucide-react";

export type AssigneeInfo = { name: string; image?: string };

type AssigneeOption = {
  id: string;
  name: string;
  image?: string;
  type: "user" | "agent";
};

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
    { id: "agent:claude_code", name: "Claude Code", type: "agent" },
    { id: "agent:codex", name: "Codex", type: "agent" },
    { id: "agent:gemini", name: "Gemini", type: "agent" },
  ];

  const memberOptions: AssigneeOption[] = (teamMembers || [])
    .filter(Boolean)
    .map((m: any) => ({
      id: m._id,
      name: currentUser && m._id === currentUser._id ? `${m.name} (you)` : m.name,
      image: m.image || m.github_avatar_url,
      type: "user" as const,
    }));

  const allOptions: AssigneeOption[] = [...agentOptions, ...memberOptions];

  const filtered = search.trim()
    ? allOptions.filter((o) => o.name.toLowerCase().includes(search.toLowerCase()))
    : allOptions;

  const select = (opt: AssigneeOption | null) => {
    onChange(opt?.id ?? null, opt ? { name: opt.name.replace(" (you)", ""), image: opt.image } : null);
    setOpen(false);
    setSearch("");
  };

  const agentColor = (id: string) =>
    id === "agent:codex" ? "text-blue-400" : id === "agent:gemini" ? "text-amber-400" : "text-sol-violet";

  const renderAvatar = (opt: { id?: string; name: string; image?: string; type?: string }, size = "w-4 h-4") => {
    if (opt.type === "agent") return <Bot className={`${size} ${agentColor(opt.id || "")}`} />;
    if (opt.image) return <img src={opt.image} alt={opt.name} className={`${size} rounded-full`} />;
    const initials = opt.name.replace(" (you)", "").split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
    return (
      <div className={`${size} rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted`}>
        {initials}
      </div>
    );
  };

  const currentOpt = value
    ? allOptions.find((o) => o.id === value) || (valueInfo ? { id: value, name: valueInfo.name, image: valueInfo.image, type: "user" as const } : null)
    : null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors border ${
          value
            ? "border-sol-border/60 bg-sol-bg-alt text-sol-text"
            : "border-sol-border/30 hover:border-sol-border/60 text-sol-text-dim hover:text-sol-text"
        }`}
      >
        {currentOpt
          ? renderAvatar({ ...currentOpt, id: currentOpt.id, type: value?.startsWith("agent:") ? "agent" : "user" })
          : <User className="w-3.5 h-3.5" />
        }
        <span>{currentOpt ? currentOpt.name.replace(" (you)", "") : "Assignee"}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-52 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-sol-border/30">
            <Search className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="flex-1 text-xs bg-transparent text-sol-text placeholder:text-sol-text-dim outline-none"
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            />
          </div>
          <div className="py-1 max-h-48 overflow-y-auto">
            {value && (
              <button
                onClick={() => select(null)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-sol-text-dim hover:bg-sol-bg-alt transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                Clear assignee
              </button>
            )}
            {filtered.map((opt) => (
              <button
                key={opt.id}
                onClick={() => select(opt)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  opt.id === value ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                }`}
              >
                {renderAvatar(opt)}
                <span className="flex-1 text-left truncate">{opt.name}</span>
                {opt.id === value && <Check className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />}
              </button>
            ))}
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-xs text-sol-text-dim">No results</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
