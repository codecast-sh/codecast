// The "?" panel's Icons tab: the registered marks visible on this screen right
// now without their word, one row per meaning, each glyph copied from the page
// as drawn. Mounted only while the panel is open on this tab, so a closed panel
// or the Shortcuts tab reads nothing and observes nothing.
import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { isOnScreen, legendGroups, readMarks, useLegendState, type SeenMark } from "../lib/iconLegend";
import type { MarkGroup } from "../lib/marks";

const ACCENT: Record<MarkGroup, string> = {
  "Priorities pass": "bg-sol-violet",
  Sessions: "bg-sol-green",
  Inbox: "bg-sol-blue",
  Priorities: "bg-sol-cyan",
  Work: "bg-sol-orange",
};

const seenSig = (seen: SeenMark[]) => seen.map((m) => `${m.id}\u0000${m.markup}`).join("\u0001");

// Re-read the page at most every 250ms while it changes: navigation, a list
// scrolling, a rail sliding under the panel.
function useMarksOnScreen(): SeenMark[] {
  const [seen, setSeen] = useState<SeenMark[]>(() => readMarks(document, isOnScreen));
  useMountEffect(() => {
    let last = seenSig(seen);
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
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style", "hidden", "data-mark", "data-mark-labeled"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    return () => {
      mo.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      if (timer) clearTimeout(timer);
    };
  });
  return seen;
}

export function IconLegend() {
  const seen = useMarksOnScreen();
  const { lead } = useLegendState();
  const groups = legendGroups(seen, lead);
  return (
    <div data-icon-legend className="space-y-4">
      {groups.length === 0 && <p className="px-1 py-6 text-center text-xs text-sol-text-dim">No icons on this screen</p>}
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
                  {glyphs.map(({ markup, box }) => (
                    // The page's box for the glyph, so one that fills its mark is drawn at its own size.
                    <span key={markup} className="inline-flex items-center justify-center [&>*]:max-h-full [&>*]:max-w-full" style={box && { width: box.w, height: box.h }} dangerouslySetInnerHTML={{ __html: markup }} />
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
// inside a registered mark nor an action (a button or link that names itself).
const OUTLINE_CSS = `svg:not([data-mark] svg, :is(button, a, [role=button])[aria-label] svg, :is(button, a, [role=button])[title] svg, [data-icon-legend] svg) { outline: 1.5px dashed var(--sol-red); outline-offset: 1px; }`;

function OutlineUnregistered() {
  const [on, setOn] = useState(false);
  return (
    <label className="flex items-center gap-2 border-t border-sol-border/30 pt-3 text-meta text-sol-text-dim">
      <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
      Outline unregistered
      {on && <style>{OUTLINE_CSS}</style>}
    </label>
  );
}
