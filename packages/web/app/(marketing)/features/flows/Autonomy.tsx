"use client";

import { Fragment, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNearViewport } from "@/hooks/useNearViewport";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { Card, DIM, INK, Label, LINE, MUTED, PERSON, Section, at, usePlayOnView, useStill } from "./kit";
import { CAUSE, CHANGE, ROLE } from "./story";
import "./autonomy.css";

/*
 * The payoff of /features/flows: the regret-free rate (shared/contracts/
 * regretRates.ts), the merge step's two modes (convex/lib/lineMerge.ts, its
 * refusals verbatim, in its order), who may change the mode
 * (convex/orgLineMerge.ts), and the library of pool flows (workflow/templates).
 *
 * The window figure and the settling figure share one history: the window the
 * first one measures is the window every change in the second one waits out.
 * The story's cause (CAUSE.sha, written by the Checkout role's line) is the
 * regretted change on the Line bucket and on the Checkout role's record.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** True while the element is on screen; clocks run only then. */
function useOnScreen(ref: React.RefObject<Element | null>) {
  return useNearViewport(ref, "0px", { latch: false });
}

/** One play control for every clock in these figures. */
function PlayButton({ playing, onClick, label }: { playing: boolean; onClick: () => void; label?: string }) {
  return (
    <button type="button" className="flx-auto-btn" onClick={onClick} aria-label={label ? `${playing ? "Pause" : "Play"} ${label}` : undefined}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden className="inline-block mr-1.5 -mt-px">
        {playing ? <path d="M2 1.5h2v7H2zM6 1.5h2v7H6z" fill="currentColor" /> : <path d="M2.5 1.2l6 3.8-6 3.8z" fill="currentColor" />}
      </svg>
      {playing ? "Pause" : "Play"}
    </button>
  );
}

/** A range input drawn with a cyan filled track up to its value. */
function Slider({ min, max, step = 1, value, label, onChange, onCommit, style }: {
  min: number;
  max: number;
  step?: number;
  value: number;
  label?: string;
  onChange: (v: number) => void;
  onCommit?: () => void;
  style?: CSSProperties;
}) {
  const p = ((value - min) / (max - min)) * 100;
  return (
    <input
      type="range"
      className="flx-auto-range"
      min={min}
      max={max}
      step={step}
      value={value}
      aria-label={label}
      style={{ ["--p" as string]: `${p}%`, ...style } as CSSProperties}
      onChange={(e) => onChange(Number(e.target.value))}
      onPointerUp={onCommit}
      onKeyUp={onCommit}
      onBlur={onCommit}
    />
  );
}

/* ------------------------------------------------------------------------- */
/* The window: regretRates.windowFromLags                                     */
/* ------------------------------------------------------------------------- */

type HistoryId = "fast" | "slow" | "none";
const HISTORIES: { id: HistoryId; name: string; lags: number[] }[] = [
  { id: "fast", name: "Fast fixes", lags: [0.2, 0.4, 0.6, 0.9, 1.1, 1.3, 1.6, 1.9, 2.2, 2.6, 3.0, 3.4, 3.9, 4.6, 5.3, 7.8, 9.5, 12.4, 17.0, 26.0] },
  { id: "slow", name: "Slow fixes", lags: [0.8, 2.1, 3.5, 4.8, 6.2, 7.9, 9.4, 11.0, 12.6, 14.1, 15.8, 17.3, 19.9, 22.5, 27.0, 34.0] },
  { id: "none", name: "None traced", lags: [] },
];
/** Fixes the reader adds, in this order: a mix of quick and late ones. */
const MORE = [8.5, 0.7, 11.2, 2.4, 13.9, 6.6, 21.0, 4.1, 9.9, 1.8, 15.2, 3.3];

const WINDOW_DEFAULT = 14;
const WINDOW_MAX = 30;
const AXIS = 32; // the dot plot's axis in days; lags past 30 sit in a "30+" bin

type Window = { days: number; p75: number | null; idx: number; n: number };

/** Sort the lags, take index ceil(n·0.75)−1, round up to whole days, clamp 1..30; 14 with no links. */
function windowOf(lags: number[]): Window {
  if (lags.length === 0) return { days: WINDOW_DEFAULT, p75: null, idx: -1, n: 0 };
  const s = [...lags].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.ceil(s.length * 0.75) - 1);
  return { days: Math.min(WINDOW_MAX, Math.max(1, Math.ceil(s[idx]))), p75: s[idx], idx, n: s.length };
}

const ax = (d: number) => `${(Math.min(d, AXIS) / AXIS) * 100}%`;

function WindowFigure({ hist, onHist, added, onAdd, lags, win }: {
  hist: HistoryId;
  onHist: (h: HistoryId) => void;
  added: number;
  onAdd: () => void;
  lags: number[];
  win: Window;
}) {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const order = lags.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const rank = new Map(order.map((o, r) => [o.i, r]));
  const stack = new Map<number, number>();
  const dots = lags.map((v, i) => {
    const bin = Math.min(30, Math.floor(v));
    const k = stack.get(bin) ?? 0;
    stack.set(bin, k + 1);
    const r = rank.get(i) ?? 0;
    return { v, i, bin, k, r, top: r === win.idx, inside: v <= win.days };
  });
  const top = dots.find((d) => d.top);
  return (
    <div ref={ref} data-play={playing ? "" : undefined}>
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="group" aria-label="Fix history" className="flx-auto-seg">
            {HISTORIES.map((h) => (
              <button key={h.id} type="button" aria-pressed={hist === h.id} onClick={() => onHist(h.id)}>{h.name}</button>
            ))}
          </div>
          <button type="button" className="flx-auto-btn" onClick={onAdd} disabled={added >= MORE.length}>+ Add a fix</button>
        </div>

        <div className="mt-8 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_220px] gap-6 md:gap-10 items-end">
          <div className="min-w-0">
            <div className="flx-rate-plot" aria-hidden>
              <div className="flx-rate-band" style={{ width: ax(win.days) }} data-default={win.n === 0 ? "" : undefined}>
                <span className="flx-rate-band-edge">{win.days}d</span>
              </div>
              {dots.map((d) => (
                <span
                  key={`${hist}-${d.i}`}
                  className="flx-rate-dot"
                  data-in={d.inside ? "" : undefined}
                  data-top={d.top ? "" : undefined}
                  style={at(0.1 + d.r * 0.035, { left: `calc(${ax(d.bin + 0.5)} - 5px)`, bottom: `${6 + d.k * 12}px` })}
                />
              ))}
              {top ? <span className="flx-rate-dot-tag" style={{ left: ax(top.bin + 0.5), bottom: `${22 + top.k * 12}px` }}>75th</span> : null}
              {win.n === 0 ? <div className="flx-rate-empty">no fix traced to a change</div> : null}
            </div>
            <div className="flx-rate-axis" aria-hidden>
              {[0, 7, 14, 21, 30].map((d) => (
                <span key={d} style={{ left: ax(d) }}>{d === 30 ? "30+" : d}</span>
              ))}
            </div>
            <div className="flx-rate-plotfoot">
              <span>days from going live to its top fix, last 60 days</span>
              <ul className="flx-rate-dotkey" aria-hidden>
                <li data-k="in">inside the window</li>
                <li data-k="top">the 75th lag</li>
                <li data-k="out">past it</li>
              </ul>
            </div>
          </div>

          <div className="flx-rate-result" aria-live="polite">
            <div className="font-mono text-[13px]" style={{ color: MUTED }}>window</div>
            <div key={win.days} className="flx-rate-big" data-default={win.n === 0 ? "" : undefined}>
              <b className="flx-auto-num">{win.days}</b><span>days</span>
            </div>
            <dl className="flx-rate-kv mt-4">
              {win.n > 0 && win.p75 !== null ? (
                <>
                  <dt>fixes traced</dt><dd>{win.n}</dd>
                  <dt>75th lag</dt><dd>#{win.idx + 1}, {win.p75.toFixed(1)}d</dd>
                  <dt>rounded up</dt><dd>{win.days === WINDOW_MAX && win.p75 > WINDOW_MAX ? "capped at 30" : `${win.days} days`}</dd>
                  <dt>bounds</dt><dd>1 to 30 days</dd>
                </>
              ) : (
                <>
                  <dt>fixes traced</dt><dd>0</dd>
                  <dt>with no links</dt><dd>14 days</dd>
                </>
              )}
            </dl>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* Settling: regretted / settled / partial, per bucket                        */
/* ------------------------------------------------------------------------- */

const SPAN = 30; // days of history the scrubber walks
const VIEW = 36; // the track shows a little past today so open windows read as open
const tx = (d: number) => `${(Math.max(0, Math.min(d, VIEW)) / VIEW) * 100}%`;

type Chg = { at: number; back?: number; kind?: "fix" | "reopen"; sha?: string };
const NOFLOW_BACK: Record<number, Omit<Chg, "at">> = {
  2: { back: 5.2, kind: "fix" },
  7: { back: 19, kind: "fix" },
  9: { back: 15, kind: "reopen" },
  13: { back: 21, kind: "fix" },
};
const BUCKETS: { id: string; name: string; sub: string; color: string; changes: Chg[] }[] = [
  {
    id: "line", name: "Line", sub: "a role's run", color: LINE,
    // CAUSE went live on day 23; the person's fix (CHANGE.landed) landed three days later and blames to it.
    changes: [{ at: 16 }, { at: 18.5 }, { at: 21 }, { at: 23, back: 26, kind: "fix", sha: CAUSE.sha }, { at: 25.5 }, { at: 27 }, { at: 28.5 }],
  },
  {
    id: "person", name: "Person", sub: "a session's flow", color: PERSON,
    changes: [{ at: 2 }, { at: 5 }, { at: 9, back: 12, kind: "fix" }, { at: 13 }, { at: 17, back: 26, kind: "reopen" }, { at: 21 }, { at: 24 }, { at: 27 }],
  },
  { id: "outside", name: "No flow", sub: "no check flow", color: MUTED, changes: Array.from({ length: 20 }, (_, i) => ({ at: Math.round(i * 14.5) / 10, ...NOFLOW_BACK[i] })) },
];

type St = "ahead" | "partial" | "clean" | "regret";

function stateOf(c: Chg, w: number, now: number) {
  const end = c.at + w;
  const hit = c.back !== undefined && c.back > c.at && c.back <= end ? c.back : null;
  const late = c.back !== undefined && hit === null && now >= c.back;
  const st: St = now < c.at ? "ahead" : hit !== null && hit <= now ? "regret" : end <= now ? "clean" : "partial";
  return { st, end, hit, late };
}

function measure(changes: Chg[], w: number, now: number) {
  let n = 0, settled = 0, regretted = 0;
  for (const c of changes) {
    const { st } = stateOf(c, w, now);
    if (st === "ahead") continue;
    n++;
    if (st === "regret") { settled++; regretted++; }
    if (st === "clean") settled++;
  }
  return { n, settled, regretted, partial: n - settled, rate: settled > 0 ? (settled - regretted) / settled : null };
}

/** A bucket's rate as the figure's headline: the Loop's three readouts, set large. */
function BigRate({ name, color, m }: { name: string; color: string; m: ReturnType<typeof measure> }) {
  return (
    <div className="flx-rate-hero">
      <div className="flx-rate-hero-k"><i style={{ backgroundColor: color }} />{name}</div>
      {m.rate !== null ? (
        <>
          <div key={pct(m.rate)} className="flx-rate-hero-v" data-tone={m.rate >= 0.9 ? "good" : m.rate >= 0.75 ? "mid" : "bad"}>{pct(m.rate)}</div>
          <div className="flx-rate-hero-s">of <b>{m.settled}</b> settled{m.partial ? <>, {m.partial} partial</> : null}</div>
        </>
      ) : (
        <>
          <div className="flx-rate-hero-v" data-tone="none">{m.n ? "none settled" : "no changes"}</div>
          <div className="flx-rate-hero-s">{m.n ? <><b>{m.n}</b> partial</> : "nothing live yet"}</div>
        </>
      )}
    </div>
  );
}

function SettleFigure({ windowDays }: { windowDays: number }) {
  const still = useStill();
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const onScreen = useOnScreen(ref);
  const [now, setNow] = useState(SPAN);
  const [auto, setAuto] = useState(true);
  const started = useRef(false);

  useWatchEffect(() => {
    if (still || !playing || !auto || !onScreen) return;
    if (!started.current) { started.current = true; setNow(0); return; }
    const t = setTimeout(() => setNow(now >= SPAN ? 0 : Math.min(SPAN, now + 0.5)), now >= SPAN ? 3400 : 150);
    return () => clearTimeout(t);
  }, [now, auto, still, playing, onScreen]);

  const shown = still ? SPAN : now;
  const togglePlay = () => {
    if (!auto && now >= SPAN) setNow(0);
    started.current = true;
    setAuto(!auto);
  };
  const measured = BUCKETS.map((b) => measure(b.changes, windowDays, shown));

  return (
    <div ref={ref} data-play={playing ? "" : undefined}>
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <PlayButton playing={auto && !still} onClick={togglePlay} label="the days" />
          <span className="font-mono text-[13px] font-semibold" style={{ color: INK }}>
            day <span className="flx-auto-num">{Math.floor(shown)}</span> of {SPAN}
          </span>
          <span className="font-mono text-[13px]" style={{ color: MUTED }}>each change waits <b style={{ color: LINE }}>{windowDays} days</b> from going live</span>
        </div>

        <div className="flx-rate-heroes mt-6">
          {BUCKETS.map((b, i) => <BigRate key={b.id} name={b.name} color={b.color} m={measured[i]} />)}
        </div>

        <ul className="flx-rate-legend mt-6">
          <li data-st="partial"><b>partial</b> window open, not counted yet</li>
          <li data-st="clean"><b>regret-free</b> window closed clean</li>
          <li data-st="regret"><b>regretted</b> top fix or reopen inside it</li>
          <li data-st="late"><b>after the window</b> does not count</li>
        </ul>

        <div className="mt-5 flx-rate-grid">
          {BUCKETS.map((b, bi) => {
            const m = measured[bi];
            return (
              <Fragment key={b.id}>
                <div className="flx-rate-name">
                  <span className="flx-rate-name-k"><i style={{ backgroundColor: b.color }} />{b.name}</span>
                  <small>{b.sub}</small>
                </div>
                <div className="flx-rate-track" aria-label={`${b.name}: ${m.settled} settled, ${m.regretted} regretted, ${m.partial} partial`}>
                  <span className="flx-rate-now" style={{ left: tx(shown) }} aria-hidden />
                  {b.changes.map((c, i) => {
                    const s = stateOf(c, windowDays, shown);
                    const fillTo = s.st === "regret" ? (s.hit ?? c.at) : s.st === "clean" ? s.end : Math.min(shown, s.end);
                    return (
                      <div key={i} className="flx-rate-row" data-st={s.st} aria-hidden>
                        {c.sha ? <span className="flx-rate-sha" style={{ left: tx(c.at) }}>{c.sha}</span> : null}
                        <span className="flx-rate-wbar" style={{ left: tx(c.at), width: `calc(${tx(s.end)} - ${tx(c.at)})` }} />
                        <span className="flx-rate-fill" style={{ left: tx(c.at), width: `calc(${tx(Math.max(c.at, fillTo))} - ${tx(c.at)})` }} />
                        <span className="flx-rate-sq" style={{ left: tx(c.at) }} />
                        {s.st === "regret" && s.hit !== null ? <span className="flx-rate-hit" style={{ left: tx(s.hit) }} /> : null}
                        {s.late && c.back !== undefined ? <span className="flx-rate-late" style={{ left: tx(c.back) }} /> : null}
                      </div>
                    );
                  })}
                </div>
              </Fragment>
            );
          })}
          <div aria-hidden className="flx-rate-gridpad" />
          <div className="flx-rate-scrub">
            <Slider
              min={0}
              max={SPAN}
              step={0.5}
              value={shown}
              label="Day"
              style={{ width: `${(SPAN / VIEW) * 100}%` }}
              onChange={(v) => { started.current = true; setAuto(false); setNow(v); }}
            />
            <div className="flx-rate-axis flx-rate-axis-t" aria-hidden>
              {[0, 7, 14, 21].map((d) => <span key={d} style={{ left: tx(d) }}>{d}</span>)}
              <span style={{ left: tx(SPAN) }} className="flx-rate-today">today</span>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

export function RateSection() {
  const [hist, setHist] = useState<HistoryId>("fast");
  const [added, setAdded] = useState(0);
  const lags = (HISTORIES.find((h) => h.id === hist)?.lags ?? []).concat(MORE.slice(0, added));
  const win = windowOf(lags);
  return (
    <Section
      id="autonomy"
      tone="paper"
      wide
      title="A regret-free rate, measured from your own history"
      lede={
        <p>
          Every night, each fix on main is blamed back to the change that gave it the most lines, its <b>top introducer</b>. The
          75th percentile of the lag from going live to that fix is the window. A change is regret-free if its window closes
          with no top fix and no reopen.
        </p>
      }
    >
      <WindowFigure hist={hist} onHist={(h) => { setHist(h); setAdded(0); }} added={added} onAdd={() => setAdded(added + 1)} lags={lags} win={win} />
      <div className="mt-5">
        <SettleFigure windowDays={win.days} />
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------- */
/* Merge modes: lineMerge.mergeAllowance                                      */
/* ------------------------------------------------------------------------- */

/**
 * The Checkout role's own line changes, week by week: settled and regretted so
 * far. Week 10 is now: CAUSE settles regretted and the rate drops under 90%.
 */
const WEEKS = [
  { s: 3, r: 1 }, { s: 6, r: 1 }, { s: 10, r: 1 }, { s: 14, r: 1 }, { s: 18, r: 1 },
  { s: 22, r: 1 }, { s: 26, r: 1 }, { s: 29, r: 2 }, { s: 33, r: 3 }, { s: 37, r: 4 },
];
const NOW_WEEK = WEEKS.length;
const ATTEMPTS = 8;
const SETTLED_AXIS = 40;
const REFUSE_MODE = "Only a person sets how the merge step decides, from the role's settings";

type Mode = "count" | "rate";

const modeValue = (mode: Mode, bar: number, min: number) => (mode === "rate" ? `${Number((bar / 100).toFixed(2))}/${min}` : "count");

/** Today's merge attempts, each decided the way the merge step decides, in its order. */
function decideDay(mode: Mode, bar: number, min: number, limit: number, settled: number, rate: number | null): (string | null)[] {
  let used = 0;
  return Array.from({ length: ATTEMPTS }, () => {
    let reason: string | null = null;
    if (mode === "rate") {
      if (settled < min) reason = `only ${settled} of the ${min} finished changes the rate needs`;
      else if (rate === null || rate < bar / 100) reason = `the role's regret-free rate is ${rate === null ? "unknown" : pct(rate)}, under its bar of ${bar}%`;
    }
    if (!reason && used >= limit) reason = `the role has reached its daily merge limit (${used} of ${limit})`;
    if (!reason) used++;
    return reason;
  });
}

function LabeledSlider({ label, value, shown, min, max, step = 1, onChange, onCommit }: {
  label: string;
  value: number;
  shown: ReactNode;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
}) {
  return (
    <label className="flx-auto-slider">
      <span className="flx-auto-slider-k">{label}</span>
      <span className="flx-auto-slider-v">{shown}</span>
      <Slider min={min} max={max} step={step} value={value} onChange={onChange} onCommit={onCommit} />
    </label>
  );
}

function PersonGlyph({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden className="inline-block shrink-0">
      <circle cx="8" cy="5.2" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.8 14c.6-2.9 2.7-4.4 5.2-4.4s4.6 1.5 5.2 4.4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Meter({ label, value, shown, tick, tickLabel, lo, hi, pass, off }: {
  label: ReactNode;
  value: number;
  shown: ReactNode;
  tick: number;
  tickLabel: string;
  lo: number;
  hi: number;
  pass: boolean;
  off: boolean;
}) {
  const p = (v: number) => `${((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100}%`;
  return (
    <div className="flx-auto-meter" data-pass={pass ? "" : undefined} data-off={off ? "" : undefined}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-[13px]" style={{ color: MUTED }}>{label}</span>
        <span className="font-mono text-[16px] font-bold flx-auto-num" style={{ color: INK }}>{shown}</span>
      </div>
      <div className="flx-auto-meter-track">
        <span className="flx-auto-meter-fill" style={{ width: p(value) }} />
        <span className="flx-auto-meter-tick" style={{ left: p(tick) }}><em>{tickLabel}</em></span>
      </div>
    </div>
  );
}

const span = (a: number, b: number) => (a === b ? `change ${a + 1}` : `changes ${a + 1} to ${b + 1}`);

function AutonomyFigure() {
  const still = useStill();
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const onScreen = useOnScreen(ref);
  const [mode, setMode] = useState<Mode>("rate");
  const [bar, setBar] = useState(90);
  const [min, setMin] = useState(20);
  const [limit, setLimit] = useState(5);
  const [week, setWeek] = useState(NOW_WEEK);
  const [reveal, setReveal] = useState(ATTEMPTS);
  const [auto, setAuto] = useState(true);
  const [log, setLog] = useState([{ id: 0, from: "count", to: "0.9/20" }]);
  const logged = useRef("0.9/20");
  const started = useRef(false);

  // A day: eight changes ask to merge one after another, then the role's history
  // moves on a week, ending on now (week 10). Touching the history holds it.
  useWatchEffect(() => {
    if (still || !playing || !onScreen) return;
    if (!started.current) { started.current = true; setWeek(1); setReveal(0); return; }
    if (reveal < ATTEMPTS) {
      const t = setTimeout(() => setReveal(reveal + 1), reveal === 0 ? 700 : 480);
      return () => clearTimeout(t);
    }
    if (!auto) return;
    const t = setTimeout(() => { setWeek(week >= NOW_WEEK ? 1 : week + 1); setReveal(0); }, week === NOW_WEEK ? 4200 : 2000);
    return () => clearTimeout(t);
  }, [reveal, week, auto, still, playing, onScreen]);

  const h = WEEKS[week - 1];
  const rate = h.s > 0 ? (h.s - h.r) / h.s : null;
  const day = decideDay(mode, bar, min, limit, h.s, rate);
  const shownReveal = still ? ATTEMPTS : reveal;
  const merged = day.slice(0, shownReveal).filter((r) => r === null).length;
  const cur = shownReveal > 0 ? shownReveal - 1 : null;
  const reason = cur === null ? undefined : day[cur];
  // The verdict speaks for every shown change that got the same answer.
  let first = cur ?? 0;
  while (cur !== null && first > 0 && day[first - 1] === reason) first--;
  const inGroup = (i: number) => cur !== null && i >= first && i <= cur;

  const commit = (next: string) => {
    if (next === logged.current) return;
    const from = logged.current;
    logged.current = next;
    setLog((l) => [{ id: l[0].id + 1, from, to: next }, ...l].slice(0, 3));
  };
  const pickMode = (m: Mode) => { setMode(m); commit(modeValue(m, bar, min)); };
  const rateOff = mode !== "rate";
  const causeSettled = week === NOW_WEEK;

  return (
    <div ref={ref} data-play={playing ? "" : undefined} className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-5">
      {/* The role's settings, the way the app lays them out. */}
      <Card className="p-5 sm:p-6 flex flex-col">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-[16px]" style={{ color: INK }}><b>{ROLE.name}</b> <span style={{ color: MUTED }}>merge step</span></div>
          <span className="flx-auto-on">On</span>
        </div>
        <div className="mt-1 font-mono text-[12px]" style={{ color: DIM }}>merge grant, {limit} a day, expires in 90 days</div>

        <div className="mt-6">
          <div className="flex items-baseline justify-between gap-3">
            <Label>Decides by</Label>
            <span className="font-mono text-[12px]" style={{ color: PERSON }}>role admin, either way</span>
          </div>
          <div role="group" aria-label="How the merge step decides" className="flx-auto-seg flx-auto-mode mt-2">
            <button type="button" aria-pressed={mode === "count"} onClick={() => pickMode("count")}>Count</button>
            <button type="button" aria-pressed={mode === "rate"} onClick={() => pickMode("rate")}>Rate</button>
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-4">
          {mode === "rate" ? (
            <>
              <LabeledSlider label="Bar, regret-free" value={bar} shown={`${bar}%`} min={50} max={100} onChange={setBar} onCommit={() => commit(modeValue("rate", bar, min))} />
              <LabeledSlider label="Min, settled changes" value={min} shown={min} min={1} max={SETTLED_AXIS} onChange={setMin} onCommit={() => commit(modeValue("rate", bar, min))} />
            </>
          ) : null}
          <LabeledSlider label={mode === "rate" ? "Daily limit, backstop" : "Daily limit"} value={limit} shown={`${limit} a day`} min={1} max={ATTEMPTS} onChange={setLimit} />
        </div>

        <div className="mt-auto pt-6">
          <Label color={MUTED}>Who sets the mode</Label>
          <ul className="flx-auto-who mt-2">
            <li data-ok=""><span><PersonGlyph /> Role admin, role settings</span><em>sets it</em></li>
            <li><span>Agent session</span><em>refused</em></li>
            <li><span>API token</span><em>refused</em></li>
          </ul>
          <div className="flx-auto-refusal mt-2">{REFUSE_MODE}</div>
        </div>
      </Card>

      {/* What the merge step makes of today's changes. */}
      <Card className="p-5 sm:p-6 flex flex-col">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="font-mono text-[16px]" style={{ color: INK }}><b>{ROLE.name}</b> <span style={{ color: MUTED }}>line changes</span></div>
          <label className="flx-auto-week ml-auto">
            <span className="font-mono text-[13px]" style={{ color: MUTED }}>week <b className="flx-auto-num" style={{ color: INK }}>{week}</b>{week === NOW_WEEK ? " (now)" : ""}</span>
            <Slider min={1} max={NOW_WEEK} value={week} label="Weeks of history" onChange={(v) => { setAuto(false); setWeek(v); setReveal(ATTEMPTS); }} />
          </label>
          <PlayButton playing={auto && !still} onClick={() => { started.current = true; setAuto(!auto); }} label="the weeks" />
        </div>

        <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
          <Meter label="settled" value={h.s} shown={h.s} tick={min} tickLabel={`min ${min}`} lo={0} hi={SETTLED_AXIS} pass={h.s >= min} off={rateOff} />
          <Meter label={<>regret-free, <span className="flx-auto-num">{h.r}</span> regretted</>} value={rate ?? 0} shown={rate === null ? "none" : pct(rate)} tick={bar / 100} tickLabel={`bar ${bar}%`} lo={0.5} hi={1} pass={rate !== null && rate >= bar / 100} off={rateOff} />
        </div>
        <div className="flx-auto-cause" data-on={causeSettled ? "" : undefined}>
          <span>newest regret</span>
          <code>{CAUSE.sha}</code>
          <span>{causeSettled ? `${CAUSE.subject}, fixed by ${CHANGE.landed}` : "not settled yet"}</span>
        </div>

        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-3">
            <Label color={MUTED}>Today, asking to merge</Label>
            <span className="font-mono text-[13px]" style={{ color: MUTED }}>
              <b className="flx-auto-num" style={{ color: INK }}>{merged}</b> merged, limit {limit}
            </span>
          </div>
          <ol className="flx-auto-day mt-2">
            {day.map((r, i) => (
              <li key={i} data-v={i >= shownReveal ? "ahead" : r === null ? "merged" : "review"} data-group={inGroup(i) ? "" : undefined} data-limit={i === limit - 1 ? "" : undefined}>
                <span className="flx-auto-num">{i + 1}</span>
                {i < shownReveal && r !== null ? <PersonGlyph size={11} /> : null}
              </li>
            ))}
          </ol>
        </div>

        <div className="flx-auto-verdict mt-4" data-v={reason === undefined ? "wait" : reason === null ? "merged" : "review"} aria-live="polite">
          {reason === undefined || cur === null ? (
            <div className="font-mono text-[13px]" style={{ color: DIM }}>waiting for the first change</div>
          ) : reason === null ? (
            <>
              <div className="flx-auto-verdict-head">Merged without a person</div>
              <div className="flx-auto-verdict-sub">{span(first, cur)} on main</div>
            </>
          ) : (
            <>
              <div className="flx-auto-verdict-head"><PersonGlyph size={16} /> In Review</div>
              <div className="flx-auto-verdict-reason">{reason}</div>
              <div className="flx-auto-verdict-sub">{span(first, cur)} wait{first === cur ? "s" : ""} for a person; the runs are not failed</div>
            </>
          )}
        </div>

        <ol className="flx-auto-log mt-4" aria-label="Role history">
          {log.map((e, i) => (
            <li key={e.id} data-new={i === 0 && e.id > 0 ? "" : undefined}>
              <span className="flx-auto-log-who"><PersonGlyph size={11} /> role admin</span>
              <code>line_merge_rate: {e.from} → {e.to}</code>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

export function AutonomySection() {
  return (
    <Section
      id="merge"
      tone="sand"
      wide
      title="Autonomy is earned"
      lede={
        <>
          <p>
            A role&apos;s merge step decides by <b>Count</b>, a daily limit, or by <b>Rate</b>: merge only while the role&apos;s
            own regret-free rate clears a bar over enough settled changes, with the daily limit still behind it. A role admin
            sets Count or Rate, in either direction.
          </p>
          <p>A refused merge leaves the task In Review for a person, and the run is not failed.</p>
        </>
      }
    >
      <AutonomyFigure />
    </Section>
  );
}

/* ------------------------------------------------------------------------- */
/* The library                                                                */
/* ------------------------------------------------------------------------- */

type Kind = "shell" | "agent" | "person";
type Tone = "good" | "live" | "bad" | "back" | "plain" | "loop" | "warn";
/** `cont`: a way out that carries on (a way back, a loop, Already landed in Change), so not an end of the flow. */
type End = { name: string; tone: Tone; cont?: boolean };
type Step = { name: string; kind: Kind; sub?: string; n?: number; opt?: boolean; ends?: End[] };
/** `ends` on a step hang under it, the way the Flows page draws them; `more` are ways out not tied to one step. */
type LibFlow = { id: string; name: string; from?: string; steps: Step[]; exit: End; more?: End[] };

const step = (kind: Kind) => (name: string, ends?: End[], o?: { sub?: string; n?: number; opt?: boolean }): Step => ({ name, kind, ends, ...o });
const S = step("shell");
const A = step("agent");
const P = step("person");
const way = (name: string): End => ({ name, tone: "back", cont: true });
const asked = (name: string): End => ({ name, tone: "back" });
const bad = (name: string): End => ({ name, tone: "bad" });
const plain = (name: string, cont?: boolean): End => ({ name, tone: "plain", cont });
const loop = (name: string): End => ({ name, tone: "loop", cont: true });
const good = (name: string): End => ({ name, tone: "good" });
const LIVE: End = { name: "Live", tone: "live" };

const LIBRARY: LibFlow[] = [
  {
    id: "line", name: "line", exit: good("Exit"),
    steps: [
      A("Ground"), A("Plan", undefined, { opt: true }), A("Analyze"), A("Prove"), S("Red"), A("Implement"), S("Verify"), S("Green"), S("Eval"),
      A("Review"), S("Card draft"), A("Present"), S("Card"), P("Decide"), S("Rebase"), S("Ship"), S("Watch"),
    ],
    more: [way("Revise"), plain("Park"), plain("Dissolve"), plain("Unproven"), plain("Unscored"), bad("Stopped"), bad("Rejected"), bad("Drop")],
  },
  {
    id: "prove", name: "Prove, then implement", exit: good("Built and green"),
    steps: [A("Prove"), S("Red"), A("Implement"), S("Verify"), S("Green")],
    more: [loop("no miss shown"), loop("checks failed"), loop("still red"), plain("Dissolved"), plain("Unproven"), bad("Cannot build")],
  },
  {
    id: "change", name: "Change", from: "Session", exit: LIVE,
    steps: [
      S("Check", [way("Fix check")]),
      A("Review", [way("Address review"), bad("Rejected")]),
      P("Decide", [way("Revise"), bad("Dropped")]),
      S("Land", [plain("Already landed", true), way("Resolve conflict"), bad("Not shipped")], { sub: "2 steps", n: 2 }),
      S("Deploy", [bad("Deploy failed")]),
    ],
  },
  {
    id: "quick", name: "Quick", from: "Session", exit: LIVE,
    steps: [S("Check", [way("Fix check")]), A("Review", [way("Address review"), bad("Rejected")]), S("Land", [way("Resolve conflict"), bad("Not shipped")], { sub: "2 steps", n: 2 }), S("Deploy")],
  },
  { id: "check", name: "Check", exit: good("Passed"), steps: [S("Verify", [bad("Checks failed")])] },
  { id: "review", name: "Review", exit: good("Approved"), steps: [A("Review", [asked("Changes asked"), bad("Rejected")])] },
  { id: "eval", name: "Eval", exit: good("Passed"), steps: [S("Eval", [plain("Unscored"), bad("Eval failed")])] },
  { id: "judge", name: "Judge", exit: good("Low risk"), steps: [S("Guidelines"), S("Diff"), A("Judge", [plain("Unscored"), { name: "High risk", tone: "warn" }])] },
  { id: "decide", name: "Decide", exit: good("Ship"), steps: [P("Decide", [asked("Revise"), bad("Dropped")])] },
  { id: "ship", name: "Ship", exit: good("Shipped"), steps: [S("Rebase", [plain("Already landed"), asked("Conflict")]), S("Land", [loop("default branch moved"), bad("Not shipped")])] },
  { id: "deploy", name: "Deploy", exit: LIVE, steps: [S("Wait for live", [bad("Deploy failed")])] },
];

const waysOut = (f: LibFlow) => [...f.steps.flatMap((s) => s.ends ?? []), ...(f.more ?? [])];
/** Steps as run (Land in Change is two), and terminal ends only (the exit plus every way out that stops the run). */
const stepCount = (f: LibFlow) => f.steps.reduce((n, s) => n + (s.n ?? 1), 0);
const endCount = (f: LibFlow) => 1 + waysOut(f).filter((e) => !e.cont).length;
const ROW = 7;

function KindIcon({ kind }: { kind: Kind }) {
  if (kind === "person") return <PersonGlyph size={13} />;
  if (kind === "agent") {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className="shrink-0">
        <rect x="2.5" y="5" width="11" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 5V2.5M6 9.2h.01M10 9.2h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden className="shrink-0">
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 6.5l2 1.8-2 1.8M8.5 10.5h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EndChip({ end, d }: { end: End; d: number }) {
  return (
    <span className="flx-lib-end flx-lib-in" data-tone={end.tone} style={at(d)}>
      {end.tone === "back" || end.tone === "loop" ? "↺ " : ""}{end.name}
    </span>
  );
}

type Item = { type: "from"; name: string } | { type: "step"; step: Step } | { type: "exit"; end: End };

/**
 * The featured flow. Wide: rows of up to seven nodes, each joined to the next
 * by a connector that touches both, a later row picking up with ↳. Narrow: one
 * column, top to bottom, the same connectors turned downward.
 */
function FlowDrawing({ flow }: { flow: LibFlow }) {
  const items: Item[] = [
    ...(flow.from ? [{ type: "from" as const, name: flow.from }] : []),
    ...flow.steps.map((s) => ({ type: "step" as const, step: s })),
    { type: "exit", end: flow.exit },
  ];
  const rows: Item[][] = [];
  for (let i = 0; i < items.length; i += ROW) rows.push(items.slice(i, i + ROW));
  let k = 0;
  return (
    <div className="flx-lib-big">
      <div className="flx-lib-chain">
        {rows.map((row, ri) => (
          <div key={ri} className="flx-lib-row">
            {ri > 0 ? <span className="flx-lib-cont" aria-hidden>↳</span> : null}
            {row.map((it, ii) => {
              const d = 0.04 * k++;
              const rowEnd = ii === row.length - 1;
              if (it.type === "exit") {
                return (
                  <div key="exit" className="flx-lib-col">
                    <div className="flx-lib-head"><span className="flx-lib-end flx-lib-exit flx-lib-in" data-tone={it.end.tone} style={at(d)}>{it.end.name}</span></div>
                  </div>
                );
              }
              const node = it.type === "from"
                ? <span className="flx-lib-from flx-lib-in" style={at(d)}><PersonGlyph size={13} />{it.name}</span>
                : (
                  <span className="flx-lib-node flx-lib-in" data-kind={it.step.kind} data-opt={it.step.opt ? "" : undefined} style={at(d)}>
                    <KindIcon kind={it.step.kind} />
                    {it.step.name}
                    {it.step.sub ? <small>{it.step.sub}</small> : null}
                  </span>
                );
              const ends = it.type === "step" ? it.step.ends : undefined;
              return (
                <div key={ii} className="flx-lib-col">
                  <div className="flx-lib-head">
                    {node}
                    <span className="flx-lib-link" data-rowend={rowEnd ? "" : undefined} aria-hidden />
                  </div>
                  {ends?.length ? (
                    <div className="flx-lib-hang">
                      {ends.map((e, j) => <EndChip key={e.name} end={e} d={0.25 + 0.04 * (k + j)} />)}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {flow.more?.length ? (
        <div className="flx-lib-ends">
          {flow.more.map((e, i) => <EndChip key={e.name + i} end={e} d={0.3 + 0.03 * i} />)}
        </div>
      ) : null}
    </div>
  );
}

function LibraryFigure() {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const stage = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState("line");
  const flow = LIBRARY.find((f) => f.id === sel) ?? LIBRARY[0];
  const steps = stepCount(flow);
  const ends = endCount(flow);
  return (
    <div ref={ref} data-play={playing ? "" : undefined}>
      <div ref={stage} className="flx-lib-stagewrap">
        <Card className="p-5 sm:p-7">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="font-mono font-bold text-[18px]" style={{ color: INK }}>{flow.name}</span>
            <span className="font-mono text-[13px]" style={{ color: MUTED }}>{steps} {steps === 1 ? "step" : "steps"}, {ends} ends</span>
          </div>
          <div className="mt-5">
            <FlowDrawing key={flow.id} flow={flow} />
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" role="group" aria-label="Library flows">
        {LIBRARY.map((f, i) => {
          const fail = waysOut(f).find((e) => e.tone === "bad");
          return (
            <button
              key={f.id}
              type="button"
              className="flx-lib-card flx-lib-in"
              data-wide={f.id === "line" ? "" : undefined}
              aria-pressed={sel === f.id}
              style={at(0.05 * i)}
              onMouseEnter={() => setSel(f.id)}
              onFocus={() => setSel(f.id)}
              onClick={() => {
                setSel(f.id);
                // On a narrow screen the drawing sits far above the cards: bring it into view.
                if (window.matchMedia("(max-width: 1023px)").matches) stage.current?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
            >
              <span className="flex items-baseline justify-between gap-3 w-full">
                <span className="flx-lib-card-name">{f.name}</span>
                <span className="flx-lib-card-n">{stepCount(f)} steps, {endCount(f)} ends</span>
              </span>
              <span className="flx-lib-mini" aria-hidden>
                {f.from ? <i data-kind="from">{f.from}</i> : null}
                {f.steps.map((s, j) => <i key={j} data-kind={s.kind} data-opt={s.opt ? "" : undefined}>{s.name}</i>)}
                <i data-kind={f.exit.tone === "live" ? "live" : "exit"}>{f.exit.name}</i>
                {fail ? <i data-kind="fail">{fail.name}</i> : null}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function LibrarySection() {
  return (
    <Section
      id="library"
      wide
      title="The library"
      lede={<p>Flows compose from segments: Change is Check, Review, Decide, Ship and Deploy in a row. Quick is Change without Decide. A team can extend any flow with its own steps, or write its own.</p>}
    >
      <LibraryFigure />
    </Section>
  );
}
