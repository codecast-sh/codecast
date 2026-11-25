// The line prompt (Ctrl-G, goto.line): a line, or line:column. Shows where the
// cursor is and how many lines the file has.

import { memo, useRef, useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { modernDialog } from "../../ui/modernLook";
import { useGroupAnchor } from "./groupAnchor";

export const GotoLine = memo(function GotoLine({
  line,
  lines,
  onGo,
  onClose,
}: {
  line: number;
  lines: number;
  onGo(at: string): void;
  onClose(): void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useWatchEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);
  const valid = /^\d+(:\d+)?$/.test(value.trim());
  const anchor = useGroupAnchor<HTMLDivElement>(300);
  return (
    <div ref={anchor.ref} role="dialog" aria-modal="true" aria-label="Go to line" className="fixed inset-0 z-[70]" onMouseDown={onClose}>
      <div
        style={anchor.style}
        className={`flex items-center gap-2 rounded-lg border border-sol-border/50 bg-sol-card px-3 py-2 shadow-2xl ${modernDialog({ scroll: false })}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="text-meta text-sol-text-dim">Line</span>
        <input
          ref={inputRef}
          value={value}
          inputMode="numeric"
          placeholder={String(line)}
          aria-label="Line, or line:column"
          onChange={(e) => setValue(e.target.value.replace(/[^\d:]/g, ""))}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (valid) onGo(value.trim());
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-sm tabular-nums text-sol-text outline-none placeholder:text-sol-text-dim"
        />
        <span className="text-meta tabular-nums text-sol-text-dim">/ {lines}</span>
      </div>
    </div>
  );
});
