"use client";

import { useState, type CSSProperties } from "react";
import { SOL } from "../../blog/blogChrome";
import { LANES, NIGHT_COUNTS, NIGHT_END, NIGHT_LOG, NIGHT_START, clock, pct, type Firing, type Lane } from "./nightData";
import { NIGHT_SECONDS, atPct } from "./motion";
import {  } from "./ui";
import { Whole } from "../kit";

const AXIS = [18, 21, 24, 27, 30, 33].map((h) => h * 60);

const delay = (s: number): CSSProperties => ({ animationDelay: `${s.toFixed(2)}s` });

/** Tooltips near the edges open inward so they never leave the card. */
function tipShift(p: number): string {
  if (p < 18) return "-12%";
  if (p > 70) return "-88%";
  return "-50%";
}

function Tip({ f, lane }: { f: Firing; lane: Lane }) {
  const p = pct(f.t);
  return (
    <span
      className="tg-tip absolute bottom-full mb-2 w-60 rounded-lg px-3 py-2 text-left text-[11.5px] leading-snug shadow-lg z-30"
      style={{ left: "50%", ["--tx" as string]: tipShift(p), backgroundColor: SOL.base03, color: SOL.base2 } as CSSProperties}
    >
      <span className="font-mono" style={{ color: lane.color }}>{lane.id}</span>
      <span className="font-mono" style={{ color: SOL.base0 }}> {clock(f.t)}{f.until ? `–${clock(f.until)}` : ""}</span>
      <span className="block mt-1">{f.note}</span>
    </span>
  );
}

function Marker({ f, lane }: { f: Firing; lane: Lane }) {
  const p = pct(f.t);
  const at = atPct(p);
  const label = `${lane.id} at ${clock(f.t)}: ${f.note}`;

  if (f.kind === "skip") {
    return (
      <span tabIndex={0} aria-label={label} className="tg-marker tg-pop absolute top-1/2 h-[9px] w-[9px] rounded-full outline-none" style={{ left: `${p}%`, transform: "translate(-50%, -50%)", border: `1.5px solid ${SOL.base1}`, backgroundColor: SOL.base3, ...delay(at) }}>
        <Tip f={f} lane={lane} />
      </span>
    );
  }

  if (f.kind === "park") {
    const end = pct(f.until!);
    const grow = (NIGHT_SECONDS * (end - p)) / 100;
    return (
      <>
        <span
          className="tg-grow absolute top-1/2 h-[10px] -translate-y-1/2 rounded-full"
          style={{
            left: `${p}%`, width: `${end - p}%`, ["--grow" as string]: `${grow}s`, ...delay(at),
            backgroundImage: `repeating-linear-gradient(135deg, color-mix(in srgb, ${lane.color} 55%, transparent) 0 4px, transparent 4px 8px)`,
            border: `1px solid color-mix(in srgb, ${lane.color} 45%, transparent)`,
          } as CSSProperties}
        />
        <span tabIndex={0} aria-label={label} className="tg-marker tg-pop absolute top-1/2 h-3 w-3 rounded-full outline-none" style={{ left: `${p}%`, transform: "translate(-50%, -50%)", backgroundColor: SOL.base3, border: `2px solid ${lane.color}`, ...delay(at) }}>
          <Tip f={f} lane={lane} />
        </span>
        <span className="tg-pop absolute top-1/2 h-3 w-3 rounded-full" style={{ left: `${end}%`, transform: "translate(-50%, -50%)", backgroundColor: lane.color, ...delay(atPct(end)) }} />
        <span className="tg-fade absolute top-[calc(50%+8px)] whitespace-nowrap font-mono text-[9.5px] leading-none hidden sm:block" style={{ left: `${(p + end) / 2}%`, transform: "translateX(-50%)", color: lane.color, ...delay(at + 0.2) }}>
          parked at limit
        </span>
      </>
    );
  }

  const attention = f.kind === "attention";
  return (
    <span tabIndex={0} aria-label={label} className="tg-marker tg-pop absolute top-1/2 rounded-full outline-none" style={{ left: `${p}%`, width: attention ? 14 : 11, height: attention ? 14 : 11, transform: "translate(-50%, -50%)", backgroundColor: lane.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${lane.color} 18%, transparent)`, ...delay(at) }}>
      <span className="tg-ring absolute left-1/2 top-1/2 h-full w-full rounded-full" style={{ border: `2px solid ${lane.color}`, ...delay(at) }} />
      {attention && <span className="tg-ring absolute left-1/2 top-1/2 h-full w-full rounded-full" style={{ border: `2px solid ${lane.color}`, ...delay(at + 0.5) }} />}
      <Tip f={f} lane={lane} />
    </span>
  );
}

function LaneRow({ lane, i }: { lane: Lane; i: number }) {
  return (
    <div className="tg-rise" style={delay(0.15 + i * 0.06)}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11.5px] leading-tight">
        <span className="font-semibold" style={{ color: lane.color }}>{lane.id}</span>
        <span className="min-w-0 truncate" style={{ color: SOL.base02 }}>{lane.title}</span>
        <span style={{ color: SOL.base1 }}>{lane.flags}</span>
      </div>
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-1/2 h-px" style={{ backgroundColor: `color-mix(in srgb, ${lane.color} 22%, ${SOL.base2})` }} />
        {lane.firings.map((f) => <Marker key={`${lane.id}-${f.t}`} f={f} lane={lane} />)}
      </div>
    </div>
  );
}

/** The sky over the axis: dusk, the night, then morning. */
function Sky() {
  const midnight = pct(24 * 60);
  return (
    <div className="relative h-8 rounded-md overflow-hidden" style={{ background: `linear-gradient(90deg, ${SOL.base2} 0%, #8a9a8f 9%, ${SOL.base02} 24%, ${SOL.base03} 45%, ${SOL.base03} 62%, ${SOL.base02} 78%, #b9b49c 90%, ${SOL.base3} 100%)` }}>
      {[8, 15, 29, 36, 51, 58, 66, 71].map((x, i) => (
        <span key={x} className="absolute h-[2px] w-[2px] rounded-full" style={{ left: `${x}%`, top: `${20 + ((i * 37) % 55)}%`, backgroundColor: SOL.base2, opacity: 0.55 }} />
      ))}
      <svg className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${midnight}%` }} width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" fill={SOL.base2} />
      </svg>
      <svg className="absolute top-1/2 -translate-y-1/2 right-2" width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="5" fill={SOL.yellow} />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <line key={a} x1="12" y1="2.5" x2="12" y2="5" stroke={SOL.yellow} strokeWidth="2" strokeLinecap="round" transform={`rotate(${a} 12 12)`} />
        ))}
      </svg>
    </div>
  );
}

function Axis() {
  return (
    <div className="relative h-5 font-mono text-[10px]" style={{ color: SOL.base1 }}>
      {AXIS.map((t) => {
        const p = pct(t);
        const edge = p === 0 ? "translateX(0)" : p === 100 ? "translateX(-100%)" : "translateX(-50%)";
        return <span key={t} className="absolute top-1" style={{ left: `${p}%`, transform: edge }}>{clock(t)}</span>;
      })}
    </div>
  );
}

function Log() {
  return (
    <div className="rounded-xl p-4 font-mono text-[11px] leading-[1.55]" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
      <div className="mb-2 flex items-center justify-between" style={{ color: SOL.base01 }}>
        <span>overnight, as it happened</span>
        <span className="tg-blink h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.green }} />
      </div>
      <ol className="gap-x-8 md:columns-2 xl:columns-3 [&>li]:mb-1.5 [&>li]:break-inside-avoid">
        {NIGHT_LOG.map((l) => (
          <li key={`${l.id}-${l.t}`} className="tg-fade grid grid-cols-[38px_44px_1fr] gap-1.5" style={delay(atPct(pct(l.t)) + 0.1)}>
            <span style={{ color: SOL.base01 }}>{clock(l.t)}</span>
            <span style={{ color: l.color }}>{l.id}</span>
            <span style={{ color: l.kind === "attention" ? SOL.base2 : l.kind === "skip" ? SOL.base01 : SOL.base1 }}>
              {l.kind === "attention" && <span className="mr-1 rounded px-1 text-[10px]" style={{ backgroundColor: SOL.red, color: SOL.base3 }}>needs you</span>}
              {l.kind === "skip" && <span className="mr-1" style={{ color: SOL.base0 }}>skipped.</span>}
              <Whole text={l.text} />
              {l.kind === "skip" && <span style={{ color: SOL.base01 }}> {NIGHT_COUNTS.skipped - 1} more like it.</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Morning() {
  const at = atPct(100) + 0.3;
  const stats: [string, string, string][] = [
    [String(NIGHT_COUNTS.firings), "firings", SOL.base02],
    [String(NIGHT_COUNTS.skipped), "skipped by a precheck, no session spent", SOL.base01],
    [String(NIGHT_COUNTS.sessions), "agent sessions ran", SOL.base02],
    [String(NIGHT_COUNTS.parked), "parked at a usage limit, then resumed", SOL.violet],
  ];
  return (
    <div className="tg-rise flex flex-col gap-3 md:flex-row md:items-center md:justify-between rounded-xl px-4 py-3" style={{ backgroundColor: SOL.base2, ...delay(at) }}>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12.5px]" style={{ color: SOL.base00 }}>
        <span className="font-mono font-semibold" style={{ color: SOL.base03 }}>09:00</span>
        {stats.map(([n, label, color]) => (
          <span key={label}><span className="font-mono font-semibold" style={{ color }}>{n}</span> {label}</span>
        ))}
      </div>
      <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] shrink-0" style={{ backgroundColor: SOL.base3, border: `1px solid color-mix(in srgb, ${SOL.red} 35%, transparent)` }}>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SOL.red }} />
        <span style={{ color: SOL.base02 }}><span className="font-semibold">{NIGHT_COUNTS.attention}</span> needs you: <span className="font-mono">tr-47</span> in the inbox</span>
      </div>
    </div>
  );
}

/**
 * The hero visual: six triggers across one night. A playhead sweeps 18:00 to
 * 09:00; each firing lights up as it passes, the log fills in alongside, and
 * the morning summary lands last. Hover or focus any mark for what that run did.
 */
export function NightShift() {
  const [take, setTake] = useState(0);
  return (
    <div className="rounded-2xl p-4 sm:p-5 shadow-xl text-left" style={{ backgroundColor: "#fffbf0", border: `1px solid ${SOL.base2}` }}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="font-mono text-[12px]" style={{ color: SOL.base01 }}>
          <span className="font-semibold" style={{ color: SOL.base03 }}>One night, six triggers</span>
          <span className="hidden sm:inline"> · hover a mark to see what the run did</span>
        </div>
        <button
          type="button"
          onClick={() => setTake((n) => n + 1)}
          className="rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors hover:brightness-95"
          style={{ backgroundColor: SOL.base2, color: SOL.base01 }}
        >
          replay the night
        </button>
      </div>
      <div key={take} className="grid gap-4">
        <div className="min-w-0">
          <div className="relative">
            <Sky />
            <Axis />
            <div className="space-y-1.5 pt-1">
              {LANES.map((lane, i) => <LaneRow key={lane.id} lane={lane} i={i} />)}
            </div>
            <div className="tg-sweep pointer-events-none absolute top-0 bottom-0 z-10 w-0" style={{ left: "100%", ...delay(0.9) }} aria-hidden>
              <div className="absolute inset-y-0 -left-px w-[2px]" style={{ background: `linear-gradient(${SOL.orange}, color-mix(in srgb, ${SOL.orange} 10%, transparent))` }} />
              <div className="absolute -left-[5px] top-[11px] h-3 w-3 rounded-full" style={{ backgroundColor: SOL.orange, boxShadow: `0 0 0 3px color-mix(in srgb, ${SOL.orange} 25%, transparent)` }} />
            </div>
          </div>
        </div>
        <Log />
      </div>
      <div key={`m${take}`} className="mt-4">
        <Morning />
      </div>
      <p className="sr-only">
        {`From ${clock(NIGHT_START)} to ${clock(NIGHT_END)}: ${NIGHT_COUNTS.firings} firings, ${NIGHT_COUNTS.skipped} skipped by a precheck, ${NIGHT_COUNTS.sessions} sessions ran, ${NIGHT_COUNTS.attention} needs attention.`}
      </p>
    </div>
  );
}
