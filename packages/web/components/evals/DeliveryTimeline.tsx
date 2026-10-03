// The tape (docs/architecture/evals-ui.md 4.7): one Multiplayer sim run as
// swim lanes. Devices group their windows; sched, timers and actors sit below.
// x is delivery order. Each channel kind has its own mark, so nothing rests on
// colour alone: a window's request rises and its answer drops, a live push is a
// stem in its feed's colour, a replication is an arc between two windows, a
// bridge a diamond on its device, a timer a ring, sched a square, an actor a
// wedge. Steps are bands, the failing delivery a magenta rule, and the
// playhead can be dragged.

import { useMemo, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useContainerWidth } from "../ActivityHeatmap";
import { feedTone, touches, type Lane, type Mark, type Timeline } from "./simLanes";
import "./sim.css";

const GUTTER = 168;
const PAD = 10;
const TOP = 34;
const AXIS = 26;
const H_DEVICE = 20;
const H_LANE = 26;
const GROUP_GAP = 8;
const MIN_COL = 9;
const CHAR_W = 6.1;

export interface DeliveryTimelineProps {
  timeline: Timeline;
  /** The failing delivery's index, or null. */
  failAt: number | null;
  /** What the failure flag says (the invariant id). */
  failLabel: string;
  playhead: number | null;
  onPlayhead: (i: number) => void;
  /** Deliveries a shrink kept; the rest dim when `showKept`. */
  kept: Set<number> | null;
  showKept: boolean;
  /** A label the lanes are traced to (--trace), and the run's id-to-label map. */
  trace: string | null;
  labels: Record<string, string>;
}

interface LaneRow {
  lane: Lane;
  y: number;
  h: number;
}

function layoutLanes(lanes: Lane[]): { rows: LaneRow[]; height: number } {
  const rows: LaneRow[] = [];
  let y = TOP;
  let prevGroup: string | null | undefined;
  for (const lane of lanes) {
    const group = lane.kind === "device" || lane.kind === "window" ? `dev:${lane.device ?? ""}` : "below";
    if (prevGroup !== undefined && group !== prevGroup) y += GROUP_GAP;
    prevGroup = group;
    const h = lane.kind === "device" ? H_DEVICE : H_LANE;
    rows.push({ lane, y, h });
    y += h;
  }
  return { rows, height: y + AXIS };
}

/** Axis step: the smallest of 1, 2, 5, 10, 20, 50 ... deliveries that keeps ticks 44px apart. */
function axisStep(colW: number): number {
  for (const base of [1, 2, 5]) for (let m = 1; m <= 1e6; m *= 10) if (base * m * colW >= 44) return base * m;
  return 1;
}

export function DeliveryTimeline({ timeline, failAt, failLabel, playhead, onPlayhead, kept, showKept, trace, labels }: DeliveryTimelineProps) {
  const { ref, width } = useContainerWidth(900);
  const { rows, height } = useMemo(() => layoutLanes(timeline.lanes), [timeline.lanes]);
  const yOf = useMemo(() => new Map(rows.map((r) => [r.lane.id, r.y + r.h / 2])), [rows]);
  const n = Math.max(1, timeline.count);
  const avail = Math.max(120, width - GUTTER - PAD * 2);
  const colW = Math.max(MIN_COL, avail / n);
  const innerW = colW * n + PAD * 2;
  const x = (i: number) => PAD + colW * (i + 0.5);
  const dragging = useRef(false);

  const off = useMemo(() => {
    const out = new Set<number>();
    for (const m of timeline.marks) {
      if (kept && showKept && !kept.has(m.i)) out.add(m.i);
      else if (trace && !touches(m, trace, labels)) out.add(m.i);
    }
    return out;
  }, [timeline.marks, kept, showKept, trace, labels]);

  const at = playhead === null ? null : timeline.marks[playhead] ?? null;

  const pick = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - PAD) / colW);
    onPlayhead(Math.max(0, Math.min(timeline.count - 1, i)));
  };

  const step = axisStep(colW);
  const ticks: number[] = [];
  for (let i = step - 1; i < timeline.count; i += step) ticks.push(i);
  const bottom = height - AXIS;

  return (
    <div className="flex min-w-0" data-evs-timeline data-evs-count={timeline.count}>
      <svg width={GUTTER} height={height} className="shrink-0" aria-hidden>
        <rect width={GUTTER} height={height} className="evs-gutter" />
        {rows.map(({ lane, y, h }) => (
          <g key={lane.id}>
            {lane.kind === "device" && <rect x={0} y={y} width={GUTTER} height={h} className="evs-device-bg" />}
            <text
              x={lane.kind === "window" ? 22 : 12}
              y={y + h / 2 + 3.5}
              className={`evs-lane-label ${lane.kind === "device" ? "evs-lane-label--device" : ""} ${lane.closed ? "evs-lane-label--closed" : ""}`}
            >
              {truncate(lane.kind === "window" && lane.role ? `${lane.label} ${lane.role === "host" ? "h" : "f"}` : lane.label, lane.kind === "window" ? 22 : 24)}
              <title>{laneTitle(lane)}</title>
            </text>
            {lane.closed && (
              <text x={GUTTER - 8} y={y + h / 2 + 3.5} textAnchor="end" className="evs-lane-label evs-lane-label--closed">
                closed
              </text>
            )}
          </g>
        ))}
        <text x={12} y={bottom + 17} className="evs-axis">
          delivery
        </text>
      </svg>
      <div ref={ref} className="evs-tape-scroll ev-bench flex-1 min-w-0">
        <svg
          width={Math.max(innerW, avail + PAD * 2)}
          height={height}
          className="evs-lanes"
          role="img"
          aria-label={`${timeline.count} deliveries across ${timeline.lanes.length} lanes`}
          onPointerDown={(e) => {
            dragging.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            pick(e);
          }}
          onPointerMove={(e) => dragging.current && pick(e)}
          onPointerUp={() => (dragging.current = false)}
          onPointerCancel={() => (dragging.current = false)}
        >
          {/* Steps as bands, labelled along the top. */}
          {timeline.steps.map((s, k) => {
            const x0 = PAD + colW * s.at;
            const w = colW * (s.end - s.at);
            const room = Math.max(w, colW) - 8;
            const text = `${s.verb} ${s.actor === "world" ? "" : `${s.actor}: `}${s.label}`;
            return (
              <g key={`${k}:${s.at}`} data-evs-step={s.verb}>
                {k % 2 === 0 && w > 0 && <rect x={x0} y={TOP - 4} width={w} height={bottom - TOP + 4} className="evs-band" />}
                <line x1={x0} x2={x0} y1={6} y2={bottom} className="evs-band-edge" />
                {room > 30 && (
                  <text x={x0 + 4} y={16} className="evs-band-label">
                    <tspan className="evs-band-verb">{s.verb}</tspan>
                    <tspan dx={5}>{truncate(s.actor === "world" ? s.label : `${s.actor}: ${s.label}`, Math.floor((room - s.verb.length * CHAR_W - 5) / CHAR_W))}</tspan>
                  </text>
                )}
                <title>{text}</title>
              </g>
            );
          })}

          {/* Lane lines; a closed window's line stops after its last delivery. */}
          {rows.map(({ lane, y, h }) => {
            if (lane.kind === "device") return null;
            const cy = y + h / 2;
            const last = timeline.lastIndex[lane.id];
            const end = lane.closed && last !== undefined ? x(last) + colW / 2 : innerW - PAD;
            return (
              <g key={lane.id}>
                <line x1={PAD} x2={end} y1={cy} y2={cy} className="evs-lane-line" />
                {lane.closed && last !== undefined && <line x1={end} x2={end} y1={cy - 6} y2={cy + 6} className="evs-lane-end" />}
              </g>
            );
          })}

          {failAt !== null && (
            <g data-evs-fail-rule={failAt}>
              <line x1={x(failAt)} x2={x(failAt)} y1={TOP - 6} y2={bottom + 4} className="evs-fail-rule" />
              <FailFlag x={x(failAt)} y={bottom + 6} text={`fails: ${failLabel}`} maxX={Math.max(innerW, avail + PAD * 2)} />
            </g>
          )}

          {timeline.marks.map((m) => (
            <MarkGlyph key={m.i} m={m} x={x(m.i)} y={yOf.get(m.lane) ?? TOP} y2={m.toLane ? yOf.get(m.toLane) : undefined} colW={colW} off={off.has(m.i)} tone={feedTone(timeline.feeds, m.feed)} />
          ))}

          {/* The playhead: its delivery gets a halo, and the deliveries of the same producer a dotted one. */}
          {at && (
            <g data-evs-playhead={at.i}>
              {timeline.marks
                .filter((m) => m.producer === at.producer && m.i !== at.i)
                .map((m) => (
                  <circle key={m.i} cx={x(m.i)} cy={yOf.get(m.lane) ?? TOP} r={7} className="evs-kin" />
                ))}
              <line x1={x(at.i)} x2={x(at.i)} y1={TOP - 8} y2={bottom} className="evs-playhead" />
              <path d={`M${x(at.i) - 5},${TOP - 14} h10 l-5,6 z`} className="evs-playhead-knob" />
              <circle cx={x(at.i)} cy={yOf.get(at.lane) ?? TOP} r={8} className="evs-halo" />
            </g>
          )}

          {ticks.map((i) => (
            <text key={i} x={x(i)} y={bottom + 17} textAnchor="middle" className="evs-axis">
              {i + 1}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

function FailFlag({ x, y, text, maxX }: { x: number; y: number; text: string; maxX: number }) {
  const w = text.length * 6.2 + 12;
  const left = Math.min(Math.max(2, x - w / 2), maxX - w - 2);
  return (
    <g>
      <rect x={left} y={y} width={w} height={15} rx={3} className="evs-fail-flag" />
      <text x={left + 6} y={y + 11} className="evs-fail-flag-text">
        {text}
      </text>
    </g>
  );
}

function MarkGlyph({ m, x, y, y2, colW, off, tone }: { m: Mark; x: number; y: number; y2: number | undefined; colW: number; off: boolean; tone: string }) {
  const title = `#${m.i + 1}  ${m.channel}\n${m.label}\n${m.producer}`;
  let body;
  switch (m.shape) {
    case "conn": {
      const req = m.label.startsWith("req");
      const res = m.label.startsWith("res");
      body = <line x1={x} x2={x} y1={res ? y + 1 : y - 7} y2={req ? y - 1 : y + 7} className="evs-mark-conn" />;
      break;
    }
    case "live":
      body = (
        <g style={{ color: tone }}>
          <line x1={x} x2={x} y1={y - 6} y2={y + 6} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
          <circle cx={x} cy={y - 6} r={2.3} fill="currentColor" />
        </g>
      );
      break;
    case "repl": {
      const to = y2 ?? y;
      const bulge = Math.min(Math.max(colW * 1.4, 10), 22);
      const d = to === y ? `M${x},${y} c${bulge},-12 ${bulge},12 0,0` : `M${x},${y} C${x + bulge},${y} ${x + bulge},${to} ${x + 1},${to}`;
      body = (
        <g>
          <circle cx={x} cy={y} r={1.8} className="evs-arc-head" />
          <path d={d} className="evs-arc" />
          <path d={`M${x + 1},${to} l5,-3 l0,6 z`} className="evs-arc-head" />
        </g>
      );
      break;
    }
    case "bridge":
      body = <path d={`M${x},${y - 5} L${x + 5},${y} L${x},${y + 5} L${x - 5},${y} Z`} className="evs-mark-solid" />;
      break;
    case "timer":
      body = <circle cx={x} cy={y} r={3.4} fill="none" stroke="var(--sol-text-muted)" strokeWidth={1.4} />;
      break;
    case "sched":
      body = <rect x={x - 3} y={y - 3} width={6} height={6} className="evs-mark-solid" />;
      break;
    case "actor":
      body = <path d={`M${x - 5},${y - 5} L${x + 5},${y - 5} L${x},${y + 4} Z`} className="evs-mark-actor" />;
      break;
    default:
      body = <circle cx={x} cy={y} r={2.2} className="evs-mark-solid" />;
  }
  return (
    <g className="evs-mark" data-evs-mark={m.shape} data-evs-off={off || undefined}>
      <title>{title}</title>
      {body}
    </g>
  );
}

function laneTitle(lane: Lane): string {
  if (lane.kind === "window") return `window ${lane.label}${lane.role ? `, ${lane.role}` : ""}${lane.device ? ` on ${lane.device}` : ""}${lane.closed ? ", closed" : ""}`;
  if (lane.kind === "device") return `device ${lane.label}: its bridge deliveries`;
  return lane.label;
}

const truncate = (s: string, max: number) => (max <= 1 ? "" : s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s);
