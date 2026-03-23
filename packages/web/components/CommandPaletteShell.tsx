import { useState, useCallback, useRef } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { Search, CornerDownLeft } from "lucide-react";

export interface PaletteItem {
  key: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  iconNode?: React.ReactNode;
  shortcut?: string;
  active?: boolean;
  color?: string;
}

export interface PaletteMode {
  key: string;
  placeholder: string;
  items: PaletteItem[];
  footerHints?: { key: string; label: string }[];
}

interface CommandPaletteShellProps {
  open: boolean;
  onClose: () => void;
  contextLabel: string;
  modes: Record<string, PaletteMode>;
  initialMode?: string;
  onSelect: (modeKey: string, itemKey: string, index: number) => void;
  onModeSwitch?: (modeKey: string) => void;
}

export function CommandPaletteShell({
  open,
  onClose,
  contextLabel,
  modes,
  initialMode = "root",
  onSelect,
  onModeSwitch,
}: CommandPaletteShellProps) {
  const [mode, setMode] = useState(initialMode);
  const [search, setSearch] = useState("");
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const currentMode = modes[mode] || modes[initialMode];

  useWatchEffect(() => {
    if (open) {
      setMode(initialMode);
      setSearch("");
      setHighlightIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, initialMode]);

  useWatchEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, mode]);

  const filteredItems = currentMode
    ? currentMode.items.filter((i) => i.label.toLowerCase().includes(search.toLowerCase()))
    : [];

  useWatchEffect(() => { setHighlightIndex(0); }, [search, mode]);

  const doSelect = useCallback((index: number) => {
    const item = filteredItems[index];
    if (item) onSelect(mode, item.key, index);
  }, [filteredItems, mode, onSelect]);

  const switchMode = useCallback((newMode: string) => {
    setMode(newMode);
    setSearch("");
    onModeSwitch?.(newMode);
  }, [onModeSwitch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (mode !== initialMode) {
        switchMode(initialMode);
      } else {
        onClose();
      }
      return;
    }
    if (e.key === "ArrowDown" || (e.key === "j" && e.ctrlKey)) {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filteredItems.length - 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "k" && e.ctrlKey)) {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      doSelect(highlightIndex);
      return;
    }
    if (mode !== "root" && filteredItems.length > 0) {
      const num = parseInt(e.key);
      if (num >= 1 && num <= filteredItems.length) {
        e.preventDefault();
        doSelect(num - 1);
        return;
      }
    }
    if (mode === "root" && search === "" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const hint = currentMode?.footerHints?.find((h) => h.key === e.key.toLowerCase());
      if (hint && modes[hint.key]) {
        e.preventDefault();
        switchMode(hint.key);
        return;
      }
    }
    if (e.key === "Backspace" && search === "" && mode !== initialMode) {
      e.preventDefault();
      switchMode(initialMode);
      return;
    }
  }, [mode, initialMode, filteredItems, highlightIndex, doSelect, onClose, search, currentMode, modes, switchMode]);

  useWatchEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const highlighted = el.children[highlightIndex] as HTMLElement;
    if (highlighted) highlighted.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[300] flex items-start justify-center pt-[12vh]" onClick={onClose}>
      <div className="fixed inset-0 bg-black/50" />
      <div className="relative w-full max-w-xl bg-sol-bg border border-sol-border rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        {contextLabel && (
          <div className="px-4 pt-3 pb-0">
            <div className="text-xs font-mono text-sol-text-dim truncate">{contextLabel}</div>
          </div>
        )}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-sol-border/30">
          {mode !== initialMode && (
            <button
              onClick={() => switchMode(initialMode)}
              className="text-xs px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/50 text-sol-text-dim hover:text-sol-text transition-colors flex-shrink-0"
            >
              &larr;
            </button>
          )}
          <Search className="w-4 h-4 text-sol-text-dim flex-shrink-0" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={currentMode?.placeholder || "Type a command..."}
            className="flex-1 text-sm bg-transparent text-sol-text placeholder:text-sol-text-dim/60 outline-none"
          />
        </div>
        <div ref={listRef} className="max-h-[320px] overflow-y-auto py-1">
          {filteredItems.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-sol-text-dim">No results</div>
          )}
          {filteredItems.map((item, i) => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => doSelect(i)}
                onMouseEnter={() => setHighlightIndex(i)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  i === highlightIndex
                    ? "bg-sol-bg-highlight text-sol-text"
                    : "text-sol-text-muted hover:bg-sol-bg-alt/50"
                }`}
              >
                {item.iconNode ? item.iconNode : Icon ? <Icon className={`w-4 h-4 flex-shrink-0 ${item.color || ""}`} /> : null}
                <span className="flex-1 text-left">{item.label}</span>
                {item.active && (
                  <svg className="w-4 h-4 text-sol-cyan flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                )}
                {item.shortcut && (
                  <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-3 px-4 py-2 border-t border-sol-border/30 text-[10px] text-sol-text-dim">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">&uarr;&darr;</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <CornerDownLeft className="w-3 h-3" />
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">esc</kbd>
            {mode !== initialMode ? "back" : "close"}
          </span>
          {mode === "root" && currentMode?.footerHints?.map(({ key, label }) => (
            <span key={key} className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{key}</kbd>
              {label}
            </span>
          ))}
          {mode !== "root" && filteredItems.length > 0 && (
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">1-{filteredItems.length}</kbd>
              quick pick
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
