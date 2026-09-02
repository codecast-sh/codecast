import { cloneElement, isValidElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X, Keyboard } from "lucide-react";
import { formatShortcutParts, formatAcceleratorParts, getShortcutsForAction, getShortcutsByContext } from "../shortcuts";
import type { ShortcutAction } from "../shortcuts";
import { HELP_SECTIONS } from "../shortcuts/sections";
import { SEND_CHORDS } from "../shortcuts/sendChords";
import { useTrackedStore } from "../store/inboxStore";
import { useEventListener } from "../hooks/useEventListener";
import { DESKTOP_SHORTCUTS, getDesktopShortcutConfig } from "../lib/desktop";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "./ui/tooltip";
import { isTriageBarCompact, toggleTriageBarCompact } from "./triage/graduation";

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


export function KeyboardShortcutsPanel() {
  const s = useTrackedStore([
    s => s.shortcutsPanelOpen,
    s => s.clientState.ui?.triage_bar_compact,
    s => s.clientState.ui?.inbox_shortcuts_hidden,
  ]);
  const triageBarHidden = isTriageBarCompact(s.clientState.ui);

  useEventListener("keydown", (e: KeyboardEvent) => {
    if (s.shortcutsPanelOpen && e.key === "Escape") {
      e.stopPropagation();
      s.toggleShortcutsPanel();
    }
  });

  // OS-global desktop shortcuts (Electron only). Live values, not registry
  // constants — the user can rebind or remove them in Settings → Desktop, so
  // refetch each time the panel opens. Empty accelerator = removed, hidden.
  const [systemRows, setSystemRows] = useState<{ description: string; parts: string[] }[]>([]);
  useEffect(() => {
    if (!s.shortcutsPanelOpen) return;
    getDesktopShortcutConfig().then((cfg) => {
      if (!cfg) return;
      setSystemRows(
        DESKTOP_SHORTCUTS
          .filter((d) => cfg.shortcuts[d.key])
          .map((d) => ({ description: d.label, parts: formatAcceleratorParts(cfg.shortcuts[d.key]) }))
      );
    });
  }, [s.shortcutsPanelOpen]);

  const sections = useMemo(() => {
    const seen = new Set<string>();
    type Row = { key: string; description: string; parts: string[] };
    const result: { label: string; accent: string; rows: Row[] }[] = [];
    for (const { when, label, accent } of HELP_SECTIONS) {
      const defs = getShortcutsByContext(when).filter(d => {
        if (seen.has(d.action)) return false;
        seen.add(d.action);
        return true;
      });
      if (defs.length > 0) {
        result.push({ label, accent, rows: defs.map((d) => ({ key: d.action, description: d.description, parts: formatShortcutParts(d) })) });
      }
      // The composer's send chords live in their own table (they run from a
      // focused textarea, outside the registry); they read as the
      // conversation's companion, so they file right under it.
      if (when === "conversation") {
        result.push({
          label: "Composer",
          accent: "bg-sol-violet",
          rows: SEND_CHORDS.map((c) => ({ key: c.accel, description: c.label, parts: formatAcceleratorParts(c.accel) })),
        });
      }
    }
    return result;
  }, []);

  return (
    <div
      className="h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out"
      style={{ width: s.shortcutsPanelOpen ? 320 : 0 }}
    >
      <div className="h-full w-[320px] bg-sol-bg border-l border-sol-border/60 flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-sol-border/40">
          <div className="flex items-center gap-2">
            <Keyboard className="w-4 h-4 text-sol-cyan" />
            <span className="text-sm font-semibold text-sol-text tracking-tight">Shortcuts</span>
          </div>
          <button
            onClick={s.toggleShortcutsPanel}
            className="p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {systemRows.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-sol-magenta" />
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-sol-text-dim">System-wide</h3>
              </div>
              <div className="space-y-0.5">
                {systemRows.map((row) => (
                  <ShortcutRow key={row.description} description={row.description} parts={row.parts} />
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-sol-text-dim">
                Work from any app. Customize or remove in Settings → Desktop.
              </p>
            </section>
          )}
          {sections.map(({ label, accent, rows }) => (
            <section key={label}>
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-1.5 h-1.5 rounded-full ${accent}`} />
                <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-sol-text-dim">{label}</h3>
              </div>
              <div className="space-y-0.5">
                {rows.map((row) => (
                  <ShortcutRow key={row.key} description={row.description} parts={row.parts} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="px-4 py-2.5 border-t border-sol-border/30 text-[10px] text-sol-text-dim flex items-center gap-1.5 whitespace-nowrap">
          <KeyCap size="xs">?</KeyCap> toggles this panel
          <span className="ml-auto flex items-center gap-3">
            {triageBarHidden && (
              <button
                onClick={toggleTriageBarCompact}
                className="text-sol-text-dim hover:text-sol-cyan transition-colors"
              >
                Show triage bar
              </button>
            )}
            <button
              onClick={() => s.setTriageNuxOpen(true)}
              className="text-sol-text-dim hover:text-sol-cyan transition-colors"
            >
              Replay the tour
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

function ShortcutRow({ description, parts }: { description: string; parts: string[] }) {
  return (
    <div className="flex items-center justify-between py-1 group">
      <span className="text-xs text-sol-text-muted group-hover:text-sol-text transition-colors">{description}</span>
      <span className="ml-3 shrink-0 flex items-center gap-[3px]">
        {parts.map((part, i) => (
          <KeyCap key={i}>{part}</KeyCap>
        ))}
      </span>
    </div>
  );
}

/** An action's binding, as caps. `className` exists because the same caps read
 *  as a menu's right-hand accelerator in one place and as an inline hint in
 *  another; the default is the menu. */
export function MenuKeyCaps({
  action,
  className = "ml-auto flex items-center gap-[2px]",
}: {
  action: ShortcutAction;
  className?: string;
}) {
  const defs = getShortcutsForAction(action);
  if (defs.length === 0) return null;
  const parts = formatShortcutParts(defs[0]);
  return (
    <span className={className}>
      {parts.map((part, i) => (
        <KeyCap key={i} size="xs">{part}</KeyCap>
      ))}
    </span>
  );
}

// A tooltip may stay open only while its trigger holds the pointer or focus.
// Fail open (true) where :hover matching is unsupported (jsdom) so tests and
// odd embedders keep the plain Radix behavior.
function isTooltipAnchored(el: HTMLElement): boolean {
  try {
    if (el.matches(":hover")) return true;
  } catch {
    return true;
  }
  const active = document.activeElement;
  return active === el || el.contains(active);
}

// Rich tooltip for icon buttons: label plus the bound shortcut rendered as
// KeyCaps (never plain-text key glyphs — see UI conventions). Replaces native
// `title` attributes, which can't render keycaps and double up with Radix.
export function ShortcutTooltip({ label, action, hint, side = "bottom", children }: {
  label: ReactNode;
  action?: ShortcutAction;
  // Optional trailing note rendered dimmed after the keycaps, e.g. "cycles" for a
  // key that steps through options rather than toggling.
  hint?: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  // Lazy: hundreds of these mount at once (every card action, every header
  // button), and the Radix provider/portal tree is ~15 fibers per instance —
  // most of the inbox's fiber count was tooltip plumbing for affordances the
  // user never hovers. Until the first pointer/focus touches the trigger,
  // render the child alone; then mount Radix for good and drive the FIRST
  // show ourselves (Radix missed the pointerenter that armed us).
  const [armed, setArmed] = useState(false);
  const [open, setOpen] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // Stuck-open guard. Arming swaps the tree (bare child → Radix trigger), which
  // remounts the DOM node, so the pointerleave that should cancel/close can land
  // on a node with no handler — or never fire at all when the list scrolls under
  // a stationary cursor. A controlled tooltip that opens with the pointer already
  // elsewhere has no event left to close it, so while open we close on any
  // evidence the pointer isn't on the trigger.
  useEffect(() => {
    if (!open) return;
    const closeIfAway = (e?: Event) => {
      const el = triggerRef.current;
      if (!el || !el.isConnected) { setOpen(false); return; }
      if (e instanceof PointerEvent && e.target instanceof Node && el.contains(e.target)) return;
      if (!isTooltipAnchored(el)) setOpen(false);
    };
    window.addEventListener("scroll", closeIfAway, { capture: true, passive: true });
    window.addEventListener("pointermove", closeIfAway, { capture: true, passive: true });
    window.addEventListener("blur", closeIfAway);
    return () => {
      window.removeEventListener("scroll", closeIfAway, { capture: true });
      window.removeEventListener("pointermove", closeIfAway, { capture: true });
      window.removeEventListener("blur", closeIfAway);
    };
  }, [open]);

  if (!isValidElement(children)) {
    return <>{children}</>;
  }

  if (!armed) {
    const arm = (e: any) => {
      triggerRef.current = e.currentTarget as HTMLElement;
      if (timerRef.current) clearTimeout(timerRef.current);
      // The first show is ours (Radix missed the arming pointerenter), so the
      // "still hovering?" check Radix would do is ours too.
      timerRef.current = setTimeout(() => {
        const el = triggerRef.current;
        if (el && el.isConnected && isTooltipAnchored(el)) setOpen(true);
      }, 300);
      setArmed(true);
    };
    const childProps = children.props as Record<string, any>;
    return cloneElement(children as React.ReactElement<any>, {
      onPointerEnter: (e: any) => { childProps.onPointerEnter?.(e); arm(e); },
      onFocus: (e: any) => { childProps.onFocus?.(e); arm(e); },
    });
  }

  const cancelFirstShow = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const defs = action ? getShortcutsForAction(action) : [];
  const parts = defs.length > 0 ? formatShortcutParts(defs[0]) : null;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip open={open} onOpenChange={(v) => { cancelFirstShow(); setOpen(v); }}>
        <TooltipTrigger asChild ref={(node) => { triggerRef.current = node; }} onPointerLeave={cancelFirstShow} onBlur={cancelFirstShow}>{children}</TooltipTrigger>
        {/* Bounded width + wrap: a label that carries a sentence (a trigger's
            standing prompt, a long path) folds into lines instead of running
            one unbroken row across the viewport and clipping. */}
        <TooltipContent side={side} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 max-w-[min(360px,calc(100vw-16px))] bg-sol-bg text-sol-text border border-sol-border shadow-md">
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
          {parts && (
            <span className="flex items-center gap-[2px]">
              {parts.map((part, i) => (
                <KeyCap key={i} size="xs">{part}</KeyCap>
              ))}
            </span>
          )}
          {hint && <span className="text-sol-text-dim">{hint}</span>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ShortcutsToggleButton() {
  const s = useTrackedStore([]);
  return (
    <ShortcutTooltip label="Keyboard shortcuts" action="ui.toggleShortcutsHelp">
      <button
        onClick={s.toggleShortcutsPanel}
        className="p-1.5 rounded-md text-sol-text-dim/60 hover:text-sol-text-muted transition-colors"
      >
        <Keyboard className="w-[18px] h-[18px]" />
      </button>
    </ShortcutTooltip>
  );
}
