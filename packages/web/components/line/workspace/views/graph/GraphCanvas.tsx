"use client";
// The Graph view's drawing (line-workspace.md LW1), Studio's graph over the
// model: a lane per half, agents as warm cards with the spread of what they
// decided, people as blue pills with their answers, scripts as dots (Essence)
// or mono boxes (All steps), ends as chips or as "can end" words, edges
// weighted by how often runs took them and named where a step branches. A
// run's path is lit and numbered; a hovered step shows where it sends work
// back. Layers are memoized apart, so a hover redraws only its own edges and
// a pan redraws nothing (the view moves the world group by its transform).
// The chat's graph widget draws this same canvas, static and fitted.
import { memo, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import type { LineModel } from "../../../../../lib/line/lineModel";
import { outcomeTone } from "../../../widgets/parts";
import { END_TONE, type GEdge, type GNode, type GraphLayout, textW } from "./graphLayout";
import type { LitRun } from "./litRun";
import "./graph.css";

const fit = (s: string, px: number, size: number, mono = false) => {
  const max = Math.max(4, Math.floor(px / (size * (mono ? 0.62 : 0.6))));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type BarTone = "fwd" | "stop" | "warn" | "bad" | "live";
const BAR_ORDER: BarTone[] = ["fwd", "stop", "warn", "bad", "live"];
const STOP_WORDS = /\b(dissolved|closed|dropped|released|owned elsewhere)\b/i;

/** Each agent's decisions as tone counts, for the bar along its card's foot. */
function decisionBars(model: LineModel): Map<string, Array<{ tone: BarTone; n: number }>> {
  const out = new Map<string, Array<{ tone: BarTone; n: number }>>();
  for (const id of model.order) {
    const step = model.steps[id];
    if (!step || step.kind !== "agent" || !step.decisions.length) continue;
    const counts = new Map<BarTone, number>();
    for (const d of step.decisions) {
      const words = d.decided.outcome ?? d.decided.words;
      const t = outcomeTone(words, d.status);
      const tone: BarTone = t === "bad" ? "bad" : t === "warn" ? "warn" : t === "live" || t === "person" ? "live" : STOP_WORDS.test(words ?? "") ? "stop" : "fwd";
      counts.set(tone, (counts.get(tone) ?? 0) + 1);
    }
    out.set(id, BAR_ORDER.filter((t) => counts.has(t)).map((t) => ({ tone: t, n: counts.get(t)! })));
  }
  return out;
}

const barCache = new WeakMap<LineModel, ReturnType<typeof decisionBars>>();
const barsOf = (model: LineModel) => {
  let b = barCache.get(model);
  if (!b) { b = decisionBars(model); barCache.set(model, b); }
  return b;
};

// ── defs ─────────────────────────────────────────────────────────────────────

export function GraphDefs({ uid }: { uid: string }) {
  return (
    <defs>
      <pattern id={`${uid}-dots`} width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" className="lwg-dot-grid" /></pattern>
      <marker id={`${uid}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" className="lwg-arrow" /></marker>
      <marker id={`${uid}-arrow-hot`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" className="lwg-arrow-hot" /></marker>
      <marker id={`${uid}-arrow-peek`} viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M0,1 L9,5 L0,9 z" className="lwg-arrow-peek" /></marker>
    </defs>
  );
}

// ── lanes ────────────────────────────────────────────────────────────────────

const Lanes = memo(function Lanes({ layout, uid }: { layout: GraphLayout; uid: string }) {
  return (
    <g className="lwg-lanes">
      {layout.lanes.map((l) => (
        <g key={l.half}>
          <rect className="lwg-lane" data-half={l.half} x={l.x} y={l.y} width={l.w} height={l.h} rx={22} />
          <text className="lwg-lane-title" x={l.x + 24} y={l.y + 38}>{l.label}</text>
          <text className="lwg-lane-sub" x={l.x + 24 + textW(l.label, 26) * 1.02 + 14} y={l.y + 37}>{l.sub}</text>
        </g>
      ))}
      {layout.stages.map((s, i) => <text key={`${s.label}${i}`} className="lwg-stage" x={s.x} y={s.y}>{s.label}</text>)}
      {layout.entry && (
        <g className="lwg-terminus" transform={`translate(${layout.entry.x},${layout.entry.y})`}>
          <circle r={6} />
          <text y={24} textAnchor="middle">{layout.entry.label}</text>
        </g>
      )}
      {layout.entryEdge && <path className="lwg-edge lwg-edge-term" d={layout.entryEdge} markerEnd={`url(#${uid}-arrow)`} />}
      {layout.finish && (
        <>
          <path className="lwg-edge lwg-edge-term" d={layout.finish.d} markerEnd={`url(#${uid}-arrow)`} />
          <g className="lwg-terminus" data-end="" transform={`translate(${layout.finish.x},${layout.finish.y})`}>
            <circle r={7} />
            <circle r={11} className="lwg-terminus-ring" />
            <text y={28} textAnchor="middle">{layout.finish.label}</text>
          </g>
        </>
      )}
    </g>
  );
});

// ── edges ────────────────────────────────────────────────────────────────────

type EdgeState = { hot: boolean; dim: boolean; faint: boolean; shown: boolean };

function EdgeLabel({ e, state, onHover }: { e: GEdge; state: EdgeState; onHover?: (e: GEdge, ev: ReactMouseEvent | null) => void }) {
  const l = e.label!;
  return (
    <g
      className="lwg-elabel"
      data-gate={e.gate ? "" : undefined}
      data-hot={state.hot ? "" : undefined}
      data-dim={state.dim ? "" : undefined}
      data-faint={state.faint ? "" : undefined}
      data-quiet={e.quiet && !state.shown ? "" : undefined}
      data-shape={e.shape}
      data-lwg-label=""
      onMouseEnter={onHover ? (ev) => onHover(e, ev) : undefined}
      onMouseLeave={onHover ? () => onHover(e, null) : undefined}
    >
      <rect x={l.x - l.w / 2} y={l.y - 9} width={l.w} height={17} rx={5} />
      <text x={l.x} y={l.y + 3.6} textAnchor="middle">{l.text}</text>
    </g>
  );
}

type EdgesProps = { layout: GraphLayout; lit: LitRun | null; selected: string | null; uid: string; intro: boolean; onHover?: (e: GEdge, ev: ReactMouseEvent | null) => void };

const Edges = memo(function Edges({ layout, lit, selected, uid, intro, onHover }: EdgesProps) {
  const max = useMemo(() => Math.max(1, ...layout.edges.map((e) => e.count)), [layout]);
  const sel = selected && layout.nodes.has(selected) ? selected : null;
  const states = layout.edges.map((e): EdgeState => {
    const hot = !!lit?.hot.has(e.id);
    const mine = !!sel && (e.from === sel || e.to === sel);
    return { hot, dim: !!lit && !hot, faint: !lit && !!sel && !mine, shown: hot || mine };
  });
  return (
    <>
      <g className="lwg-edges">
        {layout.edges.map((e, i) => {
          const s = states[i];
          const main = e.shape === "next" || e.shape === "wrap";
          const w = s.hot ? 2.6 : e.kind === "loop" ? 1.3 : (main ? 1.5 : 1.25) + 2.6 * Math.sqrt(e.count / max);
          return (
            <path
              key={e.id}
              className="lwg-edge"
              data-shape={e.shape}
              data-kind={e.kind}
              data-hot={s.hot ? "" : undefined}
              data-dim={s.dim ? "" : undefined}
              data-faint={s.faint ? "" : undefined}
              data-quiet={e.quiet && !s.shown ? "" : undefined}
              data-intro={intro && main ? "" : undefined}
              style={intro && main ? { animationDelay: `${0.2 + i * 0.025}s` } : undefined}
              pathLength={intro && main ? 1 : undefined}
              d={e.d}
              strokeWidth={w}
              markerEnd={`url(#${uid}-${s.hot ? "arrow-hot" : "arrow"})`}
            />
          );
        })}
      </g>
      <g className="lwg-elabels">
        {layout.edges.map((e, i) => e.label && <EdgeLabel key={e.id} e={e} state={states[i]} onHover={onHover} />)}
      </g>
    </>
  );
});

/** A hovered step's edges over the rest: where it sends work, and where it sends it back. */
const Peek = memo(function Peek({ layout, id, uid }: { layout: GraphLayout; id: string; uid: string }) {
  const mine = layout.edges.filter((e) => e.from === id || e.to === id);
  return (
    <g className="lwg-peek" aria-hidden>
      {mine.map((e) => <path key={e.id} className="lwg-edge" data-peek={e.to === id ? "in" : "out"} data-shape={e.shape} d={e.d} strokeWidth={1.8} markerEnd={`url(#${uid}-arrow-peek)`} />)}
      {mine.map((e) => e.label && <EdgeLabel key={`l${e.id}`} e={e} state={{ hot: false, dim: false, faint: false, shown: true }} />)}
    </g>
  );
});

// ── nodes ────────────────────────────────────────────────────────────────────

function PersonGlyph({ x }: { x: number }) {
  return (
    <g transform={`translate(${x},0)`} className="lwg-glyph">
      <circle r={4.4} cy={-5} />
      <path d="M-7.2,9.5 C-7.2,1 7.2,1 7.2,9.5 Z" />
    </g>
  );
}

type NodeProps = {
  n: GNode;
  model: LineModel;
  bars: Array<{ tone: BarTone; n: number }> | undefined;
  exits: GraphLayout["exits"];
  order: number | undefined;
  times: number | undefined;
  dim: boolean;
  soft: boolean;
  selected: boolean;
  focused: boolean;
  intro: number | null;
  onOpen: (id: string) => void;
  onHover?: (id: string, ev: ReactMouseEvent | null) => void;
};

const Node = memo(function Node({ n, model, bars, exits, order, times, dim, soft, selected, focused, intro, onOpen, onHover }: NodeProps) {
  const step = model.steps[n.id];
  const m = model.graph.nodes.find((x) => x.id === n.id);
  const { w, h } = n;
  let body;
  if (n.dot) {
    body = (
      <>
        <circle className="lwg-ring" r={11} />
        <g className="lwg-box">
          <circle className="lwg-shape" r={5.5} />
        </g>
        {n.lines.map((line, i) => <text key={i} className="lwg-dotname" y={22 + i * 15} textAnchor="middle">{line}</text>)}
      </>
    );
  } else if (n.kind === "agent") {
    const decided = step?.decisions.length ?? 0;
    const dur = m?.medianMs ? `~${Math.max(1, Math.round(m.medianMs / 60000))}m` : null;
    const sub = decided ? [`${decided} decided`, dur].filter(Boolean).join(" · ") : m?.runs ? plural(m.runs, "run") : "not reached yet";
    const total = bars?.reduce((s, b) => s + b.n, 0) ?? 0;
    const bw = w - 32;
    let cx = -w / 2 + 16;
    body = (
      <>
        <rect className="lwg-ring" x={-w / 2 - 5} y={-h / 2 - 5} width={w + 10} height={h + 10} rx={18} />
        <g className="lwg-box">
          <rect className="lwg-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={14} />
          <text className="lwg-t" x={-w / 2 + 16} y={-4}>{fit(n.label, w - 52, 15)}</text>
          <text className="lwg-s" x={-w / 2 + 16} y={13}>{fit(sub, w - 32, 11)}</text>
          {total > 0 && (
            <g className="lwg-bar">
              {bars!.map((b) => {
                const ww = (bw * b.n) / total;
                const x = cx;
                cx += ww;
                return <rect key={b.tone} data-tone={b.tone} x={x} y={h / 2 - 10} width={Math.max(1, ww - 1.5)} height={3} rx={1.5}><title>{`${b.n} ${b.tone === "fwd" ? "moved it on" : b.tone === "stop" ? "settled it" : b.tone === "warn" ? "sent it back" : b.tone === "bad" ? "failed" : "running"}`}</title></rect>;
              })}
            </g>
          )}
          <g className="lwg-glyph" transform={`translate(${w / 2 - 20},${-h / 2 + 17})`}>
            <circle r={6} className="lwg-glyph-ring" />
            <circle r={2} />
          </g>
        </g>
      </>
    );
  } else if (n.kind === "person") {
    const answers = step?.answers.map((a) => a.answer).join(" · ") || "you decide";
    body = (
      <>
        <rect className="lwg-ring" x={-w / 2 - 5} y={-h / 2 - 5} width={w + 10} height={h + 10} rx={h / 2 + 5} />
        <g className="lwg-box">
          <rect className="lwg-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} />
          <PersonGlyph x={-w / 2 + 25} />
          <text className="lwg-t" x={-w / 2 + 45} y={-3}>{fit(n.label, w - 62, 15)}</text>
          <text className="lwg-s" x={-w / 2 + 45} y={14}>{fit(answers, w - 62, 11)}</text>
        </g>
      </>
    );
  } else if (n.kind === "end") {
    body = (
      <>
        <rect className="lwg-ring" x={-w / 2 - 4} y={-h / 2 - 4} width={w + 8} height={h + 8} rx={h / 2 + 4} />
        <g className="lwg-box">
          <rect className="lwg-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} />
          <text className="lwg-t" y={3.8} textAnchor="middle">{n.label.toLowerCase()}</text>
        </g>
      </>
    );
  } else {
    body = (
      <>
        <rect className="lwg-ring" x={-w / 2 - 5} y={-h / 2 - 5} width={w + 10} height={h + 10} rx={11} />
        <g className="lwg-box">
          <rect className="lwg-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={7} />
          <text className="lwg-t" y={4} textAnchor="middle">{n.label}</text>
        </g>
      </>
    );
  }
  const ex = exits.get(n.id);
  const exY = n.dot ? 22 + n.lines.length * 15 + 4 : h / 2 + 20;
  return (
    <g
      className="lwg-node"
      data-kind={n.kind}
      data-dot={n.dot ? "" : undefined}
      data-end={n.end ?? undefined}
      data-tone={n.end ? END_TONE[n.end] : undefined}
      data-dim={dim ? "" : undefined}
      data-soft={soft ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-focus={focused ? "" : undefined}
      data-on-run={order != null ? "" : undefined}
      data-lwg-node={n.id}
      transform={`translate(${n.x},${n.y})`}
      role="button"
      tabIndex={-1}
      aria-label={`${n.label}, ${n.kind === "person" ? "you decide" : n.kind}`}
      onClick={(ev) => { ev.stopPropagation(); onOpen(n.id); }}
      onMouseEnter={onHover ? (ev) => onHover(n.id, ev) : undefined}
      onMouseLeave={onHover ? () => onHover(n.id, null) : undefined}
    >
      <g className={intro != null ? "lwg-in" : undefined} style={intro != null ? { animationDelay: `${intro * 0.03}s` } : undefined}>
        {body}
        {ex && (
          <text className="lwg-exits" x={n.dot ? 0 : -w / 2 + 4} y={exY} textAnchor={n.dot ? "middle" : undefined}>
            <tspan className="lwg-exits-lead">can end: </tspan>
            {ex.map((x, i) => <tspan key={x.label} data-tone={END_TONE[x.end]}>{`${i ? " · " : ""}${x.label}${x.count ? ` ${x.count}` : ""}`}</tspan>)}
          </text>
        )}
        {order != null && !n.dot && (
          <g className="lwg-order" transform={`translate(${-w / 2 + 2},${-h / 2 - 2})`}>
            <rect x={-11} y={-9} width={22} height={18} rx={9} />
            <text y={4} textAnchor="middle">{order}</text>
            {times != null && times > 1 && (
              <g transform="translate(20,0)"><rect x={-9} y={-8} width={22} height={16} rx={8} className="lwg-times" /><text x={2} y={3.6} textAnchor="middle" className="lwg-times-t">×{times}</text></g>
            )}
          </g>
        )}
      </g>
    </g>
  );
});

// ── the canvas ───────────────────────────────────────────────────────────────

export type GraphCanvasProps = {
  model: LineModel;
  layout: GraphLayout;
  uid: string;
  lit: LitRun | null;
  selected: string | null;
  focus?: string | null;
  peek?: string | null;
  /** First paint of this graph: nodes rise in turn and the spine draws itself. */
  intro?: boolean;
  onOpen: (id: string) => void;
  onHover?: (id: string, ev: ReactMouseEvent | null) => void;
  onEdgeHover?: (e: GEdge, ev: ReactMouseEvent | null) => void;
};

export const GraphCanvas = memo(function GraphCanvas({ model, layout, uid, lit, selected, focus = null, peek = null, intro = false, onOpen, onHover, onEdgeHover }: GraphCanvasProps) {
  const bars = barsOf(model);
  const sel = selected && layout.nodes.has(selected) ? selected : null;
  const near = useMemo(() => {
    if (!sel) return null;
    const s = new Set([sel]);
    for (const e of layout.edges) {
      if (e.from === sel) s.add(e.to);
      if (e.to === sel) s.add(e.from);
    }
    return s;
  }, [layout, sel]);
  return (
    <g className="lwg-canvas" data-mode={layout.mode} data-run={lit ? "" : undefined}>
      <Lanes layout={layout} uid={uid} />
      <Edges layout={layout} lit={lit} selected={sel} uid={uid} intro={intro} onHover={onEdgeHover} />
      {peek && layout.nodes.has(peek) && <Peek layout={layout} id={peek} uid={uid} />}
      <g className="lwg-nodes">
        {layout.list.map((n, i) => (
          <Node
            key={n.id}
            n={n}
            model={model}
            bars={bars.get(n.id)}
            exits={layout.exits}
            order={lit?.order.get(n.id)}
            times={lit?.times.get(n.id)}
            dim={!!lit && !lit.order.has(n.id)}
            soft={!lit && !!near && !near.has(n.id)}
            selected={sel === n.id}
            focused={focus === n.id && sel !== n.id}
            intro={intro ? i : null}
            onOpen={onOpen}
            onHover={onHover}
          />
        ))}
      </g>
    </g>
  );
});
