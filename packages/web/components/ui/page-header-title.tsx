"use client";

import { useState } from "react";
import { cn } from "../../lib/utils";

// The page header's title (components/ui/page-header), renamed in place when
// the page lets the viewer rename its object: click the name, Enter or a
// click away saves, Escape puts it back.

const TITLE = "min-w-0 truncate text-read font-semibold text-sol-text";

export function PageHeaderTitle({ title, onRename, renameLabel = "Rename" }: {
  title: string;
  onRename?: (next: string) => void;
  renameLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (!onRename) return <h1 title={title} className={TITLE}>{title}</h1>;
  if (draft !== null) {
    const save = () => {
      const next = draft.trim();
      setDraft(null);
      if (next && next !== title) onRename(next);
    };
    return (
      <input
        autoFocus
        value={draft}
        aria-label={renameLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") setDraft(null);
        }}
        className={cn(TITLE, "min-w-[12ch] flex-1 border-b border-sol-cyan bg-transparent outline-none")}
      />
    );
  }
  return (
    <h1 title={title} className={cn(TITLE, "cursor-text rounded-[4px] hover:bg-sol-bg-alt")} onClick={() => setDraft(title)} data-cc-page-rename>
      {title}
    </h1>
  );
}
