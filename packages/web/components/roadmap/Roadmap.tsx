"use client";
// The goals and projects in time (roadmapModel): a row per goal and project
// in the document's order, each a bar from when its work began to its target
// day. The part of a bar before today holds its burn-up, how much of its work
// was done at each moment; the part after today is the time left, and a
// dashed line from today runs to the day the open work is done at the last
// four weeks' pace, green when that lands by the target and yellow when it
// does not. Milestones are diamonds and the owner's updates are dots in the
// colour of the health they reported.
//
// The deadline is the bar's end: drag it to move it, and on a row without
// one, click the lane where it should fall. Selecting a row opens its sheet
// beside the chart (RoadmapDetail): the chart large, the roles and sessions
// on it, and its tasks.
import { createContext, useCallback, useContext, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronRight, Flag, Users } from "lucide-react";
import type { InitiativeUpdateRow } from "@codecast/shared/contracts/initiative";
import { targetDayStamp } from "@codecast/shared/time";
import { useInboxStore, type ProjectItem } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useSyncInitiativeUpdates } from "../../hooks/useInitiatives";
import { useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { useSyncTasks } from "../../hooks/useSyncTasks";
import { HEALTH_COLOR, INITIATIVE_ACCENT } from "../../lib/initiativeColors";
import { projectDotClass } from "../../lib/projectColors";
import { cn } from "../../lib/utils";
import { SegmentedToggle } from "../SegmentedToggle";
import { OwnerChip } from "../initiatives/InitiativeAtoms";
import { RoleFace } from "../org/RoleFace";
import { useLineTree } from "../org/lines/lineTree";
import { useCompanyDoc } from "../company/useCompanyDoc";
import { DAY, endedCount, indexTasks, roadmap, standingOf, visibleRows, type RoadRow, type RoadTask, type Standing, type TaskSession } from "./roadmapModel";
import { RoadmapDetail } from "./RoadmapDetail";
import { dayLabel, fmtDay, PACE_COLOR, rowAccent, STANDING_WORD } from "./roadmapAtoms";

/** The name column's width: narrower on a phone. */
const LeftWidth = createContext(384);
const ZOOMS = { weeks: 30, months: 8, quarters: 2.8, year: 1.15 } as const;
type Zoom = keyof typeof ZOOMS;
const ROW_H = { goal0: 50, goal: 42, role: 46, project: 34 } as const;
const heightOf = (r: RoadRow) => (r.kind === "project" ? ROW_H.project : r.kind === "role" ? ROW_H.role : r.depth === 0 ? ROW_H.goal0 : ROW_H.goal);
const BAR_H = { goal0: 20, goal: 16, role: 18, project: 12 } as const;
const barOf = (r: RoadRow) => (r.kind === "project" ? BAR_H.project : r.kind === "role" ? BAR_H.role : r.depth === 0 ? BAR_H.goal0 : BAR_H.goal);
const HAIR = "color-mix(in srgb, var(--sol-border) 30%, transparent)";
const TODAY = "var(--sol-blue)";

const taskSig = (t: RoadTask) => `${t.status ?? ""}|${t.project_id ?? ""}|${t.closed_at ?? ""}|${t.source ?? ""}|${t.promoted ? 1 : 0}|${t.triage_status ?? ""}|${t.assignee ?? ""}`;
const projSig = (p: ProjectItem) => `${p.status}|${p.created_at}|${p.target_date ?? ""}`;

/** One goal's updates into the store, for its dots. */
function UpdatesFeed({ id }: { id: string }) {
  useSyncInitiativeUpdates(id);
  return null;
}

export type RoadmapScope = "goals" | "projects";

export function Roadmap({ scope, switcher }: { scope: RoadmapScope; switcher?: React.ReactNode }) {
  useSyncOrgTreeFeeder();
  useSyncProjects();
  useSyncTasks();
  useSyncOrgProposals();
  const { doc } = useCompanyDoc();
  const tree = useLineTree();
  const now = useCoarseNow(60_000);
  const phone = useIsPhone();
  const LEFT = phone ? 210 : 384;
  const tasks = useWorkspaceCollection<RoadTask>("tasks", taskSig);
  const projects = useWorkspaceCollection<ProjectItem>("projects", projSig);
  const index = useMemo(() => indexTasks(tasks), [tasks]);
  const sessionSig = useInboxStore((s) => Object.entries((s.taskActiveSessions ?? {}) as Record<string, TaskSession>).map(([k, v]) => `${k}:${v?._id}:${v?.agent_status}`).join(","));
  const taskSessions = useMemo(() => ({ ...(useInboxStore.getState().taskActiveSessions ?? {}) }) as Record<string, TaskSession>, [sessionSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const [zoom, setZoom] = useState<Zoom>("months");
  const [group, setGroup] = useState<"goals" | "roles">(scope === "projects" ? "roles" : "goals");
  const [showEnded, setShowEnded] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<string | null>(null);

  const map = useMemo(() => roadmap({ doc, projects, tasks: index, tree, now, showEnded, group, taskSessions }), [doc, projects, index, tree, now, showEnded, group, taskSessions]);
  const rows = useMemo(() => visibleRows(map.rows, folded), [map.rows, folded]);
  const goalIds = useMemo(() => map.rows.filter((r) => r.kind === "goal").map((r) => r.id), [map.rows]);
  const goalSet = useMemo(() => new Set(goalIds), [goalIds]);
  const updates = useCollectionRows<InitiativeUpdateRow>("initiativeUpdates", { where: useCallback((u: InitiativeUpdateRow) => goalSet.has(u.initiative_id), [goalSet]), sig: updateSig });
  const updatesBy = useMemo(() => {
    const m = new Map<string, InitiativeUpdateRow[]>();
    for (const u of updates) m.set(u.initiative_id, [...(m.get(u.initiative_id) ?? []), u]);
    return m;
  }, [updates]);

  const ppd = ZOOMS[zoom];
  const x = useCallback((t: number) => ((t - map.from) / DAY) * ppd, [map.from, ppd]);
  const tOf = useCallback((px: number) => map.from + (px / ppd) * DAY, [map.from, ppd]);
  const width = x(map.to);

  // Keep today in view while the rows arrive (the domain widens as they do)
  // until the person scrolls, and the same moment under the centre on a zoom.
  const scroller = useRef<HTMLDivElement>(null);
  const centreAt = useRef<number | null>(null);
  const moved = useRef(false);
  const ours = useRef(false);
  const scrollTo = (t: number, at = 0.38) => {
    const el = scroller.current;
    if (!el) return;
    ours.current = true;
    el.scrollLeft = Math.max(0, x(t) - (el.clientWidth - LEFT) * at);
  };
  const onScroll = () => { if (ours.current) ours.current = false; else moved.current = true; };
  useWatchEffect(() => { if (!moved.current) scrollTo(now); }, [map.from, width > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const zoomTo = (z: Zoom) => {
    const el = scroller.current;
    if (el) centreAt.current = tOf(el.scrollLeft + (el.clientWidth - LEFT) / 2);
    setZoom(z);
  };
  useWatchEffect(() => {
    if (centreAt.current !== null) { scrollTo(centreAt.current, 0.5); centreAt.current = null; }
  }, [ppd]); // eslint-disable-line react-hooks/exhaustive-deps

  // A deadline being dragged: the row and the day under the pointer.
  const [drag, setDrag] = useState<{ key: string; t: number } | null>(null);
  const commitTarget = (r: RoadRow, t: number) => {
    const d = new Date(t);
    const st = useInboxStore.getState();
    if (r.kind === "goal") {
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const ts = targetDayStamp(day);
      if (ts && ts !== r.target) st.updateInitiative(r.id, { target_date: ts });
    } else if (r.kind === "project") {
      const ts = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59).getTime();
      if (ts !== r.target) st.updateProject(r.id, { target_date: ts });
    }
  };
  const startDrag = (r: RoadRow, e: ReactPointerEvent) => {
    e.stopPropagation(); e.preventDefault();
    const lane = (e.currentTarget as HTMLElement).closest("[data-road-lane]") as HTMLElement;
    const left = lane.getBoundingClientRect().left;
    const at = (cx: number) => Math.round(tOf(cx - left) / DAY) * DAY;
    setDrag({ key: r.key, t: at(e.clientX) });
    // Escape puts it back where it was.
    const move = (ev: PointerEvent) => setDrag({ key: r.key, t: at(ev.clientX) });
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("keydown", key, true); setDrag(null); };
    const up = (ev: PointerEvent) => { end(); commitTarget(r, at(ev.clientX)); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") { ev.stopPropagation(); end(); } };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("keydown", key, true);
  };

  const tally = useMemo(() => {
    const c: Partial<Record<Standing, number>> = {};
    for (const r of map.rows) if (r.kind === (group === "roles" ? "project" : scope === "projects" ? "project" : "goal")) { const s = standingOf(r, now); c[s] = (c[s] ?? 0) + 1; }
    return c;
  }, [map.rows, now, group, scope]);
  const sel = selected ? map.byKey.get(selected) ?? null : null;
  const ended = useMemo(() => endedCount(doc), [doc]);

  // ↑/↓ walk the rows, Escape closes the sheet.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && selected) { setSelected(null); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const i = rows.findIndex((r) => r.key === selected);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) { e.preventDefault(); setSelected(next.key); }
  };

  const toggleFold = (key: string) => setFolded((f) => { const n = new Set(f); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  let y = 0;
  const placed = rows.map((r) => { const top = y; y += heightOf(r); return { r, top }; });
  const bodyH = y;

  return (
    <LeftWidth.Provider value={LEFT}>
    <div className="flex h-full min-h-0 flex-col outline-none" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} tabIndex={-1} onKeyDown={onKey} data-roadmap>
      {goalIds.map((id) => <UpdatesFeed key={id} id={id} />)}
      <header className="flex flex-wrap items-end gap-x-6 gap-y-2 px-6 pb-3 pt-5">
        <div className="min-w-0">
          <h1 className="text-[26px] font-medium leading-none tracking-[-0.015em]" style={{ fontFamily: "var(--font-serif)" }}>{scope === "projects" ? "Projects" : "Goals"}</h1>
          {scope === "goals" && map.mission && <p className="mt-2 max-w-[640px] truncate text-[12.5px]" style={{ color: "var(--sol-text-muted)", fontFamily: "var(--font-serif)" }} title={map.mission.title}>{map.mission.title}</p>}
          <Tally tally={tally} />
        </div>
        <div className="ml-auto flex items-center gap-2">
          <SegmentedToggle size="sm" value={group} onChange={(k) => setGroup(k as "goals" | "roles")} items={[{ key: "goals", label: "By goal", icon: Flag }, { key: "roles", label: "By role", icon: Users }]} />
          <SegmentedToggle size="sm" value={zoom} onChange={(k) => zoomTo(k as Zoom)} items={[{ key: "weeks", label: "Weeks" }, { key: "months", label: "Months" }, { key: "quarters", label: "Quarters" }, { key: "year", label: "Year" }]} />
          <button type="button" onClick={() => scrollTo(now, 0.38)} className="h-6 rounded-md border border-sol-border/40 px-2 text-[11px] text-sol-text-dim transition-colors hover:text-sol-text">Today</button>
          <button type="button" onClick={() => setShowEnded(!showEnded)} aria-pressed={showEnded} disabled={!ended} className={cn("h-6 rounded-md border px-2 text-[11px] tabular-nums transition-colors disabled:opacity-40", showEnded ? "border-sol-border/60 bg-sol-bg-highlight text-sol-text" : "border-sol-border/40 text-sol-text-dim hover:text-sol-text")} title={showEnded ? "Hide finished goals and projects" : "Show finished goals and projects"}>Finished {ended}</button>
          {switcher}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 border-t" style={{ borderColor: HAIR }}>
        <div ref={scroller} onScroll={onScroll} className="relative min-w-0 flex-1 overflow-auto overscroll-contain" data-road-scroller>
          <div className="relative" style={{ width: LEFT + width, minHeight: "100%" }}>
            <Axis from={map.from} to={map.to} x={x} zoom={zoom} now={now} />
            <div className="relative" style={{ height: bodyH }}>
              <Grid from={map.from} to={map.to} x={x} zoom={zoom} height={bodyH} />
              <div className="pointer-events-none absolute top-0 z-[2] w-px" style={{ left: LEFT + x(now), height: bodyH, background: TODAY, opacity: 0.55 }} />
              {placed.map(({ r, top }) => (
                <Row
                  key={r.key} r={r} top={top} now={now} x={x} tOf={tOf}
                  selected={selected === r.key} folded={folded.has(r.key)} onFold={() => toggleFold(r.key)}
                  onSelect={() => setSelected(selected === r.key ? null : r.key)}
                  drag={drag?.key === r.key ? drag.t : null} onDrag={(e) => startDrag(r, e)} onSet={(t) => commitTarget(r, t)}
                  updates={r.kind === "goal" ? updatesBy.get(r.id) : undefined}
                />
              ))}
            </div>
            {rows.length === 0 && <p className="sticky left-0 px-6 py-10 text-[13px]" style={{ color: "var(--sol-text-dim)", width: LEFT + 400 }}>{scope === "projects" ? "No projects yet." : "No goals yet."}</p>}
          </div>
        </div>
        {sel && <RoadmapDetail row={sel} now={now} index={index} updates={sel.kind === "goal" ? updatesBy.get(sel.id) ?? [] : []} onClose={() => setSelected(null)} onSelect={setSelected} map={map} phone={phone} />}
      </div>
    </div>
    </LeftWidth.Provider>
  );
}

const updateSig = (u: InitiativeUpdateRow) => `${u.initiative_id}|${u.health}|${u.at}`;

function Tally({ tally }: { tally: Partial<Record<Standing, number>> }) {
  const order: Standing[] = ["late", "behind", "on_pace", "no_pace", "no_date", "done"];
  const parts = order.filter((s) => tally[s]);
  if (!parts.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] tabular-nums" data-roadmap-tally>
      {parts.map((s) => (
        <span key={s} className="inline-flex items-center gap-1.5" style={{ color: "var(--sol-text-muted)" }}>
          <span className="h-[7px] w-[7px] rounded-full" style={{ background: PACE_COLOR[s] }} />
          <span style={{ color: "var(--sol-text)" }}>{tally[s]}</span> {STANDING_WORD[s]}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the axis

type Tick = { t: number; label: string; major: boolean };

function ticks(from: number, to: number, zoom: Zoom): { top: Tick[]; minor: Tick[] } {
  const top: Tick[] = [], minor: Tick[] = [];
  const start = new Date(from); start.setHours(0, 0, 0, 0);
  if (zoom === "weeks" || zoom === "months") {
    const m = new Date(start.getFullYear(), start.getMonth(), 1);
    for (; m.getTime() <= to; m.setMonth(m.getMonth() + 1)) {
      top.push({ t: m.getTime(), label: m.toLocaleDateString(undefined, { month: zoom === "weeks" ? "long" : "short", ...(m.getMonth() === 0 || zoom === "weeks" ? { year: "numeric" } : {}) }), major: true });
    }
    const w = new Date(start); w.setDate(w.getDate() - ((w.getDay() + 6) % 7));
    for (; w.getTime() <= to; w.setDate(w.getDate() + 7)) minor.push({ t: w.getTime(), label: zoom === "weeks" ? String(w.getDate()) : "", major: false });
  } else {
    const m = new Date(start.getFullYear(), start.getMonth(), 1);
    for (; m.getTime() <= to; m.setMonth(m.getMonth() + 1)) {
      const q = m.getMonth() % 3 === 0;
      if (zoom === "quarters" ? q : m.getMonth() === 0) top.push({ t: m.getTime(), label: zoom === "quarters" ? `Q${m.getMonth() / 3 + 1} ${m.getFullYear()}` : String(m.getFullYear()), major: true });
      minor.push({ t: m.getTime(), label: m.toLocaleDateString(undefined, { month: zoom === "year" ? "narrow" : "short" }), major: false });
    }
  }
  return { top, minor };
}

function Axis({ from, to, x, zoom, now }: { from: number; to: number; x: (t: number) => number; zoom: Zoom; now: number }) {
  const LEFT = useContext(LeftWidth);
  const { top, minor } = useMemo(() => ticks(from, to, zoom), [from, to, zoom]);
  return (
    <div className="sticky top-0 z-[6] flex h-[46px] border-b backdrop-blur" style={{ borderColor: HAIR, background: "color-mix(in srgb, var(--sol-bg) 92%, transparent)" }}>
      <div className="sticky left-0 z-[7] flex shrink-0 items-end border-r px-6 pb-2 text-[11px]" style={{ width: LEFT, borderColor: HAIR, background: "var(--sol-bg)", color: "var(--sol-text-dim)" }}>
        <span className="flex-1">Name</span>
        <span className="w-[74px] text-right">Done</span>
      </div>
      <div className="relative flex-1">
        {top.map((k) => (
          <div key={`t${k.t}`} className="absolute top-0 h-[22px] border-l pl-1.5 pt-1 text-[11px] font-medium whitespace-nowrap" style={{ left: x(k.t), borderColor: HAIR, color: "var(--sol-text-muted)" }}>{k.label}</div>
        ))}
        {minor.map((k) => k.label && Math.abs(x(k.t) - x(now)) > 34 && (
          <div key={`m${k.t}`} className="absolute bottom-1.5 pl-1 text-[10px] tabular-nums whitespace-nowrap" style={{ left: x(k.t), color: "var(--sol-text-dim)" }}>{k.label}</div>
        ))}
        <div className="absolute bottom-0 z-[1] -translate-x-1/2 rounded-t px-1.5 py-[1px] text-[10px] font-medium text-white" style={{ left: x(now), background: TODAY }}>Today</div>
      </div>
    </div>
  );
}

function Grid({ from, to, x, zoom, height }: { from: number; to: number; x: (t: number) => number; zoom: Zoom; height: number }) {
  const LEFT = useContext(LeftWidth);
  const { top, minor } = useMemo(() => ticks(from, to, zoom), [from, to, zoom]);
  return (
    <svg className="pointer-events-none absolute top-0" style={{ left: LEFT, height }} width={x(to)} height={height} aria-hidden>
      {minor.map((k) => <line key={`m${k.t}`} x1={x(k.t)} x2={x(k.t)} y1={0} y2={height} stroke="var(--sol-border)" strokeOpacity={0.12} />)}
      {top.map((k) => <line key={`t${k.t}`} x1={x(k.t)} x2={x(k.t)} y1={0} y2={height} stroke="var(--sol-border)" strokeOpacity={0.3} />)}
    </svg>
  );
}

// ---------------------------------------------------------------- a row

function Row({ r, top, now, x, tOf, selected, folded, onFold, onSelect, drag, onDrag, onSet, updates }: {
  r: RoadRow; top: number; now: number; x: (t: number) => number; tOf: (px: number) => number;
  selected: boolean; folded: boolean; onFold: () => void; onSelect: () => void;
  drag: number | null; onDrag: (e: ReactPointerEvent) => void; onSet: (t: number) => void;
  updates?: InitiativeUpdateRow[];
}) {
  const LEFT = useContext(LeftWidth);
  const h = heightOf(r);
  const accent = rowAccent(r);
  const live = (r.counts?.working ?? 0) + (r.counts?.needs_input ?? 0);
  const pct = r.total ? Math.round((r.done / r.total) * 100) : null;
  const strong = r.kind !== "project";
  return (
    <div
      className={cn("group/row absolute left-0 flex w-full hover:z-[5]", selected ? "z-[3]" : "z-[1]")}
      style={{ top, height: h, background: selected ? "color-mix(in srgb, var(--sol-blue) 7%, transparent)" : undefined, borderTop: r.depth === 0 && r.kind !== "project" ? `1px solid ${HAIR}` : undefined }}
      data-road-row={r.kind} data-road-key={r.key}
    >
      <div
        className="sticky left-0 z-[4] flex shrink-0 cursor-pointer items-center gap-2 border-r pr-3 transition-colors group-hover/row:bg-sol-bg-highlight/40"
        style={{ width: LEFT, paddingLeft: 14 + r.depth * 18, borderColor: HAIR, background: selected ? "color-mix(in srgb, var(--sol-blue) 9%, var(--sol-bg))" : "var(--sol-bg)" }}
        onClick={onSelect}
      >
        <button
          type="button" onClick={(e) => { e.stopPropagation(); onFold(); }}
          className={cn("grid h-4 w-4 shrink-0 place-items-center rounded transition-colors hover:bg-sol-bg-highlight", !r.children.length && "invisible")}
          aria-label={folded ? "Unfold" : "Fold"} aria-expanded={!folded}
        >
          <ChevronRight className={cn("h-3 w-3 transition-transform", !folded && "rotate-90")} style={{ color: "var(--sol-text-dim)" }} />
        </button>
        <Glyph r={r} accent={accent} />
        <span className={cn("min-w-0 flex-1 truncate", strong ? "text-[13px] font-medium" : "text-[12.5px]")} style={{ color: r.ended ? "var(--sol-text-dim)" : strong ? "var(--sol-text)" : "var(--sol-text-secondary)" }} title={r.title}>{r.title}</span>
        {live > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] tabular-nums" style={{ color: "var(--sol-green)" }} title={`${r.counts?.working ?? 0} working, ${r.counts?.needs_input ?? 0} need input`}>
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: r.counts?.needs_input ? "var(--sol-yellow)" : "var(--sol-green)" }} />{live}
          </span>
        )}
        {r.kind === "goal" && r.owner ? <OwnerChip owner={r.owner} size={16} nameless className="shrink-0" /> : r.kind === "project" && r.lead && r.parent !== `r:${r.lead._id}` ? <RoleFace role={r.lead as never} size={16} className="shrink-0" /> : null}
        <span className="flex w-[74px] shrink-0 items-center justify-end gap-2" title={r.total ? `${r.done} of ${r.total} tasks done` : "No tasks"}>
          {pct !== null && (
            <>
              <span className="h-[3px] w-[32px] overflow-hidden rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
                <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: accent }} />
              </span>
              <span className="w-[30px] text-right text-[11px] tabular-nums" style={{ color: "var(--sol-text-muted)" }}>{pct}%</span>
            </>
          )}
        </span>
      </div>
      <Lane r={r} h={h} now={now} x={x} tOf={tOf} accent={accent} onSelect={onSelect} drag={drag} onDrag={onDrag} onSet={onSet} updates={updates} />
    </div>
  );
}

function Glyph({ r, accent }: { r: RoadRow; accent: string }) {
  if (r.kind === "project") return <span className={cn("h-[8px] w-[8px] shrink-0 rounded-[2px]", projectDotClass({ color: r.color, title: r.title }))} />;
  if (r.kind === "role") return <RoleFace role={r.lead as never} size={18} className="shrink-0" />;
  return <span className="h-[10px] w-[10px] shrink-0 rounded-full border-2" style={{ borderColor: accent, background: r.health && r.health !== "none" ? accent : "transparent" }} />;
}

function Lane({ r, h, now, x, tOf, accent, onSelect, drag, onDrag, onSet, updates }: {
  r: RoadRow; h: number; now: number; x: (t: number) => number; tOf: (px: number) => number; accent: string;
  onSelect: () => void; drag: number | null; onDrag: (e: ReactPointerEvent) => void; onSet: (t: number) => void; updates?: InitiativeUpdateRow[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const bh = barOf(r);
  const mid = h / 2;
  const target = drag ?? r.target;
  const x0 = x(r.start);
  const xNow = x(now);
  const xEnd = target ? x(target) : xNow;
  const late = !r.ended && !!target && target < now;
  const standing = standingOf({ ...r, target }, now);
  const pastEnd = Math.min(xNow, Math.max(xEnd, xNow));
  const editable = r.kind !== "role";
  const undated = !target && editable;
  const dayAt = (cx: number, el: HTMLElement) => Math.round(tOf(cx - el.getBoundingClientRect().left) / DAY) * DAY;

  return (
    <div
      className={cn("relative flex-1", undated && hover !== null && hover >= now - DAY ? "cursor-crosshair" : "cursor-pointer")}
      data-road-lane
      onPointerMove={(e) => setHover(dayAt(e.clientX, e.currentTarget))}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => { const t = dayAt(e.clientX, e.currentTarget); if (undated && t >= now - DAY) { onSet(t); setHover(null); } else onSelect(); }}
    >
      {/* The span until today: the burn-up inside it. */}
      <div className="absolute overflow-hidden rounded-[3px]" style={{ left: x0, width: Math.max(2, pastEnd - x0), top: mid - bh / 2, height: bh, background: `color-mix(in srgb, ${accent} 16%, transparent)` }}>
        <Burnup r={r} w={Math.max(2, pastEnd - x0)} h={bh} accent={accent} x0={x0} x={x} />
      </div>
      {/* The time left to the target. */}
      {target && target > now && (
        <div className="absolute rounded-r-[3px] border border-l-0 border-dashed" style={{ left: xNow, width: xEnd - xNow, top: mid - bh / 2, height: bh, borderColor: `color-mix(in srgb, ${accent} 45%, transparent)`, background: `color-mix(in srgb, ${accent} 4%, transparent)` }} />
      )}
      {/* Past the target and not done: the overrun to today. */}
      {late && (
        <div className="absolute" style={{ left: xEnd, width: xNow - xEnd, top: mid - bh / 2, height: bh, background: "repeating-linear-gradient(135deg, color-mix(in srgb, var(--sol-red) 38%, transparent) 0 3px, transparent 3px 7px)" }} />
      )}
      {/* At this pace: today to the day the open work is done. */}
      {!r.ended && r.forecast && r.total > r.done && (
        <Forecast from={xNow} to={x(r.forecast)} y={mid} color={PACE_COLOR[standing === "behind" || standing === "late" ? "behind" : target ? "on_pace" : "no_date"]} quiet={r.kind === "project"} label={r.kind !== "project" && (!target || Math.abs(x(r.forecast) - xEnd) > 70) ? `~${dayLabel(r.forecast)}` : undefined} />
      )}
      {/* The deadline, dragged to move. */}
      {target && (
        <div
          className={cn("absolute z-[2] flex items-center", editable && "cursor-ew-resize")}
          style={{ left: xEnd - 6, top: mid - bh / 2 - 4, height: bh + 8, width: 12 }}
          onPointerDown={editable ? onDrag : undefined}
          onClick={(e) => e.stopPropagation()}
          title={editable ? "Drag to move the deadline" : undefined}
          data-road-deadline
        >
          <span className="mx-auto block h-full w-[3px] rounded-full" style={{ background: late ? "var(--sol-red)" : accent }} />
        </div>
      )}
      {target && (
        <span className={cn("pointer-events-none absolute z-[2] whitespace-nowrap rounded px-1 text-[10.5px] leading-[15px] tabular-nums", drag !== null && "font-medium")} style={{ left: xEnd + 6, top: mid - 7.5, background: late || drag !== null ? "var(--sol-bg)" : undefined, color: drag !== null ? "var(--sol-text)" : late ? "var(--sol-red)" : "var(--sol-text-dim)" }}>
          {fmtDay(target, r.targetLocal)}{drag !== null && r.target && drag !== r.target ? ` · ${drag > r.target ? "+" : "−"}${Math.round(Math.abs(drag - r.target) / DAY)}d` : ""}
        </span>
      )}
      {/* Milestones and updates. */}
      {r.milestones.map((m) => {
        const t = m.done_at ?? m.date;
        if (!t) return null;
        return <span key={m.key} className="absolute z-[2] h-[9px] w-[9px] rotate-45 border" title={`${m.title} · ${m.done_at ? `done ${dayLabel(m.done_at)}` : `due ${dayLabel(m.date!)}`}`} style={{ left: x(t) - 4.5, top: mid - bh / 2 - 7, borderColor: accent, background: m.done_at ? accent : "var(--sol-bg)" }} />;
      })}
      {updates?.map((u) => (
        <span key={u._id} className="absolute z-[2] h-[7px] w-[7px] rounded-full ring-2 ring-[var(--sol-bg)]" title={`${dayLabel(u.at)} · ${u.health.replace("_", " ")}: ${u.body.slice(0, 160)}`} style={{ left: x(u.at) - 3.5, top: mid + bh / 2 - 2, background: HEALTH_COLOR[u.health] }} />
      ))}
      {hover !== null && undated && hover >= now - DAY && (
        <>
          <span className="pointer-events-none absolute w-[2px] rounded-full" style={{ left: x(hover) - 1, top: mid - bh / 2 - 4, height: bh + 8, background: accent, opacity: 0.6 }} />
          <span className="pointer-events-none absolute whitespace-nowrap rounded px-1.5 py-[1px] text-[10.5px]" style={{ left: x(hover) + 6, top: mid - 8, background: "var(--sol-bg-alt)", color: "var(--sol-text)", border: `1px solid ${HAIR}` }}>Set deadline {dayLabel(hover)}</span>
        </>
      )}
      {hover !== null && !(undated && hover >= now - DAY) && drag === null && <Scrub r={r} t={hover} now={now} x={x(hover)} h={h} />}
    </div>
  );
}

/** The share done over time, as a rising fill inside the bar. */
function Burnup({ r, w, h, accent, x0, x }: { r: RoadRow; w: number; h: number; accent: string; x0: number; x: (t: number) => number }) {
  if (r.total === 0 || w < 6) return null;
  const pts = r.series.map((s) => [x(s.t) - x0, h - (s.total ? (s.done / s.total) * h : 0)] as const);
  const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
  return (
    <svg className="absolute inset-0" width={w} height={h} preserveAspectRatio="none" aria-hidden>
      <path d={`${line}L${pts.at(-1)![0].toFixed(1)},${h}L0,${h}Z`} fill={accent} fillOpacity={0.55} />
      <path d={line} fill="none" stroke={accent} strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Forecast({ from, to, y, color, label, quiet }: { from: number; to: number; y: number; color: string; label?: string; quiet?: boolean }) {
  if (to - from < 3) return null;
  return (
    <span className={cn("contents", quiet && "[&>*]:opacity-30 group-hover/row:[&>*]:opacity-90")}>
      {label && <span className="pointer-events-none absolute whitespace-nowrap text-[10px] tabular-nums" style={{ left: to + 7, top: y - 7, color }} title="When the open tasks are done at the last four weeks' pace">{label}</span>}
      <span className="pointer-events-none absolute border-t border-dashed" style={{ left: from, width: to - from, top: y, borderColor: color }} />
      <span className="pointer-events-none absolute h-[7px] w-[7px] rounded-full border-[1.5px]" style={{ left: to - 3.5, top: y - 3.5, borderColor: color, background: "var(--sol-bg)" }} />
    </span>
  );
}

/** What the row said on the day under the pointer: how much was done by
 *  then, or for a day ahead, how far off it is and where the pace lands. */
function Scrub({ r, t, now, x, h }: { r: RoadRow; t: number; now: number; x: number; h: number }) {
  const past = t <= now;
  const at = past ? sampleAt(r, t) : null;
  const s = standingOf(r, now);
  const days = Math.round((t - now) / DAY);
  if (past && t < r.start) return null;
  return (
    <>
      <span className="pointer-events-none absolute top-1 w-px" style={{ left: x, height: h - 2, background: "var(--sol-text-muted)", opacity: 0.45 }} />
      <div className="pointer-events-none absolute z-[9] whitespace-nowrap rounded-md px-2.5 py-1.5 text-[11px] tabular-nums shadow-lg" style={{ left: x + 10, top: h - 4, background: "var(--sol-bg-alt)", border: `1px solid ${HAIR}`, color: "var(--sol-text-muted)" }} data-road-scrub>
        <span style={{ color: "var(--sol-text)" }}>{dayLabel(t)}</span>
        {at ? (
          at.total ? <> · <span style={{ color: "var(--sol-text)" }}>{at.done}</span> of {at.total} done <span style={{ color: "var(--sol-text-dim)" }}>{Math.round((at.done / at.total) * 100)}%</span></> : <> · no tasks yet</>
        ) : (
          <> · in {days}d{r.target ? <> · {r.target >= t ? `${Math.round((r.target - t) / DAY)}d before deadline` : <span style={{ color: "var(--sol-red)" }}>{Math.round((t - r.target) / DAY)}d past deadline</span>}</> : null}</>
        )}
        {!past && r.forecast && r.total > r.done && <> · pace lands <span style={{ color: PACE_COLOR[s] }}>{dayLabel(r.forecast)}</span></>}
        {past && Math.abs(t - now) < DAY && <> · {r.pace.closed} closed, {r.pace.opened} opened in 4w</>}
      </div>
    </>
  );
}

function sampleAt(r: RoadRow, t: number) {
  let best = r.series[0];
  for (const s of r.series) { if (s.t <= t) best = s; else break; }
  return best;
}

