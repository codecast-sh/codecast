"use client";
// Replay's rail (line-workspace.md LW1): the whole line as one vertical
// spine, ported from the Replay prototype. Who decides is a big glyph with
// what it decided written under it, a script a small square, bookkeeping a
// tick named on hover; each end sits beside the step that reaches it. The
// run's path is drawn over it, solid up to the playhead and faint after, the
// newest stretch drawing itself in; the step under the playhead breathes.
import { memo, useRef } from "react";
import { decisionKey, type LineModel, type LineRunModel, type LineVisit } from "../../../../../lib/line/lineModel";
import { RAIL, latestVisits, railEdge, railLayout } from "../../../../../lib/line/replay";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { outcomeWords } from "../../../widgets";

export type ReplayRailProps = {
  model: LineModel;
  run: LineRunModel;
  cur: number;
  /** Steps whose decision on this run someone marked wrong. */
  wrong: ReadonlySet<string>;
  /** Steps with an unsaved prompt edit. */
  drafted: ReadonlySet<string>;
  allExits: boolean;
  onStep: (stepId: string) => void;
};

/** What a visit decided, as the rail writes it under the step: null when it only handed on. */
function decisionWords(v: LineVisit | undefined): string | null {
  if (!v) return null;
  if (v.status === "live") return "working";
  if (v.status === "waiting") return "waiting";
  if (v.kind === "person") return v.decided.toWords ?? (v.decided.outcome ? outcomeWords(v.decided.outcome) : null);
  // The step's tally key (decisionKey), so the rail says what the drawer counts: "cut off" for a session that decided nothing.
  if (v.decided.outcome || v.status === "failed") return outcomeWords(decisionKey(v));
  return null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export const ReplayRail = memo(function ReplayRail({ model, run, cur, wrong, drafted, allExits, onStep }: ReplayRailProps) {
  const L = railLayout(model);
  const visits = run.visits;
  const curNode = visits[cur]?.node ?? null;
  const visited = new Set(visits.map((v) => v.node));
  const upTo = latestVisits(visits, cur);
  const firstOf = new Map<string, LineVisit>();
  for (const v of visits) if (!firstOf.has(v.node)) firstOf.set(v.node, v);
  const timesNow = new Map<string, number>();
  for (let i = 0; i <= cur && i < visits.length; i++) timesNow.set(visits[i].node, (timesNow.get(visits[i].node) ?? 0) + 1);
  const shown = (id: string) => !L.at[id]?.end || allExits || visited.has(id);

  // The stretch played last draws itself in, only when the playhead moved forward by one.
  const last = useRef(cur);
  const fresh = cur === last.current + 1 ? cur - 1 : -1;
  useWatchEffect(() => { last.current = cur; }, [cur]);

  // Keep the step under the playhead in view.
  const box = useRef<HTMLDivElement>(null);
  const curY = curNode ? L.at[curNode]?.y ?? null : null;
  useWatchEffect(() => {
    const el = box.current;
    if (!el || curY == null) return;
    const top = curY + 30 - el.clientHeight / 2;
    if (Math.abs(el.scrollTop - top) > el.clientHeight / 3) el.scrollTo({ top, behavior: "smooth" });
  }, [curY, run.id]);

  const spineFirst = L.at[L.spine[0]];
  const spineLast = L.at[L.spine[L.spine.length - 1]];

  return (
    <div className="rp-rail" ref={box}>
      <svg width={RAIL.width} height={L.height} className="rp-rail-svg" role="img" aria-label={`${run.caseTitle}: the run's path through the line`}>
        {L.bands.map((b, i) => (
          <g key={b.half}>
            <rect x={8} y={b.y1} width={RAIL.width - 16} height={b.y2 - b.y1} rx={14} className="rp-band" data-alt={i % 2 ? "" : undefined} />
            <text className="rp-band-label" x={18} y={b.y1 + 15}>{b.label}</text>
          </g>
        ))}
        {spineFirst && spineLast && <line x1={RAIL.spineX} y1={spineFirst.y} x2={RAIL.spineX} y2={spineLast.y} className="rp-spine" />}

        {/* the graph's other ways: loops back, branches out to an end */}
        {model.graph.edges.map((e, i) => {
          const a = L.at[e.from];
          const b = L.at[e.to];
          if (!a || !b || !shown(e.from) || !shown(e.to)) return null;
          if (!a.end && !b.end && b.y >= a.y) return null;
          const back = b.y < a.y;
          if (back && !allExits && !(visited.has(e.from) && visited.has(e.to))) return null;
          const d = railEdge(a, b);
          return d ? <path key={`${e.id}#${i}`} d={d} className="rp-edge" data-back={back ? "" : undefined} /> : null;
        })}

        {/* the run: played solid up to the playhead, the rest faint */}
        {visits.slice(0, -1).map((v, i) => {
          const d = railEdge(L.at[v.node], L.at[visits[i + 1].node]);
          if (!d) return null;
          return <path key={`p${i}`} d={d} className="rp-trail" data-played={i < cur ? "" : undefined} data-fresh={i === fresh ? "" : undefined} pathLength={i === fresh ? 1 : undefined} />;
        })}

        {L.ends.filter(shown).map((id) => {
          const p = L.at[id];
          const lit = upTo.has(id);
          return (
            <g key={id} className="rp-node" data-end="" onClick={() => onStep(id)} data-rail-step={id}>
              <title>{model.steps[id]?.purpose ?? model.steps[id]?.label}</title>
              {id === curNode && <circle className="rp-halo" cx={p.x} cy={p.y} r={8} />}
              <rect x={p.x - 8} y={p.y - 9} width={78} height={18} fill="transparent" />
              <circle cx={p.x} cy={p.y} r={4.5} className="rp-endmark" data-lit={lit ? "" : undefined} data-run={visited.has(id) ? "" : undefined} />
              <text className="rp-end-label" data-lit={lit ? "" : undefined} x={p.x + 9} y={p.y + 3.5}>{clip(model.steps[id]?.label ?? id, p.col === 0 && L.ends.some((o) => L.at[o].col === 1 && L.at[o].y === p.y) ? 11 : 16)}</text>
            </g>
          );
        })}

        {L.spine.map((id) => {
          const p = L.at[id];
          const step = model.steps[id];
          const k = step.kind;
          const lit = timesNow.has(id);
          const inRun = visited.has(id);
          const isCur = id === curNode;
          if (L.ticks.has(id)) {
            return (
              <g key={id} className="rp-node" data-tick="" data-lit={lit ? "" : undefined} data-run={inRun ? "" : undefined} onClick={() => onStep(id)} data-rail-step={id}>
                <title>{`${step.label}, a script`}</title>
                {isCur && <circle className="rp-halo" cx={p.x} cy={p.y} r={9} />}
                <rect x={p.x - 18} y={p.y - 8} width={150} height={16} fill="transparent" />
                <line x1={p.x - 5} y1={p.y} x2={p.x + 5} y2={p.y} className="rp-tick" />
                <text className="rp-tick-label" x={p.x + 20} y={p.y + 3.5}>{clip(step.label, 22)}</text>
              </g>
            );
          }
          const big = k === "agent" || k === "person";
          const v = upTo.get(id);
          const said = big ? decisionWords(v ?? firstOf.get(id)) : null;
          const times = timesNow.get(id) ?? 0;
          return (
            <g key={id} className="rp-node" data-kind={k} data-lit={lit ? "" : undefined} data-run={inRun ? "" : undefined} data-cur={isCur ? "" : undefined} onClick={() => onStep(id)} data-rail-step={id}>
              <title>{step.purpose}</title>
              {isCur && <circle className="rp-halo" cx={p.x} cy={p.y} r={15} />}
              <rect x={p.x - 20} y={p.y - 14} width={168} height={28} fill="transparent" />
              {k === "agent" && <><circle cx={p.x} cy={p.y} r={10} className="rp-glyph" />{lit && <circle cx={p.x} cy={p.y} r={3.2} className="rp-glyph-eye" />}</>}
              {k === "person" && <path d={`M${p.x} ${p.y - 11} L${p.x + 11} ${p.y} L${p.x} ${p.y + 11} L${p.x - 11} ${p.y}Z`} className="rp-glyph" />}
              {k === "script" && <rect x={p.x - 4.5} y={p.y - 4.5} width={9} height={9} rx={1.5} className="rp-glyph" />}
              {wrong.has(id) && <circle cx={p.x - 19} cy={p.y} r={3.5} className="rp-wrongdot"><title>Marked wrong on this run</title></circle>}
              {drafted.has(id) && <text className="rp-draft" x={p.x - 24} y={p.y + 3.5} textAnchor="end">draft</text>}
              <text className="rp-label" data-script={big ? undefined : ""} x={p.x + 22} y={p.y + (said ? -1 : 4.5)}>{clip(step.label, big ? 19 : 22)}</text>
              {said && <text className="rp-said" data-kind={k} data-future={v ? undefined : ""} x={p.x + 22} y={p.y + 14}>{clip(said, 24)}</text>}
              {times > 1 && <text className="rp-times" x={p.x + 14} y={p.y - 9}>×{times}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
});
