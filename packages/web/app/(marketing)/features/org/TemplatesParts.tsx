"use client";

import type { ReactNode } from "react";
import { Tile } from "./kit";
import { at, BODY, DIM, INK, LINE, MUTED, PAPER, SAND, SOL, TEXT, accentOf, tint } from "./model";
import { cadenceWords, DAYS, HOURS, perWeek, PERM_KINDS, type Hire, type Routine } from "./templatesData";

/*
 * The hire gallery's detail pieces: the routines as a week of firings, the
 * counts of what a hire asks for, and the steps a hire goes through.
 */

const pct = (h: number) => `${(h / 168) * 100}%`;

/** Where in the week a routine's firings land: a fixed hour of day, staggered by row so rows don't stack. */
function firings(rt: Routine, row: number): number[] {
  const h = HOURS[rt.every];
  if (rt.every === "30d") return [24 * 2 + 10];
  const start = h >= 168 ? 24 * ((3 + row) % 5) + 10 : h >= 48 ? 24 * (row % 2) + 9 : 9 + (row % 3) * 2;
  const out: number[] = [];
  for (let t = start; t < 168; t += h) out.push(t);
  return out;
}

function Track({ rt, row, color }: { rt: Routine; row: number; color: string }) {
  const h = HOURS[rt.every];
  const dense = h <= 6;
  if (rt.onChange) {
    return (
      <div className="relative h-[22px] rounded-md" style={{ backgroundColor: tint(SAND, 55) }}>
        <div className="og-anim og-tp-wipe absolute inset-x-0 top-1/2 h-0 border-t border-dashed" style={at(0.12 + row * 0.09, { borderColor: color })} />
      </div>
    );
  }
  return (
    <div className="og-tp-track relative h-[22px] rounded-md" style={{ backgroundColor: tint(SAND, 55) }}>
      <div className="og-anim og-tp-wipe absolute inset-0" style={at(0.12 + row * 0.09)}>
        {dense ? (
          <div
            className="absolute inset-x-0 top-[5px] bottom-[5px]"
            style={{ backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 ${h === 1 ? 1 : 2}px, transparent ${h === 1 ? 1 : 2}px ${pct(h)})`, opacity: h === 1 ? 0.75 : 0.9 }}
          />
        ) : firings(rt, row).map((t) => (
          <span
            key={t}
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={rt.every === "30d"
              ? { left: pct(t), width: 10, height: 10, boxShadow: `inset 0 0 0 2px ${color}`, backgroundColor: PAPER }
              : { left: pct(t), width: h >= 168 ? 12 : 9, height: h >= 168 ? 12 : 9, backgroundColor: color, boxShadow: `0 0 0 2px ${PAPER}` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Every routine as a row over one week, so the role's rhythm reads at a glance. */
export function Cadence({ hire }: { hire: Hire }) {
  const color = accentOf(hire.k);
  const total = hire.routines.reduce((n, rt) => n + (rt.every === "30d" || rt.onChange ? 0 : perWeek(rt.every)), 0);
  if (!hire.routines.length) {
    return (
      <div className="rounded-xl border px-3 py-2.5 font-mono text-[12.5px]" style={{ borderColor: LINE, backgroundColor: PAPER, color: TEXT }}>
        No routines · it works when you ask it something
      </div>
    );
  }
  const acts = hire.routines.filter((rt) => rt.mode === "acts").length;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 mb-2.5">
        <div className="font-mono text-[12.5px] font-semibold" style={{ color: INK }}>
          {hire.routines.length} routine{hire.routines.length === 1 ? "" : "s"}
          {acts > 0 && <span className="font-normal" style={{ color: MUTED }}> · {acts} act{acts === 1 ? "s" : ""} once you allow it</span>}
        </div>
        <div className="font-mono text-meta shrink-0" style={{ color: MUTED }}><span className="font-semibold" style={{ color: INK }}>{total}</span> runs a week</div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_3.2rem] gap-x-3 gap-y-2 items-center">
        <div className="hidden sm:block" />
        <div className="hidden sm:grid grid-cols-7 font-mono text-meta" style={{ color: DIM }}>
          {DAYS.map((d) => <span key={d} className="pl-1 border-l" style={{ borderColor: LINE }}>{d}</span>)}
        </div>
        <div className="hidden sm:block" />
        {hire.routines.map((rt, i) => (
          <div key={rt.title} className="contents">
            <div className="min-w-0 col-span-2 sm:col-span-1">
              <div className="text-[12.5px] leading-tight truncate" style={{ color: TEXT }} title={rt.title}>{rt.title}</div>
              <div className="font-mono text-meta" style={{ color: rt.mode === "acts" ? color : DIM }}>{rt.onChange ? `when one changes · watched every ${rt.every}` : cadenceWords(rt.every)}</div>
            </div>
            <Track rt={rt} row={i} color={rt.mode === "acts" ? color : SOL.base1} />
            <div className="font-mono text-meta text-right tabular-nums" style={{ color: MUTED }}>{rt.onChange ? "on change" : rt.every === "30d" ? "1/mo" : `${perWeek(rt.every)}×`}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Count({ n, label, sub, children }: { n: number; label: string; sub: string; children?: ReactNode }) {
  return (
    <div className="rounded-xl border px-3 py-2.5 min-w-0" style={{ borderColor: LINE, backgroundColor: PAPER }}>
      <div className="flex items-baseline gap-2">
        <span className="font-mono font-bold text-[22px] leading-none tabular-nums" style={{ color: n ? INK : DIM }}>{n}</span>
        <span className="font-mono text-[12px] font-semibold" style={{ color: TEXT }}>{label}</span>
      </div>
      <div className="mt-1 text-meta leading-snug" style={{ color: MUTED }}>{sub}</div>
      {children}
    </div>
  );
}

/** What a hire asks of the person, as counts. */
export function Asks({ hire }: { hire: Hire }) {
  if (hire.builtin) {
    return (
      <div className="rounded-xl border px-3 py-2.5 font-mono text-[12.5px]" style={{ borderColor: LINE, backgroundColor: PAPER, color: TEXT }}>
        Built in · asks nothing at hire
      </div>
    );
  }
  const perms = PERM_KINDS.reduce((n, k) => n + (hire.perms[k] ?? 0), 0);
  return (
    <div className="grid grid-cols-2 gap-2">
      <Count n={hire.answers} label="answers" sub={`${hire.must ? `${hire.must} with no default` : "each has a default"} · plus ${hire.secrets.length} secret${hire.secrets.length === 1 ? "" : "s"}`} />
      <Count n={hire.secrets.length} label="secrets" sub="kept on your machine">
        {hire.secrets.length > 0 && (
          <div className="mt-1.5 font-mono text-meta leading-snug truncate" style={{ color: DIM }} title={hire.secrets.join(", ")}>{hire.secrets.slice(0, 2).join(", ")}{hire.secrets.length > 2 ? ` +${hire.secrets.length - 2}` : ""}</div>
        )}
      </Count>
      <Count n={perms} label="permissions" sub="outside codecast">
        <div className="mt-1.5 flex flex-wrap gap-1">
          {PERM_KINDS.map((k) => {
            const n = hire.perms[k] ?? 0;
            const c = k === "spend" ? SOL.orange : k === "publish" ? SOL.magenta : k === "write" ? SOL.blue : SOL.cyan;
            return (
              <span key={k} className="rounded px-1 font-mono text-meta leading-[18px]" style={n ? { backgroundColor: tint(c, 16), color: `color-mix(in srgb, ${c} 70%, ${INK})` } : { color: DIM, boxShadow: `inset 0 0 0 1px ${LINE}`, opacity: 0.6 }}>
                {k}{n > 1 ? ` ${n}` : ""}
              </span>
            );
          })}
        </div>
      </Count>
      <Count n={hire.setup} label="setup steps" sub={`only you can do · ${hire.setupAll} in all`} />
    </div>
  );
}

export type Stage = 0 | 1 | 2;

/** The three things a hire goes through, lit as the person presses through them. */
export function HireSteps({ hire, stage }: { hire: Hire; stage: Stage }) {
  const color = accentOf(hire.k);
  const paused = hire.setup > 0;
  const steps = hire.builtin
    ? [
        { at: 1, title: `Seated as ${hire.handle}`, sub: hire.id === "head-of-people" ? "A fresh session, or the agent you already talk to" : "Global by default: every workspace you are in" },
        { at: 1, title: hire.id === "head-of-people" ? "First review runs now" : "Pinned in your header", sub: hire.seat },
      ]
    : [
        { at: 1, title: "A proposal for you", sub: `The role, ${hire.routines.length} routines and ${PERM_KINDS.reduce((n, k) => n + (hire.perms[k] ?? 0), 0)} permissions in one ask` },
        { at: 2, title: `Seated as ${hire.handle}`, sub: hire.seat },
        { at: 2, title: paused ? "Routines start paused" : "Routines start", sub: paused ? `Each turns on once its setup is done · 0 of ${hire.setup}` : "Nothing to set up first" },
      ];
  return (
    <ol className="grid gap-2">
      {steps.map((s, i) => {
        const lit = stage >= s.at;
        return (
          <li
            key={s.title}
            className={`relative rounded-xl border px-3 py-2.5 transition-[background-color,border-color] duration-300 ${lit ? "og-anim og-tp-light" : ""}`}
            style={{ ...at(i * 0.18), borderColor: lit ? tint(color, 55) : LINE, backgroundColor: lit ? tint(color, 9) : PAPER }}
          >
            <div className="flex items-start gap-2">
              <span className="mt-px inline-flex w-[20px] h-[20px] shrink-0 items-center justify-center rounded-full font-mono text-meta font-bold" style={lit ? { backgroundColor: color, color: PAPER } : { boxShadow: `inset 0 0 0 1.5px ${color}`, color: `color-mix(in srgb, ${color} 70%, ${INK})` }}>
                {lit && !(i === steps.length - 1 && paused && !hire.builtin) ? "✓" : i + 1}
              </span>
              <span className="min-w-0 font-mono text-[12px] font-semibold leading-[1.35] break-words" style={{ color: INK }}>{s.title}</span>
            </div>
            <div className="mt-1 text-meta leading-snug" style={{ color: BODY }}>{s.sub}</div>
          </li>
        );
      })}
    </ol>
  );
}

/** The setup only a person can do, as the role page lists it after the hire. */
export function SetupList({ hire, lit }: { hire: Hire; lit: boolean }) {
  if (!hire.steps.length) return null;
  return (
    <ul className="space-y-1">
      {hire.steps.map((s, i) => (
        <li key={s} className={`flex items-start gap-2 text-[12px] ${lit ? "og-anim og-rise" : ""}`} style={{ ...at(0.5 + i * 0.1), color: TEXT }}>
          <span className="mt-[3px] w-3 h-3 shrink-0 rounded-[3px]" style={{ boxShadow: `inset 0 0 0 1.5px ${DIM}` }} />
          <span className="min-w-0 leading-snug">{s}</span>
        </li>
      ))}
      {hire.setup > hire.steps.length && <li className="pl-5 font-mono text-meta" style={{ color: DIM }}>and {hire.setup - hire.steps.length} more</li>}
    </ul>
  );
}

/** The pinned release a hired role runs, as the pane's footer. */
export function Release({ hire }: { hire: Hire }) {
  if (hire.builtin || !hire.version) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-meta" style={{ color: MUTED }}>
      <Tile k={hire.k} size={16} />
      <span style={{ color: INK }}>{hire.id} {hire.version}</span>
      <span className="rounded px-1 leading-[16px]" style={{ boxShadow: `inset 0 0 0 1px ${LINE}`, color: TEXT }}>pinned</span>
    </div>
  );
}

function Node({ title, sub, color, filled, t }: { title: string; sub: string; color: string; filled?: boolean; t: number }) {
  return (
    <div className="og-anim og-rise min-w-0 flex-1 rounded-lg border px-2.5 py-2" style={{ ...at(t), borderColor: filled ? color : LINE, backgroundColor: filled ? tint(color, 12) : PAPER }}>
      <div className="font-mono text-[12px] font-semibold leading-tight" style={{ color: INK }}>{title}</div>
      <div className="mt-0.5 text-meta leading-snug" style={{ color: MUTED }}>{sub}</div>
    </div>
  );
}

const Arrow = () => <span aria-hidden className="shrink-0 self-center font-mono text-[12px] rotate-90 sm:rotate-0" style={{ color: DIM }}>→</span>;

/** Releases and lessons as structure: the class rail with the pin and the drift preview, and the path a lesson takes back to the template. */
export function Lifecycle({ hire }: { hire: Hire }) {
  const color = accentOf(hire.k);
  const v = hire.version ?? "1.3.0";
  return (
    <div className="rounded-2xl border p-4 sm:p-5 space-y-5" style={{ borderColor: LINE, backgroundColor: "#fffdf6" }}>
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-mono text-[12.5px] font-semibold" style={{ color: INK }}>Releases</span>
          <span className="font-mono text-meta" style={{ color: DIM }}>immutable · SHA-256 digested</span>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Node t={0} title="draft" sub="not offered yet" color={SOL.base1} />
          <Arrow />
          <Node t={0.1} title="canary" sub="runs first on roles that opt in" color={SOL.yellow} />
          <Arrow />
          <Node t={0.2} title="stable" sub="offered to you as an Update" color={SOL.green} filled />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 font-mono text-meta">
          <span className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5" style={{ borderColor: tint(color, 50), backgroundColor: tint(color, 10), color: TEXT }}>
            <Tile k={hire.k} size={14} /> your {hire.builtin ? "role" : hire.name} · pinned {v}
          </span>
          <span style={{ color: DIM }}>→</span>
          <span className="rounded-full border px-2 py-0.5" style={{ borderColor: LINE, color: TEXT }}>Update: drift preview first</span>
          <span style={{ color: DIM }}>→</span>
          <span className="rounded-full border px-2 py-0.5" style={{ borderColor: LINE, color: TEXT }}>apply</span>
        </div>
      </div>
      <div className="pt-4 border-t" style={{ borderColor: LINE }}>
        <div className="mb-2 font-mono text-[12.5px] font-semibold" style={{ color: INK }}>Lessons, for roles that opt in</div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Node t={0.3} title="Your role" sub="learns on your team" color={color} filled />
          <Arrow />
          <Node t={0.4} title="Leak check" sub="screened for your data" color={SOL.base1} />
          <Arrow />
          <Node t={0.5} title="Review" sub="approved before it ships" color={SOL.base1} />
          <Arrow />
          <Node t={0.6} title="Template" sub="reaches every role hired from it" color={SOL.violet} filled />
        </div>
      </div>
    </div>
  );
}
