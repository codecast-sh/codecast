"use client";

import type { ReactNode } from "react";
import { SOL } from "../blogChrome";
import { FigureStyles, PanelHead, Stage, t } from "../figureKit";

/**
 * Illustrations for "Fewer, bigger jumps", built on the shared figure kit
 * (../figureKit.tsx): each figure plays once when it scrolls into view.
 */

export { FigureStyles };

// ─── Figure 1: hops vs a leap ──────────────────────────────────────────────

type Pt = [number, number];
const START: Pt = [44, 246];
const GOAL: Pt = [336, 76];

const f1 = (n: number) => n.toFixed(1);

/** A jump as a quadratic arc, lifted `lift` above the chord's midpoint. */
function control(p0: Pt, p1: Pt, lift: number): Pt {
  return [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2 - lift];
}

/** A short hop bows sideways off its own chord, so a steep one still arcs. */
function bow(p0: Pt, p1: Pt, lift: number): Pt {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len = Math.hypot(dx, dy) || 1;
  const s = dx >= 0 ? 1 : -1;
  return [(p0[0] + p1[0]) / 2 + (s * dy * lift) / len, (p0[1] + p1[1]) / 2 - (s * dx * lift) / len];
}

function arc(p0: Pt, p1: Pt, lift: number, c: Pt = control(p0, p1, lift)): string {
  return `M${f1(p0[0])} ${f1(p0[1])}Q${f1(c[0])} ${f1(c[1])} ${f1(p1[0])} ${f1(p1[1])}`;
}

/** The same arc wound into `loops` coils of radius `r`: the agent iterating
 *  in flight. The offset is zero at both ends, so it still lands exactly. */
function coil(p0: Pt, p1: Pt, lift: number, loops: number, r: number): string {
  if (loops === 0) return arc(p0, p1, lift);
  const c = control(p0, p1, lift);
  const steps = loops * 36 + 40;
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const bx = (1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * c[0] + u ** 2 * p1[0];
    const by = (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * c[1] + u ** 2 * p1[1];
    let tx = 2 * (1 - u) * (c[0] - p0[0]) + 2 * u * (p1[0] - c[0]);
    let ty = 2 * (1 - u) * (c[1] - p0[1]) + 2 * u * (p1[1] - c[1]);
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const th = u * loops * 2 * Math.PI;
    const a = r * Math.sin(th);
    const b = r * (1 - Math.cos(th));
    d += `${i ? "L" : "M"}${f1(bx + a * tx + b * ty)} ${f1(by + a * ty - b * tx)}`;
  }
  return d;
}

const HOP_COUNT = 16;
const HOP_STEP = 0.36;
const HOPS = (() => {
  const dx = GOAL[0] - START[0];
  const dy = GOAL[1] - START[1];
  const len = Math.hypot(dx, dy);
  const perp: Pt = [-dy / len, dx / len];
  const pts: Pt[] = [START];
  for (let i = 1; i <= HOP_COUNT; i++) {
    const f = i / HOP_COUNT;
    const w = 26 * Math.sin(i * 1.9 + 0.4) * (1 - f) ** 0.7;
    pts.push([START[0] + dx * f + perp[0] * w, START[1] + dy * f + perp[1] * w]);
  }
  return pts.slice(1).map((to, i) => ({ d: arc(pts[i], to, 16, bow(pts[i], to, 16)), to, at: 0.3 + i * HOP_STEP, dur: 0.3 }));
})();

const LEAP_SPEC: { to: Pt; lift: number; loops: number; r: number; dur: number }[] = [
  { to: [262, 128], lift: 205, loops: 21, r: 6.5, dur: 2.8 },
  { to: [352, 64], lift: 40, loops: 3, r: 3.2, dur: 0.9 },
  { to: [329, 82], lift: 14, loops: 0, r: 0, dur: 0.55 },
  { to: GOAL, lift: 7, loops: 0, r: 0, dur: 0.4 },
];
const LEAP = (() => {
  let from = START;
  let at = 0.3;
  return LEAP_SPEC.map((j) => {
    const out = { d: coil(from, j.to, j.lift, j.loops, j.r), to: j.to, at, dur: j.dur };
    from = j.to;
    at += j.dur + 0.25;
    return out;
  });
})();

function Field({ jumps, color, children }: { jumps: { d: string; to: Pt; at: number; dur: number }[]; color: string; children?: ReactNode }) {
  const done = jumps[jumps.length - 1].at + jumps[jumps.length - 1].dur;
  return (
    <svg viewBox="0 0 400 300" className="w-full block font-mono" role="img">
      <defs>
        <pattern id="bj-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="0.9" fill={SOL.base2} />
        </pattern>
      </defs>
      <rect width="400" height="300" fill="url(#bj-grid)" />

      {[34, 20, 9].map((r, i) => (
        <circle key={r} cx={GOAL[0]} cy={GOAL[1]} r={r} fill={i === 2 ? `${SOL.red}22` : "none"} stroke={SOL.red} strokeOpacity={0.25 + i * 0.25} strokeDasharray={i === 0 ? "3 4" : undefined} />
      ))}
      <circle cx={GOAL[0]} cy={GOAL[1]} r={2.5} fill={SOL.red} />
      <text x={GOAL[0]} y={GOAL[1] - 44} textAnchor="middle" fontSize="10.5" fill={SOL.red}>what you meant</text>

      <circle cx={START[0]} cy={START[1]} r={4} fill={SOL.base01} />
      <text x={START[0]} y={START[1] + 20} textAnchor="middle" fontSize="10.5" fill={SOL.base01}>start</text>

      {jumps.map((j, i) => (
        <g key={i}>
          <path d={j.d} pathLength={1} fill="none" stroke={color} strokeWidth={i === 0 && jumps.length < 8 ? 1.4 : 1.6} strokeLinecap="round" strokeLinejoin="round" className="bj-draw" style={t(j.at, j.dur)} />
          <circle cx={j.to[0]} cy={j.to[1]} r={3.2} fill={SOL.base3} stroke={color} strokeWidth={1.6} className="bj-pop" style={t(j.at + j.dur)} />
        </g>
      ))}

      {children}

      <text x={16} y={286} fontSize="10" fill={SOL.base1}>your turns</text>
      {Array.from({ length: HOP_COUNT }, (_, i) => (
        <rect key={i} x={80 + i * 13} y={278} width={9} height={9} rx={2.5} fill="none" stroke={SOL.base2} />
      ))}
      {jumps.map((j, i) => (
        <rect key={i} x={80 + i * 13} y={278} width={9} height={9} rx={2.5} fill={color} className="bj-pop" style={t(j.at + j.dur)} />
      ))}
      <text x={80 + HOP_COUNT * 13 + 6} y={286.5} fontSize="11" fontWeight={700} fill={color} className="bj-fade" style={t(done + 0.1)}>
        {jumps.length}
      </text>
    </svg>
  );
}

export function JumpsFigure() {
  const [j1] = LEAP;
  return (
    <Stage>
      <div className="grid md:grid-cols-2">
        <div className="border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
          <PanelHead title="Small hops" sub="Each prompt asks for one safe step. You read, judge and re-prompt every time." color={SOL.blue} />
          <Field jumps={HOPS} color={SOL.blue} />
        </div>
        <div>
          <PanelHead title="One leap, then corrections" sub="One prompt asks for the whole thing. The agent iterates on its own and lands near; you steer the rest." color={SOL.orange} />
          <Field jumps={LEAP} color={SOL.orange}>
            <text x={70} y={20} fontSize="10" fill={SOL.orange} className="bj-fade" style={t(j1.at + 0.5)}>
              <tspan x={70}>the agent loops on its own:</tspan>
              <tspan x={70} dy={13}>plan, build, test, look, fix</tspan>
            </text>
            <text x={256} y={150} fontSize="10" textAnchor="end" fill={SOL.base01} className="bj-fade" style={t(j1.at + j1.dur + 0.1)}>
              <tspan x={256}>lands close,</tspan>
              <tspan x={256} dy={13}>wrong in ways you can see</tspan>
            </text>
            <text x={384} y={128} fontSize="10" textAnchor="end" fill={SOL.base01} className="bj-fade" style={t(LEAP[2].at)}>
              <tspan x={384}>corrections</tspan>
              <tspan x={384} dy={13}>shrink</tspan>
            </text>
          </Field>
        </div>
      </div>
    </Stage>
  );
}

// ─── Figure 2: a real session's shape ──────────────────────────────────────

/** Message indexes from two codecast sessions, read on 2026-10-04. A prompt
 *  is a message the human typed with real direction in it; a nudge is a bare
 *  "continue" after a pause. */
const TRACES = [
  {
    name: "Changes page",
    total: 1187,
    prompts: [
      { at: 1, label: "the leap", quote: ["“a high level natural language beautifully", "rendered timeline of everything that is changing…”"] },
      { at: 760, label: "the correction", quote: ["“a single timeline - not one page per day…", "just try to pare it down to the core”"] },
    ],
    nudges: [116, 254, 753, 869, 988, 998],
  },
  {
    name: "Docs audit",
    total: 300,
    prompts: [
      { at: 3, label: "", quote: [] as string[] },
      { at: 277, label: "", quote: [] as string[] },
    ],
    nudges: [] as number[],
    aside: ["“do an audit and update our docs…, add images,", "screenshots, and vector drawings”  then  “remove the stray/leftovers”"],
  },
];

export function TraceFigure() {
  const x0 = 40;
  const w = 680;
  const scale = w / TRACES[0].total;
  const rows = [100, 178];
  const SWEEP = 2.6;
  return (
    <Stage minWidth={660}>
      <svg viewBox="0 0 760 232" className="w-full block font-mono" role="img">
        <defs>
          <pattern id="bj-msgs" width="3" height="14" patternUnits="userSpaceOnUse">
            <rect width="1.2" height="14" fill={SOL.cyan} opacity={0.55} />
          </pattern>
        </defs>
        {TRACES.map((tr, ri) => {
          const y = rows[ri];
          const bw = tr.total * scale;
          const dur = SWEEP * (tr.total / TRACES[0].total);
          const at = ri * 0.4;
          const xOf = (m: number) => x0 + m * scale;
          return (
            <g key={tr.name}>
              <text x={x0} y={y - (ri === 0 ? 76 : 32)} fontSize="11" fontWeight={700} fill={SOL.base02}>
                {tr.name}
                <tspan fontWeight={400} fill={SOL.base1}>{`  ${tr.total.toLocaleString("en-US")} messages`}</tspan>
              </text>
              <rect x={x0} y={y} width={bw} height={14} rx={2} fill={`${SOL.cyan}14`} />
              <rect x={x0} y={y} width={bw} height={14} rx={2} fill="url(#bj-msgs)" className="bj-grow" style={t(at, dur)} />
              {tr.nudges.map((m) => (
                <path key={m} d={`M${f1(xOf(m))} ${y + 19}l-3.5 6h7z`} fill={SOL.base1} className="bj-pop" style={t(at + dur * (m / tr.total))} />
              ))}
              {tr.prompts.map((p, pi) => {
                const x = xOf(p.at);
                const pAt = at + dur * (p.at / tr.total);
                return (
                  <g key={p.at}>
                    {p.label && <line x1={x} x2={x} y1={y - 22} y2={y - 2} stroke={SOL.orange} strokeWidth={1.2} className="bj-fade" style={t(pAt)} />}
                    <rect x={x - 5} y={y + 2} width={10} height={10} rx={1} transform={`rotate(45 ${x} ${y + 7})`} fill={SOL.orange} stroke={SOL.base3} strokeWidth={1.5} className="bj-pop" style={t(pAt)} />
                    {p.label && (
                      <text x={x + (pi === 0 ? -4 : 6)} y={y - 56} fontSize="10.5" fill={SOL.orange} className="bj-fade" style={t(pAt + 0.1)}>
                        <tspan fontWeight={700}>{`msg ${p.at} · ${p.label}`}</tspan>
                        {p.quote.map((line) => (
                          <tspan key={line} x={x + (pi === 0 ? -4 : 6)} dy={13.5} fill={SOL.base01}>{line}</tspan>
                        ))}
                      </text>
                    )}
                  </g>
                );
              })}
              {"aside" in tr && tr.aside && (
                <text x={x0 + bw + 18} y={y + 2} fontSize="10.5" fill={SOL.base01} className="bj-fade" style={t(at + dur)}>
                  <tspan x={x0 + bw + 18}>{tr.aside[0]}</tspan>
                  <tspan x={x0 + bw + 18} dy={14}>{tr.aside[1]}</tspan>
                </text>
              )}
            </g>
          );
        })}
        <g fontSize="10" fill={SOL.base1}>
          <rect x={x0} y={214} width={9} height={9} rx={1} transform={`rotate(45 ${x0 + 4.5} 218.5)`} fill={SOL.orange} />
          <text x={x0 + 16} y={222}>a prompt with direction in it</text>
          <path d={`M${x0 + 222} 214l-3.5 6h7z`} fill={SOL.base1} />
          <text x={x0 + 232} y={222}>a bare “continue” after a pause</text>
          <rect x={x0 + 462} y={213} width={18} height={9} fill="url(#bj-msgs)" />
          <text x={x0 + 486} y={222}>agent messages</text>
        </g>
      </svg>
    </Stage>
  );
}

// ─── Figure 3: one person, many sessions ───────────────────────────────────

type Span = [number, number];
type Lane = { name: string; you: Span[]; agent: Span[] };

const HOP_LANE: Lane = {
  name: "",
  you: Array.from({ length: 20 }, (_, i): Span => [i * 5, i * 5 + 2]),
  agent: Array.from({ length: 20 }, (_, i): Span => [i * 5 + 2, i * 5 + 5]),
};

const LEAP_LANES: Lane[] = [
  { name: "session A", you: [[0, 5], [32, 38], [63, 67], [88, 90]], agent: [[5, 32], [38, 60], [67, 82]] },
  { name: "session B", you: [[5, 10], [38, 44], [70, 74], [90, 92]], agent: [[10, 38], [44, 70], [74, 88]] },
  { name: "session C", you: [[10, 15], [45, 51], [75, 79], [92, 94]], agent: [[15, 45], [51, 75], [79, 90]] },
  { name: "session D", you: [[15, 20], [51, 57], [80, 83], [94, 96]], agent: [[20, 50], [57, 80], [83, 92]] },
  { name: "session E", you: [[20, 25], [57, 63], [85, 88], [96, 98]], agent: [[25, 55], [63, 85], [88, 96]] },
];

const busyShare = (spans: Span[], end: number) => Math.round((100 * spans.reduce((s, [a, b]) => s + b - a, 0)) / end);

export function AttentionFigure() {
  const X0 = 112;
  const PX = 6;
  const SEC = 0.055; // seconds of animation per minute of schedule
  const x = (m: number) => X0 + m * PX;
  const H = 13;
  const bar = (key: string, [a, b]: Span, y: number, fill: string, opacity = 1) => (
    <rect key={key} x={x(a)} y={y} width={(b - a) * PX - 0.8} height={H} rx={2.5} fill={fill} opacity={opacity} className="bj-grow" style={t(a * SEC, (b - a) * SEC)} />
  );
  const leapYou = LEAP_LANES.flatMap((l, li) => l.you.map(([a, b]) => ({ a, b, li }))).sort((p, q) => p.a - q.a);
  const laneY = (li: number) => 128 + li * 24;
  const youRow = laneY(LEAP_LANES.length) + 6;
  const hopBusy = busyShare(HOP_LANE.you, 100);
  const leapBusy = busyShare(leapYou.map(({ a, b }): Span => [a, b]), 100);

  return (
    <Stage minWidth={700}>
      <svg viewBox="0 0 830 330" className="w-full block font-mono" role="img">
        <defs>
          <pattern id="bj-wait" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="2" height="6" fill={SOL.base1} opacity={0.45} />
          </pattern>
        </defs>

        {[0, 20, 40, 60, 80, 100].map((m) => (
          <g key={m}>
            <line x1={x(m)} x2={x(m)} y1={30} y2={youRow + H + 6} stroke={SOL.base2} />
            <text x={x(m)} y={youRow + H + 22} fontSize="10" textAnchor="middle" fill={SOL.base1}>{`${m} min`}</text>
          </g>
        ))}

        <text x={16} y={22} fontSize="11.5" fontWeight={700} fill={SOL.base02}>Small hops, one session</text>
        <text x={16} y={46} fontSize="10.5" fill={SOL.base01}>agent</text>
        <text x={16} y={68} fontSize="10.5" fill={SOL.base01}>you</text>
        {HOP_LANE.agent.map((s, i) => bar(`ha${i}`, s, 36, SOL.cyan, 0.75))}
        {HOP_LANE.agent.map((s, i) => bar(`hw${i}`, s, 58, "url(#bj-wait)"))}
        {HOP_LANE.you.map((s, i) => bar(`hy${i}`, s, 58, SOL.blue))}
        <text x={x(100) + 12} y={68} fontSize="10.5" fill={SOL.blue} className="bj-fade" style={t(100 * SEC)}>
          <tspan fontWeight={700}>{`${hopBusy}% busy`}</tspan>
          <tspan x={x(100) + 12} dy={13} fill={SOL.base1}>the rest waiting</tspan>
        </text>

        <text x={16} y={108} fontSize="11.5" fontWeight={700} fill={SOL.base02}>Big leaps, five sessions</text>
        {LEAP_LANES.map((l, li) => {
          const y = laneY(li);
          const last = l.you[l.you.length - 1];
          return (
            <g key={l.name}>
              <text x={16} y={y + 10} fontSize="10.5" fill={SOL.base01}>{l.name}</text>
              {l.agent.map((s, i) => bar(`la${li}${i}`, s, y, SOL.cyan, 0.75))}
              {l.you.map((s, i) => bar(`ly${li}${i}`, s, y, SOL.orange))}
              <path d={`M${x(last[1]) + 6} ${y + 7}l3 3 6-7`} fill="none" stroke={SOL.green} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="bj-pop" style={t(last[1] * SEC + 0.1)} />
            </g>
          );
        })}
        <text x={16} y={youRow + 10} fontSize="10.5" fill={SOL.base01}>you</text>
        {leapYou.map((p, i) => bar(`lyou${i}`, [p.a, p.b], youRow, SOL.orange))}
        <text x={x(100) + 12} y={youRow + 10} fontSize="10.5" fill={SOL.orange} className="bj-fade" style={t(100 * SEC)}>
          <tspan fontWeight={700}>{`${leapBusy}% busy`}</tspan>
          <tspan x={x(100) + 12} dy={13} fill={SOL.base1}>five features</tspan>
        </text>

        <line x1={X0} x2={X0} y1={28} y2={youRow + H + 4} stroke={SOL.base02} strokeWidth={1.2} className="bj-sweep" style={t(0, 100 * SEC, { "--to": `${100 * PX}px` })} />
      </svg>
    </Stage>
  );
}

// ─── Figure 4: anatomy of a leap prompt ────────────────────────────────────

const HOP_PROMPT = "Add a date column to the changes table.";

const LEAP_PROMPT: { tag: string; color: string; text: string }[] = [
  {
    tag: "the destination",
    color: SOL.blue,
    text: "Build a changes page: one timeline of everything the team is shipping, drawn from sessions and commits, that a person can understand at a glance and zoom into.",
  },
  {
    tag: "how to know it's done",
    color: SOL.green,
    text: "Done means it runs on real data, you have opened it in the browser and screenshotted every zoom level, the grouping logic has tests, and you have reread your own diff once.",
  },
  {
    tag: "spend compute",
    color: SOL.magenta,
    text: "Plan first. Fan the independent parts out to subagents. Once it works, keep iterating on the copy and the polish until you would show it to a customer.",
  },
  {
    tag: "the only interrupt",
    color: SOL.red,
    text: "Work on your own until then. Stop only for a choice that changes what the product does.",
  },
];

export function PromptFigure() {
  return (
    <div className="grid md:grid-cols-[1fr_1.9fr]">
      <div className="p-5 border-b md:border-b-0 md:border-r" style={{ borderColor: SOL.base2 }}>
        <div className="font-mono text-xs font-bold mb-3 flex items-center gap-2" style={{ color: SOL.base01 }}>
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: SOL.blue }} />
          a hop
        </div>
        <p className="text-[15px] leading-7" style={{ color: SOL.base02 }}>{HOP_PROMPT}</p>
        <p className="mt-4 text-[13px] leading-6" style={{ color: SOL.base1 }}>
          Fine on its own. The trouble is the next nineteen like it, each waiting on you.
        </p>
      </div>
      <div className="p-5">
        <div className="font-mono text-xs font-bold mb-3 flex items-center gap-2" style={{ color: SOL.base01 }}>
          <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: SOL.orange }} />
          a leap
        </div>
        <div className="space-y-3">
          {LEAP_PROMPT.map((c) => (
            <div key={c.tag} className="border-l-[3px] pl-3" style={{ borderColor: c.color }}>
              <div className="font-mono text-[12px] font-bold mb-0.5" style={{ color: c.color }}>{c.tag}</div>
              <p className="text-[15px] leading-7" style={{ color: SOL.base02 }}>{c.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
