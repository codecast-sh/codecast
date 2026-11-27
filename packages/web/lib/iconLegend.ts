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

let unwatchClose: (() => void) | null = null;

/** Open the "?" panel on its Icons tab, with `lead`'s group first until the
 *  panel closes. Only a surface's own "?" passes a lead, so a plain open (the
 *  "?" key, the palette) leads with no group. */
export function openIconLegend(lead?: MarkGroup) {
  setLegendTab("icons", lead);
  const s = useInboxStore.getState();
  if (!s.shortcutsPanelOpen) s.toggleShortcutsPanel();
  if (!lead || unwatchClose) return;
  unwatchClose = useInboxStore.subscribe((next) => {
    if (next.shortcutsPanelOpen) return;
    unwatchClose?.();
    unwatchClose = null;
    if (state.lead) setLegendTab(state.tab);
  });
}

export function useLegendState() {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => state,
    () => state,
  );
}

/** A mark's box as drawn on the page, in px. */
export type GlyphBox = { w: number; h: number };

/** A registered mark found on the page: its id, a copy of its box with the
 *  glyph inside in the ink it was drawn in (svg <title>/<desc> taken out, so
 *  no text reaches a legend row), that glyph's markup as a key for telling
 *  variants apart (never parsed back into the page), and the box the page drew
 *  it in. A tinted mark's copy and key carry no colour: every project's
 *  diamond is one picture, in neutral ink. */
export type SeenMark = { id: string; markup: string; glyph: Element; box: GlyphBox };

/** The bare registered marks under `root` that `isSeen` passes: not drawn with
 *  their word (`data-mark-labeled`), and not the legend's own copies. */
export function readMarks(root: ParentNode, isSeen: (el: HTMLElement) => boolean): SeenMark[] {
  const out: SeenMark[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-mark]")) {
    if (el.hasAttribute("data-mark-labeled") || el.closest("[data-icon-legend]")) continue;
    if (!isSeen(el)) continue;
    const glyph = el.cloneNode(true) as HTMLElement;
    for (const t of glyph.querySelectorAll("title, desc")) t.remove();
    if (el.hasAttribute("data-mark-tinted")) {
      neutralize(glyph);
      glyph.style.color = "var(--sol-text-muted)";
    } else {
      // A glyph drawn in currentColor takes its ink from the page around it.
      glyph.style.color = el.ownerDocument.defaultView!.getComputedStyle(el).color;
    }
    const r = el.getBoundingClientRect();
    out.push({ id: el.dataset.mark!, markup: glyph.innerHTML, glyph, box: { w: Math.round(r.width), h: Math.round(r.height) } });
  }
  return out;
}

// A colour utility class (`bg-sol-cyan`, `dark:bg-red-400`, `text-[#abc]`), not
// a size or a width (`text-xs`, `border-2`).
const COLOR_CLASS = /^(?:[\w-]+:)*(text|bg|fill|stroke|border|ring|outline)-(?:sol-|\[|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black|current|transparent|inherit)\b)/;
const PAINT: Record<string, string | null> = { text: null, bg: "background-color", fill: "fill", stroke: "stroke", border: "border-color", ring: null, outline: "outline-color" };
const PAINT_STYLES = ["background", "background-color", "fill", "stroke", "border-color", "outline-color"];

/** Repaint a tinted glyph's own colours in currentColor, so it draws in the
 *  ink its box is given and its markup no longer differs by colour. */
function neutralize(root: HTMLElement) {
  for (const n of [root, ...root.querySelectorAll<HTMLElement | SVGElement>("*")]) {
    const cls = n.getAttribute("class");
    if (cls) {
      const kept: string[] = [];
      for (const c of cls.split(/\s+/)) {
        const m = c && COLOR_CLASS.exec(c);
        if (!m) { if (c) kept.push(c); continue; }
        const prop = PAINT[m[1]];
        if (prop) n.style.setProperty(prop, "currentColor");
      }
      n.setAttribute("class", kept.join(" "));
    }
    n.style.removeProperty("color");
    for (const prop of PAINT_STYLES) if (n.style.getPropertyValue(prop)) n.style.setProperty(prop, "currentColor");
    for (const attr of ["fill", "stroke"]) {
      const v = n.getAttribute(attr);
      if (v && v !== "none") n.setAttribute(attr, "currentColor");
    }
  }
}

const visible = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });

/** What a person can see right now: laid out, not hidden or transparent, and
 *  uncovered at its centre (a rail slid under the panel, or a row scrolled out
 *  of its list, is not on screen). Something invisible over it (a card's hover
 *  tools at opacity 0) does not cover it. */
export function isOnScreen(el: HTMLElement): boolean {
  if (!visible(el)) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  for (const hit of document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)) {
    if (hit === el || el.contains(hit)) return true;
    if (!visible(hit)) continue;
    // A mark that ignores the pointer lets the hit fall through to its container.
    return hit.contains(el) && getComputedStyle(el).pointerEvents === "none";
  }
  return false;
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

/** How a glyph sits in its legend row: drawn at its page size, then scaled by
 *  `scale` to fit a box `w`x`h` no taller than 20px and no wider than 48px (a
 *  wide data mark, a ten-day strip, stays readable), and at least 8px a side. */
export type GlyphFit = GlyphBox & { scale: number };

export function legendBox({ w, h }: GlyphBox): GlyphFit {
  const scale = Math.min(1, 20 / h, 48 / w);
  return { w: Math.max(8, Math.round(w * scale)), h: Math.max(8, Math.round(h * scale)), scale };
}

type Seen = Pick<SeenMark, "id" | "markup" | "box">;
export type LegendGlyph<S extends Seen = SeenMark> = { seen: S; fit: GlyphFit };
export type LegendRow<S extends Seen = SeenMark> = { def: MarkDef; glyphs: LegendGlyph<S>[] };
export type LegendGroup<S extends Seen = SeenMark> = { group: MarkGroup; rows: LegendRow<S>[] };

/** One row per meaning, each with its distinct glyphs in the order seen;
 *  `lead`'s group first, then GROUP_ORDER, and registry order inside a group. */
export function legendGroups<S extends Seen>(seen: readonly S[], lead?: MarkGroup, marks: readonly MarkDef[] = MARKS): LegendGroup<S>[] {
  const glyphs = new Map<string, Map<string, LegendGlyph<S>>>();
  for (const m of seen) {
    const variants = glyphs.get(m.id) ?? new Map<string, LegendGlyph<S>>();
    const key = glyphKey(m.markup);
    if (!variants.has(key)) variants.set(key, { seen: m, fit: legendBox(m.box) });
    glyphs.set(m.id, variants);
  }
  const order = lead ? [lead, ...GROUP_ORDER.filter((g) => g !== lead)] : GROUP_ORDER;
  return order
    .map((group) => ({
      group,
      rows: marks.filter((m) => m.group === group && glyphs.has(m.id)).map((def) => {
        const all = [...glyphs.get(def.id)!.values()];
        return { def, glyphs: def.oneGlyph ? all.slice(0, 1) : all };
      }),
    }))
    .filter((g) => g.rows.length > 0);
}
