// The "?" panel's Icons tab: the registered marks visible on this screen right
// now without their word, one row per meaning, each glyph copied from the page
// as drawn. Mounted only while the panel is open on this tab, so a closed panel
// or the Shortcuts tab reads nothing and observes nothing.
import { useRef, useState, type RefObject } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { isOnScreen, legendGroups, readMarks, useLegendState, type GlyphFit, type SeenMark } from "../lib/iconLegend";
import type { MarkGroup } from "../lib/marks";

const ACCENT: Record<MarkGroup, string> = {
  "Priorities pass": "bg-sol-violet",
  Sessions: "bg-sol-green",
  Inbox: "bg-sol-blue",
  Priorities: "bg-sol-cyan",
  Work: "bg-sol-orange",
};

const seenSig = (seen: SeenMark[]) => seen.map((m) => `${m.id}\u0000${m.markup}\u0000${m.box.w}x${m.box.h}`).join("\u0001");

// Read the page once the panel has slid open, then at most every 250ms while
// it changes: navigation, a list scrolling, a rail sliding under the panel.
// Null until the first read, so the panel never flashes "No icons".
function useMarksOnScreen(rootRef: RefObject<HTMLElement | null>): SeenMark[] | null {
  const [seen, setSeen] = useState<SeenMark[] | null>(null);
  useMountEffect(() => {
    let last: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        const next = readMarks(document, isOnScreen);
        const sig = seenSig(next);
        if (sig !== last) { last = sig; setSeen(next); }
      }, 250);
    };
    // The panel's open transition moves the page under it without a mutation.
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.target instanceof Node && rootRef.current && e.target.contains(rootRef.current)) schedule();
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "data-mark", "data-mark-labeled"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("transitionend", onTransitionEnd);
    schedule();
    return () => {
      mo.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("transitionend", onTransitionEnd);
      if (timer) clearTimeout(timer);
    };
  });
  return seen;
}

/** A copy of the page's glyph, drawn in its page box and scaled down to its
 *  legend box, clipped so nothing reaches the row's words. */
function GlyphCopy({ glyph, box, fit }: { glyph: Element; box: SeenMark["box"]; fit: GlyphFit }) {
  const put = (host: HTMLSpanElement | null) => {
    if (!host || host.firstChild) return;
    const copy = glyph.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, { width: `${box.w}px`, height: `${box.h}px`, margin: "0", flexShrink: "0", transform: fit.scale < 1 ? `scale(${fit.scale})` : "" });
    host.append(copy);
  };
  return <span ref={put} className="inline-flex shrink-0 items-center justify-center overflow-hidden" style={{ width: fit.w, height: fit.h }} />;
}

export function IconLegend() {
  const rootRef = useRef<HTMLDivElement>(null);
  const seen = useMarksOnScreen(rootRef);
  const { lead } = useLegendState();
  const groups = seen ? legendGroups(seen, lead) : [];
  return (
    <div ref={rootRef} data-icon-legend className="space-y-4">
      {seen && groups.length === 0 && <p className="px-1 py-6 text-center text-xs text-sol-text-dim">No icons on this screen</p>}
      {groups.map(({ group, rows }) => (
        <section key={group} data-legend-group={group}>
          <div className="mb-2 flex items-center gap-2">
            <div className={`h-1.5 w-1.5 rounded-full ${ACCENT[group]}`} />
            <h3 className="text-mark font-semibold uppercase tracking-[0.12em] text-sol-text-dim">{group}</h3>
          </div>
          <div className="space-y-0.5">
            {rows.map(({ def, glyphs }) => (
              <div key={def.id} data-legend-row={def.id} className="flex items-baseline gap-2 py-1">
                <span className="flex min-w-9 shrink-0 items-center gap-1.5 self-center">
                  {glyphs.map(({ seen: { markup, glyph, box }, fit }) => (
                    <GlyphCopy key={`${markup}\u0000${box.w}x${box.h}`} glyph={glyph} box={box} fit={fit} />
                  ))}
                </span>
                <span className="min-w-0 text-xs leading-snug text-sol-text">
                  {def.name}<span className="text-sol-text-dim"> · {def.meaning}</span>
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
      {import.meta.env.DEV && <OutlineUnregistered />}
    </div>
  );
}

// Dev aid for registering marks: outline every svg on the page that is neither
// inside a registered mark nor the whole content of an icon-only control (a
// button or link that names itself in aria-label or title and shows no word).
// A card that is a [role=button], or a link with a title around words and
// glyphs, names nothing about the glyphs inside it, so those stay outlined.
const OUTLINE_CSS = `[data-legend-unregistered] { outline: 1.5px dashed var(--sol-red); outline-offset: 1px; }`;

function iconOnlyControl(svg: SVGSVGElement): boolean {
  const c = svg.parentElement?.closest("button, a");
  return !!c && (c.hasAttribute("aria-label") || c.hasAttribute("title")) && (c as HTMLElement).innerText.trim() === "";
}

function outlineUnregistered() {
  for (const svg of document.querySelectorAll("svg")) {
    const skip = !!svg.closest("[data-mark], [data-icon-legend]") || !!svg.parentElement?.closest("svg") || iconOnlyControl(svg);
    svg.toggleAttribute("data-legend-unregistered", !skip);
  }
}

function OutlineUnregistered() {
  const [on, setOn] = useState(false);
  useWatchEffect(() => {
    if (!on) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => { timer ??= setTimeout(() => { timer = null; outlineUnregistered(); }, 250); };
    outlineUnregistered();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true });
    return () => {
      mo.disconnect();
      if (timer) clearTimeout(timer);
      for (const svg of document.querySelectorAll("[data-legend-unregistered]")) svg.removeAttribute("data-legend-unregistered");
    };
  }, [on]);
  return (
    <label className="flex items-center gap-2 border-t border-sol-border/30 pt-3 text-meta text-sol-text-dim">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
      Outline unregistered
      {on && <style>{OUTLINE_CSS}</style>}
    </label>
  );
}
