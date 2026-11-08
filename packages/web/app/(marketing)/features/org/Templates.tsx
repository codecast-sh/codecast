"use client";

import { useState } from "react";
import { C, ForScripts, Whole } from "../kit";
import { Frame, Section, Tile } from "./kit";
import { BODY, DIM, INK, LINE, MUTED, PAPER, SAND, SOL, TEXT, accentOf, tint } from "./model";
import { DEFAULT_HIRE, HIRES, type Hire } from "./templatesData";
import { Asks, Cadence, HireSteps, Lifecycle, Release, SetupList, type Stage } from "./TemplatesParts";

/*
 * Hiring a role from a template (brief 2.9, 2.11, 2.12). The gallery holds the
 * two built-ins and the eight templates; the selected card opens its detail:
 * the routines as a week of firings, the counts of what the hire asks for, and
 * the hire itself pressed through its steps (a proposal, the seat, routines
 * paused until setup is done). The default selection is the On-call Engineer,
 * shown complete before any press.
 */

const COMMANDS = [
  "cast org template install ./on-call --instance app --project <id>",
  "cast org template bind app --secret accounts.sentry_token=<file>",
];

const CSS = `
.og-tp-wipe { animation-name: og-tp-wipe; animation-duration: 1s; }
@keyframes og-tp-wipe { from { clip-path: inset(0 100% 0 0); } to { clip-path: inset(0 0 0 0); } }
.og-tp-light { animation-name: og-tp-light; animation-duration: .5s; }
@keyframes og-tp-light { from { transform: translateY(6px); opacity: .5; } to { transform: none; opacity: 1; } }
.og-tp-card { transition: border-color .2s ease, background-color .2s ease, box-shadow .2s ease, transform .2s var(--og-ease); }
.og-tp-card:hover { transform: translateY(-1px); }
.og-tp-strip { scrollbar-width: none; }
.og-tp-strip::-webkit-scrollbar { display: none; }
@media (prefers-reduced-motion: reduce) { .og-tp-card, .og-tp-card:hover { transition: none; transform: none; } }
`;

function Card({ hire, on, onPick }: { hire: Hire; on: boolean; onPick: () => void }) {
  const color = accentOf(hire.k);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={on}
      className="og-tp-card text-left rounded-xl border px-3 py-2.5 w-[220px] shrink-0 snap-start lg:w-auto"
      style={{
        borderColor: on ? color : LINE,
        backgroundColor: on ? tint(color, 10) : PAPER,
        boxShadow: on ? `0 0 0 1px ${color}, 0 12px 26px -20px rgba(0,43,54,.5)` : "none",
      }}
    >
      <div className="flex items-start gap-2.5">
        <Tile k={hire.k} size={30} />
        <div className="min-w-0 flex-1">
          <div className="font-mono font-bold text-[12.5px] leading-tight break-words" style={{ color: INK }}>{hire.name}</div>
          <div className="mt-0.5 font-mono text-[11.5px]" style={{ color: hire.builtin ? SOL.cyan : DIM }}>{hire.builtin ? "built in" : hire.version} · {hire.routines.length ? `${hire.routines.length} routine${hire.routines.length === 1 ? "" : "s"}` : "on request"}</div>
        </div>
      </div>
      <p className="mt-1.5 text-[11.5px] leading-snug line-clamp-2" style={{ color: MUTED }}>{hire.line}</p>
    </button>
  );
}

function Gallery({ picked, onPick }: { picked: string; onPick: (id: string) => void }) {
  const builtins = HIRES.filter((h) => h.builtin).length;
  return (
    <div className="min-w-0 space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-[12px]" style={{ color: MUTED }}>
        <span><span className="font-semibold" style={{ color: INK }}>{HIRES.length} roles</span> · {builtins} built in · {HIRES.length - builtins} templates</span>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed px-2 py-0.5" style={{ borderColor: tint(SOL.base1, 60) }}>
          <span style={{ color: DIM }}>+</span> Add a role by hand
        </span>
      </div>
      <div className="og-tp-strip flex gap-2 overflow-x-auto snap-x -mx-4 px-4 pb-1 lg:mx-0 lg:px-0 lg:pb-0 lg:grid lg:grid-cols-5 lg:overflow-visible">
        {HIRES.map((h) => <Card key={h.id} hire={h} on={h.id === picked} onPick={() => onPick(h.id)} />)}
      </div>
    </div>
  );
}

function Detail({ hire }: { hire: Hire }) {
  const [stage, setStage] = useState<Stage>(0);
  const color = accentOf(hire.k);
  const last: Stage = hire.builtin ? 1 : 2;
  const press = () => setStage((s) => (s === 0 ? 1 : 2));
  const label = stage === 0 ? `Hire ${hire.name}` : stage === 1 && !hire.builtin ? "Approve" : null;
  return (
    <div className="min-w-0 rounded-2xl border p-4 sm:p-5 space-y-5" style={{ borderColor: LINE, backgroundColor: tint(SAND, 35) }}>
      <header className="flex items-start gap-3">
        <Tile k={hire.k} size={48} className="og-anim og-pop" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5">
            <h3 className="font-mono font-bold text-[18px] leading-tight tracking-[-0.02em]" style={{ color: INK }}>{hire.name}</h3>
            <span className="font-mono text-[11.5px]" style={{ color: DIM }}>{hire.handle}</span>
          </div>
          <p className="mt-1 text-[13.5px] leading-[1.55]" style={{ color: BODY }}>{hire.line}</p>
        </div>
      </header>

      <Cadence hire={hire} />

      <div className="grid gap-6 lg:grid-cols-2 items-start">
      <div className="space-y-2.5">
        <div className="font-mono text-[12.5px] font-semibold" style={{ color: INK }}>What it asks for</div>
        <Asks hire={hire} />
      </div>

      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-mono text-[12.5px] font-semibold" style={{ color: INK }}>When you hire it</div>
          {label ? (
            <button
              type="button"
              onClick={press}
              className="og-press rounded-lg px-3.5 py-1.5 font-mono text-[12.5px] font-semibold"
              style={stage === 1 ? { backgroundColor: INK, color: PAPER } : { backgroundColor: color, color: PAPER }}
            >
              {label} →
            </button>
          ) : (
            <button type="button" onClick={() => setStage(0)} className="og-press font-mono text-[11.5px] rounded-full border px-2.5 py-0.5" style={{ borderColor: LINE, color: MUTED, backgroundColor: PAPER }}>
              ↻ Start over
            </button>
          )}
        </div>
        <HireSteps hire={hire} stage={stage} />
        {stage >= last && hire.steps.length > 0 && (
          <div className="rounded-xl border px-3 py-2.5" style={{ borderColor: LINE, backgroundColor: PAPER }}>
            <div className="mb-1.5 flex items-baseline justify-between font-mono text-[11.5px]">
              <span style={{ color: TEXT }}>On its role page</span>
              <span style={{ color: SOL.yellow }}>0 of {hire.setup} done</span>
            </div>
            <SetupList hire={hire} lit />
          </div>
        )}
      </div>
      </div>

      <div className="pt-3 border-t" style={{ borderColor: LINE }}>
        {hire.builtin
          ? <div className="font-mono text-[11.5px]" style={{ color: MUTED }}>Shown here until one stands · {hire.id === "head-of-people" ? "one per workspace" : "one per person"}</div>
          : <Release hire={hire} />}
      </div>
    </div>
  );
}

export function Templates() {
  const [picked, setPicked] = useState(DEFAULT_HIRE);
  const hire = HIRES.find((h) => h.id === picked)!;
  return (
    <Section
      id="templates"
      title="Hire a role from a template"
      lede={
        <p>
          A template is a versioned folder holding a role&apos;s charter, its routines and what it needs from you, so any team can hire it for each of its projects. A hire arrives as a proposal. Once you approve it, the role takes its seat, and its routines stay paused until the setup only you can do is done.
        </p>
      }
    >
      <style>{CSS}</style>
      <Frame label={<><Tile k="org chart" size={16} /> Org · Hire</>}>
        <div className="space-y-5 p-4 sm:p-6">
          <Gallery picked={picked} onPick={setPicked} />
          <Detail key={hire.id} hire={hire} />
        </div>
      </Frame>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start">
        <Lifecycle hire={hire.builtin ? HIRES.find((h) => h.id === DEFAULT_HIRE)! : hire} />
        <ForScripts note={<>The same hire from a checkout. <C>bind</C> runs on the host after you approve, so secret files never leave the machine.</>}>
          <div className="rounded-lg px-4 py-3 font-mono text-[12.5px] leading-[1.7] space-y-1.5" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
            {COMMANDS.map((cmd) => <div key={cmd}><span style={{ color: SOL.base01 }}>$ </span><Whole text={cmd} /></div>)}
          </div>
        </ForScripts>
      </div>
    </Section>
  );
}
