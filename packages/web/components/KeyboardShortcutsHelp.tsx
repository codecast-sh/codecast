import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { formatShortcutParts, formatAcceleratorParts, getShortcutsByContext } from "../shortcuts";
import type { ShortcutAction } from "../shortcuts";
import { BOARD_SHORTCUT_SECTIONS } from "./boards/boardModel";
import { visibleShortcutSections } from "../shortcuts/visibleSections";
import { useKeyBindingsVersion, useShortcutParts } from "../shortcuts/registry";
import { rebindShortcut } from "../lib/keyboardSettings";
import { SEND_CHORDS } from "../shortcuts/sendChords";
import { EDITOR_PALETTE_COMMANDS, editorPaletteKey } from "../lib/editorPaletteCommands";
import type { ShortcutSection } from "../shortcuts/visibleSections";
import { useTrackedStore } from "../store/inboxStore";
import { useEventListener } from "../hooks/useEventListener";
import { DESKTOP_SHORTCUTS, getDesktopShortcutConfig } from "../lib/desktop";
import { isTriageBarCompact, toggleTriageBarCompact } from "./triage/graduation";

import { useWatchEffect } from "../hooks/useWatchEffect";
import { KeyCap } from "./KeyCap";
import { IconLegend } from "./IconLegend";
import { setLegendTab, useLegendState } from "../lib/iconLegend";
import { useWorkspaceFeature } from "../lib/teamFeatures";

export { KeyCap };

const isEditorAction = (action: string) => action.startsWith("code.");

export function KeyboardShortcutsPanel() {
  const s = useTrackedStore([
    s => s.shortcutsPanelOpen,
    s => s.clientState.ui?.triage_bar_compact,
    s => s.clientState.ui?.inbox_shortcuts_hidden,
    s => s.clientState.ui?.key_bindings,
  ]);
  const triageBarHidden = isTriageBarCompact(s.clientState.ui);
  const { tab } = useLegendState();
  const everOpened = useRef(false);
  if (s.shortcutsPanelOpen) everOpened.current = true;

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
  useWatchEffect(() => {
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

  // Live bindings: a rebound action shows its own keys, an unbound one drops out.
  const flowsOn = useWorkspaceFeature("line");
  const bindingsVersion = useKeyBindingsVersion();
  const changed = new Set((s.clientState.ui?.key_bindings ?? []).map((o) => o.action));
  const sections = useMemo(() => {
    type Row = { key: string; description: string; parts: string[]; action?: ShortcutAction };
    const result: { label: string; accent: string; rows: Row[] }[] = [];
    const rowOf = (a: ShortcutSection["actions"][number]): Row => ({ key: a.action, action: a.def.fixed ? undefined : a.action, description: a.label, parts: formatShortcutParts(a.def) });
    // The code editor's keys in one section: its app shortcuts (code.*),
    // then each key the editor claims itself, read from the palette's list,
    // so the panel and the palette show one set.
    const editor = {
      label: "Editor",
      accent: "bg-sol-cyan",
      rows: [
        ...visibleShortcutSections(flowsOn, getShortcutsByContext).flatMap((sec) => sec.actions.filter((a) => isEditorAction(a.action)).map(rowOf)),
        ...EDITOR_PALETTE_COMMANDS.filter((c) => c.editorKey).map((c) => ({ key: `editor:${editorPaletteKey(c)}`, description: c.label, parts: formatAcceleratorParts(c.editorKey!) })),
      ],
    };
    for (const sec of visibleShortcutSections(flowsOn, getShortcutsByContext)) {
      const actions = sec.actions.filter((a) => !isEditorAction(a.action));
      if (actions.length > 0) result.push({ label: sec.label, accent: sec.accent, rows: actions.map(rowOf) });
      // After Global, or first while a code editor is on screen.
      if (sec.when === undefined) {
        const editorOnScreen = s.shortcutsPanelOpen && typeof document !== "undefined" && !!document.querySelector("[data-code-workspace]");
        if (editorOnScreen) result.unshift(editor);
        else result.push(editor);
      }
      // The composer's send chords live in their own table (they run from a
      // focused textarea, outside the registry); they read as the
      // conversation's companion, so they file right under it.
      if (sec.when === "conversation") {
        result.push({
          label: "Composer",
          accent: "bg-sol-violet",
          rows: SEND_CHORDS.map((c) => ({ key: c.accel, description: c.label, parts: formatAcceleratorParts(c.accel) })),
        });
      }
    }
    // A board on screen answers to its own keys (they run inside the canvas, outside the registry): they lead the panel.
    if (s.shortcutsPanelOpen && typeof document !== "undefined" && document.querySelector("[data-board]:not(.is-readonly)")) {
      result.unshift(...BOARD_SHORTCUT_SECTIONS.map((g) => ({
        label: `Board · ${g.title}`,
        accent: "bg-sol-yellow",
        rows: g.rows.map(([description, parts]) => ({ key: `board:${g.title}:${description}`, description, parts })),
      })));
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowsOn, bindingsVersion, s.shortcutsPanelOpen]);

  return (
    // Beside the page from sm up; on a phone, where a 320px column would squeeze the page to nothing, a full-width
    // sheet over its lower part (the icon legend still reads the page under it, lib/iconLegend isOnScreen).
    <div
      data-legend-sheet
      className={`h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:z-[150] max-sm:h-[70dvh] max-sm:!w-full max-sm:rounded-t-2xl max-sm:shadow-dialog max-sm:transition-none ${s.shortcutsPanelOpen ? "" : "max-sm:hidden"}`}
      style={{ width: s.shortcutsPanelOpen ? 320 : 0 }}
    >
      {everOpened.current && <div className="h-full w-[320px] max-sm:w-full bg-sol-bg border-l border-sol-border/60 max-sm:border-l-0 max-sm:border-t flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-sol-border/40">
          <div role="tablist" className="flex items-center gap-0.5 rounded-control bg-sol-text/[0.05] p-0.5">
            {(["shortcuts", "icons"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setLegendTab(t)}
                className={`rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors ${tab === t ? "bg-sol-card text-sol-text shadow-sm" : "text-sol-text-dim hover:text-sol-text-muted"}`}
              >
                {t === "shortcuts" ? "Shortcuts" : "Icons"}
              </button>
            ))}
          </div>
          <button
            onClick={s.toggleShortcutsPanel}
            className="p-1 rounded text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
            aria-label="Close shortcuts"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {tab === "icons" ? (
          <div className="flex-1 overflow-y-auto px-4 py-3">{s.shortcutsPanelOpen && <IconLegend />}</div>
        ) : <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
          {systemRows.length > 0 && (
            <section>
              <div className="flex items-center gap-2 mb-2">
                <div className="w-1.5 h-1.5 rounded-full bg-sol-magenta" />
                <h3 data-cc-help-heading className="text-mark font-semibold uppercase tracking-[0.12em] text-sol-text-dim">System-wide</h3>
              </div>
              <div className="space-y-0.5">
                {systemRows.map((row) => (
                  <ShortcutRow key={row.description} description={row.description} parts={row.parts} />
                ))}
              </div>
              <p className="mt-1.5 text-meta text-sol-text-dim">
                Work from any app. Customize or remove in Settings → Desktop.
              </p>
            </section>
          )}
          {sections.map(({ label, accent, rows }) => (
            <section key={label}>
              <div className="flex items-center gap-2 mb-2">
                <div className={`w-1.5 h-1.5 rounded-full ${accent}`} />
                <h3 data-cc-help-heading className="text-mark font-semibold uppercase tracking-[0.12em] text-sol-text-dim">{label}</h3>
              </div>
              <div className="space-y-0.5">
                {rows.map((row) => (
                  <ShortcutRow key={row.key} description={row.description} parts={row.parts} changed={!!row.action && changed.has(row.action)} onRebind={row.action ? () => rebindShortcut(row.action) : undefined} />
                ))}
              </div>
            </section>
          ))}
        </div>}

        <div className="px-4 py-2.5 border-t border-sol-border/30 text-meta text-sol-text-dim flex items-center gap-1.5 whitespace-nowrap">
          <MenuKeyCaps action="ui.toggleShortcutsHelp" className="contents" /> toggles this panel
          <span className="ml-auto flex items-center gap-3">
            <button
              onClick={() => rebindShortcut()}
              className="text-sol-text-dim hover:text-sol-cyan transition-colors"
            >
              Customize
            </button>
            {triageBarHidden && (
              <button
                onClick={toggleTriageBarCompact}
                className="text-sol-text-dim hover:text-sol-cyan transition-colors"
              >
                Show triage bar
              </button>
            )}
            <button
              onClick={() => s.setToursPanelOpen(true)}
              className="text-sol-text-dim hover:text-sol-cyan transition-colors"
            >
              Tours
            </button>
          </span>
        </div>
      </div>}
    </div>
  );
}

/** A row with `onRebind` is a button: pressing it opens the keyboard
 *  settings on that action, already listening for the new keys. */
function ShortcutRow({ description, parts, changed, onRebind }: { description: string; parts: string[]; changed?: boolean; onRebind?: () => void }) {
  const body = (
    <>
      {/* A long name wraps rather than pushing its keys out of the panel. */}
      <span className="min-w-0 flex-1 text-xs text-sol-text-muted group-hover:text-sol-text transition-colors">
        {changed && <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-sol-cyan align-middle" />}
        {description}
      </span>
      <span className="shrink-0 flex items-center gap-[3px] rounded group-hover:ring-1 group-hover:ring-sol-cyan/40 group-hover:ring-offset-2 group-hover:ring-offset-sol-bg transition-shadow">
        {parts.map((part, i) => (
          <KeyCap key={i}>{part}</KeyCap>
        ))}
      </span>
    </>
  );
  if (!onRebind) return <div className="flex items-center justify-between gap-3 py-1 group">{body}</div>;
  return (
    <button onClick={onRebind} aria-label={`Change shortcut: ${description}`} className="flex w-full items-center justify-between gap-3 py-1 text-left group">
      {body}
    </button>
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
  const parts = useShortcutParts(action);
  if (!parts) return null;
  return (
    <span className={className}>
      {parts.map((part, i) => (
        <KeyCap key={i} size="xs">{part}</KeyCap>
      ))}
    </span>
  );
}

export { ShortcutTooltip } from "./ShortcutTooltip";
