// The tab switcher (Ctrl-Tab, vim's :Buffers / CtrlPBuffer): every open tab,
// most recently used first. Held: Ctrl-Tab steps, Ctrl-Shift-Tab steps back,
// letting go of Ctrl opens the selection. Opened by a command it stays until
// Enter, a click or Escape.

import { memo, useRef, useState } from "react";
import { File, FileText } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { bufferKey, useCodeStore } from "../../../store/codeStore";
import { useEventListener } from "../../../hooks/useEventListener";
import { hoverFocus } from "../../../shortcuts/focusSource";
import { modernDialog } from "../../ui/modernLook";
import { useGroupAnchor } from "./groupAnchor";
import type { MruEntry } from "../../../lib/code/workspace/model";

export interface TabSwitcherProps {
  vaultId: string;
  entries: MruEntry[];
  /** Group number per group id, shown when there is more than one group. */
  groupNumbers: Map<string, number> | null;
  /** Opened with Ctrl held: releasing it picks. */
  held: boolean;
  onPick(entry: MruEntry): void;
  onClose(): void;
}

export const TabSwitcher = memo(function TabSwitcher({ vaultId, entries, groupNumbers, held, onPick, onClose }: TabSwitcherProps) {
  const dirty = useCodeStore((s) => s.dirty);
  const [selected, setSelected] = useState(entries.length > 1 ? 1 : 0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEventListener("keyup", (e: KeyboardEvent) => {
    if (held && e.key === "Control" && entries[selectedRef.current]) onPick(entries[selectedRef.current]);
  });
  useEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "Enter") entries[selectedRef.current] && onPick(entries[selectedRef.current]);
      else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) setSelected((i) => (i + 1) % entries.length);
      else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) setSelected((i) => (i - 1 + entries.length) % entries.length);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    window,
    { capture: true },
  );

  const anchor = useGroupAnchor<HTMLDivElement>(440);
  return (
    <div ref={anchor.ref} role="dialog" aria-modal="true" aria-label="Switch tab" className="fixed inset-0 z-[70]" onMouseDown={onClose}>
      <div
        style={anchor.style}
        className={`overflow-hidden rounded-lg border border-sol-border/50 bg-sol-card py-1 shadow-2xl ${modernDialog({ scroll: false })}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {entries.map((entry, i) => {
          const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
          const dir = entry.path.slice(0, Math.max(0, entry.path.length - name.length - 1));
          const Icon = isVaultMarkdownPath(entry.path) ? FileText : File;
          return (
            <button
              key={`${entry.groupId}\u0000${entry.path}`}
              type="button"
              onClick={() => onPick(entry)}
              {...hoverFocus(() => setSelected(i))}
              className={`flex w-full items-center gap-2.5 px-3 py-1 text-left text-[13px] ${i === selected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
            >
              <Icon className="h-3.5 w-3.5 shrink-0 opacity-50" />
              <span className="shrink-0 truncate">{name}</span>
              <span className="min-w-0 flex-1 truncate text-meta text-sol-text-dim">{dir}</span>
              {dirty[bufferKey(vaultId, entry.path)] && <span className="size-2 shrink-0 rounded-full bg-sol-text-muted" aria-label="Unsaved" />}
              {groupNumbers && <span className="w-3 shrink-0 text-right text-meta tabular-nums text-sol-text-dim">{groupNumbers.get(entry.groupId)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
});
