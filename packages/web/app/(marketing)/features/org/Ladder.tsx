"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { Frame, Person, Section, SessionDot, Tile } from "./kit";
import { BODY, DIM, INK, LINE, MUTED, PAPER, SOL, TEXT, at, person, role, tint } from "./model";

/*
 * Questions climb the chart. One illustrative afternoon: 14 sessions under five
 * roles each ask one question. Without an org every one of them reaches Maya.
 * With an org each goes to its role first; twelve are answered there, one is
 * passed up with a recommendation, one passes up because its role stayed
 * silent for 5 minutes, and Maya gets one card per lead.
 *
 * The chart is a 560 x 400 stage: an SVG for lines, dots and the travelling
 * questions, HTML over it for the faces. Every keyframe below is generated from
 * the data, so timings and resting colours come from one place. Resting styles
 * are the END state; the section mounts at rest and plays when the reader
 * toggles or replays.
 */

type Mode = "without" | "with";
type Up = "asked" | "lapse";
type SessionRow = { r: string; q: string; s: string; up?: Up };

const W = 560;
const H = 400;
const MAYA = { x: 280, y: 36 };
const LEAD_Y = 130;
const SUB_Y = 232;
const DOT_Y = 318;
const LEADS: Record<string, number> = { eng: 164, growth: 436 };
const SUBS: Record<string, number> = { release: 60, infra: 164, mobile: 268, social: 382, ads: 492 };

const SESSIONS: SessionRow[] = [
  { r: "release", q: "Merge #412 before the freeze?", s: "merge-train" },
  { r: "infra", q: "Resize the worker pool to 6?", s: "worker-pool" },
  { r: "social", q: "Thread or a single post?", s: "launch-post" },
  { r: "mobile", q: "Bump the iOS build number?", s: "ios-build" },
  { r: "ads", q: "Pause the slowest ad group?", s: "ad-groups" },
  { r: "release", q: "Ship the checkout fix now?", s: "checkout-fix", up: "asked" },
  { r: "infra", q: "Rotate the staging key today?", s: "staging-keys" },
  { r: "ads", q: "Add 'free' as a negative keyword?", s: "search-terms" },
  { r: "mobile", q: "Use the new icon set?", s: "app-icons" },
  { r: "social", q: "Post the launch thread today?", s: "launch-thread", up: "lapse" },
  { r: "release", q: "Rerun the flaky e2e or skip it?", s: "e2e-retry" },
  { r: "infra", q: "Drop the old logs bucket?", s: "log-cleanup" },
  { r: "ads", q: "Rewrite headline 3?", s: "ad-copy" },
  { r: "social", q: "Quote the changelog line?", s: "changelog-post" },
];

// ---- Geometry and timing, derived once ------------------------------------

type Pt = { x: number; y: number; dwell?: number };
const SPEED = 340; // stage units per second
const LIGHT = (i: number) => 0.45 + i * 0.3;

const dotPos = (i: number): Pt => {
  const row = SESSIONS[i];
  const mates = SESSIONS.map((s, j) => ({ s, j })).filter(({ s }) => s.r === row.r);
  const k = mates.findIndex(({ j }) => j === i);
  const gap = 22;
  return { x: SUBS[row.r] + (k - (mates.length - 1) / 2) * gap, y: DOT_Y };
};

function route(i: number, mode: Mode): Pt[] {
  const row = SESSIONS[i];
  const from = dotPos(i);
  if (mode === "without") return [from, MAYA];
  const sub = { x: SUBS[row.r], y: SUB_Y };
  if (!row.up) return [from, sub];
  const lead = { x: LEADS[role(row.r).reportsTo], y: LEAD_Y, dwell: 0.3 };
  return [from, { ...sub, dwell: row.up === "lapse" ? 1.2 : 0.35 }, lead, MAYA];
}

type Trip = { name: string; start: number; dur: number; end: number; arriveRole: number; css: string };

function trip(i: number, mode: Mode): Trip {
  const pts = route(i, mode);
  const legs = pts.slice(1).map((p, k) => Math.max(0.28, Math.hypot(p.x - pts[k].x, p.y - pts[k].y) / SPEED));
  const dwells = pts.map((p) => p.dwell ?? 0);
  const TAIL = 0.18; // the dot fades on arrival
  const dur = legs.reduce((a, b) => a + b, 0) + dwells.reduce((a, b) => a + b, 0) + TAIL;
  const name = `og-ladder-tr-${mode}-${i}`;
  const frames: string[] = [];
  let t = 0;
  const put = (p: Pt, extra = "") => frames.push(`${((t / dur) * 100).toFixed(2)}% { transform: translate(${p.x}px, ${p.y}px);${extra} }`);
  put(pts[0], " opacity: 0;");
  pts.slice(1).forEach((p, k) => {
    t += legs[k];
    put(p, " opacity: 1;");
    if (p.dwell) { t += p.dwell; put(p, " opacity: 1;"); }
  });
  const last = pts[pts.length - 1];
  frames.push(`100% { transform: translate(${last.x}px, ${last.y}px); opacity: 0; }`);
  const start = LIGHT(i) + 0.2;
  return { name, start, dur, end: start + dur - TAIL, arriveRole: start + legs[0], css: `@keyframes ${name} { ${frames.join(" ")} }` };
}

const TRIPS: Record<Mode, Trip[]> = {
  without: SESSIONS.map((_, i) => trip(i, "without")),
  with: SESSIONS.map((_, i) => trip(i, "with")),
};

/** What reaches Maya in each mode, in arrival order. */
const REACH: Record<Mode, number[]> = {
  without: SESSIONS.map((_, i) => i),
  with: SESSIONS.map((s, i) => (s.up ? i : -1)).filter((i) => i >= 0),
};
const COUNT: Record<Mode, number> = { without: REACH.without.length, with: REACH.with.length };
const ANSWERED = SESSIONS.length - COUNT.with;

const anim = (style: CSSProperties = {}, animation: string): CSSProperties => ({ ...style, animation });

// ---- Small parts ------------------------------------------------------------

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

function Box({ x, y, children, className = "", style }: { x: number; y: number; children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`absolute -translate-x-1/2 -translate-y-1/2 ${className}`} style={{ left: pct(x, W), top: pct(y, H), ...style }}>
      {children}
    </div>
  );
}

/** A number that counts from `from` to `to` between two moments, resting on `to`. */
function Count({ from, to, t0, t1 }: { from: number; to: number; t0: number; t1: number }) {
  return (
    <span
      className="og-anim og-ladder-count tabular-nums"
      style={anim({ ["--og-ladder-n" as string]: to, ["--og-ladder-from" as string]: from, ["--og-ladder-to" as string]: to }, `og-ladder-count ${Math.max(0.01, t1 - t0)}s linear ${t0}s both`)}
    />
  );
}

function RoleNode({ id, x, y, size, dim, lead }: { id: string; x: number; y: number; size: number; dim: boolean; lead?: boolean }) {
  const r = role(id);
  return (
    <Box x={x} y={y + 6} className="flex flex-col items-center og-ladder-fadeable" style={{ opacity: dim ? 0.28 : 1, filter: dim ? "grayscale(1)" : undefined }}>
      <Tile k={r.k} size={size} className={lead ? "og-ladder-tile-lead" : "og-ladder-tile-sub"} />
      <span className="mt-1 sm:mt-1.5 font-mono text-[10px] sm:text-[12px] font-semibold whitespace-nowrap" style={{ color: TEXT }}>{r.handle}</span>
    </Box>
  );
}

// ---- The chart --------------------------------------------------------------

const elbow = (x1: number, y1: number, x2: number, y2: number) => `M${x1} ${y1} V${(y1 + y2) / 2} H${x2} V${y2}`;

function Chart({ mode }: { mode: Mode }) {
  const withOrg = mode === "with";
  const maya = person("maya");
  const trips = TRIPS[mode];
  const reach = REACH[mode].map((i) => trips[i].end);
  const lapse = SESSIONS.findIndex((s) => s.up === "lapse");
  return (
    <div className="relative w-full" style={{ aspectRatio: `${W} / ${H}` }}>
      <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} fill="none" aria-hidden>
        <g stroke={SOL.base1} strokeWidth={1.25} style={{ opacity: withOrg ? 1 : 0.25 }}>
          {Object.values(LEADS).map((x) => <path key={x} d={elbow(MAYA.x, MAYA.y + 23, x, LEAD_Y - 22)} />)}
          {Object.entries(SUBS).map(([id, x]) => <path key={id} d={elbow(LEADS[role(id).reportsTo], LEAD_Y + 38, x, SUB_Y - 20)} />)}
        </g>
        {SESSIONS.map((_, i) => {
          const p = dotPos(i);
          return withOrg
            ? <path key={i} d={`M${SUBS[SESSIONS[i].r]} ${SUB_Y + 38} L${p.x} ${p.y - 9}`} stroke={SOL.base1} strokeWidth={1} />
            : <path key={i} d={`M${p.x} ${p.y - 9} L${MAYA.x} ${MAYA.y + 23}`} stroke={tint(SOL.yellow, 55)} strokeWidth={1} strokeDasharray="2 3" pathLength={1} className="og-anim og-ladder-line" style={at(LIGHT(i) + 0.15)} />;
        })}
        {SESSIONS.map((s, i) => {
          const p = dotPos(i);
          const waits = !withOrg || !!s.up;
          const t1 = LIGHT(i);
          const t2 = trips[i].end + 0.1;
          const a = waits
            ? `og-ladder-ask .3s ease ${t1}s both`
            : `og-ladder-ask .3s ease ${t1}s both, og-ladder-ok .35s ease ${t2}s forwards`;
          return (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={7.5} className="og-anim" style={anim({ fill: waits ? SOL.yellow : SOL.green }, a)} />
              {!waits && <circle cx={p.x} cy={p.y} r={7.5} stroke={SOL.green} strokeWidth={1.5} className="og-anim og-ladder-ring" style={at(t2)} />}
            </g>
          );
        })}
      </svg>

      <Box x={MAYA.x} y={MAYA.y} className="flex items-center gap-2">
        <Person p={maya} size={42} className="og-ladder-maya" />
      </Box>
      <div className="absolute -translate-y-1/2 flex flex-col items-start leading-tight" style={{ left: pct(MAYA.x + 36, W), top: pct(MAYA.y, H) }}>
        <span className="font-mono text-[12px] sm:text-[13.5px] font-semibold whitespace-nowrap" style={{ color: INK }}>Maya Chen</span>
        <span className="font-mono text-[11px] sm:text-[12px] whitespace-nowrap" style={{ color: SOL.yellow }}>
          <Count from={1} to={COUNT[mode]} t0={reach[0]} t1={reach[reach.length - 1]} /> waiting on her
        </span>
      </div>

      {Object.entries(LEADS).map(([id, x]) => <RoleNode key={id} id={id} x={x} y={LEAD_Y} size={46} dim={!withOrg} lead />)}
      {Object.entries(SUBS).map(([id, x]) => <RoleNode key={id} id={id} x={x} y={SUB_Y} size={40} dim={!withOrg} />)}

      {withOrg && Object.entries(SUBS).map(([id, x]) => {
        const mine = SESSIONS.map((s, i) => ({ s, i })).filter(({ s }) => s.r === id);
        const answered = mine.filter(({ s }) => !s.up);
        const up = mine.find(({ s }) => s.up);
        const done = Math.max(...answered.map(({ i }) => trips[i].end)) + 0.2;
        return (
          <Box key={id} x={x} y={DOT_Y + 38} className="hidden sm:flex flex-col items-center font-mono text-[11.5px] leading-[1.4] whitespace-nowrap">
            <span className="og-anim og-pop" style={at(done, { color: SOL.green })}>✓ {answered.length} answered</span>
            {up && <span className="og-anim og-pop" style={at(trips[up.i].arriveRole + 0.2, { color: SOL.yellow })}>↑ 1 {up.s.up === "lapse" ? "up by lapse" : "passed up"}</span>}
          </Box>
        );
      })}

      {withOrg && (
        <Box x={SUBS.social + 42} y={SUB_Y - 22} className="og-anim og-ladder-blink hidden sm:block" style={at(trips[lapse].arriveRole)}>
          <span className="rounded-full px-1.5 py-px font-mono text-[11px] border whitespace-nowrap" style={{ borderColor: tint(SOL.orange, 50), color: SOL.orange, backgroundColor: PAPER }}>silent 5m</span>
        </Box>
      )}

      <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${W} ${H}`} aria-hidden>
        {trips.map((tr, i) => (
          <circle key={i} r={6} cx={0} cy={0} className="og-anim" style={anim({ fill: SOL.yellow, opacity: 0, filter: `drop-shadow(0 0 4px ${SOL.yellow})` }, `${tr.name} ${tr.dur}s cubic-bezier(.45,0,.3,1) ${tr.start}s both`)} />
        ))}
      </svg>
    </div>
  );
}

// ---- Maya's inbox -----------------------------------------------------------

const CLOCK = (i: number) => {
  const m = 2 * 60 + 5 + i * 14;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} pm`;
};

function FloodRows() {
  const trips = TRIPS.without;
  const order = [...REACH.without].reverse();
  return (
    <div className="relative h-full overflow-hidden">
      <div className="flex flex-col">
        {order.map((i) => (
          <div key={i} className="og-anim og-ladder-row overflow-hidden" style={anim({}, `og-ladder-row .45s cubic-bezier(.2,.75,.2,1) ${trips[i].end}s both`)}>
            <div className="flex items-center gap-2.5 px-3.5 py-2 border-b" style={{ borderColor: LINE }}>
              <SessionDot state="needs" size={8} />
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[12px] font-semibold truncate" style={{ color: INK }}>{SESSIONS[i].q}</div>
                <div className="font-mono text-[10.5px] truncate" style={{ color: DIM }}>{SESSIONS[i].s} · needs input</div>
              </div>
              <span className="font-mono text-[10px] shrink-0" style={{ color: DIM }}>{CLOCK(i)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="absolute inset-x-0 bottom-0 h-16 pointer-events-none" style={{ background: "linear-gradient(to bottom, transparent, #fffdf6)" }} />
    </div>
  );
}

type CardSpec = { i: number; lead: string; rec: string; options: [string, string]; under: number };
const CARDS: CardSpec[] = [
  { i: SESSIONS.findIndex((s) => s.up === "asked"), lead: "eng", rec: "Ship it. Tests are green and @release read the diff.", options: ["Ship", "Hold until Monday"], under: 8 },
  { i: SESSIONS.findIndex((s) => s.up === "lapse"), lead: "growth", rec: "Wait for the iOS review so the app link works.", options: ["After the review", "Post today"], under: 6 },
];

function Step({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-1 whitespace-nowrap">{children}</span>;
}
const Arrow = () => <span style={{ color: DIM }}>→</span>;

function LeadCard({ c }: { c: CardSpec }) {
  const lead = role(c.lead);
  const sub = role(SESSIONS[c.i].r);
  const lapsed = SESSIONS[c.i].up === "lapse";
  return (
    <div className="og-anim og-rise rounded-xl border px-3.5 py-3" style={at(TRIPS.with[c.i].end, { borderColor: tint(SOL.yellow, 55), backgroundColor: tint(SOL.yellow, 8) })}>
      <div className="flex items-center gap-2.5">
        <Tile k={lead.k} size={30} />
        <div className="min-w-0 flex-1">
          <div className="font-mono font-bold text-[12.5px] leading-tight truncate" style={{ color: INK }}>{lead.title}</div>
          <div className="font-mono text-[10.5px]" style={{ color: DIM }}>{lead.handle} · {c.under} sessions</div>
        </div>
        <span className="rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold shrink-0" style={{ backgroundColor: tint(SOL.yellow, 28), color: `color-mix(in srgb, ${SOL.yellow} 55%, ${INK})` }}>waiting on you</span>
      </div>
      <div className="mt-2.5 font-mono text-[13px] font-semibold leading-snug" style={{ color: INK }}>{SESSIONS[c.i].q}</div>
      <div className="mt-1 text-[12.5px] leading-snug" style={{ color: BODY }}>
        <span className="font-mono text-[10.5px] font-semibold mr-1.5" style={{ color: SOL.green }}>Recommends</span>{c.rec}
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[10.5px]" style={{ color: MUTED }}>
        <Step><SessionDot state="needs" size={7} />{SESSIONS[c.i].s}</Step><Arrow />
        <Step><Tile k={sub.k} size={15} />{sub.handle}{lapsed && <span style={{ color: SOL.orange }}>· silent 5m</span>}</Step><Arrow />
        <Step><Tile k={lead.k} size={15} />{lead.handle}</Step><Arrow />
        <Step><Person p={person("maya")} size={15} style={{ boxShadow: "none" }} />you</Step>
      </div>
      <div className="mt-3 flex gap-1.5">
        <span className="rounded-md px-2.5 py-1 font-mono text-[11px]" style={{ backgroundColor: INK, color: PAPER }}>{c.options[0]}</span>
        <span className="rounded-md px-2.5 py-1 font-mono text-[11px] border" style={{ borderColor: LINE, color: TEXT }}>{c.options[1]}</span>
      </div>
    </div>
  );
}

function Inbox({ mode }: { mode: Mode }) {
  const reach = REACH[mode].map((i) => TRIPS[mode][i].end);
  return (
    <Frame
      className="h-full flex flex-col"
      label={<>
        <Person p={person("maya")} size={16} style={{ boxShadow: "none" }} />
        <span style={{ color: TEXT }}>Maya&apos;s inbox</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-px" style={{ backgroundColor: tint(SOL.yellow, 22), color: INK }}>
          <SessionDot state="needs" size={6} />Needs input <b><Count from={1} to={COUNT[mode]} t0={reach[0]} t1={reach[reach.length - 1]} /></b>
        </span>
      </>}
    >
      <div className="h-[440px] lg:h-[480px] min-h-0">
        {mode === "without" ? <FloodRows /> : (
          <div className="p-3 space-y-2.5">
            {CARDS.map((c) => <LeadCard key={c.i} c={c} />)}
            <div className="og-anim og-fade flex items-center gap-2 px-1 pt-1 font-mono text-[11px]" style={at(TRIPS.with[SESSIONS.length - 1].end, { color: DIM })}>
              <SessionDot state="working" size={7} />{ANSWERED} answered by roles, none rang Maya
            </div>
          </div>
        )}
      </div>
    </Frame>
  );
}

// ---- The section ------------------------------------------------------------

function Toggle({ mode, onPick }: { mode: Mode; onPick: (m: Mode) => void }) {
  const opts: { m: Mode; label: string }[] = [{ m: "without", label: "Without an org" }, { m: "with", label: "With an org" }];
  return (
    <div role="radiogroup" aria-label="Compare" className="grid grid-cols-2 gap-2 sm:gap-3">
      {opts.map(({ m, label }) => {
        const on = m === mode;
        const accent = m === "with" ? SOL.green : SOL.yellow;
        const strong = `color-mix(in srgb, ${accent} 70%, ${INK})`;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onPick(m)}
            className={`og-press og-ladder-seg rounded-2xl px-4 sm:px-5 py-3.5 text-left flex items-end justify-between gap-3 ${on ? "" : "og-ladder-seg-off"}`}
            style={{
              border: `2px solid ${on ? accent : LINE}`,
              backgroundColor: on ? tint(accent, 12, "#fffdf6") : PAPER,
              boxShadow: on ? `0 0 0 4px ${tint(accent, 18, PAPER)}, 0 14px 30px -20px rgba(0,43,54,.5)` : "0 2px 0 rgba(88,110,117,.14)",
            }}
          >
            <span className="min-w-0">
              <span className="flex items-center gap-2 font-mono text-[13px] sm:text-[14px] font-semibold" style={{ color: on ? INK : TEXT }}>
                <span aria-hidden className="w-3.5 h-3.5 rounded-full shrink-0" style={{ border: `2px solid ${on ? accent : DIM}`, backgroundColor: on ? accent : "transparent", boxShadow: on ? `inset 0 0 0 2px ${PAPER}` : "none" }} />
                {label}
              </span>
              <span className="block mt-1 font-mono text-[11px]" style={{ color: on ? MUTED : DIM }}>questions that reach Maya</span>
            </span>
            <span className="font-mono font-bold text-[40px] sm:text-[56px] leading-none tracking-[-0.04em] tabular-nums" style={{ color: on ? strong : DIM }}>{COUNT[m]}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Ladder() {
  const [mode, setMode] = useState<Mode>("with");
  const [run, setRun] = useState(0);
  const play = (m: Mode) => { setMode(m); setRun((n) => n + 1); };
  return (
    <Section
      id="needs-you"
      title="Questions climb the chart before they reach you"
      lede={<p>A session under a role asks that role first. The role answers when its &quot;Starts work on its own&quot; switch is on and the call is inside its area; otherwise it passes the question up with its recommendation. Only the lead that reports to you raises it with you. The numbers are one illustrative afternoon with 14 sessions.</p>}
    >
      <style>{CSS}</style>
      <div className={run === 0 ? "og-ladder-rest" : undefined}>
        <Toggle mode={mode} onPick={play} />
        <div key={`${mode}-${run}`} className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Frame label={<><Tile k="org chart" size={16} /><span style={{ color: TEXT }}>Org</span><span className="ml-auto" style={{ color: DIM }}>{mode === "with" ? "5 roles, 2 leads" : "no roles"}</span></>}>
            <div className="og-grid px-2 py-3 sm:px-3 sm:py-4"><Chart mode={mode} /></div>
          </Frame>
          <Inbox mode={mode} />
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" onClick={() => play(mode)} className="og-press font-mono text-[12px] rounded-full border px-3 py-1" style={{ borderColor: LINE, color: MUTED, backgroundColor: PAPER }}>
            ↻ Replay
          </button>
        </div>
      </div>
    </Section>
  );
}

const KEYFRAMES = [...TRIPS.without, ...TRIPS.with].map((t) => t.css).join("\n");

const CSS = `
@property --og-ladder-n { syntax: "<integer>"; inherits: false; initial-value: 0; }
.og-ladder-count { counter-reset: og-ladder-n var(--og-ladder-n); }
.og-ladder-count::after { content: counter(og-ladder-n); }
@keyframes og-ladder-count { from { --og-ladder-n: var(--og-ladder-from); } to { --og-ladder-n: var(--og-ladder-to); } }
@keyframes og-ladder-ask { from { fill: ${SOL.green}; } to { fill: ${SOL.yellow}; } }
@keyframes og-ladder-ok { from { fill: ${SOL.yellow}; } to { fill: ${SOL.green}; } }
.og-ladder-ring { animation-name: og-ladder-ring; animation-duration: .7s; opacity: 0; transform-box: fill-box; transform-origin: center; }
@keyframes og-ladder-ring { from { opacity: .9; transform: scale(1); } to { opacity: 0; transform: scale(2.4); } }
.og-ladder-line { animation-name: og-ladder-line; animation-duration: .5s; }
@keyframes og-ladder-line { from { opacity: 0; } to { opacity: 1; } }
.og-ladder-blink { animation-name: og-ladder-blink; animation-duration: 1.2s; }
@keyframes og-ladder-blink { 0% { opacity: 0; transform: translate(-50%, -50%) scale(.6); } 25% { opacity: 1; transform: translate(-50%, -50%) scale(1.15); } 45% { opacity: .35; transform: translate(-50%, -50%) scale(1); } 65%, 100% { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
@keyframes og-ladder-row { from { max-height: 0; opacity: 0; } to { max-height: 64px; opacity: 1; } }
.og-ladder-seg-off { cursor: pointer; transition: border-color .18s ease, background-color .18s ease, transform .12s ease; }
.og-ladder-seg-off:hover { border-color: ${SOL.base1} !important; background-color: #fffdf6 !important; }
@media (max-width: 639px) {
  .og-ladder-tile-sub { width: 28px !important; height: 28px !important; border-radius: 8px !important; }
  .og-ladder-tile-lead { width: 34px !important; height: 34px !important; border-radius: 10px !important; }
  .og-ladder-maya { width: 32px !important; height: 32px !important; font-size: 12px !important; }
}
.og-ladder-fadeable { transition: opacity .4s ease, filter .4s ease; }
.og-ladder-rest .og-anim { animation: none !important; }
${KEYFRAMES}
`;
