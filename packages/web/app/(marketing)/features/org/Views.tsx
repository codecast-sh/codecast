"use client";

import { useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { Frame, Section, Tile } from "./kit";
import { DIM, INK, LINE, MUTED, SAND, SOL, TEXT, role, tint } from "./model";
import { ItemCard, PersonCard, PersonChip, RoleCard, type Mark } from "./ViewsCards";
import { COUNT_META, COUNT_ORDER, HOLDERS, ITEMS, TOTALS, itemsOf, levelOf, ownerWaits, projectsOf, type Level } from "./viewsData";

/*
 * The chart: the app's /org screen with its view switch (People, Everything,
 * Goals), Needs you, Find and the This week overlay, plus a zoom slider that
 * walks the cards through the app's three zoom levels. Default: People at the
 * middle level, which reads complete without a press.
 */

type View = "people" | "everything" | "goals";
const VIEWS: { id: View; label: string }[] = [{ id: "people", label: "People" }, { id: "everything", label: "Everything" }, { id: "goals", label: "Goals" }];
const WIDTH: Record<Level, number> = { far: 160, mid: 210, close: 260 };
const STOPS: { level: Level; label: string; z: number }[] = [{ level: "far", label: "far", z: 0.6 }, { level: "mid", label: "middle", z: 1 }, { level: "close", label: "close", z: 1.35 }];
const LEADS = ["eng", "growth", "people"];
const GOALS = ["g1", "g2", "g3"];
const underNoGoal = ITEMS.filter((i) => i.kind === "project" && !i.goal);
const subsOf = (id: string) => ["infra", "release", "mobile", "evals", "social", "ads", "support"].filter((r) => role(r).reportsTo === id);

/** The cards a view draws, in reading order: what Find walks and Needs you lights. */
function visibleCards(view: View): { key: string; find: string; lit: boolean }[] {
  const r = (id: string) => ({ key: id, find: `${role(id).title} ${role(id).handle}`, lit: !!HOLDERS[id].needsMaya });
  const it = (id: string) => { const x = ITEMS.find((i) => i.id === id)!; return { key: id, find: x.title, lit: ownerWaits(x.owner) }; };
  const p = (id: string, name: string) => ({ key: id, find: name, lit: !!HOLDERS[id].needsMaya });
  if (view === "goals") return ["m", ...GOALS.flatMap((g) => [g, ...projectsOf(g).map((x) => x.id)]), ...underNoGoal.map((x) => x.id)].map(it);
  const top = [p("maya", "Maya Chen"), ...(view === "everything" ? [it("m")] : []), p("leo", "Leo Park"), p("ines", "Ines Ruiz"), ...(view === "everything" ? [it("g3")] : [])];
  const owned = (id: string) => (view === "everything" ? itemsOf(id).filter((x) => x.kind !== "mission").map((x) => it(x.id)) : []);
  return [...top, ...LEADS.flatMap((l) => [r(l), ...owned(l), ...subsOf(l).flatMap((s) => [r(s), ...owned(s)])])];
}

/**
 * Slide every card from where it was to where the change puts it (260ms, as
 * the app does when a view or zoom stop changes); cards new to the view fade
 * in and the lines fade in under them. Measured around a synchronous render
 * in the handler, so nothing runs on render.
 */
function flip(root: HTMLElement | null, update: () => void) {
  const still = !root || !!root.closest("[data-static]") || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (still) { update(); return; }
  // The phone list and the canvas both draw every card; only the one on screen moves.
  const cards = () => Array.from(root.querySelectorAll<HTMLElement>("[data-flip]")).filter((el) => el.offsetParent !== null);
  const before = new Map<string, DOMRect>();
  for (const el of cards()) { el.getAnimations().forEach((a) => a.cancel()); before.set(el.dataset.flip!, el.getBoundingClientRect()); }
  flushSync(update);
  const ease = "cubic-bezier(.2,.75,.2,1)";
  for (const el of cards()) {
    const b = before.get(el.dataset.flip!);
    const a = el.getBoundingClientRect();
    if (!b) { el.animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 120, easing: ease, fill: "backwards" }); continue; }
    const dx = b.left - a.left;
    const dy = b.top - a.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 260, easing: ease });
  }
  const fadeIn = { duration: 200, delay: 160, fill: "backwards" as const };
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-line]"))) el.animate([{ opacity: 0 }, { opacity: 1 }], fadeIn);
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".og-views-kid"))) {
    for (const pseudoElement of ["::before", "::after"]) el.animate([{ opacity: 0 }, { opacity: 1 }], { ...fadeIn, pseudoElement });
  }
}

const matches = (find: string, q: string) => q.trim().length > 0 && find.toLowerCase().includes(q.trim().toLowerCase());

export function Views() {
  const [view, setView] = useState<View>("people");
  const [needs, setNeeds] = useState(false);
  const [week, setWeek] = useState(false);
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(0);
  const [zoom, setZoom] = useState(1);
  const level = levelOf(zoom);
  const chartRef = useRef<HTMLDivElement>(null);
  const moving = (update: () => void) => flip(chartRef.current, update);
  /** A zoom that crosses a stop re-lays the cards; within a level it only moves the readout. */
  const zoomTo = (z: number) => {
    const next = Math.min(1.6, Math.max(0.5, +z.toFixed(2)));
    if (levelOf(next) === level) setZoom(next);
    else moving(() => setZoom(next));
  };

  const cards = visibleCards(view);
  const hits = cards.filter((c) => matches(c.find, q)).map((c) => c.key);
  const litCount = cards.filter((c) => c.lit).length;
  const focused = hits.length ? hits[focus % hits.length] : null;
  const mark = (key: string): Mark => {
    const c = cards.find((x) => x.key === key);
    const hit = hits.includes(key);
    return {
      lit: needs && !!c?.lit,
      dim: (needs && !c?.lit) || (q.trim().length > 0 && !hit),
      match: key === focused ? "focus" : hit ? "hit" : undefined,
    };
  };
  const step = (d: number) => setFocus((f) => (hits.length ? (f + d + hits.length) % hits.length : 0));

  const roleCard = (id: string) => <RoleCard r={role(id)} level={level} mark={mark(id)} week={week && view === "people"} />;
  const item = (id: string) => <ItemCard it={ITEMS.find((i) => i.id === id)!} level={level} mark={mark(id)} />;
  const owned = (id: string) => (view === "everything" ? itemsOf(id).filter((x) => x.kind !== "mission").map((x) => item(x.id)) : []);
  const withOwned = (id: string) => <>{roleCard(id)}<Kids>{owned(id)}</Kids></>;

  const lead = (id: string) => <>{roleCard(id)}<Kids>{[...owned(id), ...subsOf(id).map(withOwned)]}</Kids></>;
  const maya = <PersonCard id="maya" level={level} mark={mark("maya")} note="owner" />;
  const chip = (id: string) => <PersonChip id={id} level={level} mark={mark(id)} />;
  const mission = view === "everything" && <><span data-line className="mt-[28px] w-4 shrink-0 border-t-[1.5px]" style={{ borderColor: "var(--og-views-line)" }} />{item("m")}</>;
  const peers = <div className="flex flex-col gap-1.5">{chip("leo")}{chip("ines")}<Kids>{owned("p:ines")}</Kids></div>;
  const noGoal = (
    <div className="mt-8 pt-4 border-t font-mono" style={{ borderColor: LINE }}>
      <div className="text-meta mb-3" style={{ color: DIM }}>{underNoGoal.length} projects under no goal</div>
      <div className="flex flex-wrap gap-3">{underNoGoal.map((x) => <div key={x.id}>{item(x.id)}</div>)}</div>
    </div>
  );

  // Wide screens: Maya over a bus to the three leads, Leo and Ines beside her
  // as peers with no lines; Engineering's four roles two up so the tree fits.
  const canvas = view === "goals" ? (
    <>
      <Tree head={item("m")} cols={GOALS.map((g) => <>{item(g)}<Kids>{projectsOf(g).map((x) => item(x.id))}</Kids></>)} />
      {noGoal}
    </>
  ) : (
    <Tree
      head={<div className="flex items-start gap-6"><div className="flex items-start">{maya}{mission}</div>{peers}</div>}
      cols={[
        <>{roleCard("eng")}<Split cols={[[...owned("eng"), withOwned("infra"), withOwned("release")], [withOwned("mobile"), withOwned("evals")]]} /></>,
        lead("growth"),
        lead("people"),
      ]}
    />
  );

  // Phones: one vertical list, leads indented under Maya with their roles under them.
  const list = view === "goals" ? (
    <>{item("m")}<Kids>{GOALS.map((g) => <>{item(g)}<Kids>{projectsOf(g).map((x) => item(x.id))}</Kids></>)}</Kids>{noGoal}</>
  ) : (
    <>
      <div className="mb-4">{peers}</div>
      {maya}
      <Kids>{[...(view === "everything" ? [item("m")] : []), ...LEADS.map((l) => lead(l))]}</Kids>
    </>
  );

  return (
    <Section
      id="the-chart"
      band
      title="The whole company on one chart"
      lede={<p>Org draws every person and role as one chart. Each role card says what its agent is doing in its own words, how its sessions stand, and how its area is doing: waiting on you, stuck, overloaded, quiet or on track, with the reason. Needs you lights only what waits on you.</p>}
    >
      <style>{CSS}</style>
      <Frame>
        <div className="og-views-bar flex flex-nowrap sm:flex-wrap items-center gap-2 px-3 py-2 border-b font-mono text-[12px] overflow-x-auto sm:overflow-visible" style={{ borderColor: LINE, background: tint(SAND, 35) }}>
          <span className="font-bold text-[14px] mr-1 shrink-0 whitespace-nowrap" style={{ color: INK }}>Org</span>
          <div className="flex shrink-0 rounded-lg p-[3px] border" style={{ background: tint(SAND, 90), borderColor: LINE }} role="tablist">
            {VIEWS.map((v) => (
              <button key={v.id} type="button" role="tab" aria-selected={view === v.id} onClick={() => view !== v.id && moving(() => { setView(v.id); setFocus(0); })} className={`og-press shrink-0 whitespace-nowrap h-7 px-3 rounded-md font-semibold ${view === v.id ? "" : "hover:bg-[#fffdf6]/70 cursor-pointer"}`} style={view === v.id ? { background: "#fffdf6", color: INK, boxShadow: `0 1px 3px rgba(0,43,54,.18), inset 0 0 0 1px ${LINE}` } : { color: MUTED }}>{v.label}</button>
            ))}
          </div>
          {view === "people" && <Toggle on={week} onClick={() => moving(() => setWeek(!week))}>This week</Toggle>}
          <label className="flex shrink-0 whitespace-nowrap items-center gap-1.5 h-8 px-2.5 rounded-lg border w-[200px] sm:w-[230px]" style={{ borderColor: LINE, background: "#fffdf6" }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={DIM} strokeWidth="2.2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <input value={q} onChange={(e) => { setQ(e.target.value); setFocus(0); }} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }} placeholder="Find on the chart" aria-label="Find on the chart" className="min-w-0 flex-1 bg-transparent outline-none text-[12px]" style={{ color: TEXT }} />
            {q.trim() && <span className="shrink-0 tabular-nums text-meta" style={{ color: hits.length ? MUTED : SOL.red }}>{hits.length ? `${(focus % hits.length) + 1} of ${hits.length}` : "none"}</span>}
            {hits.length > 1 && (
              <span className="flex shrink-0">
                <button type="button" aria-label="Previous match" onClick={() => step(-1)} className="w-5 h-5 rounded hover:bg-black/5" style={{ color: MUTED }}>‹</button>
                <button type="button" aria-label="Next match" onClick={() => step(1)} className="w-5 h-5 rounded hover:bg-black/5" style={{ color: MUTED }}>›</button>
              </span>
            )}
          </label>
          <Toggle on={needs} onClick={() => setNeeds(!needs)} lead={<span className="w-[7px] h-[7px] rounded-full" style={{ background: SOL.yellow }} />}>
            Needs you{needs && <span className="tabular-nums" style={{ color: DIM }}> {litCount}</span>}
          </Toggle>
          <span className="ml-auto hidden lg:inline-flex shrink-0 whitespace-nowrap items-center gap-2 h-8 px-2.5 rounded-lg border" style={{ borderColor: LINE, color: TEXT }}>
            <Tile k="org chart" size={18} /> Head of People
          </span>
        </div>

        <div ref={chartRef} style={{ ["--og-views-line" as string]: "rgba(88,110,117,.38)" }}>
          <div className="hidden sm:block og-grid overflow-auto h-[600px]" style={{ ["--og-views-w" as string]: `${WIDTH[level]}px` }}>
            <div className="w-max mx-auto px-4 py-5">{canvas}</div>
          </div>
          <div className="sm:hidden og-grid px-3 py-4" style={{ ["--og-views-w" as string]: "100%" }}>{list}</div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-3 py-2.5 border-t font-mono text-meta" style={{ borderColor: LINE, background: tint(SAND, 35) }}>
          <div className="flex items-center gap-1.5">
            <ZoomBtn label="Zoom out" onClick={() => zoomTo(zoom - 0.15)}>−</ZoomBtn>
            <input type="range" min={0.5} max={1.6} step={0.05} value={zoom} onChange={(e) => zoomTo(Number(e.target.value))} aria-label="Zoom" className="w-[120px] accent-[#268bd2]" />
            <ZoomBtn label="Zoom in" onClick={() => zoomTo(zoom + 0.15)}>+</ZoomBtn>
            <span className="w-10 text-right tabular-nums" style={{ color: MUTED }}>{Math.round(zoom * 100)}%</span>
            <span className="flex ml-1">
              {STOPS.map((s) => (
                <button key={s.level} type="button" onClick={() => zoomTo(s.z)} className={`og-press px-2 h-7 rounded-md ${level === s.level ? "" : "hover:bg-black/5"}`} style={level === s.level ? { background: tint(SOL.blue, 14, "#fffdf6"), color: SOL.blue } : { color: DIM }}>{s.label}</button>
              ))}
            </span>
          </div>
          <span className="ml-auto inline-flex flex-wrap items-center gap-x-2.5 gap-y-1 tabular-nums" title="Every session in the company">
            {COUNT_ORDER.map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span className="w-[6px] h-[6px] rounded-full" style={{ background: COUNT_META[k].color }} />
                <span style={{ color: TEXT }}>{TOTALS[k] ?? 0}</span>
                <span style={{ color: MUTED }}>{COUNT_META[k].label}</span>
              </span>
            ))}
          </span>
        </div>
      </Frame>
    </Section>
  );
}

/**
 * A tidy tree: the parent (and anything drawn beside it) over the second
 * column, a bus from it to every column, one child per column with its own
 * children under it. Card centres sit at half the card width, so the lines
 * meet them at every zoom level.
 */
function Tree({ head, cols }: { head: ReactNode; cols: ReactNode[] }) {
  const line = "1.5px solid var(--og-views-line)";
  return (
    <div className="grid" style={{ gridTemplateColumns: `repeat(${cols.length}, max-content)` }}>
      <div className="flex flex-col" style={{ gridColumn: "2 / -1", gridRow: 1 }}>
        {head}
        <span data-line className="flex-1 min-h-3" style={{ marginLeft: "calc(var(--og-views-w) / 2)", borderLeft: line }} />
      </div>
      {cols.map((c, i) => (
        <div key={i} className={`relative pt-7 ${i < cols.length - 1 ? "pr-6" : ""}`} style={{ gridRow: 2, gridColumn: i + 1 }}>
          <span data-line className="absolute top-0 h-0" style={{ borderTop: line, left: i === 0 ? "calc(var(--og-views-w) / 2)" : 0, right: i === cols.length - 1 ? "auto" : 0, width: i === cols.length - 1 ? "calc(var(--og-views-w) / 2)" : undefined }} />
          <span data-line className="absolute top-0 h-7" style={{ left: "calc(var(--og-views-w) / 2)", borderLeft: line }} />
          {c}
        </div>
      ))}
    </div>
  );
}

/** A parent's children two up: a short bus from the parent to two rails side by side. */
function Split({ cols }: { cols: ReactNode[][] }) {
  const line = "1.5px solid var(--og-views-line)";
  return (
    <div className="relative flex gap-3 pt-2.5">
      <span data-line className="absolute top-0 h-2.5" style={{ left: "calc(var(--og-views-w) / 2)", borderLeft: line }} />
      <span data-line className="absolute top-2.5 h-0" style={{ left: 14, width: "calc(var(--og-views-w) + 40px)", borderTop: line }} />
      {cols.map((c, i) => <div key={i}><Kids>{c}</Kids></div>)}
    </div>
  );
}

/** Children on a rail under their parent, like sessions under a role in the app. */
function Kids({ children }: { children: ReactNode[] }) {
  if (children.length === 0) return null;
  return <div className="og-views-kids">{children.map((c, i) => <div key={i} className="og-views-kid">{c}</div>)}</div>;
}

function Toggle({ on, onClick, children, lead }: { on: boolean; onClick: () => void; children: ReactNode; lead?: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={`og-press inline-flex shrink-0 whitespace-nowrap items-center gap-1.5 h-8 px-2.5 rounded-lg border font-semibold ${on ? "" : "hover:border-[rgba(88,110,117,.45)]"}`} style={on ? { borderColor: tint(SOL.yellow, 70), background: tint(SOL.yellow, 16, "#fffdf6"), color: INK } : { borderColor: LINE, color: TEXT, background: "#fffdf6" }}>
      {lead}{children}
    </button>
  );
}

function ZoomBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-label={label} onClick={onClick} className="og-press w-7 h-7 rounded-md border text-[15px] leading-none hover:border-[rgba(88,110,117,.45)]" style={{ borderColor: LINE, color: TEXT, background: "#fffdf6" }}>{children}</button>;
}

const CSS = `
.og-views-card { transition: opacity .2s ease, filter .2s ease, box-shadow .2s ease, width .26s var(--og-ease); }
.og-views-card[data-dim] { opacity: .3; filter: saturate(.2); }
.og-views-swap { animation-name: og-fade; animation-duration: .26s; }
.og-views-kids { margin-left: 14px; }
.og-views-kid { position: relative; padding-left: 14px; padding-top: 8px; }
.og-views-kid::before { content: ""; position: absolute; left: 0; top: 28px; width: 12px; border-top: 1.5px solid var(--og-views-line); }
.og-views-kid::after { content: ""; position: absolute; left: 0; top: 0; bottom: 0; border-left: 1.5px solid var(--og-views-line); }
.og-views-kid:last-child::after { bottom: auto; height: 29px; }
.og-views-bar { scrollbar-width: none; }
.og-views-bar::-webkit-scrollbar { display: none; }
@media (prefers-reduced-motion: reduce) { .og-views-card { transition: none; } }
`;
