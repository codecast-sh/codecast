"use client";

import Link from "next/link";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Person, SessionDot, Tile } from "./kit";
import { at, BODY, DIM, INK, LINE, MUTED, PAPER, SOL, STATE, TEXT, accentOf, person, role, tint, ROLES, type RoleRow } from "./model";

/*
 * The hero: the org assembling itself, then one ordinary afternoon on it.
 * An error arrives, travels to the role whose area it falls in, that role
 * wakes and puts a worker on it; later its Release Captain asks to ship, the
 * Engineering lead adds its recommendation and
 * the question climbs the reporting line to the person at the top.
 *
 * Positions are in a 1120 x 560 stage. Resting styles are the END state, so
 * ?static, reduced motion and a background tab all read complete; Replay
 * remounts the stage to play it again.
 */

const W = 1120;
const H = 560;
const MAYA = { x: 560, y: 22, w: 230, h: 60 };
const LEAD_Y = 222;
const LEAD_H = 92;
const LEAD_W = 214;
const SUB_Y = 412;
const LEADS: Record<string, number> = { eng: 250, growth: 640, people: 930 };
const SUBS: Record<string, number> = { infra: 70, release: 190, mobile: 310, evals: 430, social: 580, ads: 700, support: 930 };

const T = {
  signal: 3.2, // the error card lands
  route: 3.8, // its dot leaves for @eng
  wake: 4.6, // @eng wakes
  worker: 5.3, // a worker session starts under it
  ready: 6.4, // the Release Captain has a fix ready
  climb: 7.0, // the question leaves for Maya
  ask: 8.3, // it lands on her
};

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

function Box({ x, y, w, children, style, className = "" }: { x: number; y: number; w: number; children: ReactNode; style?: CSSProperties; className?: string }) {
  return (
    <div className={`absolute ${className}`} style={{ left: pct(x - w / 2, W), top: pct(y, H), width: pct(w, W), ...style }}>
      {children}
    </div>
  );
}

/** One line swapping for another at `t`. */
function Swap({ t, before, after, className = "" }: { t: number; before: ReactNode; after: ReactNode; className?: string }) {
  return (
    <span className={`grid min-w-0 ${className}`}>
      <span className="og-anim og-out [grid-area:1/1] truncate" style={at(t)}>{before}</span>
      <span className="og-anim og-in [grid-area:1/1] truncate" style={at(t + 0.15)}>{after}</span>
    </span>
  );
}

function LeadCard({ r, t, status, extra }: { r: RoleRow; t: number; status: ReactNode; extra?: ReactNode }) {
  return (
    <Box x={LEADS[r.id]} y={LEAD_Y} w={LEAD_W} className="og-anim og-pop" style={at(t)}>
      <div
        className={`rounded-xl border px-3 py-2.5 ${r.id === "eng" ? "og-wake" : ""}`}
        style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 14px 30px -22px rgba(0,43,54,.5)", ["--og-acc" as string]: accentOf(r.k), ...at(T.wake) }}
      >
        <div className="flex items-center gap-2.5">
          <Tile k={r.k} size={30} />
          <div className="min-w-0">
            <div className="font-mono font-bold text-[13px] leading-tight truncate" style={{ color: INK }}>{r.title}</div>
            <div className="font-mono text-meta" style={{ color: DIM }}>{r.handle}</div>
          </div>
        </div>
        <div className="mt-2 font-mono text-meta leading-4" style={{ color: MUTED }}>{status}</div>
        <div className="mt-1 font-mono text-meta leading-4 h-4" style={{ color: MUTED }}>{extra}</div>
      </div>
    </Box>
  );
}

function SubNode({ r, t, status }: { r: RoleRow; t: number; status?: ReactNode }) {
  return (
    <Box x={SUBS[r.id]} y={SUB_Y} w={118} className="og-anim og-pop flex flex-col items-center text-center" style={at(t)}>
      <Tile k={r.k} size={44} />
      <div className="mt-2 font-mono font-semibold text-meta leading-[1.25]" style={{ color: TEXT }}>{r.title}</div>
      <div className="mt-1 font-mono text-meta leading-4 w-full" style={{ color: MUTED }}>{status ?? <span style={{ color: DIM }}>{STATE.dormant.word}</span>}</div>
    </Box>
  );
}

/** Orthogonal reporting line from a parent's bottom centre to a child's top centre. */
const elbow = (x1: number, y1: number, x2: number, y2: number) => {
  const my = (y1 + y2) / 2;
  return `M${x1} ${y1} V${my} H${x2} V${y2}`;
};

const LEAD_LINES = Object.values(LEADS).map((x) => elbow(MAYA.x, MAYA.y + MAYA.h, x, LEAD_Y));
const SUB_LINES = ROLES.filter((r) => SUBS[r.id] !== undefined).map((r) => ({ id: r.id, d: elbow(LEADS[r.reportsTo], LEAD_Y + LEAD_H, SUBS[r.id], SUB_Y) }));

// The error's route into @eng, and the Release Captain's question up the lines to Maya.
const ROUTE = `M140 100 C 140 136, ${LEADS.eng - 40} 118, ${LEADS.eng - 40} ${LEAD_Y}`;
const CLIMB = `M${SUBS.release} ${SUB_Y} V${(LEAD_Y + LEAD_H + SUB_Y) / 2} H${LEADS.eng} V${LEAD_Y + LEAD_H} M${LEADS.eng} ${LEAD_Y} V${(MAYA.y + MAYA.h + LEAD_Y) / 2} H${MAYA.x} V${MAYA.y + MAYA.h}`;

function Traveller({ path, t, dur, color }: { path: string; t: number; dur: number; color: string }) {
  return (
    <div
      aria-hidden
      className="og-anim og-travel absolute left-0 top-0 rounded-full"
      style={{
        width: pct(12, W), aspectRatio: "1", marginLeft: "-0.55%", marginTop: "-0.55%",
        backgroundColor: color, boxShadow: `0 0 0 4px ${tint(color, 25, "transparent")}, 0 0 18px ${color}`,
        offsetPath: `path("${path}")`, offsetRotate: "0deg",
        ...at(t, { animationDuration: `${dur}s` }),
      }}
    />
  );
}

/** The question as it reaches Maya: the Engineering lead's card, with the Release Captain on its ladder. */
function AskCard() {
  const eng = role("eng");
  const release = role("release");
  return (
    <div className="rounded-xl border px-3 py-2.5" style={{ borderColor: tint(SOL.yellow, 55), backgroundColor: tint(SOL.yellow, 9), boxShadow: "0 18px 34px -24px rgba(0,43,54,.55)" }}>
      <div className="flex items-center gap-2">
        <Tile k={eng.k} size={18} />
        <span className="font-mono text-meta font-semibold" style={{ color: INK }}>{eng.title}</span>
        <span className="ml-auto font-mono text-meta" style={{ color: SOL.yellow }}>waiting on you</span>
      </div>
      <div className="mt-1.5 font-mono text-[12px] font-semibold leading-snug" style={{ color: INK }}>Ship the checkout fix now?</div>
      <div className="mt-1 font-mono text-meta" style={{ color: MUTED }}>
        <span style={{ color: SOL.green }}>Recommends</span> Ship · tests green
      </div>
      <div className="mt-1 flex items-center gap-1 whitespace-nowrap font-mono text-meta" style={{ color: DIM }}>
        <Tile k={release.k} size={13} /> @release <span>→</span> <Tile k={eng.k} size={13} /> @eng <span>→</span> you
      </div>
      <div className="mt-2 flex gap-1.5">
        <span className="rounded-md px-2 py-0.5 font-mono text-meta" style={{ backgroundColor: INK, color: PAPER }}>Ship</span>
        <span className="rounded-md px-2 py-0.5 font-mono text-meta border" style={{ borderColor: LINE, color: TEXT }}>Hold until Monday</span>
      </div>
    </div>
  );
}

/** A connector between the phone story's steps: a short line and what moved along it. */
function Hop({ color, children, t }: { color: string; children: ReactNode; t: number }) {
  return (
    <div className="og-anim og-fade flex items-center gap-2.5 pl-[18px] py-1.5" style={at(t)}>
      <span className="w-px h-6" style={{ backgroundColor: color }} />
      <span className="font-mono text-meta" style={{ color }}>{children}</span>
    </div>
  );
}

/** The same afternoon for a phone: the chart's story as one column, top to bottom. */
function PhoneStory() {
  const eng = role("eng");
  const release = role("release");
  const maya = person("maya");
  const card = { borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 14px 30px -22px rgba(0,43,54,.5)" };
  return (
    <div className="flex flex-col">
      <div className="og-anim og-rise rounded-lg border px-3 py-2 font-mono" style={at(0.2, { borderColor: tint(SOL.red, 45), backgroundColor: tint(SOL.red, 7) })}>
        <div className="flex items-center gap-2 text-meta" style={{ color: SOL.red }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SOL.red }} />error · production
        </div>
        <div className="mt-1 text-[12.5px] font-semibold" style={{ color: INK }}>TypeError: cart is undefined</div>
        <div className="text-meta" style={{ color: MUTED }}>checkout.ts:212 · 41 events in 5m</div>
      </div>
      <Hop color={SOL.red} t={0.5}>→ @eng · its area: the codebase</Hop>
      <div className="og-anim og-rise rounded-xl border px-3 py-2.5" style={at(0.7, card)}>
        <div className="flex items-center gap-2.5">
          <Tile k={eng.k} size={30} />
          <div className="min-w-0">
            <div className="font-mono font-bold text-[13px] leading-tight" style={{ color: INK }}>{eng.title}</div>
            <div className="font-mono text-meta" style={{ color: DIM }}>{eng.handle} · reports to Maya</div>
          </div>
        </div>
        <div className="mt-2 font-mono text-meta" style={{ color: MUTED }}>
          <SessionDot state="working" className="mr-1.5 align-middle" size={6} /><span style={{ color: SOL.green }}>working</span> · checkout error
        </div>
        <div className="mt-1 font-mono text-meta" style={{ color: MUTED }}><span style={{ color: DIM }}>└</span> <span style={{ color: TEXT }}>worker</span> · fix cart crash</div>
        <div className="mt-2 pt-2 border-t flex items-center gap-2 font-mono text-meta" style={{ borderColor: LINE, color: MUTED }}>
          <Tile k={release.k} size={20} /> <span style={{ color: TEXT }}>{release.title}</span> · <span style={{ color: SOL.yellow }}>fix ready to ship</span>
        </div>
      </div>
      <Hop color={SOL.yellow} t={1}>↑ @release asks @eng, @eng asks Maya</Hop>
      <div className="og-anim og-rise rounded-xl border px-3 py-2.5 flex items-center gap-3" style={at(1.2, card)}>
        <Person p={maya} size={32} />
        <div>
          <div className="font-mono font-bold text-[13px]" style={{ color: INK }}>{maya.name}</div>
          <div className="font-mono text-meta" style={{ color: SOL.yellow }}>1 needs you</div>
        </div>
      </div>
      <div className="og-anim og-ask mt-2" style={at(1.4)}><AskCard /></div>
    </div>
  );
}

function Stage() {
  const eng = role("eng");
  const maya = person("maya");
  return (
    <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden>
        {LEAD_LINES.map((d, i) => (
          <path key={d} d={d} pathLength={1} className="og-anim og-draw" style={at(0.45 + i * 0.08)} stroke={SOL.base1} strokeWidth={1.5} />
        ))}
        {SUB_LINES.map(({ id, d }, i) => (
          <path key={id} d={d} pathLength={1} className="og-anim og-draw" style={at(1.3 + i * 0.06)} stroke={SOL.base1} strokeWidth={1.5} />
        ))}
        <path d={`M${MAYA.x + MAYA.w / 2} ${MAYA.y + 30} H840`} pathLength={1} className="og-anim og-draw" style={at(T.ask - 0.2, { animationDuration: ".4s" })} stroke={SOL.yellow} strokeWidth={1.5} />
        <path d={ROUTE} pathLength={1} className="og-anim og-draw" style={at(T.route, { animationDuration: ".8s" })} stroke={SOL.red} strokeWidth={1.5} strokeDasharray="1" />
      </svg>

      {/* The scale at the top: one person. */}
      <Box x={MAYA.x} y={MAYA.y} w={MAYA.w} className="og-anim og-pop" style={at(0.15)}>
        <div className="rounded-xl border px-3 py-2.5 flex items-center gap-3" style={{ borderColor: LINE, backgroundColor: "#fffdf6", boxShadow: "0 14px 30px -22px rgba(0,43,54,.5)" }}>
          <Person p={maya} size={34} />
          <div className="min-w-0 flex-1">
            <div className="font-mono font-bold text-[13px] leading-tight" style={{ color: INK }}>{maya.name}</div>
            <div className="font-mono text-meta">
              <Swap
                t={T.ask}
                before={<span style={{ color: DIM }}>founder · 3 leads</span>}
                after={<span style={{ color: SOL.yellow }}>1 needs you <span style={{ color: DIM }}>· 3 leads</span></span>}
              />
            </div>
          </div>
        </div>
      </Box>

      <LeadCard
        r={eng}
        t={0.75}
        status={
          <Swap
            t={T.wake}
            before={<><SessionDot state="dormant" className="mr-1.5 align-middle" size={6} />dormant · checked 2h ago</>}
            after={<><SessionDot state="working" className="mr-1.5 align-middle" size={6} /><span style={{ color: SOL.green }}>working</span> · checkout error</>}
          />
        }
        extra={
          <span className="og-anim og-pop inline-flex items-center gap-1.5 origin-left" style={at(T.worker)}>
            <span style={{ color: DIM }}>└</span><span className="inline-block w-2 h-2 rounded-full border" style={{ borderColor: SOL.green, backgroundColor: tint(SOL.green, 30) }} />
            <span style={{ color: TEXT }}>worker</span> · fix cart crash
          </span>
        }
      />
      <LeadCard r={role("growth")} t={0.85} status={<><SessionDot state="working" className="mr-1.5 align-middle" size={6} /><span style={{ color: SOL.green }}>working</span> · launch post draft</>} />
      <LeadCard r={role("people")} t={0.95} status={<><SessionDot state="dormant" className="mr-1.5 align-middle" size={6} />dormant · weekly review Fri</>} />

      {ROLES.filter((r) => SUBS[r.id] !== undefined).map((r, i) => (
        <SubNode
          key={r.id}
          r={r}
          t={1.55 + i * 0.07}
          status={r.id === "release"
            ? <Swap t={T.ready} before={<span style={{ color: DIM }}>dormant</span>} after={<span style={{ color: SOL.yellow }}>fix ready to ship</span>} className="justify-center" />
            : r.id === "social" ? <span style={{ color: SOL.green }}>working</span> : undefined}
        />
      ))}

      {/* The error, arriving from production. */}
      <Box x={140} y={18} w={250} className="og-anim og-rise" style={at(T.signal)}>
        <div className="rounded-lg border px-3 py-2 font-mono" style={{ borderColor: tint(SOL.red, 45), backgroundColor: tint(SOL.red, 7) }}>
          <div className="flex items-center gap-2 text-meta" style={{ color: SOL.red }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SOL.red }} />error · production
          </div>
          <div className="mt-1 text-meta font-semibold truncate" style={{ color: INK }}>TypeError: cart is undefined</div>
          <div className="text-meta">
            <Swap t={T.route + 0.4} before={<span style={{ color: MUTED }}>checkout.ts:212 · 41 events in 5m</span>} after={<span style={{ color: SOL.red }}>→ @eng · its area: the codebase</span>} />
          </div>
        </div>
      </Box>
      {/* The question, raised with Maya by the lead that reports to her. */}
      <Box x={978} y={6} w={276} className="og-anim og-ask" style={at(T.ask)}>
        <AskCard />
      </Box>

      <Traveller path={ROUTE} t={T.route} dur={0.8} color={SOL.red} />
      <Traveller path={CLIMB} t={T.climb} dur={1.3} color={SOL.yellow} />
    </div>
  );
}

const HERO_CSS = `
.og-out { animation-name: og-out; animation-duration: .3s; opacity: 0; visibility: hidden; }
.og-in { animation-name: og-rise; animation-duration: .45s; }
@keyframes og-out { from { opacity: 1; visibility: visible; } to { opacity: 0; visibility: hidden; } }
.og-travel { animation-name: og-travel; animation-timing-function: cubic-bezier(.45,0,.25,1); opacity: 0; }
@keyframes og-travel {
  0% { offset-distance: 0%; opacity: 0; }
  8% { opacity: 1; }
  92% { opacity: 1; }
  100% { offset-distance: 100%; opacity: 0; }
}
.og-wake { animation: og-wake 1.6s ease-out var(--d) both; }
@keyframes og-wake {
  0% { box-shadow: 0 14px 30px -22px rgba(0,43,54,.5), 0 0 0 0 transparent; }
  25% { box-shadow: 0 14px 30px -22px rgba(0,43,54,.5), 0 0 0 4px color-mix(in srgb, var(--og-acc) 45%, transparent); }
  100% { box-shadow: 0 14px 30px -22px rgba(0,43,54,.5), 0 0 0 2px color-mix(in srgb, var(--og-acc) 30%, transparent); }
}
.og-ask { animation-name: og-ask; animation-duration: .6s; animation-timing-function: cubic-bezier(.3,1.35,.5,1); transform-origin: 0% 30%; }
@keyframes og-ask { from { opacity: 0; transform: translateX(-24px) scale(.85); } to { opacity: 1; transform: none; } }
.og-root[data-static] .og-wake, .og-root[data-static] .og-travel { animation: none !important; }
@media (prefers-reduced-motion: reduce) { .og-wake, .og-travel { animation: none !important; } }
`;

export function Hero() {
  const [run, setRun] = useState(0);
  return (
    <header className="og-grid relative overflow-hidden border-b" style={{ borderColor: LINE }}>
      <style>{HERO_CSS}</style>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:gap-16 items-end">
          <div className="og-anim og-rise" style={at(0)}>
            <div className="flex items-center gap-2 mb-6 font-mono text-[13px]" style={{ color: MUTED }}>
              <Tile k="org chart" size={20} /> Org
            </div>
            <h1 className="font-mono font-bold text-[38px] sm:text-[56px] leading-[1.02] tracking-[-0.045em]" style={{ color: INK }}>
              Every area of your work has an agent that answers for it
            </h1>
          </div>
          <div className="og-anim og-rise lg:pb-2" style={at(0.1)}>
            <p className="text-[16px] sm:text-[17px] leading-[1.7]" style={{ color: BODY }}>
              An org in codecast is a chart of standing agent roles and the people they report to. Each role owns an area and keeps one long-lived session. It wakes on its own schedule or when someone writes to it, and starts workers on what it finds. Questions climb the chart until they reach someone who can answer them.
            </p>
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[14px]">
              <a href="#install" className="underline underline-offset-[6px] decoration-2" style={{ color: INK, textDecorationColor: SOL.violet }}>Install codecast</a>
              <a href="#templates" className="underline underline-offset-[6px]" style={{ color: MUTED, textDecorationColor: DIM }}>Start from a template</a>
              <Link href="/features/decisions" className="underline underline-offset-[6px]" style={{ color: MUTED, textDecorationColor: DIM }}>Decisions</Link>
            </div>
          </div>
        </div>
      </div>
      <div className="max-w-6xl mx-auto px-2 sm:px-8 pt-10 pb-6">
        <div className="hidden md:block" key={`s${run}`}>
          <Stage />
        </div>
        <div className="md:hidden px-3" key={`p${run}`}>
          <PhoneStory />
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={() => setRun((n) => n + 1)} className="og-press font-mono text-[12px] rounded-full border px-3 py-1" style={{ borderColor: LINE, color: MUTED, backgroundColor: PAPER }}>
            ↻ Replay
          </button>
        </div>
      </div>
    </header>
  );
}
