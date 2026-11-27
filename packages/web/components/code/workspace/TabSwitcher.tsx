// The tab switcher (Ctrl-Tab, vim's :Buffers / CtrlPBuffer): every open tab,
// most recently used first. Held: Ctrl-Tab steps, Ctrl-Shift-Tab steps back,
// letting go of Ctrl opens the selection. Opened by a command it stays until
// Enter, a click or Escape. The tab strip's overflow count opens it on one
// group's tabs, in tab order, starting on the active one.

import { FileStateMark } from "./FileStateMark";
import { memo, useRef, useState } from "react";
import { File, FileText, Pin } from "lucide-react";
import { isVaultMarkdownPath } from "@codecast/shared/contracts";
import { bufferKey, useCodeStore } from "../../../store/codeStore";
import { useEventListener } from "../../../hooks/useEventListener";
import { hoverFocus } from "../../../shortcuts/focusSource";
import { modernDialog } from "../../ui/modernLook";
import { useGroupAnchor } from "./groupAnchor";
import { usePickerAria } from "./pickerAria";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import type { MruEntry } from "../../../lib/code/workspace/model";

export interface TabSwitcherProps {
  vaultId: string;
  entries: MruEntry[];
  /** Group number per group id, shown when there is more than one group. */
  groupNumbers: Map<string, number> | null;
  /** Opened with Ctrl held: releasing it picks. */
  held: boolean;
  /** The row selected first; the previous tab when absent. */
  initial?: number;
  /** Paths shown with a pin. */
  pinned?: ReadonlySet<string>;
  onPick(entry: MruEntry): void;
  onClose(): void;
}

export const TabSwitcher = memo(function TabSwitcher({ vaultId, entries, groupNumbers, held, initial, pinned, onPick, onClose }: TabSwitcherProps) {
  const dirty = useCodeStore((s) => s.dirty);
  const conflicts = useCodeStore((s) => s.conflicts);
  const [selected, setSelected] = useState(initial ?? (entries.length > 1 ? 1 : 0));
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
  const aria = usePickerAria(entries[selected] ? selected : null);
  // The list takes focus, so a screen reader follows the highlight; closing
  // hands focus back to the group (CodeWorkspace's focus keeper).
  const listRef = useRef<HTMLDivElement | null>(null);
  useWatchEffect(() => listRef.current?.focus({ preventScroll: true }), []);
  return (
    <div ref={anchor.ref} role="dialog" aria-modal="true" aria-label="Switch tab" className="fixed inset-0 z-[70]" onMouseDown={onClose}>
      <div
        style={anchor.style}
        ref={listRef}
        {...aria.list(true)}
        aria-label="Open tabs"
        className={`overflow-hidden rounded-lg border border-sol-border/50 bg-sol-card py-1 shadow-2xl outline-none ${modernDialog({ scroll: false })}`}
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
              {...aria.option(i, i === selected)}
              tabIndex={-1}
              onClick={() => onPick(entry)}
              {...hoverFocus(() => setSelected(i))}
              className={`flex w-full items-center gap-2.5 px-3 py-1 text-left text-[13px] ${i === selected ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"}`}
            >
              {pinned?.has(entry.path) ? <Pin className="h-3.5 w-3.5 shrink-0 -rotate-45 opacity-50" /> : <Icon className="h-3.5 w-3.5 shrink-0 opacity-50" />}
              <span className="shrink-0 truncate">{name}</span>
              <span className="min-w-0 flex-1 truncate text-meta text-sol-text-dim">{dir}</span>
              <FileStateMark conflict={conflicts[bufferKey(vaultId, entry.path)]} dirty={!!dirty[bufferKey(vaultId, entry.path)]} />
              {groupNumbers && <span className="w-3 shrink-0 text-right text-meta tabular-nums text-sol-text-dim">{groupNumbers.get(entry.groupId)}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
});
