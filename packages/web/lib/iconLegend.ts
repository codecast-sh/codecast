// The icon legend (the "?" panel's Icons tab, components/IconLegend.tsx): which
// tab the panel shows, and the rules for what it lists. It lists the registered
// marks a person can see right now without their word, one row per meaning,
// each glyph taken from the page as drawn.
import { useSyncExternalStore } from "react";
import { GROUP_ORDER, MARKS, type MarkDef, type MarkGroup } from "./marks";
import { useInboxStore } from "../store/inboxStore";

export type LegendTab = "shortcuts" | "icons";

// Ephemeral UI: which tab the panel shows and which group a surface asked to
// lead with. Not persisted; a reload opens on Shortcuts.
let state: { tab: LegendTab; lead?: MarkGroup } = { tab: "shortcuts" };
const listeners = new Set<() => void>();

export function setLegendTab(tab: LegendTab, lead?: MarkGroup) {
  state = { tab, lead };
  listeners.forEach((l) => l());
}

/** Open the "?" panel on its Icons tab, with `lead`'s group first. */
export function openIconLegend(lead?: MarkGroup) {
  setLegendTab("icons", lead);
  const s = useInboxStore.getState();
  if (!s.shortcutsPanelOpen) s.toggleShortcutsPanel();
}

export function useLegendState() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
    () => state,
  );
}

/** A registered mark found on the page: its id and the glyph inside it. */
export type SeenMark = { id: string; markup: string };

/** The bare registered marks under `root` that `isSeen` passes: not drawn with
 *  their word (`data-mark-labeled`), and not the legend's own copies. */
export function readMarks(root: ParentNode, isSeen: (el: HTMLElement) => boolean): SeenMark[] {
  const out: SeenMark[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-mark]")) {
    if (el.hasAttribute("data-mark-labeled") || el.closest("[data-icon-legend]")) continue;
    if (!isSeen(el)) continue;
    out.push({ id: el.dataset.mark!, markup: el.innerHTML });
  }
  return out;
}

/** What a person can see right now: laid out, not hidden or transparent, and
 *  uncovered at its centre (a rail slid under the panel, or a row scrolled out
 *  of its list, is not on screen). */
export function isOnScreen(el: HTMLElement): boolean {
  if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!hit) return false;
  if (hit === el || el.contains(hit)) return true;
  // A mark that ignores the pointer lets the hit fall through to its container.
  return hit.contains(el) && getComputedStyle(el).pointerEvents === "none";
}

/** The same glyph drawn at two sizes is one variant. */
export function glyphKey(markup: string): string {
  return markup
    .replace(/\s(?:width|height)="[^"]*"/g, "")
    .replace(/\sclass="([^"]*)"/g, (_, cls: string) => {
      const kept = cls.split(/\s+/).filter((c) => c && !/^(?:size|w|h|min-w|min-h|max-w|max-h)-/.test(c));
      return kept.length ? ` class="${kept.join(" ")}"` : "";
    });
}

export type LegendRow = { def: MarkDef; glyphs: string[] };
export type LegendGroup = { group: MarkGroup; rows: LegendRow[] };

/** One row per meaning, each with its distinct glyphs in the order seen;
 *  `lead`'s group first, then GROUP_ORDER, and registry order inside a group. */
export function legendGroups(seen: readonly SeenMark[], lead?: MarkGroup, marks: readonly MarkDef[] = MARKS): LegendGroup[] {
  const glyphs = new Map<string, Map<string, string>>();
  for (const { id, markup } of seen) {
    const variants = glyphs.get(id) ?? new Map<string, string>();
    const key = glyphKey(markup);
    if (!variants.has(key)) variants.set(key, markup);
    glyphs.set(id, variants);
  }
  const order = lead ? [lead, ...GROUP_ORDER.filter((g) => g !== lead)] : GROUP_ORDER;
  return order
    .map((group) => ({
      group,
      rows: marks.filter((m) => m.group === group && glyphs.has(m.id)).map((def) => ({ def, glyphs: [...glyphs.get(def.id)!.values()] })),
    }))
    .filter((g) => g.rows.length > 0);
}
