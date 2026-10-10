"use client";
// The Graph view (line-workspace.md LW1): Studio's graph of the line. Lanes
// for Diagnose and Fix, agents, people and scripts drawn unmistakably apart,
// branches named in words, edge weight from how often runs took them. Essence
// draws scripts as dots and keeps a script's loops out of sight until a step
// is hovered; All steps draws every script and every end. A run is lit with
// its steps numbered, and the run bar steps to the run before or after.
// Pan, zoom and fit by pointer or key; ? lists every key. Clicking a step
// opens the shared step drawer through the selection, so the URL holds it.
import { useCallback, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Maximize2 } from "lucide-react";
import { stepCameBack, type LineRunModel } from "../../../../lib/line/lineModel";
import { useTabActive } from "../../../../hooks/usePagePresence";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { useMountEffect } from "../../../../hooks/useMountEffect";
import { hasOpenModal, isMac } from "../../../../shortcuts";
import { keyBelongsElsewhere } from "../../../../shortcuts/keyOwnership";
import { KeyCap } from "../../../KeyCap";
import { RunTrail, dayWords, durationWords, failureWords, useLineNav } from "../../widgets";
import { GraphCanvas, GraphDefs } from "./graph/GraphCanvas";
import { litRun } from "./graph/litRun";
import { DOT_LINE, essenceExits, exitWords, graphLayout, textW, type GEdge, type GraphMode } from "./graph/graphLayout";
import { FIT_MIN_K, usePanZoom, type Insets, type View } from "./graph/usePanZoom";
import { EdgeArrows } from "../../EdgeArrows";
import type { LineViewProps } from "./types";
import { FindBand } from "../FindBand";

const MODE_KEY = "lw-graph-mode";
const NO_PAST: { left: string[]; right: string[] } = { left: [], right: [] };
const readMode = (): GraphMode => {
  try { return localStorage.getItem(MODE_KEY) === "all" ? "all" : "essence"; } catch { return "essence"; }
};

type Tip = { x: number; y: number; title: string; body: string };
const KIND_TIP = { agent: "agent, one prompt", person: "you decide", script: "script, code", end: "ends the run" } as const;

/** A run's end as a tag, from how runReport reads its outcome (runOutcome). */
function endTag(r: LineRunModel): { label: string; tone: string } {
  const o = r.outcome;
  if (r.live || o.tone === "live") return { label: "running", tone: "live" };
  if (o.end === "shipped" || o.tone === "shipped") return { label: "shipped", tone: "agent" };
  if (o.tone === "waiting") return { label: "waiting on you", tone: "person" };
  if (o.end === "parked") return { label: "parked", tone: "person" };
  if (o.tone === "failed") return { label: "failed", tone: "bad" };
  if (o.tone === "stuck") return { label: "stopped", tone: "warn" };
  if (o.end === "dissolved" || o.end === "dropped") return { label: o.end, tone: "ok" };
  if (o.tone === "closed") return { label: "closed", tone: "ok" };
  return { label: "ended", tone: "none" };
}

const RUN_GROUPS: Array<[string, string]> = [["running", "Running"], ["shipped", "Shipped"], ["waiting on you", "Waiting on you"], ["parked", "Parked"], ["failed", "Failed"], ["stopped", "Stopped mid-way"], ["closed", "Closed without a change"], ["dissolved", "Dissolved"], ["dropped", "Dropped"], ["ended", "Ended"]];
const GROUP_PAGE = 40;

function RunsList({ runs, current, onPick }: { runs: LineRunModel[]; current: string | null; onPick: (r: LineRunModel) => void }) {
  const [shown, setShown] = useState<Record<string, number>>({});
  const groups = useMemo(() => {
    const by = new Map<string, LineRunModel[]>();
    for (const r of runs) {
      const k = endTag(r).label;
      by.set(k, [...(by.get(k) ?? []), r]);
    }
    return RUN_GROUPS.map(([k, label]) => ({ k, label, runs: by.get(k) ?? [] })).filter((g) => g.runs.length);
  }, [runs]);
  return (
    <div className="lwg-pop" role="dialog" aria-label="Runs" data-lwg-runs>
      {groups.map((g) => {
        const n = shown[g.k] ?? GROUP_PAGE;
        return (
          <section key={g.k}>
            <h4>{g.label} <em>{g.runs.length}</em></h4>
            {g.runs.slice(0, n).map((r) => (
              <button key={r.id} type="button" className="lwg-runrow" aria-current={r.id === current} onClick={() => onPick(r)} data-lwg-run={r.id}>
                <b>{r.caseTitle}</b>
                <small>{durationWords(r.durationMs) ?? ""}</small>
                <small style={{ gridColumn: "1 / -1" }}>{[r.caseRef, dayWords(r.at), `${r.visits.length} steps`, r.outcome.text].filter(Boolean).join(" · ")}</small>
                <RunTrail run={r} />
              </button>
            ))}
            {g.runs.length > n && <button type="button" className="lwg-more" onClick={() => setShown((s) => ({ ...s, [g.k]: n + GROUP_PAGE * 3 }))}>Show {Math.min(GROUP_PAGE * 3, g.runs.length - n)} more of {g.runs.length - n}</button>}
          </section>
        );
      })}
    </div>
  );
}

function RunBar({ run, index, total, onPrev, onNext, onClear }: { run: LineRunModel; index: number; total: number; onPrev: () => void; onNext: () => void; onClear: () => void }) {
  const nav = useLineNav();
  const tag = endTag(run);
  const meta = [run.caseRef, dayWords(run.at), durationWords(run.durationMs), `${run.visits.length} steps`, run.outcome.text].filter(Boolean).join(" · ");
  const replay = nav.runHref(run.id, run.caseId);
  return (
    <div className="lwg-runbar" data-lwg-runbar={run.id}>
      <span className="lwg-endtag" data-tone={tag.tone}>{tag.label}</span>
      <div className="lwg-runbar-text"><b>{run.caseTitle}</b><span>{meta}</span></div>
      {index >= 0 && <span className="lwg-runbar-n">{index + 1} of {total}</span>}
      <button type="button" className="lwg-btn" data-ghost="" data-icon="" onClick={onPrev} disabled={index < 0 || index >= total - 1} title="Older run" aria-label="Older run">‹</button>
      <button type="button" className="lwg-btn" data-ghost="" data-icon="" onClick={onNext} disabled={index <= 0} title="Newer run" aria-label="Newer run">›</button>
      {replay && <a className="lwg-btn" data-ghost="" href={replay} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.button !== 0) return; e.preventDefault(); nav.openRun(run.id, run.caseId); }}>Replay</a>}
      <button type="button" className="lwg-btn" onClick={onClear}>Clear <KeyCap size="xs">Esc</KeyCap></button>
    </div>
  );
}

const KEYS: Array<[string[], string]> = [
  [["←", "→"], "previous or next step"],
  [["⇧", "←", "→"], "previous or next agent or person"],
  [["↵"], "open the focused step"],
  [["[", "]"], "older or newer run"],
  [["R"], "the runs"],
  [["M"], "Essence or All steps"],
  [["F"], "fit the graph"],
  [["+", "−"], "zoom in or out"],
  [["1", "5"], "switch view"],
  [["Esc"], "close"],
];

function KeySheet({ onClose }: { onClose: () => void }) {
  return (
    <div className="lwg-sheet" onClick={onClose} role="dialog" aria-label="Keys" data-lwg-keys>
      <div className="lwg-sheet-box">
        <h3>Keys</h3>
        <div className="lwg-keys">
          {KEYS.map(([keys, what]) => (
            <span key={what} style={{ display: "contents" }}>
              <span>{keys.map((k, i) => <KeyCap key={i}>{k}</KeyCap>)}</span>
              <span>{what}</span>
            </span>
          ))}
          <span><KeyCap>{isMac ? "⌘" : "Ctrl"}</KeyCap><span style={{ alignSelf: "center", fontSize: 11 }}>+ scroll</span></span><span>zoom at the pointer; scroll alone pans</span>
        </div>
      </div>
    </div>
  );
}


/** Where a lane's pinned name sits when steps lie past the left edge: clear of the edge fade (graph.css .lwg::before, 112px) and its arrow. */
const LANE_HEAD_CLEAR = 132;
/** How far under an open step's box the past-edge arrows sit, in canvas units: below its "can end" line (a dot's name lines take two more). */
const ARROW_BELOW_ROW = 78;
/** How far in from each side of the stage its edge fade hides words, in px (graph.css .lwg::before: 112px, nearly opaque for the first third). */
const EDGE_FADE = 40;

export function GraphView({ model, workspace, selection, select }: LineViewProps) {
  const nav = useLineNav();
  const [mode, setModeState] = useState<GraphMode>(readMode);
  const [peek, setPeek] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [runsOpen, setRunsOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const [intro, setIntro] = useState(true);
  const layout = useMemo(() => graphLayout(model.graph, { mode }), [model.graph, mode]);
  const [focus, setFocus] = useState<string | null>(null);
  const run = useMemo(() => (selection.run ? model.runs.find((r) => r.id === selection.run) ?? null : null), [model.runs, selection.run]);
  const lit = useMemo(() => litRun(run), [run]);
  const runIndex = run ? model.runs.indexOf(run) : -1;
  const uid = `lwg${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const active = useTabActive();
  const drawerStep = selection.step && model.steps[selection.step] ? selection.step : null;

  const rootRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(drawerStep);
  openRef.current = drawerStep;
  const svgRef = useRef<SVGSVGElement>(null);
  const worldRef = useRef<SVGGElement>(null);
  const insets: Insets = { top: 62, bottom: run ? 96 : 24, left: 18, right: 18 };
  // What lies past the stage's edges: the steps a reader would pan to, named on the arrows.
  const [past, setPast] = useState<{ left: string[]; right: string[] }>(NO_PAST);
  const onView = useCallback((v: View, width: number) => {
    const left: string[] = [];
    const right: string[] = [];
    const nodes = rootRef.current?.querySelectorAll<SVGGElement>("[data-lwg-node]");
    const cut = new Set<string>();
    const whole = new Set<string>();
    for (const n of layout.list) {
      // A dot's name, and the "can end" words centered under it, are wider than its dot.
      const ends = n.dot ? layout.exits.get(n.id) : undefined;
      const half = n.dot ? Math.max(n.w / 2, textW(n.label, 14) / 2 + 4, ends ? textW(exitWords(ends), 14) / 2 + 4 : 0) : n.w / 2;
      const l = v.x + (n.x - half) * v.k;
      const r = v.x + (n.x + half) * v.k;
      // A step the edge cuts through is folded into the arrow's names and faded, never half drawn.
      // The edges' fades count as past them: a step reaching into one does not read either.
      if (r > 0 && l < EDGE_FADE || l < width - EDGE_FADE && r > width - EDGE_FADE) cut.add(n.id);
      else if (l >= EDGE_FADE && r <= width - EDGE_FADE) whole.add(n.id);
      if (n.kind === "end" || n.dot) continue;
      // A step cut by the edge counts as past it: its words do not read.
      if (l < EDGE_FADE) left.unshift(n.label);
      else if (r > width - EDGE_FADE) right.push(n.label);
    }
    // A DOM write per frame, no render: the cut steps fade.
    nodes?.forEach((g) => {
      const on = cut.has(g.dataset.lwgNode ?? "");
      if (on !== g.hasAttribute("data-cut")) g.toggleAttribute("data-cut", on);
    });
    // An edge with neither end in view is a bare line across the stage: it fades with the steps it joins.
    rootRef.current?.querySelectorAll<SVGPathElement>(".lwg-edges [data-from]").forEach((p) => {
      const on = !whole.has(p.dataset.from ?? "") && !whole.has(p.dataset.to ?? "");
      if (on !== p.hasAttribute("data-cut")) p.toggleAttribute("data-cut", on);
    });
    setPast((p) => (p.left.join("|") === left.join("|") && p.right.join("|") === right.join("|") ? p : { left, right }));
    // With a step open, the arrows sit under its row, past its "can end" words and in the gap before the next row,
    // so they never cover the step or a label mid-stage.
    const open = openRef.current ? layout.nodes.get(openRef.current) : null;
    const arrowY = open ? `${(v.y + (open.y + open.h / 2 + ARROW_BELOW_ROW + (open.dot ? DOT_LINE * 2 : 0)) * v.k).toFixed(1)}px` : "";
    if (rootRef.current && rootRef.current.style.getPropertyValue("--lwg-arrow-y") !== arrowY) rootRef.current.style.setProperty("--lwg-arrow-y", arrowY || null);
    // Each lane's heading stays at the stage's left edge once its frame starts past it: a DOM write per frame, no render.
    // Past the left fade and its arrow when steps lie beyond that edge, so no frame shows as a bare line with its name hidden.
    const seen = (-v.x + (left.length ? LANE_HEAD_CLEAR : 16)) / v.k;
    rootRef.current?.querySelectorAll<SVGGElement>(".lwg-lane-head").forEach((g) => {
      const dx = Math.max(0, seen - (Number(g.dataset.laneX) + 24));
      g.setAttribute("transform", dx ? `translate(${dx.toFixed(1)},0)` : "");
    });
  }, [layout]);
  const pz = usePanZoom(svgRef, worldRef, {
    bounds: layout.bounds,
    insets,
    onBackgroundClick: () => { if (drawerStep) select({ step: null }); setRunsOpen(false); },
    onView,
  });

  /** Where the view should rest now: on the open step, else the whole graph. */
  const settle = useCallback((anim: boolean) => {
    const n = drawerStep ? layout.nodes.get(drawerStep) : null;
    if (!n) { pz.fit(anim); return; }
    // Its "can end" words run past the step's right edge: keep them in view with it.
    const ends = layout.exits.has(n.id) ? essenceExits(model.graph, (id) => layout.nodes.has(id)).get(n.id) : undefined;
    const words = ends && !n.dot ? -n.w / 2 + 4 + textW(`can end: ${exitWords(ends)}`, 14) : 0;
    const own = { left: n.w / 2, right: Math.max(n.w / 2, words) };
    // The steps either side of it in its row, whole, when the stage holds them: a drawer that narrows it never half draws a neighbor.
    const row = layout.edges.flatMap((e) => (e.from === n.id ? [e.to] : e.to === n.id ? [e.from] : []))
      .map((id) => layout.nodes.get(id)).filter((m): m is NonNullable<typeof m> => !!m && !m.dot && Math.abs(m.y - n.y) < n.h);
    const reach = row.reduce((r, m) => ({ left: Math.max(r.left, n.x - (m.x - m.w / 2)), right: Math.max(r.right, m.x + m.w / 2 - n.x) }), own);
    const k = Math.max(FIT_MIN_K, Math.min(pz.get().k, 1.2));
    const aw = pz.size().w - insets.left - insets.right - 48;
    const ah = pz.size().h - insets.top - insets.bottom - 48;
    // Where it sends most work, in any row: in view with it, zoomed out as far as the words still read, so the
    // step a reader opens next is never past the edge (the drawer narrows the stage to a few steps).
    const main = layout.edges.filter((e) => e.from === n.id && e.to !== n.id).sort((a, b) => b.count - a.count)
      .map((e) => layout.nodes.get(e.to)).find((m): m is NonNullable<typeof m> => !!m && !m.dot && m.kind !== "end");
    if (main) {
      const box = {
        l: Math.min(n.x - Math.max(own.left, reach.left), main.x - main.w / 2), r: Math.max(n.x + Math.max(own.right, reach.right), main.x + main.w / 2),
        t: Math.min(n.y, main.y) - Math.max(n.h, main.h) / 2 - 30, b: Math.max(n.y, main.y) + Math.max(n.h, main.h) / 2 + 40,
      };
      const kk = Math.min(k, aw / (box.r - box.l), ah / (box.b - box.t));
      if (kk >= FIT_MIN_K) {
        const cx = (box.l + box.r) / 2;
        pz.centerOn(cx, (box.t + box.b) / 2, anim, { left: cx - box.l, right: box.r - cx }, { k: kk, middle: true });
        return;
      }
    }
    const fits = (reach.left + reach.right) * k <= aw;
    pz.centerOn(n.x, n.y, anim, fits ? reach : own);
  }, [drawerStep, layout, model.graph, pz]);
  const settleRef = useRef(settle);
  settleRef.current = settle;

  useMountEffect(() => {
    settleRef.current(false);
    const timer = window.setTimeout(() => setIntro(false), 1700);
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return () => window.clearTimeout(timer);
    let last = "";
    const ro = new ResizeObserver(([e]) => {
      const key = `${Math.round(e.contentRect.width)}x${Math.round(e.contentRect.height)}`;
      if (key === last) return;
      last = key;
      settleRef.current(false);
    });
    ro.observe(el);
    return () => { window.clearTimeout(timer); ro.disconnect(); };
  });
  // A new layout (the other mode, another graph's shape) or a step opened or closed: ease to it.
  const settledFor = useRef<string | null>(null);
  useWatchEffect(() => {
    const key = `${mode}:${drawerStep ?? ""}`;
    if (settledFor.current === null) { settledFor.current = key; return; }
    if (settledFor.current === key) return;
    settledFor.current = key;
    settle(true);
  }, [mode, drawerStep, layout]);

  const setMode = useCallback((m: GraphMode) => {
    setModeState(m);
    try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ }
  }, []);
  const open = useCallback((id: string) => { setFocus(id); setTip(null); select({ step: id }); }, [select]);
  const pickRun = useCallback((r: LineRunModel | null) => { setRunsOpen(false); select({ run: r?.id ?? null }, r?.caseId ?? null); }, [select]);
  const stepRun = useCallback((dir: 1 | -1) => {
    if (!model.runs.length) return;
    const i = runIndex < 0 ? (dir > 0 ? -1 : model.runs.length) : runIndex;
    const r = model.runs[i + dir];
    if (r) pickRun(r);
  }, [model.runs, runIndex, pickRun]);

  const onHover = useCallback((id: string, ev: ReactMouseEvent | null) => {
    if (!ev) { setPeek(null); setTip(null); return; }
    setPeek(id);
    const step = model.steps[id];
    const node = model.graph.nodes.find((n) => n.id === id);
    if (!step || !node) return;
    const reached = node.runs ? ` Reached in ${node.runs} of ${model.runs.length} runs${failureWords(step.tally) ? `, ${failureWords(step.tally)}` : ""}.` : model.runs.length ? " No run has reached it yet." : "";
    const n = stepCameBack(step);
    const cameBack = n ? ` ${n === 1 ? "One close" : `${n} closes`} it made came back after it; its Decisions mark each.` : "";
    setTip({ x: ev.clientX, y: ev.clientY, title: `${step.label} · ${KIND_TIP[step.kind]}`, body: `${step.purpose}${reached}${cameBack}` });
  }, [model]);
  const onEdgeHover = useCallback((e: GEdge, ev: ReactMouseEvent | null) => {
    if (!ev) { setTip(null); return; }
    const from = model.steps[e.from]?.label ?? e.from;
    const to = model.steps[e.to]?.label ?? e.to;
    const edge = model.graph.edges.find((x) => x.id === e.id);
    const why = edge?.does ?? (edge?.condition ? `When ${edge.condition}.` : "");
    setTip({ x: ev.clientX, y: ev.clientY, title: `${from} → ${to}`, body: [why, e.count ? `Taken ${e.count} ${e.count === 1 ? "time" : "times"}.` : "Never taken yet."].filter(Boolean).join(" ") });
  }, [model]);

  const moveFocus = useCallback((dir: 1 | -1, actorsOnly: boolean) => {
    const list = actorsOnly ? layout.actors : layout.walk;
    if (!list.length) return;
    const cur = drawerStep ?? focus;
    let i = cur ? list.indexOf(cur) : -1;
    if (i < 0 && cur) {
      // A step not in this list (a script under ⇧): start from its place in reading order.
      const at = layout.walk.indexOf(cur);
      i = list.findIndex((id) => layout.walk.indexOf(id) >= at) - (dir > 0 ? 1 : 0);
    }
    const next = list[Math.max(0, Math.min(list.length - 1, i + dir))];
    if (!next) return;
    if (drawerStep) open(next);
    else {
      setFocus(next);
      const n = layout.nodes.get(next);
      if (n) pz.centerOn(n.x, n.y, true, n.w / 2);
    }
  }, [layout, drawerStep, focus, open, pz]);

  // Keys, read before the workspace's own (capture), so this view's ← → and Esc win where they mean something here.
  useWatchEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || hasOpenModal() || keyBelongsElsewhere(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      const take = () => { e.preventDefault(); e.stopPropagation(); };
      if (k === "Escape") {
        if (help) { take(); setHelp(false); return; }
        if (runsOpen) { take(); setRunsOpen(false); return; }
        if (drawerStep) return;
        if (run) { take(); pickRun(null); }
        return;
      }
      if (k === "?") { take(); setHelp((h) => !h); return; }
      if (help) return;
      if (k === "ArrowRight" || k === "ArrowLeft") {
        if (drawerStep && !e.shiftKey) return;
        take();
        moveFocus(k === "ArrowRight" ? 1 : -1, e.shiftKey);
        return;
      }
      if (k === "Enter" && !drawerStep && focus) { take(); open(focus); return; }
      const lower = k.toLowerCase();
      if (lower === "m") { take(); setMode(mode === "essence" ? "all" : "essence"); return; }
      if (lower === "f") { take(); settle(true); return; }
      if (lower === "r") { take(); setRunsOpen((o) => !o); return; }
      if (k === "[") { take(); stepRun(1); return; }
      if (k === "]") { take(); stepRun(-1); return; }
      if (k === "+" || k === "=") { take(); pz.zoomBy(1.25); return; }
      if (k === "-" || k === "_") { take(); pz.zoomBy(0.8); return; }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, help, runsOpen, drawerStep, run, focus, mode, moveFocus, open, pickRun, setMode, settle, stepRun, pz]);

  if (!model.graph.nodes.length) {
    return <div className="lw-empty" data-line-view="graph"><b>No steps to draw yet</b>This graph names no steps codecast can read. Its first run fills it in.</div>;
  }
  const counts = { agent: 0, person: 0, script: 0 };
  for (const n of model.graph.nodes) if (n.kind !== "end") counts[n.kind]++;

  return (
    // The loop starts above the line (learning-loop.md LL1): the Find band, then the line's lanes.
    <div className="lw-graph-col">
    <FindBand loop={workspace.loop} projectId={nav.projectId ?? workspace.project?._id ?? null} product={workspace.product} layout="row" routes={workspace.rollup?.graphs} neverRun={workspace.rollup?.neverRun} squeezed={!!drawerStep} />
    <div className="lwg-wrap">
    <div className="lwg" ref={rootRef} data-line-view="graph" data-mode={mode} data-hovering={peek ? "" : undefined} data-run-bar={run ? "" : undefined} data-more-left={past.left.length ? "" : undefined} data-more-right={past.right.length ? "" : undefined}>
      <svg ref={svgRef} className="lwg-svg" role="group" aria-label={`${model.title}: ${model.graph.nodes.length} steps`}>
        <GraphDefs uid={uid} />
        <rect width="100%" height="100%" fill={`url(#${uid}-dots)`} />
        <g ref={worldRef}>
          <GraphCanvas
            model={model}
            layout={layout}
            uid={uid}
            lit={lit}
            selected={drawerStep}
            focus={focus}
            peek={peek}
            intro={intro}
            onOpen={open}
            onHover={onHover}
            onEdgeHover={onEdgeHover}
          />
        </g>
      </svg>

      <div className="lwg-top">
        <div className="lwg-legend" aria-label="Step kinds">
          {counts.agent > 0 && <span className="lwg-lg" data-kind="agent"><b />Agent <i>one prompt</i></span>}
          {counts.person > 0 && <span className="lwg-lg" data-kind="person"><b />You <i>decide</i></span>}
          {counts.script > 0 && <span className="lwg-lg" data-kind={mode === "essence" ? "dot" : "script"}><b />Script <i>code</i></span>}
        </div>
        {/* Docked in the legend row, so it never sits over a lane's steps. */}
        <div className="lwg-hint"><b>Click a step</b> to see and change what it decided <KeyCap size="xs">?</KeyCap> keys</div>
        <div className="lwg-controls">
          <div className="lw-seg" role="tablist" aria-label="How much to draw">
            <button type="button" role="tab" aria-selected={mode === "essence"} onClick={() => setMode("essence")} title="Agents and people, scripts as dots (M)" data-lwg-mode="essence">Essence</button>
            <button type="button" role="tab" aria-selected={mode === "all"} onClick={() => setMode("all")} title="Every script and every end (M)" data-lwg-mode="all">All steps</button>
          </div>
          <button type="button" className="lwg-btn" data-ghost="" aria-pressed={!!run} aria-expanded={runsOpen} onClick={() => setRunsOpen((o) => !o)} disabled={!model.runs.length} title="Light a run's path (R)" data-lwg-runs-btn>
            <span className="lwg-runs-dot" />Runs <em>{model.runs.length}</em>
          </button>
          <button type="button" className="lwg-btn" data-ghost="" data-icon="" onClick={() => settle(true)} title="Fit (F)" aria-label="Fit the graph"><Maximize2 className="w-3.5 h-3.5" /></button>
          <button type="button" className="lwg-btn" data-ghost="" data-icon="" onClick={() => setHelp(true)} title="Keys (?)" aria-label="Keys">?</button>
        </div>
      </div>

      {runsOpen && <RunsList runs={model.runs} current={run?.id ?? null} onPick={pickRun} />}
      {run ? (
        <RunBar run={run} index={runIndex} total={model.runs.length} onPrev={() => stepRun(1)} onNext={() => stepRun(-1)} onClear={() => pickRun(null)} />
      ) : null}
      <EdgeArrows edges={{ left: past.left.length > 0, right: past.right.length > 0 }} names={past} label="the graph" step={0.6} onMove={(dir, step) => pz.panBy(dir * step)} />
      <div className="lwg-zoom" aria-label="Zoom">
        <button type="button" onClick={() => pz.zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)">+</button>
        <button type="button" onClick={() => pz.zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (−)">−</button>
      </div>
      {tip && <div className="lwg-tip" style={{ left: Math.min(tip.x + 14, (typeof window !== "undefined" ? window.innerWidth : 1600) - 320), top: tip.y + 16 }}><b>{tip.title}</b>{tip.body}</div>}
      {help && <KeySheet onClose={() => setHelp(false)} />}
    </div>
    </div>
    </div>
  );
}
