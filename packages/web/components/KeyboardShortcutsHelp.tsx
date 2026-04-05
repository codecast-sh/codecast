import { useMemo } from "react";
import { X, Keyboard } from "lucide-react";
import { formatShortcutParts, getShortcutsForAction, getShortcutsByContext } from "../shortcuts";
import type { ShortcutAction, ShortcutDef } from "../shortcuts";
import { useInboxStore } from "../store/inboxStore";
import { useEventListener } from "../hooks/useEventListener";

const KEYCAP_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';

export function KeyCap({ children, size = "sm" }: { children: React.ReactNode; size?: "sm" | "xs" }) {
  const cls = size === "xs"
    ? "inline-flex items-center justify-center min-w-[16px] h-[16px] px-[4px] text-[9px]"
    : "inline-flex items-center justify-center min-w-[20px] h-[20px] px-[5px] text-[10px]";
  return (
    <kbd
      className={`${cls} leading-none text-sol-text-dim bg-sol-bg-alt border border-sol-border/50 rounded-[4px] shadow-[0_1px_0_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.04)]`}
      style={{ fontFamily: KEYCAP_FONT }}
    >
      {children}
    </kbd>
  );
}

const SECTION_ORDER: { when: string | undefined; label: string; accent: string }[] = [
  { when: undefined, label: "Global", accent: "bg-sol-cyan" },
  { when: "conversation", label: "Conversation", accent: "bg-sol-blue" },
  { when: "diff", label: "Diff", accent: "bg-sol-green" },
  { when: "list", label: "List", accent: "bg-sol-orange" },
  { when: "review", label: "Review", accent: "bg-sol-violet" },
  { when: "desktop", label: "Desktop", accent: "bg-sol-yellow" },
];

export function KeyboardShortcutsPanel() {
  const isOpen = useInboxStore(s => s.shortcutsPanelOpen);
  const toggle = useInboxStore(s => s.toggleShortcutsPanel);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (isOpen && e.key === "Escape") {
      e.stopPropagation();
      toggle();
    }
  });

  const sections = useMemo(() => {
    const seen = new Set<string>();
    const result: { label: string; accent: string; shortcuts: ShortcutDef[] }[] = [];
    for (const { when, label, accent } of SECTION_ORDER) {
      const defs = getShortcutsByContext(when).filter(d => {
        if (seen.has(d.action)) return false;
        seen.add(d.action);
        return true;
      });
      if (defs.length > 0) result.push({ label, accent, shortcuts: defs });
    }
    return result;
  }, []);

  return (
    <div
      className="h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
      style={{ width: isOpen ? 320 : 0 }}
    >
      <div className="h-full w-[320px] bg-sol-bg border-l border-sol-border/60 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-sol-border/40">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-sol-cyan" />
            <span className="text-sm font-semibold text-sol-text tracking-tight">Shortcuts</span>
          </div>
          <button
            onClick={toggle}
            className="p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {sections.map(({ label, accent, shortcuts }) => (
            <section key={label}>
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-1.5 h-1.5 rounded-full ${accent}`} />
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-sol-text-dim">{label}</h3>
              </div>
              <div className="space-y-0.5">
                {shortcuts.map((def) => (
                  <ShortcutRow key={def.action} def={def} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="px-4 py-2.5 border-t border-sol-border/30 text-[10px] text-sol-text-dim flex items-center gap-1.5">
          Press <KeyCap size="xs">?</KeyCap> to toggle this panel
        </div>
      </div>
    </div>
  );
}

function ShortcutRow({ def }: { def: ShortcutDef }) {
  const parts = formatShortcutParts(def);
  return (
    <div className="flex items-center justify-between py-1 group">
      <span className="text-xs text-sol-text-muted group-hover:text-sol-text transition-colors">{def.description}</span>
      <span className="ml-3 shrink-0 flex items-center gap-[3px]">
        {parts.map((part, i) => (
          <KeyCap key={i}>{part}</KeyCap>
        ))}
      </span>
    </div>
  );
}

export function MenuKeyCaps({ action }: { action: ShortcutAction }) {
  const defs = getShortcutsForAction(action);
  if (defs.length === 0) return null;
  const parts = formatShortcutParts(defs[0]);
  return (
    <span className="ml-auto flex items-center gap-[2px]">
      {parts.map((part, i) => (
        <KeyCap key={i} size="xs">{part}</KeyCap>
      ))}
    </span>
  );
}

export function ShortcutsToggleButton() {
  const toggle = useInboxStore(s => s.toggleShortcutsPanel);
  return (
    <button
      onClick={toggle}
      className="p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
      title="Keyboard shortcuts (?)"
    >
      <Keyboard className="w-[18px] h-[18px]" />
    </button>
  );
}
