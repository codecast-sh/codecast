"use client";

import type { ReactNode } from "react";
import { Copy, Code2, Maximize2, Rocket, Puzzle, FileText } from "lucide-react";
import { SOL } from "../../blog/blogChrome";
import { DIM, LINE, MUTED, TEXT, V, at, tint } from "./theme";

/*
 * A mod's fenced block as the app draws it: inside BlockFrame, the frame
 * every rich block wears (a title strip naming the mod and the block type,
 * copy, show source and fullscreen), with the mod's own drawing in the body.
 */

export function BlockFrame({ mod, lang, children, icon }: { mod: string; lang: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-lg border overflow-hidden" style={{ borderColor: tint(V, 28), backgroundColor: "#fffdf6" }}>
      <div className="h-8 px-2.5 flex items-center gap-2 border-b text-[11px]" style={{ borderColor: tint(V, 18), backgroundColor: tint(V, 7), color: MUTED }}>
        <span className="w-5 h-5 rounded grid place-items-center" style={{ backgroundColor: tint(V, 14), color: V }}>{icon ?? <Puzzle className="w-3 h-3" />}</span>
        <span className="font-medium" style={{ color: TEXT }}>{mod}</span>
        <span style={{ color: DIM }}>·</span>
        <span className="font-mono" style={{ color: DIM }}>{lang}</span>
        <span className="ml-auto flex items-center gap-2.5" style={{ color: DIM }}>
          <Copy className="w-3 h-3" /><Code2 className="w-3 h-3" /><Maximize2 className="w-3 h-3" />
        </span>
      </div>
      <div className="p-3">{children}</div>
    </div>
  );
}

/** A mod element `Stat`: a value over a label, toned. */
export function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-md px-2.5 py-2" style={{ backgroundColor: tone ? tint(tone, 8) : "rgba(238,232,213,.55)" }}>
      <div className="font-mono text-[17px] font-semibold leading-none tabular-nums" style={{ color: tone ?? TEXT }}>{value}</div>
      <div className="mt-1 text-[10.5px] truncate" style={{ color: MUTED }}>{label}{sub && <span style={{ color: DIM }}> · {sub}</span>}</div>
    </div>
  );
}

/** A small line chart that draws itself in once. */
export function Spark({ points, color, d = 0, height = 34, marker }: { points: number[]; color: string; d?: number; height?: number; marker?: number }) {
  const w = 240, h = height, max = Math.max(...points), min = Math.min(...points);
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 3 - ((p - min) / (max - min || 1)) * (h - 6)] as const);
  const path = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="md-in w-full block" preserveAspectRatio="none" aria-hidden style={at(d, { height })}>
      <path d={`${path} L${w},${h} L0,${h} Z`} fill={tint(color, 10)} />
      {marker !== undefined && <line x1={(marker / (points.length - 1)) * w} x2={(marker / (points.length - 1)) * w} y1={0} y2={h} stroke={tint(SOL.base1, 70)} strokeDasharray="2 3" />}
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}


const ERRORS = [0.1, 0.1, 0.12, 0.1, 4.8, 6.1, 5.9, 6.3, 2.2, 0.6, 0.4, 0.3, 0.3, 0.2];

/** The rollout block a release mod draws: the agent wrote three fields, the mod draws live numbers and the buttons that act on them. */
export function RolloutBlock({ d = 0 }: { d?: number }) {
  return (
    <BlockFrame mod="Releases" lang="rollout" icon={<Rocket className="w-3 h-3" />}>
      <div className="flex items-baseline gap-2 mb-2.5">
        <span className="text-[13px] font-semibold" style={{ color: TEXT }}>payments-api</span>
        <span className="text-[11.5px] font-mono" style={{ color: MUTED }}>v412 canary</span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] font-medium" style={{ color: SOL.green }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SOL.green }} />holding
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="traffic on v412" value="25%" />
        <Stat label="errors" sub="v412" value="0.2%" tone={SOL.green} />
        <Stat label="errors" sub="v413" value="6.1%" tone={SOL.red} />
      </div>
      <div className="mt-2.5">
        <div className="flex justify-between text-[10px] font-mono mb-1" style={{ color: DIM }}><span>error rate, last 40m</span><span>canary at 2:31</span></div>
        <Spark points={ERRORS} color={SOL.red} d={d} marker={8} />
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <span className="rounded-md px-2.5 py-1 text-[11.5px] font-medium" style={{ backgroundColor: V, color: SOL.base3 }}>Promote to 50%</span>
        <span className="rounded-md px-2.5 py-1 text-[11.5px] font-medium border" style={{ borderColor: LINE, color: TEXT }}>Roll back</span>
        <span className="rounded-md px-2.5 py-1 text-[11.5px]" style={{ color: MUTED }}>Open deploy</span>
      </div>
    </BlockFrame>
  );
}

/** A finding block a bug tracking mod draws, with the button that files it as an object. */
export function FindingBlock({ filed }: { filed?: ReactNode }) {
  return (
    <BlockFrame mod="Incident desk" lang="finding" icon={<FileText className="w-3 h-3" />}>
      <div className="text-[13px] font-semibold" style={{ color: TEXT }}>Refund webhooks retry with no cap</div>
      <p className="mt-1 text-[12px] leading-relaxed" style={{ color: MUTED }}>Same pattern as the payments worker: a provider outage multiplies into a retry storm. Not fixing it in this session.</p>
      <div className="mt-2.5 flex items-center gap-2 flex-wrap">
        <span className="rounded-full px-2 py-[1px] text-[10.5px] font-medium" style={{ color: SOL.orange, backgroundColor: tint(SOL.orange, 12) }}>sev-3</span>
        <span className="text-[11px] font-mono" style={{ color: DIM }}>refunds-worker</span>
        <span className="ml-auto">{filed}</span>
      </div>
    </BlockFrame>
  );
}
