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
import { Fragment, memo, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import type { LineModel } from "../../../../../lib/line/lineModel";
import { stepBackWords } from "../../../../../lib/line/lineActions";
import { outcomeTone } from "../../../widgets/parts";
import { DOT_LINE, END_TONE, EXIT_LEAD, essenceExits, exitBackWords, ranWords, withFailures, type GEdge, type GNode, type GraphLayout, textW } from "./graphLayout";
import type { LitRun } from "./litRun";
import type { StepWait } from "../../../../../lib/line/stepTable";
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
/** A step's biggest decision when it went more than one way, in words: "mechanism 18: 9 Refine, 9 Record the problem". Null otherwise. */
export function splitOutcome(outcomes: ReadonlyArray<{ words: string; toLabel: string; count: number }>): string | null {
  const by = new Map<string, Array<{ toLabel: string; count: number }>>();
  for (const o of outcomes) if (o.count > 0 && o.words !== "next") by.set(o.words, [...(by.get(o.words) ?? []), o]);
  const top = [...by].filter(([, ways]) => ways.length > 1).sort((a, b) => b[1].reduce((n, w) => n + w.count, 0) - a[1].reduce((n, w) => n + w.count, 0))[0];
  if (!top) return null;
  const ways = [...top[1]].sort((a, b) => b.count - a.count);
  return `${top[0]} ${ways.reduce((n, w) => n + w.count, 0)}: ${ways.map((w) => `${w.count} ${w.toLabel}`).join(", ")}`;
}

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
          {/* The lane's heading slides with the view (GraphView pinLaneHeads), so a step far along the row never cuts its frame's name. */}
          <g className="lwg-lane-head" data-lane-x={l.x}>
            <text className="lwg-lane-title" x={l.x + 24} y={l.y + 38}>{l.label}</text>
            <text className="lwg-lane-sub" x={l.x + 24 + textW(l.label, 26) * 1.02 + 14} y={l.y + 37}>{l.sub}</text>
          </g>
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
      data-owed={e.owed ? "" : undefined}
      data-lwg-label=""
      onMouseEnter={onHover ? (ev) => onHover(e, ev) : undefined}
      onMouseLeave={onHover ? () => onHover(e, null) : undefined}
    >
      <rect x={l.x - l.w / 2} y={l.y - 10.5} width={l.w} height={21} rx={6} />
      <text x={l.x} y={l.y + 4.5} textAnchor="middle">{l.text}</text>
      {/* How many runs took this way: the funnel read off the edges. */}
      {e.count > 0 && !e.split && <text className="lwg-ecount" x={l.x + l.w / 2 + 4} y={l.y + 4.5}>{e.count}</text>}
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
              key={`${e.id}#${i}`}
              className="lwg-edge"
              data-shape={e.shape}
              data-kind={e.kind}
              data-from={e.from}
              data-to={e.to}
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
        {layout.edges.map((e, i) => e.label && <EdgeLabel key={`${e.id}#${i}`} e={e} state={states[i]} onHover={onHover} />)}
      </g>
    </>
  );
});

/** A hovered step's edges over the rest: where it sends work, and where it sends it back. */
const Peek = memo(function Peek({ layout, id, uid }: { layout: GraphLayout; id: string; uid: string }) {
  const mine = layout.edges.filter((e) => e.from === id || e.to === id);
  return (
    <g className="lwg-peek" aria-hidden>
      {mine.map((e, i) => <path key={`${e.id}#${i}`} className="lwg-edge" data-peek={e.to === id ? "in" : "out"} data-shape={e.shape} d={e.d} strokeWidth={1.8} markerEnd={`url(#${uid}-arrow-peek)`} />)}
      {mine.map((e, i) => e.label && <EdgeLabel key={`l${e.id}#${i}`} e={e} state={{ hot: false, dim: false, faint: false, shown: true }} />)}
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
  /** Its failures as the Steps table counts them, when known. */
  failed: number | undefined;
  /** Its passes as the Steps table counts them (problems, not visits), when known. */
  passed: number | undefined;
  /** What waits there as the Steps table splits it (on you, on someone else), when known. */
  wait: StepWait | undefined;
  /** Open its Waiting list. */
  onWaiting?: (id: string) => void;
  order: number | undefined;
  times: number | undefined;
  dim: boolean;
  soft: boolean;
  selected: boolean;
  focused: boolean;
  intro: number | null;
  /** This step's closes the problem came back after, with their unit (stepBackWords, learning-loop.md LL4). */
  back: string | null;
  onOpen: (id: string) => void;
  onHover?: (id: string, ev: ReactMouseEvent | null) => void;
};

/** An end's count colored by whether its closes held: its own tone when none came back, amber when some did, red when most did. */
const exitTone = (x: { end: keyof typeof END_TONE; count: number; back: number }) => (!x.back ? END_TONE[x.end] : x.back * 2 > x.count ? "bad" : "warn");

/** "all 6 dissolves came back" over a step's top right corner: its closes the problem came back after, the step's own learning signal. */
function BackBadge({ words, x, y }: { words: string; x: number; y: number }) {
  const w = textW(words, 11) + 14;
  return (
    <g className="lwg-back" transform={`translate(${x - w},${y - 10})`} data-lwg-back={words}>
      <rect width={w} height={20} rx={10} />
      <text x={w / 2} y={14} textAnchor="middle">{words}</text>
    </g>
  );
}

/** "6 on you" over a step, else "1 waiting" (on someone else): the Steps table's own split. Pressing it opens the step's Waiting list. */
function WaitBadge({ wait, x, y, onOpen }: { wait: StepWait; x: number; y: number; onOpen?: () => void }) {
  const mine = wait.onYou > 0;
  const words = mine ? `${wait.onYou} on you` : `${wait.others} waiting`;
  const w = textW(words, 11) + 16;
  return (
    <g className="lwg-wait" transform={`translate(${x - w},${y - 10})`} data-lwg-waiting={wait.onYou + wait.others} data-mine={mine ? "" : undefined}
      onClick={onOpen ? (ev) => { ev.stopPropagation(); onOpen(); } : undefined}>
      <title>{[wait.onYou ? `${wait.onYou} on you` : null, wait.others ? `${wait.others} on someone else` : null].filter(Boolean).join(" · ")}</title>
      <rect width={w} height={20} rx={10} />
      <text x={w / 2} y={14} textAnchor="middle">{words}</text>
    </g>
  );
}

const Node = memo(function Node({ n, model, bars, exits, failed, passed, wait: tableWait, onWaiting, order, times, dim, soft, selected, focused, intro, back, onOpen, onHover }: NodeProps) {
  const step = model.steps[n.id];
  const m = model.graph.nodes.find((x) => x.id === n.id);
  const { w, h } = n;
  // A dot's way back (Essence hides a script's loop edge until hovered): said under it, so it never reads as a dead end.
  const backTo = n.dot ? model.graph.edges.filter((e) => e.from === n.id && e.kind === "loop").map((e) => model.steps[e.to]?.label ?? e.to)[0] ?? null : null;
  // A script's trouble in red beside how often it ran: its failures (decided or cut off) and its loops (visits past one a run).
  const fails = failed ?? (m?.failed ?? 0) + (m?.cutOff ?? 0);
  const looped = m ? Math.max(0, m.visits - m.runs) : 0;
  const dotTrouble = n.dot ? [fails ? `failed ${fails}` : null, looped ? `looped ${looped}` : null].filter(Boolean).join(" · ") || null : null;
  // What waits there, as the Steps table counts it; drawn alone (no table), a person's step's live runs waiting there.
  const live = n.kind === "person" && !tableWait ? model.runs.filter((r) => r.at_node === n.id && r.outcome.tone === "waiting" && !r.superseded).length : 0;
  const wait: StepWait | null = tableWait ?? (live ? { onYou: 0, others: live } : null);
  const waiting = wait ? wait.onYou + wait.others : 0;
  // A step with something on the viewer opens where it waits, as its badge does: the node is the bigger target.
  const press = () => (wait?.onYou && onWaiting ? onWaiting(n.id) : onOpen(n.id));
  let body;
  if (n.dot) {
    body = (
      <>
        <circle className="lwg-ring" r={11} />
        <g className="lwg-box">
          <circle className="lwg-shape" r={5.5} />
        </g>
        {n.lines.map((line, i) => <text key={i} className="lwg-dotname" y={24 + i * DOT_LINE} textAnchor="middle">{line}</text>)}
        {/* One short count under the name, so neighbours never collide: its failures in red when it has any, else how often
            it ran. The rest (runs, loops) is on hover. */}
        {n.ran > 0 && <text className={fails ? "lwg-ran lwg-trouble" : "lwg-ran"} y={24 + n.lines.length * DOT_LINE} textAnchor="middle" data-lwg-count="">{fails ? `failed ${fails}` : passed != null ? (passed ? `${passed} passed` : "") : ranWords(n.ran)}<title>{[passed ? `${passed} passed` : null, ranWords(n.ran), dotTrouble].filter(Boolean).join(" · ")}</title></text>}
        {backTo && <text className="lwg-ran lwg-backto" y={24 + (n.lines.length + (n.ran ? 1 : 0)) * DOT_LINE} textAnchor="middle">↩ {backTo}</text>}
      </>
    );
  } else if (n.kind === "agent") {
    const decided = step?.decisions.length ?? 0;
    const dur = m?.medianMs ? `~${Math.max(1, Math.round(m.medianMs / 60000))}m` : null;
    // With the Steps table beside it, the node counts what the table counts: problems passed and failed there, never
    // its visits (retries and closed problems are the bar's, said on its hover). Drawn alone, its decisions; one
    // decision split across routes reads as its split: "mechanism 18: 9 Refine, 9 Record the problem".
    const known = passed != null || failed != null;
    const split = !known && step ? splitOutcome(step.outcomes) : null;
    const bad = known && failed ? `${failed} failed` : null;
    // The counts outrank the time: the duration goes first when the line would not fit.
    const counts = [passed ? `${passed} passed` : null, bad].filter(Boolean).join(" · ");
    const timed = [counts, dur].filter(Boolean).join(" · ");
    const sub = known
      ? (textW(timed, 14) <= w - 32 ? timed : counts) || (m?.runs ? plural(m.runs, "run") : "not reached yet")
      : decided ? (split ?? [`${decided} decided`, dur].filter(Boolean).join(" · ")) : m?.runs ? plural(m.runs, "run") : "not reached yet";
    const subShown = fit(sub, w - 32, 14);
    // The failed figure in red, as a dot's is, when it is drawn whole.
    const badAt = bad ? subShown.indexOf(bad) : -1;
    const total = bars?.reduce((s, b) => s + b.n, 0) ?? 0;
    const bw = w - 32;
    let cx = -w / 2 + 16;
    body = (
      <>
        <rect className="lwg-ring" x={-w / 2 - 5} y={-h / 2 - 5} width={w + 10} height={h + 10} rx={18} />
        <g className="lwg-box">
          <rect className="lwg-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={14} />
          <text className="lwg-t" x={-w / 2 + 16} y={-5}>{fit(n.label, w - 52, 16)}</text>
          <text className="lwg-s" x={-w / 2 + 16} y={15} data-lwg-count="">{badAt < 0 ? subShown : <>{subShown.slice(0, badAt)}<tspan className="lwg-trouble">{bad}</tspan>{subShown.slice(badAt + bad!.length)}</>}</text>
          {total > 0 && (
            <g className="lwg-bar">
              {bars!.map((b) => {
                const ww = (bw * b.n) / total;
                const x = cx;
                cx += ww;
                return <rect key={b.tone} data-tone={b.tone} x={x} y={h / 2 - 10} width={Math.max(1, ww - 1.5)} height={3} rx={1.5}><title>{`${b.n} ${b.tone === "fwd" ? "moved it on" : b.tone === "stop" ? "settled it" : b.tone === "warn" ? "sent it back" : b.tone === "bad" ? "failed" : "running"} of every visit, retries and closed problems included`}</title></rect>;
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
    // Every answer that fits, then how many more: a gate's ways out are what a person reads it for.
    const all = step?.answers.map((a) => a.answer) ?? [];
    let answers = all.length ? "" : "you decide";
    for (let i = 0; i < all.length; i++) {
      const next = `${answers}${i ? " · " : ""}${all[i]}`;
      const rest = all.length - i - 1;
      if (textW(`${next}${rest ? ` +${rest}` : ""}`, 14) > w - 62) { answers = `${answers} +${all.length - i}`; break; }
      answers = next;
    }
    body = (
      <>
        <rect className="lwg-ring" x={-w / 2 - 5} y={-h / 2 - 5} width={w + 10} height={h + 10} rx={h / 2 + 5} />
        <g className="lwg-box">
          <rect className="lwg-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} />
          <PersonGlyph x={-w / 2 + 25} />
          <text className="lwg-t" x={-w / 2 + 45} y={-4}>{fit(n.label, w - 62, 16)}</text>
          <text className="lwg-s" x={-w / 2 + 45} y={15}>{answers}<title>{all.join(" · ")}</title></text>
        </g>
      </>
    );
  } else if (n.kind === "end") {
    body = (
      <>
        <rect className="lwg-ring" x={-w / 2 - 4} y={-h / 2 - 4} width={w + 8} height={h + 8} rx={h / 2 + 4} />
        <g className="lwg-box">
          <rect className="lwg-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={h / 2} />
          <text className="lwg-t" y={4.8} textAnchor="middle">{n.label.toLowerCase()}</text>
        </g>
      </>
    );
  } else {
    body = (
      <>
        <rect className="lwg-ring" x={-w / 2 - 5} y={-h / 2 - 5} width={w + 10} height={h + 10} rx={11} />
        <g className="lwg-box">
          <rect className="lwg-shape" x={-w / 2} y={-h / 2} width={w} height={h} rx={8} />
          <text className="lwg-glyph-sh" x={-w / 2 + 12} y={-1.5}>&gt;_</text>
          <text className="lwg-t" x={-w / 2 + 38} y={-2}>{n.label}</text>
          {n.ran > 0 && <text className="lwg-s lwg-ran" x={-w / 2 + 38} y={15}>{ranWords(n.ran)}</text>}
        </g>
      </>
    );
  }
  const ex = exits.get(n.id);
  const exY = n.dot ? 24 + (n.lines.length + (n.ran ? 1 : 0) + (backTo ? 1 : 0)) * DOT_LINE + 2 : h / 2 + 22;
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
      data-waiting={wait?.onYou ? "" : undefined}
      role="button"
      tabIndex={0}
      aria-label={`${n.label}, ${n.kind === "person" ? "a person decides" : n.kind}${wait?.onYou ? `, ${wait.onYou} on you` : ""}${wait?.others ? `, ${wait.others} on someone else` : ""}`}
      onClick={(ev) => { ev.stopPropagation(); press(); }}
      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); ev.stopPropagation(); press(); } }}
      onMouseEnter={onHover ? (ev) => onHover(n.id, ev) : undefined}
      onMouseLeave={onHover ? () => onHover(n.id, null) : undefined}
    >
      <g className={intro != null ? "lwg-in" : undefined} style={intro != null ? { animationDelay: `${intro * 0.03}s` } : undefined}>
        {body}
        {ex && (
          <text className="lwg-exits" x={n.dot ? 0 : -w / 2 + 4} y={exY} textAnchor={n.dot ? "middle" : undefined}>
            <tspan className="lwg-exits-lead">{EXIT_LEAD}</tspan>
            {ex.map((x, i) => (
              <Fragment key={x.label}>
                <tspan data-tone={exitTone(x)} data-zero={x.count ? undefined : ""} x={n.dot && i === 0 ? 0 : undefined} dy={n.dot && i === 0 ? DOT_LINE : undefined}>
                  {`${i ? " · " : ""}${x.label} ${x.count}`}
                </tspan>
                {x.back > 0 && <tspan data-tone="bad">{exitBackWords(x)}</tspan>}
              </Fragment>
            ))}
          </text>
        )}
        {/* An agent's exits line under it already says what came back of its closes; a badge over it would cover its border. */}
        {wait && waiting > 0 && <WaitBadge wait={wait} x={w / 2 + 6} y={-h / 2 - 2} onOpen={onWaiting ? () => onWaiting(n.id) : undefined} />}
        {back && n.kind !== "agent" && (n.dot ? <BackBadge words={back} x={textW(back, 11) / 2 + 7} y={-22} /> : <BackBadge words={back} x={w / 2 + 6} y={-h / 2 - 2} />)}
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
  /** Each step's failures as the Steps table counts them (stepFailures): the one number both views draw. */
  failed?: ReadonlyMap<string, number>;
  /** Each step's passes as the Steps table counts them (stepPassed): the count under a node is the table's, never a visit count. */
  passed?: ReadonlyMap<string, number>;
  /** Each step's waits as the Steps table splits them (stepWaits), and how to open a step's Waiting list. */
  waits?: ReadonlyMap<string, StepWait>;
  onWaiting?: (id: string) => void;
};

export const GraphCanvas = memo(function GraphCanvas({ model, layout, uid, lit, selected, focus = null, peek = null, intro = false, onOpen, onHover, onEdgeHover, failed, passed, waits, onWaiting }: GraphCanvasProps) {
  const bars = barsOf(model);
  // The ends' counts from this model: the layout is shared by every model of its shape.
  const exits = useMemo(() => withFailures(layout.mode === "essence" ? essenceExits(model.graph, (id) => layout.nodes.has(id)) : layout.exits, failed), [model.graph, layout, failed]);
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
            exits={exits}
            failed={failed?.get(n.id)}
            passed={passed?.get(n.id)}
            wait={waits ? waits.get(n.id) ?? { onYou: 0, others: 0 } : undefined}
            onWaiting={onWaiting}
            order={lit?.order.get(n.id)}
            times={lit?.times.get(n.id)}
            dim={!!lit && !lit.order.has(n.id)}
            soft={!lit && !!near && !near.has(n.id)}
            selected={sel === n.id}
            focused={focus === n.id && sel !== n.id}
            intro={intro ? i : null}
            back={model.steps[n.id] ? stepBackWords(model.steps[n.id]) : null}
            onOpen={onOpen}
            onHover={onHover}
          />
        ))}
      </g>
    </g>
  );
});
