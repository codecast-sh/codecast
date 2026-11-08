"use client";

import { memo, useRef, useState, type ReactNode } from "react";
import { useNearViewport } from "@/hooks/useNearViewport";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../blog/blogChrome";
import { at, BACK, BAD, FLOOR, GOOD, LINE, PERSON, usePlayOnView, useStill } from "./kit";
import {
  countEvents, L, slotFill, slotSnapshot, smil, snapshot, STEP_IDS, STEP_LABEL, T0, TALL, untilNextChange, WIDE, zonesAt,
  type Box, type Floor, type Kind, type NodeId, type Piece, type Plan, type TextAt,
} from "./heroFloor";
import { CAUSE, ROLE } from "./story";
import "./hero.css";

/*
 * The hero: the whole loop as one floor plan that keeps running. Signals
 * stream from the sources into Triage, where most join an open problem (its
 * count ticks) and a few open a new one; the line takes problems from the
 * queue into machine slots (a slot is held from the moment a run takes it
 * until the run waits at Decide, so "N running" is the filled slots) while a
 * person's session sends its own change; both merge into Check, Review and
 * Decide, then Land, Deploy, Live and a 7 day Watch, which ends Closed clean
 * or sends a regression back to the signals. Violet tokens are the ways back
 * to the person's session (Fix check, Revise).
 *
 * Desktop (xl and up) draws the wide plan, phones and tablets the tall one;
 * heroFloor.ts lays one schedule onto both. Motion is SMIL on one SVG
 * timeline per plan, so the counters read the same clock the tokens move on,
 * and pausing the SVG off screen pauses both. Before play and in still mode
 * every token sits where the schedule puts it at T0, counters at base values.
 *
 * HeroReprise closes the page with the same floor at a fraction of the
 * height: the story's regression coming back into Signals.
 */

const INK2 = SOL.base2;
const DIMT = SOL.base0;
const FAINT = "rgba(147,161,161,.26)";
const NODE_FILL = SOL.base02;
const NODE_LINE = "rgba(147,161,161,.32)";
/** Violet and red lifted for text on the dark floor: quieter than the main path, still readable. */
const BACK_TEXT = "#a9abec";
const BAD_TEXT = "#f0625f";
const LABEL = 13;
const SMALL = 12;

const KIND_COLOR: Record<Kind, string> = { signal: SOL.base1, line: LINE, person: PERSON, back: BACK, regress: BAD };

const SOURCES: { name: string; state: "flowing" | "quiet" | "stopped"; base?: number; days: number[] }[] = [
  { name: "New issues", state: "flowing", base: 1892, days: [6, 7, 5, 8, 7, 6, 8, 7, 8, 6, 7, 8, 7, 8] },
  { name: "Failed jobs", state: "flowing", base: 311, days: [3, 2, 4, 3, 5, 2, 3, 4, 3, 5, 4, 3, 4, 5] },
  { name: "Eval reds", state: "flowing", base: 73, days: [1, 0, 2, 1, 0, 3, 1, 0, 2, 1, 0, 2, 1, 2] },
  { name: "Teammate reports", state: "quiet", days: [2, 0, 3, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: "Judge mistakes", state: "stopped", days: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
];
/** Open problems in Triage: the signal kind and how many signals it holds. */
const PROBLEMS = [
  { kind: "bug", base: 214, fill: 0.7 },
  { kind: "regression", base: 38, fill: 0.42 },
  { kind: "prompt_miss", base: 12, fill: 0.24 },
];
const SIGNALS_BASE = 2276;
const BASE = { onPerson: 1, live: 42, watching: 44 };
/** Trail behind a moving token: how far back each ghost runs (s) and how strong it is. */
const TRAIL: [number, number][] = [[0.08, 0.42], [0.16, 0.2], [0.24, 0.09]];

const fmt = (n: number) => n.toLocaleString("en-US");
const Txt = ({ at: p, size = SMALL, fill = DIMT, weight, children, className }: { at: TextAt; size?: number; fill?: string; weight?: number; children: ReactNode; className?: string }) => (
  <text x={p.x} y={p.y} textAnchor={p.anchor ?? "start"} fontSize={size} fill={fill} fontWeight={weight} className={className}>{children}</text>
);

export function Hero() {
  return (
    <section className="flx-hero relative overflow-hidden flx-floor-grid" style={{ backgroundColor: FLOOR }}>
      <div className="relative max-w-7xl mx-auto px-5 sm:px-8 pt-12 sm:pt-16">
        <h1 className="flx-rise font-mono font-bold text-[34px] sm:text-[50px] leading-[1.05] tracking-[-0.04em] max-w-5xl [text-wrap:balance]" style={at(0, { color: SOL.base3 })}>
          Every change takes the same path to production
        </h1>
        <p className="flx-rise mt-5 sm:mt-6 max-w-3xl text-[16px] sm:text-[17px] leading-[1.65]" style={at(0.12, { color: SOL.base1 })}>
          Your session and the line&apos;s agents ship through the same Check, Review and Decide. Fixes trace back to the
          change that caused them, and that record sets how much an agent may merge alone.
        </p>
      </div>
      <div className="relative max-w-[1500px] mx-auto px-5 sm:px-8 pt-8 sm:pt-10 pb-10 sm:pb-14">
        <FloorFigure floor={WIDE} className="hidden xl:block" />
        <FloorFigure floor={TALL} className="xl:hidden mx-auto max-w-[440px]" />
      </div>
    </section>
  );
}

const ARIA =
  "The loop: signals from production enter Triage, the line and a person's session both build changes, every change passes Check, Review and Decide, then lands, deploys, goes live and is watched for 7 days; a watch ends Closed clean or a regression returns to the signals.";

function FloorFigure({ floor, className }: { floor: Floor; className: string }) {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const still = useStill();
  const visible = useNearViewport(ref, "0px", { latch: false });
  const svgRef = useRef<SVGSVGElement | null>(null);
  const live = playing && !still;
  const { W, H } = floor.plan;
  return (
    <div ref={ref} className={`flx-hero-fig ${className}`} data-play={playing ? "" : undefined}>
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="block w-full h-auto font-mono" role="img" aria-label={ARIA}>
        <Defs />
        <Under plan={floor.plan} />
        <Tokens floor={floor} live={live} />
        <Over floor={floor} svgRef={svgRef} live={live} visible={visible} />
      </svg>
    </div>
  );
}

function Defs() {
  const glows: [string, string][] = [["line", LINE], ["person", PERSON], ["back", BACK], ["regress", BAD], ["signal", SOL.base1]];
  return (
    <defs>
      {glows.map(([id, c]) => (
        <radialGradient key={id} id={`flx-hero-glow-${id}`}>
          <stop offset="0%" stopColor={c} stopOpacity={0.6} />
          <stop offset="40%" stopColor={c} stopOpacity={0.2} />
          <stop offset="100%" stopColor={c} stopOpacity={0} />
        </radialGradient>
      ))}
    </defs>
  );
}

// ---------- glyphs (the app's step icons) ----------
function PersonGlyph({ x, y, c }: { x: number; y: number; c: string }) {
  return (
    <g fill="none" stroke={c} strokeWidth={1.3} strokeLinecap="round">
      <circle cx={x} cy={y - 2.6} r={2.4} />
      <path d={`M${x - 4.4} ${y + 5} a4.4 4.4 0 0 1 8.8 0`} />
    </g>
  );
}
function TermGlyph({ x, y, c }: { x: number; y: number; c: string }) {
  return (
    <g fill="none" stroke={c} strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round">
      <rect x={x - 5.5} y={y - 5} width={11} height={10} rx={2} />
      <path d={`M${x - 3} ${y - 1.8} l2 1.8 l-2 1.8 M${x + 0.5} ${y + 2} h2.5`} />
    </g>
  );
}
function BotGlyph({ x, y, c }: { x: number; y: number; c: string }) {
  return (
    <g fill="none" stroke={c} strokeWidth={1.2} strokeLinecap="round">
      <rect x={x - 5.5} y={y - 3} width={11} height={8} rx={2} />
      <path d={`M${x} ${y - 3} v-2.5`} />
      <circle cx={x - 2.2} cy={y + 1} r={0.6} fill={c} />
      <circle cx={x + 2.2} cy={y + 1} r={0.6} fill={c} />
    </g>
  );
}
function LineGlyph({ x, y, c }: { x: number; y: number; c: string }) {
  return (
    <g fill="none" stroke={c} strokeWidth={1.3}>
      <circle cx={x} cy={y} r={5} />
      <path d={`M${x} ${y - 2.6} v2.6 l1.8 1.4`} strokeLinecap="round" />
    </g>
  );
}
/** Check, Land and Deploy run shell; Review is an agent; Decide is a person. */
const STEP_ICON: Record<Exclude<NodeId, "live">, typeof TermGlyph> = { check: TermGlyph, review: BotGlyph, decide: PersonGlyph, land: TermGlyph, deploy: TermGlyph };

function BackLabel({ l, label }: { l: TextAt & { chip: boolean }; label: string }) {
  // Plain text where there is no room for a chip, without the ↺ (the dashed violet route says it).
  if (!l.chip) return <Txt at={l} fill={BACK_TEXT} weight={600}>{label.replace("↺ ", "")}</Txt>;
  const w = label.length * 7.4 + 18;
  return (
    <g>
      <rect x={l.x - w / 2} y={l.y - 11} width={w} height={22} rx={6} fill={FLOOR} />
      <rect x={l.x - w / 2} y={l.y - 11} width={w} height={22} rx={6} fill={BACK} fillOpacity={0.2} stroke={BACK} strokeOpacity={0.85} />
      <text x={l.x} y={l.y + 4.3} textAnchor="middle" fontSize={SMALL} fill={BACK_TEXT} fontWeight={600}>{label}</text>
    </g>
  );
}

function Legend({ plan }: { plan: Plan }) {
  const dot = (c: string) => (x: number, y: number) => <rect x={x - 6} y={y - 4} width={12} height={8} rx={2.5} fill={c} />;
  const items: [(x: number, y: number) => ReactNode, string][] = [
    [dot(PERSON), "Work a person starts"],
    [dot(LINE), "Work the line starts"],
    [(x, y) => <PersonGlyph x={x} y={y} c={PERSON} />, "A person decides"],
    [(x, y) => <TermGlyph x={x} y={y} c={SOL.base1} />, "Automated check"],
    [dot(BACK), "Back to its session"],
    [dot(BAD), "A regression"],
  ];
  return (
    <g className="flx-fade" style={at(1.5)}>
      {items.map(([sw, label], i) => {
        const x = plan.legend.cols[i % 2];
        const y = plan.legend.rows[Math.floor(i / 2)];
        return (
          <g key={label}>
            {sw(x + 6, y - 4)}
            <text x={x + 18} y={y} fontSize={SMALL} fill={DIMT}>{label}</text>
          </g>
        );
      })}
    </g>
  );
}

// ---------- the floor under the tokens ----------
const Under = memo(function Under({ plan }: { plan: Plan }) {
  const { triage, line, edges, labels } = plan;
  const sparkStep = 5.2;
  return (
    <g>
      {plan.stages.map((s, i) => (
        <g key={s.n} className="flx-fade" style={at(0.15 + i * 0.06)}>
          <text x={s.x0} y={s.y} fontSize={LABEL} fontWeight={600} fill={INK2}>
            <tspan fill={SOL.base01}>{s.n}</tspan>
            <tspan dx={7}>{s.name}</tspan>
          </text>
          <line x1={s.x0} x2={s.x1} y1={s.y + 10} y2={s.y + 10} stroke={FAINT} />
        </g>
      ))}

      <g fill="none" strokeWidth={1.25} strokeLinecap="round">
        {edges.signals.map((d, i) => <path key={i} d={d} stroke={FAINT} pathLength={1} className="flx-hero-draw" style={at(0.35 + i * 0.03)} />)}
        {edges.silent.map((d, i) => <path key={i} d={d} stroke={FAINT} strokeDasharray="2 4" className="flx-fade" style={at(0.5)} />)}
        {edges.line.map((d, i) => <path key={i} d={d} stroke="rgba(42,161,152,.42)" pathLength={1} className="flx-hero-draw" style={at(0.55 + i * 0.04)} />)}
        <path d={edges.person} stroke="rgba(38,139,210,.6)" pathLength={1} className="flx-hero-draw" style={at(0.7)} />
        <path d={edges.main} stroke="rgba(42,161,152,.55)" pathLength={1} className="flx-hero-draw" style={at(0.85)} />
        <path d={plan.fixRoute.d} stroke={BACK} strokeOpacity={0.75} strokeDasharray="4 4" className="flx-fade" style={at(1.2)} />
        <path d={plan.reviseRoute.d} stroke={BACK} strokeOpacity={0.75} strokeDasharray="4 4" className="flx-fade" style={at(1.25)} />
        <path d={plan.regressRoute.d} stroke={BAD} strokeOpacity={0.6} strokeDasharray="4 5" className="flx-fade" style={at(1.35)} />
      </g>

      {SOURCES.map((s, i) => {
        const src = plan.sources[i];
        const stopped = s.state === "stopped";
        const quiet = s.state === "quiet";
        return (
          <g key={s.name} className="flx-rise" style={at(0.1 + i * 0.05)}>
            <rect {...xywh(src.box)} rx={7} fill={NODE_FILL} stroke={stopped ? BAD : NODE_LINE} strokeOpacity={stopped ? 0.6 : 1} />
            <Txt at={src.name} weight={600} fill={s.state === "flowing" ? INK2 : DIMT}>{s.name}</Txt>
            {s.days.map((v, d) => (
              <rect
                key={d}
                x={src.spark[0] + d * sparkStep}
                y={src.spark[1] - Math.max(1, v)}
                width={3}
                height={Math.max(1, v)}
                rx={0.8}
                fill={v === 0 ? (stopped ? BAD : SOL.base01) : quiet ? SOL.base00 : LINE}
                fillOpacity={v === 0 ? 0.6 : 0.8}
              />
            ))}
            {s.state !== "flowing" ? <Txt at={src.status} fill={stopped ? BAD_TEXT : DIMT}>{s.state}</Txt> : null}
            <circle cx={src.port[0]} cy={src.port[1]} r={2.2} fill={s.state === "flowing" ? SOL.base1 : SOL.base01} />
          </g>
        );
      })}

      <g className="flx-rise" style={at(0.45)}>
        <rect {...xywh(triage.box)} rx={9} fill={NODE_FILL} stroke={NODE_LINE} />
        {triage.title ? <Txt at={triage.title} size={LABEL} weight={700} fill={INK2}>Triage</Txt> : null}
        {triage.rows.map((r, i) => (
          <g key={i}>
            <rect {...xywh(r.box)} rx={3.5} fill={FLOOR} stroke={NODE_LINE} />
            <rect x={r.box.x + 1} y={r.box.y + 1} width={(r.box.w - 2) * PROBLEMS[i].fill} height={r.box.h - 2} rx={3} fill={LINE} fillOpacity={0.16} />
            <Txt at={r.kind} fill={SOL.base1}>{PROBLEMS[i].kind}</Txt>
          </g>
        ))}
        {triage.chips.map(([x, y], i) => (
          <rect key={i} x={x - 4} y={y - 4} width={8} height={8} rx={2} fill={LINE} fillOpacity={0.2} stroke={LINE} strokeOpacity={0.7} />
        ))}
        <Txt at={triage.queued}>
          <tspan fill={INK2} fontWeight={700}>17</tspan> queued
        </Txt>
      </g>

      <g className="flx-rise" style={at(0.6)}>
        <rect {...xywh(line.box)} rx={9} fill={NODE_FILL} stroke={LINE} strokeOpacity={0.4} />
        <rect x={line.box.x} y={line.box.y + 8} width={3} height={line.box.h - 16} rx={1.5} fill={LINE} />
        {line.glyph ? <LineGlyph x={line.glyph[0]} y={line.glyph[1]} c={LINE} /> : null}
        <Txt at={line.title} size={LABEL} weight={600} fill={INK2}>The line</Txt>
        {line.slots.map((b, k) => <rect key={k} {...xywh(b)} rx={4} fill={FLOOR} stroke={NODE_LINE} />)}
      </g>

      <g className="flx-fade" style={at(1.3)}>
        <BackLabel l={labels.fix} label="↺ Fix check" />
        <BackLabel l={labels.revise} label="↺ Revise" />
        <Txt at={labels.back} weight={600} fill={INK2}>
          <tspan fill={BAD_TEXT}>↺</tspan> Back to signals
          <tspan dx={10} fill={BAD_TEXT} fontWeight={500}>2 regressed</tspan>
        </Txt>
        {labels.sameChecks ? <Txt at={labels.sameChecks}>Same checks, every change</Txt> : null}
      </g>
      <Legend plan={plan} />
    </g>
  );
});

const xywh = (b: Box) => ({ x: b.x, y: b.y, width: b.w, height: b.h });

// ---------- tokens ----------
function TokenShape({ kind }: { kind: Kind }) {
  const c = KIND_COLOR[kind];
  if (kind === "signal") {
    return (
      <>
        <circle r={10} fill="url(#flx-hero-glow-signal)" />
        <circle r={3.4} fill={c} />
      </>
    );
  }
  return (
    <>
      <circle r={kind === "regress" ? 22 : 17} fill={`url(#flx-hero-glow-${kind})`} />
      <rect x={-8} y={-5} width={16} height={10} rx={3} fill={c} />
      <rect x={-8} y={-5} width={16} height={10} rx={3} fill="none" stroke="#fdf6e3" strokeOpacity={0.45} strokeWidth={0.8} />
    </>
  );
}

/** One moving thing on a piece's path: SMIL while live, its T0 position otherwise. */
function Mover({ p, live, lag, children }: { p: Piece; live: boolean; lag: number; children: ReactNode }) {
  if (!live) {
    const s = snapshot(p, T0 - lag);
    if (s.o <= 0) return null;
    return <g transform={`translate(${s.x.toFixed(1)} ${s.y.toFixed(1)})`} opacity={s.o}>{children}</g>;
  }
  const a = smil(p);
  const begin = `${(((p.begin + lag) % L) + L) % L}s`;
  return (
    <g opacity={0}>
      <animateMotion dur={`${L}s`} begin={begin} repeatCount="indefinite" path={p.route.d} keyPoints={a.keyPoints} keyTimes={a.keyTimes} calcMode="linear" />
      <animate attributeName="opacity" dur={`${L}s`} begin={begin} repeatCount="indefinite" values={a.opacityValues} keyTimes={a.opacityTimes} calcMode="linear" />
      {children}
    </g>
  );
}

/** A machine slot row filling while a run works in it, held full until the run waits at Decide. */
function SlotFill({ p, slots, live }: { p: Piece; slots: Box[]; live: boolean }) {
  if (!p.slot) return null;
  const b = slots[p.slot.k];
  const f = slotFill(p, b);
  if (!f) return null;
  const common = { x: b.x + 1, y: b.y + 1, height: b.h - 2, rx: 3, fill: LINE, fillOpacity: 0.26 };
  if (!live) {
    const s = slotSnapshot(p, b, T0);
    return s ? <rect {...common} width={s.w} opacity={s.o} /> : null;
  }
  const begin = `${p.begin}s`;
  return (
    <rect {...common} width={6} opacity={0}>
      <animate attributeName="width" dur={`${L}s`} begin={begin} repeatCount="indefinite" values={f.widthValues} keyTimes={f.widthTimes} calcMode="linear" />
      <animate attributeName="opacity" dur={`${L}s`} begin={begin} repeatCount="indefinite" values={f.opacityValues} keyTimes={f.opacityTimes} calcMode="linear" />
    </rect>
  );
}

const Tokens = memo(function Tokens({ floor, live }: { floor: Floor; live: boolean }) {
  const slots = floor.plan.line.slots;
  return (
    <g className="flx-fade" style={at(1.4)}>
      {floor.pieces.map((p) => <SlotFill key={`f-${p.id}`} p={p} slots={slots} live={live} />)}
      {floor.pieces.map((p) =>
        TRAIL.slice(0, p.kind === "signal" ? 2 : 3).map(([lag, strength]) => (
          <Mover key={`${p.id}-${lag}`} p={p} live={live} lag={lag}>
            <circle r={p.kind === "signal" ? 2.6 : 4.2} fill={KIND_COLOR[p.kind]} opacity={strength} />
          </Mover>
        )),
      )}
      {floor.pieces.map((p) => (
        <Mover key={p.id} p={p} live={live} lag={0}>
          <TokenShape kind={p.kind} />
        </Mover>
      ))}
    </g>
  );
});

// ---------- the floor over the tokens: steps, highlights and counters on the shared clock ----------
type Occupant = "idle" | "line" | "person" | "fail";
function occupant(z: Map<string, number>, id: string): Occupant {
  if (z.get(`n:${id}:fail`)) return "fail";
  if (z.get(`n:${id}:person`)) return "person";
  if (z.get(`n:${id}:line`)) return "line";
  return "idle";
}
const OCC_COLOR: Record<Occupant, string | null> = { idle: null, line: LINE, person: PERSON, fail: BAD };

/** A node's two layers: an opaque base that hides the tokens inside, and a state layer that lights. */
function NodeRect({ b, rx, lit, base, dashed }: { b: Box; rx: number; lit: string | null; base: string | null; dashed?: boolean }) {
  return (
    <>
      <rect {...xywh(b)} rx={rx} fill={NODE_FILL} />
      <rect
        className="flx-hero-step"
        data-lit={lit ? "" : undefined}
        style={lit ? { color: lit } : undefined}
        {...xywh(b)}
        rx={rx}
        fill={lit ?? base ?? "transparent"}
        fillOpacity={lit ? 0.3 : base ? 0.1 : 0}
        stroke={lit ?? base ?? NODE_LINE}
        strokeOpacity={lit ? 1 : base ? 0.6 : 1}
        strokeWidth={lit ? 1.75 : 1}
        strokeDasharray={dashed && !lit ? "4 3" : undefined}
      />
    </>
  );
}

function Step({ id, b, occ, wait, delay }: { id: NodeId; b: Box; occ: Occupant; wait?: boolean; delay: number }) {
  const lit = OCC_COLOR[occ];
  const isLive = id === "live";
  const rx = isLive ? b.h / 2 : 8;
  const cy = b.y + b.h / 2;
  const Icon = isLive ? null : STEP_ICON[id];
  return (
    <g className="flx-rise" style={at(delay)}>
      {wait ? <rect className="flx-hero-ring" x={b.x - 5} y={b.y - 5} width={b.w + 10} height={b.h + 10} rx={rx + 4} fill="none" stroke={PERSON} strokeWidth={1.5} /> : null}
      <NodeRect b={b} rx={rx} lit={lit} base={id === "decide" ? PERSON : isLive ? LINE : null} dashed={isLive} />
      {Icon ? (
        <>
          <Icon x={b.x + 15} y={cy} c={lit ? SOL.base3 : id === "decide" ? PERSON : SOL.base1} />
          <text x={b.x + 27} y={cy + 4.5} fontSize={LABEL} fontWeight={700} fill={lit ? SOL.base3 : INK2}>{STEP_LABEL[id]}</text>
        </>
      ) : (
        <text x={b.x + b.w / 2} y={cy + 4.5} textAnchor="middle" fontSize={LABEL} fontWeight={700} fill={lit ? SOL.base3 : LINE}>Live</text>
      )}
    </g>
  );
}

function Count({ at: p, n, label, c, size = SMALL }: { at: TextAt; n: number; label?: string; c: string; size?: number }) {
  return (
    <text x={p.x} y={p.y} textAnchor={p.anchor ?? "start"} fontSize={size} fill={c}>
      <tspan key={n} className="flx-hero-tick" fontWeight={700}>{fmt(n)}</tspan>
      {label ? ` ${label}` : null}
    </text>
  );
}

function Over({ floor, svgRef, live, visible }: { floor: Floor; svgRef: React.RefObject<SVGSVGElement | null>; live: boolean; visible: boolean }) {
  const plan = floor.plan;
  // Clock time on the SVG's own timeline. It starts at L + T0 (the still
  // frame), so every token has begun and the first frame matches the snapshot.
  const [now, setNow] = useState({ t: L + T0, n: 0 });
  const started = useRef(false);
  useWatchEffect(() => {
    const svg = svgRef.current;
    if (!svg || !live) return;
    if (!started.current) {
      started.current = true;
      svg.setCurrentTime(L + T0);
    }
    if (!visible) {
      svg.pauseAnimations();
      return;
    }
    svg.unpauseAnimations();
    const t = svg.getCurrentTime();
    const id = setTimeout(() => setNow((p) => ({ t: svg.getCurrentTime(), n: p.n + 1 })), untilNextChange(floor, t) * 1000 + 25);
    return () => clearTimeout(id);
  }, [now, live, visible]);

  const t = now.t;
  const z = zonesAt(floor, t);
  const ev = (e: string) => countEvents(floor, e, L + T0, t);
  const held = plan.line.slots.map((_, k) => (z.get(`slot:${k}`) ?? 0) > 0);
  const running = held.filter(Boolean).length;
  const watching = BASE.watching + (z.get("watch") ?? 0);
  const session = (z.get("n:session") ?? 0) > 0;
  const { watch, clean, session: sb, triage, labels } = plan;

  return (
    <g>
      <g className="flx-rise" style={at(0.05)}>
        <text x={plan.signalsToday.num.x} y={plan.signalsToday.num.y} fontSize={plan.signalsToday.size} fontWeight={700} fill={SOL.base3} letterSpacing={-0.5}>
          <tspan key={ev("signal")} className="flx-hero-tick">{fmt(SIGNALS_BASE + ev("signal"))}</tspan>
        </text>
        <Txt at={plan.signalsToday.label}>signals today</Txt>
      </g>
      {SOURCES.map((s, i) =>
        s.state === "flowing" ? (
          <g key={s.name} className="flx-fade" style={at(0.3)}>
            <Count at={plan.sources[i].status} n={(s.base ?? 0) + ev(`src:${i}`)} c={SOL.base1} />
          </g>
        ) : null,
      )}

      {triage.rows.map((r, i) => (
        <g key={i} className="flx-fade" style={at(0.5)}>
          {z.get(`bar:${i}`) ? <rect className="flx-hero-hit" {...xywh(r.box)} rx={3.5} fill="none" stroke={LINE} strokeWidth={1.3} /> : null}
          <Count at={r.count} n={PROBLEMS[i].base + ev(`bar:${i}`)} c={INK2} />
        </g>
      ))}
      {z.get("queue") ? <rect className="flx-hero-hit" {...xywh(triage.queueHit)} rx={4} fill="none" stroke={LINE} strokeWidth={1.3} /> : null}

      <Count at={plan.line.count} n={running} label="running" c={LINE} />
      {plan.line.slots.map((b, k) =>
        held[k] ? null : (
          <text key={k} x={b.x + b.w - 8} y={b.y + b.h / 2 + 4} textAnchor="end" fontSize={SMALL} fill={SOL.base01} className="flx-fade" style={at(0.8)}>free</text>
        ),
      )}

      <g className="flx-rise" style={at(0.55)}>
        <NodeRect b={sb.box} rx={9} lit={session ? PERSON : null} base={PERSON} />
        <rect x={sb.box.x} y={sb.box.y + 8} width={3} height={sb.box.h - 16} rx={1.5} fill={PERSON} />
        <PersonGlyph x={sb.glyph[0]} y={sb.glyph[1]} c={session ? SOL.base3 : PERSON} />
        <Txt at={sb.title} weight={600} fill={INK2}>A person&apos;s session</Txt>
        <Txt at={sb.sub}>Ships through a flow</Txt>
      </g>

      {STEP_IDS.map((id, i) => (
        <Step key={id} id={id} b={plan.steps[id]} occ={occupant(z, id)} wait={id === "decide" && (z.get("decide") ?? 0) > 0} delay={0.8 + i * 0.08} />
      ))}

      <g className="flx-rise" style={at(1.3)}>
        <NodeRect b={watch.box} rx={9} lit={(z.get("watch") ?? 0) > 0 ? LINE : null} base={LINE} />
        <Txt at={watch.title} size={LABEL} weight={700} fill={INK2}>Watch</Txt>
        <Txt at={watch.days}>7 days</Txt>
        <Count at={watch.count} n={watching} label="watching" c={SOL.base1} />
        <rect {...xywh(clean)} rx={clean.h / 2} fill={NODE_FILL} />
        <rect
          className="flx-hero-step"
          {...xywh(clean)}
          rx={clean.h / 2}
          fill={GOOD}
          fillOpacity={z.get("clean") ? 0.3 : 0.08}
          stroke={GOOD}
          strokeOpacity={z.get("clean") ? 1 : 0.7}
        />
        <text x={clean.x + clean.w / 2} y={clean.y + clean.h / 2 + 4.3} textAnchor="middle" fontSize={SMALL} fontWeight={600} fill={GOOD}>Closed clean</text>
      </g>

      <g className="flx-fade" style={at(1.3)}>
        <Count at={labels.onPerson} n={BASE.onPerson + (z.get("decide") ?? 0)} label="on a person" c={PERSON} />
        <Count at={labels.liveToday} n={BASE.live + ev("live")} label="live today" c={LINE} />
      </g>
    </g>
  );
}

// ---------- the reprise at the end of the page ----------
/**
 * The floor again, slim: changes moving along the path and the story's
 * regression riding the return arc into Signals. `title` and `children`
 * (the install CTA) sit beside it.
 */
export function HeroReprise({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const still = useStill();
  const visible = useNearViewport(ref, "0px", { latch: false });
  const wide = useRef<SVGSVGElement | null>(null);
  const narrow = useRef<SVGSVGElement | null>(null);
  const live = playing && !still;
  useWatchEffect(() => {
    for (const svg of [wide.current, narrow.current]) {
      if (!svg) continue;
      if (live && visible) svg.unpauseAnimations();
      else svg.pauseAnimations();
    }
  }, [live, visible]);
  return (
    <section className="flx-hero relative overflow-hidden flx-floor-grid" style={{ backgroundColor: FLOOR }}>
      <div ref={ref} className="relative max-w-7xl mx-auto px-5 sm:px-8 py-12 sm:py-16" data-play={playing ? "" : undefined}>
        <div className="flx-hero-fig">
          <RepriseStrip svgRef={wide} live={live} narrow={false} className="hidden xl:block" />
          <RepriseStrip svgRef={narrow} live={live} narrow className="xl:hidden mx-auto max-w-[440px]" />
        </div>
        <div className="mt-10 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 items-center">
          <div>
            <h2 className="font-mono font-bold text-[28px] sm:text-[38px] leading-[1.1] tracking-[-0.035em] [text-wrap:balance]" style={{ color: SOL.base3 }}>{title}</h2>
            <div className="mt-6 flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono">
              <span className="text-[34px] font-bold tracking-[-0.03em]" style={{ color: SOL.base3 }}>8 of 17</span>
              <span className="text-[14px]" style={{ color: SOL.base1 }}>roles merge without a person</span>
            </div>
            <div className="mt-2 font-mono text-[13px]" style={{ color: SOL.base0 }}>
              <span style={{ color: BAD_TEXT }}>{CAUSE.sha}</span> regretted on {ROLE.name}&apos;s record
            </div>
          </div>
          {children ? <div>{children}</div> : null}
        </div>
      </div>
    </section>
  );
}

const REPRISE_L = 9;
const REPRISE_NODES = ["Signals", "Triage", "Build", "Check", "Review", "Decide", "Land", "Deploy", "Live", "Watch"];

function RepriseStrip({ svgRef, live, narrow, className }: { svgRef: React.RefObject<SVGSVGElement | null>; live: boolean; narrow: boolean; className: string }) {
  // Wide: every station on one line. Narrow: Signals, the path folded to a
  // dotted run, Live and Watch, so the labels stay full size on a phone.
  const W = narrow ? 340 : 1216;
  const H = narrow ? 112 : 124;
  const y = 34;
  const names = narrow ? ["Signals", "Live", "Watch"] : REPRISE_NODES;
  const xs = narrow ? [40, 200, 292] : REPRISE_NODES.map((_, i) => 54 + i * 123);
  const nodeW = narrow ? 76 : 92;
  const last = xs[xs.length - 1];
  const arcY = narrow ? 84 : 92;
  const back = `M${last} ${y + 15} V${arcY - 8} Q${last} ${arcY} ${last - 8} ${arcY} H${xs[0] + 8} Q${xs[0]} ${arcY} ${xs[0]} ${arcY - 8} V${y + 15}`;
  const forward = `M${xs[0]} ${y} H${last}`;
  // Where the two forward tokens sit in the still frame: between stations, never under one.
  const parked = narrow ? [(xs[0] + xs[1]) / 2 - 22, (xs[0] + xs[1]) / 2 + 22] : [(xs[3] + xs[4]) / 2, (xs[6] + xs[7]) / 2];
  const isPerson = (n: string) => n === "Decide";
  const isLive = (n: string) => n === "Live";
  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className={`block w-full h-auto font-mono ${className}`} role="img" aria-label={`The same floor: changes move from Signals to Watch, and ${CAUSE.sha}'s regression returns to Signals.`}>
      <Defs />
      <path d={forward} stroke="rgba(42,161,152,.55)" strokeWidth={1.25} fill="none" strokeDasharray={narrow ? "2 5" : undefined} />
      <path d={back} stroke={BAD} strokeOpacity={0.6} strokeWidth={1.25} fill="none" strokeDasharray="4 5" />
      <text x={(xs[0] + last) / 2} y={arcY + 18} textAnchor="middle" fontSize={SMALL} fill={INK2} fontWeight={600}>
        <tspan fill={BAD_TEXT}>↺</tspan> Back to signals
      </text>
      {names.map((n, i) => {
        const b: Box = { x: xs[i] - nodeW / 2, y: y - 15, w: nodeW, h: 30 };
        const c = isPerson(n) ? PERSON : isLive(n) ? LINE : null;
        return (
          <g key={n}>
            <rect {...xywh(b)} rx={isLive(n) ? 15 : 7} fill={NODE_FILL} />
            <rect {...xywh(b)} rx={isLive(n) ? 15 : 7} fill={c ?? "transparent"} fillOpacity={c ? 0.12 : 0} stroke={c ?? NODE_LINE} strokeOpacity={c ? 0.7 : 1} strokeDasharray={isLive(n) ? "4 3" : undefined} />
            <text x={xs[i]} y={y + 4.5} textAnchor="middle" fontSize={LABEL} fontWeight={700} fill={isLive(n) ? LINE : INK2}>{n}</text>
          </g>
        );
      })}
      {[0, 1].map((i) => (
        <g key={i} opacity={live ? 0 : 1} transform={live ? undefined : `translate(${parked[i]} ${y})`}>
          {live ? (
            <>
              <animateMotion dur={`${REPRISE_L}s`} begin={`${i * (REPRISE_L / 2)}s`} repeatCount="indefinite" path={forward} keyPoints="0;1;1" keyTimes="0;0.55;1" calcMode="linear" />
              <animate attributeName="opacity" dur={`${REPRISE_L}s`} begin={`${i * (REPRISE_L / 2)}s`} repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;0.04;0.5;0.55;1" />
            </>
          ) : null}
          <TokenShape kind={i === 0 ? "line" : "person"} />
        </g>
      ))}
      <g opacity={live ? 0 : 1} transform={live ? undefined : `translate(${xs[0] + 140} ${arcY})`}>
        {live ? (
          <>
            <animateMotion dur={`${REPRISE_L}s`} begin="2s" repeatCount="indefinite" path={back} keyPoints="0;1;1" keyTimes="0;0.6;1" calcMode="linear" />
            <animate attributeName="opacity" dur={`${REPRISE_L}s`} begin="2s" repeatCount="indefinite" values="0;1;1;0;0" keyTimes="0;0.04;0.56;0.6;1" />
          </>
        ) : null}
        <TokenShape kind="regress" />
        <text y={-12} textAnchor="middle" fontSize={SMALL} fontWeight={700} fill={BAD_TEXT}>{CAUSE.sha}</text>
      </g>
      {live && names[0] === "Signals" ? (
        <rect x={xs[0] - nodeW / 2 - 4} y={y - 19} width={nodeW + 8} height={38} rx={10} fill="none" stroke={BAD} strokeWidth={1.5} opacity={0}>
          <animate attributeName="opacity" dur={`${REPRISE_L}s`} begin="2s" repeatCount="indefinite" values="0;0;1;0;0" keyTimes="0;0.58;0.62;0.75;1" />
        </rect>
      ) : null}
    </svg>
  );
}
