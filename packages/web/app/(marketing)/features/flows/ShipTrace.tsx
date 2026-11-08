"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { useMountEffect } from "@/hooks/useMountEffect";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { SOL } from "../../blog/blogChrome";
import { BAD, Card, DIM, GOOD, HAIR, INK, LINE, Label, MUTED, Section, tint, usePlayOnView, useStill } from "./kit";
import { CAUSE, CHANGE, PROBLEM, ROLE } from "./story";
import "./shiptrace.css";

/*
 * Ship and watch, and Production comes back, following the page's one story
 * (./story): the fix CHANGE lands, goes live on web and backend, its problem is
 * watched for 7 days, and that night the trace blames the fix's lines to CAUSE.
 * Three working models:
 *  - deploy targets by path: a landed change lights only the targets whose
 *    paths it touches (codecast's own .codecast/deploy.toml), each goes out by
 *    its own policy, and the change is live on a target once a deploy recorded
 *    live has a sha the landed commit is an ancestor of (awaitDeploy.ts);
 *  - the watch: 7 days from the moment the deploy goes live, re-anchored and
 *    never shortened, closed quiet or reopened by a report inside it
 *    (convex/deploys.ts, signals.ts);
 *  - the nightly SZZ trace: a fix's removed lines blamed at its parent, the top
 *    introducer regretted (cli/src/lineFixloop.ts, landedChanges.ts).
 * Each figure plays once in view; its first render (SSR, still mode) is the
 * finished frame.
 */

// ---------- A play-once clock ----------

/**
 * Steps 0..durations.length, where step k means k beats have happened. The
 * first render is the last step (the finished frame, for prerender and still
 * mode); on mount it rewinds to 0 and runs once the figure is in view.
 */
function usePlayOnce(durations: number[]) {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const still = useStill();
  const last = durations.length;
  const [step, setStep] = useState(last);
  useMountEffect(() => setStep(0));
  useWatchEffect(() => {
    if (still || !playing || step >= last) return;
    const t = setTimeout(() => setStep(step + 1), durations[step]);
    return () => clearTimeout(t);
  }, [step, playing, still]);
  const s = still ? last : step;
  return { ref, step: s, replay: () => setStep(0), canReplay: !still && s >= last };
}

function Replay({ onClick, show }: { onClick: () => void; show: boolean }) {
  return (
    <button type="button" onClick={onClick} className="flx-ship-replay" data-off={show ? undefined : ""} tabIndex={show ? 0 : -1} aria-hidden={show ? undefined : true}>
      <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden><path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M12 1.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      Replay
    </button>
  );
}

/** Fades and lifts in when `on` turns true; at rest it is shown. */
function In({ on, children, className = "", style }: { on: boolean; children?: ReactNode; className?: string; style?: CSSProperties }) {
  return <div className={`flx-ship-in ${className}`} data-off={on ? undefined : ""} style={style}>{children}</div>;
}

function Check({ color = GOOD }: { color?: string }) {
  return <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden style={{ color, flexShrink: 0 }}><path d="M2.5 6.4l2.3 2.3 4.7-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

// ---------- Figure 1: deploy targets by path ----------

type TargetName = "backend" | "web" | "cli" | "mobile" | "desktop";
type Policy = "press" | "push";

/** codecast's own targets and their `when` paths (.codecast/deploy.toml; backend takes the convex ship step's). */
const TARGETS: { name: TargetName; when: string[]; policy: Policy }[] = [
  { name: "web", when: ["packages/web/**", "packages/shared/**", "platform/**"], policy: "push" },
  { name: "backend", when: ["packages/convex/**", "packages/shared/**", "platform/**"], policy: "press" },
  { name: "cli", when: ["packages/cli/**", "packages/shared/**", "platform/**"], policy: "press" },
  { name: "mobile", when: ["packages/mobile/**", "packages/shared/**"], policy: "press" },
  { name: "desktop", when: ["packages/electron/**"], policy: "press" },
];
const POLICY_WORDS: Record<Policy, string> = { press: "on a press", push: "on every push" };

/** Which glob each of the change's files falls under. */
const FILE_HITS: { path: string; target: TargetName; glob: string }[] = CHANGE.files.map((path) => {
  const t = TARGETS.find((x) => path.startsWith(x.when[0].replace("**", "")))!;
  return { path, target: t.name, glob: t.when[0] };
});
const HIT_GLOBS = new Set(FILE_HITS.map((f) => f.glob));

/** main from the landed commit on; each later commit touches web, backend or both. */
const MAIN: { sha: string; subject: string; targets: TargetName[] }[] = [
  { sha: CHANGE.landed, subject: CHANGE.subject, targets: ["web", "backend"] },
  { sha: "c2d7f18", subject: "feat(convex): carry list per session", targets: ["backend"] },
  { sha: "a93d2f4", subject: "chore(web): rail spacing", targets: ["web"] },
  { sha: "5e08b7c", subject: "fix(convex): close watches in batches", targets: ["backend"] },
];
const DEPLOYS: Record<"web" | "backend", { dp: string; sha: string }> = {
  web: { dp: CHANGE.deploys.web, sha: "a93d2f4" },
  backend: { dp: CHANGE.deploys.backend, sha: "5e08b7c" },
};
const BACKEND_CARRIES = MAIN.filter((c) => c.targets.includes("backend"));

// Beats: 1 paths matched, 2 web going out + backend's button, 3 pressed,
// 4 web live, 5 backend live, 6 the run reaches Live.
const SHIP_BEATS = [700, 1100, 1300, 1100, 1300, 900];

type TState = "idle" | "waiting" | "going" | "live" | "untouched";
function targetState(name: TargetName, step: number): TState {
  if (step < 1) return "idle";
  if (name === "web") return step >= 4 ? "live" : step >= 2 ? "going" : "waiting";
  if (name === "backend") return step >= 5 ? "live" : step >= 3 ? "going" : "waiting";
  return "untouched";
}
const STATE_WORDS: Record<TState, string> = { idle: "", waiting: "waiting on main", going: "going out", live: "live", untouched: "not touched" };

function TargetRow({ t, step }: { t: (typeof TARGETS)[number]; step: number }) {
  const st = targetState(t.name, step);
  const dep = st === "live" && (t.name === "web" || t.name === "backend") ? DEPLOYS[t.name] : null;
  const showPress = t.name === "backend" && step >= 2;
  return (
    <div className="flx-ship-trow" data-state={st}>
      <div className="flx-ship-thead">
        <span className="flx-ship-tname">{t.name}</span>
        <span className="flx-ship-policy" data-policy={t.policy}>{POLICY_WORDS[t.policy]}</span>
        <span className="flx-ship-state" data-state={st}>
          {st === "going" ? <span className="flx-ship-dot" /> : st === "live" ? <Check color={LINE} /> : null}
          {STATE_WORDS[st]}
          {dep ? <span className="flx-ship-dp">{dep.dp}</span> : null}
        </span>
      </div>
      <div className="flx-ship-twhen">
        {t.when.map((w) => (
          <span key={w} className="flx-ship-glob" data-hit={st !== "idle" && st !== "untouched" && HIT_GLOBS.has(w) ? "" : undefined}>{w}</span>
        ))}
      </div>
      {showPress ? (
        <In on className="flx-ship-press">
          <span className="flx-ship-btn" data-pressed={step >= 3 ? "" : undefined}>Deploy {BACKEND_CARRIES.length} commits</span>
          <span className="flx-ship-carries">
            {BACKEND_CARRIES.map((c) => <span key={c.sha} data-landed={c.sha === CHANGE.landed ? "" : undefined}>{c.sha}</span>)}
            <span className="flx-ship-notfor">1 not for backend</span>
          </span>
        </In>
      ) : null}
    </div>
  );
}

function TargetsFigure() {
  const { ref, step, replay, canReplay } = usePlayOnce(SHIP_BEATS);
  const webLive = step >= 4;
  const backLive = step >= 5;
  const webIdx = MAIN.findIndex((m) => m.sha === DEPLOYS.web.sha);
  const backIdx = MAIN.findIndex((m) => m.sha === DEPLOYS.backend.sha);
  const reach = Math.max(webLive ? webIdx : -1, backLive ? backIdx : -1);
  return (
    <Card className="flx-ship-fig relative p-4 sm:p-6">
      <div ref={ref} data-step={step} className="flx-ship-tgrid">
        <div className="min-w-0">
          <Label>Landed on main, {CHANGE.landedOn}</Label>
          <div className="mt-2 font-mono text-[14px] leading-snug" style={{ color: INK }}>
            <span className="font-semibold" style={{ color: LINE }}>{CHANGE.landed}</span> {CHANGE.subject}
          </div>
          <ul className="mt-3 flex flex-col gap-1.5">
            {FILE_HITS.map((f) => (
              <li key={f.path} className="flx-ship-file" data-lit={step >= 1 ? "" : undefined}>
                <span className="flx-ship-path">{f.path}</span>
                <span className="flx-ship-ftag">{f.target}</span>
              </li>
            ))}
          </ul>

          <div className="mt-6"><Label>Deploy targets</Label></div>
          <div className="mt-1 flex flex-col">
            {TARGETS.map((t) => <TargetRow key={t.name} t={t} step={step} />)}
          </div>
          <div className="flx-ship-polkey">
            <span><span className="flx-ship-policy" data-policy="press">on a press</span> a person&apos;s Deploy</span>
            <span><span className="flx-ship-policy" data-policy="auto">auto</span> when CI on main is green</span>
            <span><span className="flx-ship-policy" data-policy="push">on every push</span> runs = push</span>
          </div>
        </div>

        <div className="min-w-0 flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <Label>main</Label>
            <Replay onClick={replay} show={canReplay} />
          </div>
          <ol className="flx-ship-main mt-3">
            {MAIN.map((c, i) => {
              const flag = c.sha === DEPLOYS.web.sha && webLive ? ("web" as const) : c.sha === DEPLOYS.backend.sha && backLive ? ("backend" as const) : null;
              return (
                <li key={c.sha} className="flx-ship-commit" data-landed={i === 0 ? "" : undefined} data-covered={i <= reach ? "" : undefined} data-seg={i < reach ? "" : undefined}>
                  <span className="flx-ship-node" />
                  <span className="flx-ship-csha">{c.sha}</span>
                  <span className="flx-ship-csub">{c.subject}</span>
                  <span className="flx-ship-flagslot">
                    {i === 0 ? <span className="flx-ship-flag flx-ship-flag-landed">landed</span> : null}
                    {flag ? <In on className="flx-ship-flag">{flag} {DEPLOYS[flag].dp}</In> : null}
                  </span>
                </li>
              );
            })}
          </ol>
          <div className="flx-ship-key"><i aria-hidden /> deploys whose sha has {CHANGE.landed} as an ancestor</div>

          <div className="flx-ship-foot mt-auto">
            <div className="flx-ship-out">
              <div className="flx-ship-await">
                <span>cast flow await-deploy</span>
                <span className="flx-ship-parked" data-on={step >= 6 ? "" : undefined}>{step >= 6 ? "done" : "parked, holds no slot"}</span>
              </div>
              <In on={webLive}><Check color={LINE} /> Live: {DEPLOYS.web.sha} on web {DEPLOYS.web.dp}</In>
              <In on={backLive}><Check color={LINE} /> Live: {DEPLOYS.backend.sha} on backend {DEPLOYS.backend.dp}</In>
            </div>
            <span className="flx-ship-end" data-on={step >= 6 ? "" : undefined}>Live</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------- Figure 2: the watch ----------

/** Day -1.2 .. 7.6 across the track (day 0 = live). */
const DOMAIN = [-1.2, 7.6] as const;
const x = (d: number) => `${((d - DOMAIN[0]) / (DOMAIN[1] - DOMAIN[0])) * 100}%`;
const span = (from: number, to: number) => `calc(${x(to)} - ${x(from)})`;
const REPORT_DAY = 3.2;
const FILL_MS = 2600;
const REPORT_MS = Math.round((REPORT_DAY / 7) * FILL_MS);
// Beats: 1 the deploy goes live, 2 the window slides to it, 3 an early report
// is ignored, 4 the watch runs, 5 a report reopens the second lane, 6 the
// first lane ends quiet, 7 closed clean.
const WATCH_BEATS = [600, 900, 1500, 1000, REPORT_MS, FILL_MS - REPORT_MS + 200, 900];
const DAYS = ["Nov 4", "Nov 5", "Nov 6", "Nov 7", "Nov 8", "Nov 9", "Nov 10", "Nov 11"];

function WatchLane({ kind, step }: { kind: "quiet" | "report"; step: number }) {
  const quiet = kind === "quiet";
  const end = quiet ? 7 : REPORT_DAY;
  const filling = step >= 4;
  const reopened = !quiet && step >= 5;
  const ended = quiet && step >= 6;
  const closed = quiet && step >= 7;
  const verdict = quiet ? closed : reopened;
  return (
    <div className="flx-ship-lane" data-kind={kind}>
      <div className="flx-ship-lanehead">
        <span className="flx-ship-lanename">{quiet ? "If production stays quiet" : "If a report arrives Nov 7"}</span>
        <span className="flx-ship-cap" data-kind={kind} data-on={verdict ? "" : undefined}>
          {quiet ? <><Check color="currentColor" /> Closed clean</> : <><span aria-hidden>↺</span> Open, back in the queue</>}
        </span>
      </div>
      <div className="flx-ship-ltrack">
        <div className="flx-ship-lbase" style={{ left: x(0), width: span(0, 7) }} />
        {quiet ? null : (
          <div className="flx-ship-cleared" data-on={reopened ? "" : undefined} style={{ left: x(REPORT_DAY), width: span(REPORT_DAY, 7) }}>
            <span>watch cleared</span>
          </div>
        )}
        <div className="flx-ship-lfill" data-run={filling ? "" : undefined} data-closed={closed ? "" : undefined} style={{ left: x(0), width: span(0, end), transitionDuration: filling ? `${Math.round((end / 7) * FILL_MS)}ms, .5s` : "0ms" }} />
        {quiet ? (
          <In on={step >= 3} className="flx-ship-early" style={{ left: x(-0.5) }}>
            <span className="flx-ship-pip" />
            <span className="flx-ship-plabel">ignored</span>
          </In>
        ) : (
          <In on={reopened} className="flx-ship-report" style={{ left: x(REPORT_DAY) }}>
            <span className="flx-ship-pip" />
            <span className="flx-ship-plabel">Reopened during watch</span>
          </In>
        )}
        {quiet ? (
          <In on={ended} className="flx-ship-endq" style={{ left: x(7) }}>
            <span className="flx-ship-pip" />
            <span className="flx-ship-plabel">Watch ended quiet</span>
          </In>
        ) : null}
      </div>
    </div>
  );
}

function WatchFigure() {
  const { ref, step, replay, canReplay } = usePlayOnce(WATCH_BEATS);
  const live = step >= 1;
  const anchored = step >= 2;
  return (
    <Card className="flx-ship-fig relative p-4 sm:p-6">
      <div ref={ref} data-step={step}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label>Watch on {PROBLEM.task}</Label>
            <div className="mt-1 font-mono text-[14px] font-semibold" style={{ color: INK }}>{PROBLEM.title}</div>
          </div>
          <Replay onClick={replay} show={canReplay} />
        </div>
        <div className="flx-ship-watch mt-5">
          {/* On a phone the three dates read as one line above the axis. */}
          <div className="flx-ship-wdates">
            <span>Landed {CHANGE.landedOn}</span><span>Live {CHANGE.deploys.backend} {CHANGE.liveOn}</span><span>until {CHANGE.watchUntil}</span>
          </div>
          <div className="flx-ship-axis">
            <div className="flx-ship-mark" style={{ left: x(-1) }}><b>Landed</b><span>{CHANGE.landedOn}</span></div>
            <In on={live} className="flx-ship-mark flx-ship-mark-live" style={{ left: x(0) }}><b>Live {CHANGE.deploys.backend}</b><span>{CHANGE.liveOn}</span></In>
            {DAYS.slice(1).map((d, i) => (
              <div key={d} className="flx-ship-tick" data-last={i === 6 ? "" : undefined} style={{ left: x(i + 1) }}><span>{d}</span></div>
            ))}
          </div>
          {/* The window as landing set it, then the same 7 days moved to live. */}
          <div className="flx-ship-wrow">
            <div className="flx-ship-ghost" style={{ left: x(-1), width: span(0, 7) }}><span>set at landing</span><span className="flx-ship-wide">until Nov 10</span></div>
            <In on={anchored} className="flx-ship-shiftlabel" style={{ left: x(-1) }}>re-anchored at live</In>
            <In on={anchored} className="flx-ship-shift" style={{ left: x(-1), width: span(-1, 0) }} />
            <div className="flx-ship-window" data-anchored={anchored ? "" : undefined} style={{ ["--from" as string]: x(-1), ["--to" as string]: x(0), width: span(0, 7) } as CSSProperties}>
              <span className="flx-ship-wide">watch_from</span><span>7 days, never shortened</span><span className="flx-ship-wide">watch_until</span>
            </div>
          </div>
          <WatchLane kind="quiet" step={step} />
          <WatchLane kind="report" step={step} />
        </div>
      </div>
    </Card>
  );
}

export function ShipSection() {
  return (
    <Section
      id="ship"
      tone="paper"
      wide
      title="Land, go live, then a week of quiet"
      lede={
        <p>
          A change that passes lands on main and goes out with the next deploy of each place it touches. The run parks,
          holding no slot, until every one of them is live. The problem it fixed is done after 7 quiet days counted from
          that moment.
        </p>
      }
    >
      <TargetsFigure />
      <div className="mt-6">
        <WatchFigure />
      </div>
    </Section>
  );
}

// ---------- Production comes back: the nightly trace ----------

const LANE_Y = 100;
const LANE_X0 = 96;
const OTHER = { sha: "81d4c6f", subject: "refactor(web): currency" };
const COMMITS = [
  { x: 168, sha: CAUSE.sha, subject: CAUSE.subject },
  { x: 384, sha: OTHER.sha, subject: OTHER.subject },
  { x: 560, sha: "d05a7b3", subject: "feat(web): coupons" },
];
const FIX_X = 770;
const NIGHT_X = 925;

const DIFF_X = 440;
const DIFF_TOP = 204;
const DIFF_STEP = 24;
const DIFF: { sign: "-" | "+"; text: string; from?: string }[] = [
  { sign: "-", text: "const first = items[0];", from: CAUSE.sha },
  { sign: "-", text: "let sum = first.price * first.qty;", from: CAUSE.sha },
  { sign: "-", text: "for (const i of rest) sum += line(i);", from: CAUSE.sha },
  { sign: "-", text: "return round(sum, cart.cur);", from: OTHER.sha },
  { sign: "+", text: "const sum = items.reduce(add, 0);" },
  { sign: "+", text: "return round(sum, cart.currency);" },
];
const TALLY = [
  { sha: CAUSE.sha, lines: CAUSE.lines, top: true },
  { sha: OTHER.sha, lines: 1, top: false },
];
const RULES = ["bug task", "fix story", "fix subject"] as const;

// Beats: 1 the nightly read sweeps main, 2 the fix is recognised, 3 its diff,
// 4 blame arrows, 5 the tally and the regret, 6 the session.
const TRACE_BEATS = [500, 1400, 800, 900, 1500, 900];

/** The ≥1024px drawing: main across the top, the diff, blame curves leaving the commit markers. */
function TraceDrawing({ step }: { step: number }) {
  const commitX = (sha: string) => COMMITS.find((c) => c.sha === sha)!.x;
  return (
    <svg viewBox="0 0 960 470" preserveAspectRatio="xMidYMid meet" className="flx-trace-svg" role="img" aria-label={`The fix ${CHANGE.landed} on main, its removed lines blamed at its parent, curves back to the commits that wrote them, and ${CAUSE.sha} marked regretted and resolved to its session`}>
      <defs>
        <marker id="flx-trace-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill={BAD} />
        </marker>
        <marker id="flx-trace-head-dim" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill={MUTED} />
        </marker>
      </defs>

      {/* main */}
      <text x={40} y={LANE_Y + 4} className="flx-trace-t flx-trace-b" fill={DIM}>main</text>
      <line x1={LANE_X0} y1={LANE_Y} x2={940} y2={LANE_Y} stroke={SOL.base1} strokeWidth={2} vectorEffect="non-scaling-stroke" />

      {/* the nightly read sweeps in and settles at its hour */}
      <g className="flx-trace-night" data-on={step >= 1 ? "" : undefined} style={{ ["--sweep" as string]: `${LANE_X0 - NIGHT_X}px` } as CSSProperties}>
        <line x1={NIGHT_X} y1={LANE_Y - 50} x2={NIGHT_X} y2={LANE_Y + 30} stroke={LINE} strokeWidth={1.6} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        <text x={944} y={24} textAnchor="end" className="flx-trace-t flx-trace-s" fill={MUTED}>reads what landed</text>
        <text x={944} y={42} textAnchor="end" className="flx-trace-t flx-trace-b" fill={LINE}>03:30 UTC</text>
      </g>

      {COMMITS.map((c) => {
        const t = TALLY.find((r) => r.sha === c.sha);
        const regretted = t?.top && step >= 5;
        const blamed = !!t && step >= 4;
        return (
          <g key={c.sha}>
            <text x={c.x} y={LANE_Y - 40} textAnchor="middle" className="flx-trace-t flx-trace-s" fill={MUTED}>{c.subject}</text>
            <text x={c.x} y={LANE_Y - 18} textAnchor="middle" className="flx-trace-t flx-trace-b flx-trace-col" fill={regretted ? BAD : blamed ? INK : MUTED}>{c.sha}</text>
            <circle cx={c.x} cy={LANE_Y} r={8} className="flx-trace-col" fill={regretted ? BAD : SOL.base3} stroke={regretted ? BAD : blamed ? INK : SOL.base1} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          </g>
        );
      })}

      {/* the fix: this story's landed change */}
      <g>
        <text x={FIX_X} y={LANE_Y - 40} textAnchor="middle" className="flx-trace-t flx-trace-s" fill={MUTED}>
          <tspan className="flx-trace-col" fill={step >= 2 ? LINE : MUTED} fontWeight={step >= 2 ? 700 : 400}>fix(web):</tspan>{CHANGE.subject.slice("fix(web):".length)}
        </text>
        <text x={FIX_X} y={LANE_Y - 18} textAnchor="middle" className="flx-trace-t flx-trace-b" fill={INK}>{CHANGE.landed}</text>
        <circle cx={FIX_X} cy={LANE_Y} r={15} fill="none" stroke={LINE} strokeWidth={2} vectorEffect="non-scaling-stroke" className="flx-trace-ring" data-on={step >= 2 ? "" : undefined} />
        <circle cx={FIX_X} cy={LANE_Y} r={8} fill={step >= 2 ? LINE : SOL.base3} stroke={step >= 2 ? LINE : SOL.base1} strokeWidth={2} vectorEffect="non-scaling-stroke" className="flx-trace-col" />
        {/* the three ways a commit counts as a fix; this one matched on its subject */}
        <text x={FIX_X} y={LANE_Y + 36} textAnchor="middle" className="flx-trace-t flx-trace-s" fill={DIM}>
          {RULES.map((r, i) => (
            <tspan key={r} className="flx-trace-col" fill={r === "fix subject" && step >= 2 ? LINE : DIM} fontWeight={r === "fix subject" && step >= 2 ? 700 : 400}>{i ? "  ·  " : ""}{r}</tspan>
          ))}
        </text>
      </g>

      {/* blame curves: from each removed line back into the commit marker that wrote it */}
      {DIFF.map((l, i) => {
        if (!l.from) return null;
        const y = DIFF_TOP + i * DIFF_STEP - 4;
        const cx = commitX(l.from);
        const top = TALLY.find((r) => r.sha === l.from)?.top;
        const d = `M${DIFF_X - 4} ${y} C ${cx + (DIFF_X - cx) * 0.45} ${y}, ${cx} ${y - 30}, ${cx} ${LANE_Y + 12}`;
        return (
          <path key={i} d={d} pathLength={1} fill="none" stroke={top ? BAD : MUTED} strokeWidth={1.6} strokeOpacity={top ? 0.85 : 0.6} vectorEffect="non-scaling-stroke" markerEnd={`url(#${top ? "flx-trace-head" : "flx-trace-head-dim"})`} className="flx-trace-arrow" data-on={step >= 4 ? "" : undefined} style={{ transitionDelay: `${i * 140}ms` }} />
        );
      })}

      {/* the fix's diff */}
      <g className="flx-trace-in" data-on={step >= 3 ? "" : undefined}>
        <rect x={DIFF_X} y={150} width={500} height={180} rx={10} fill={SOL.base3} stroke={HAIR} vectorEffect="non-scaling-stroke" />
        <text x={DIFF_X + 16} y={174} className="flx-trace-t flx-trace-s" fill={MUTED}>total.ts, blamed at {CHANGE.landed}^</text>
        {DIFF.map((l, i) => {
          const y = DIFF_TOP + i * DIFF_STEP;
          const minus = l.sign === "-";
          return (
            <g key={i}>
              <rect x={DIFF_X + 8} y={y - 16} width={484} height={21} rx={4} style={{ fill: minus ? tint(BAD, 10) : tint(GOOD, 8) }} />
              <text x={DIFF_X + 18} y={y} className="flx-trace-t" fill={minus ? BAD : GOOD}>{l.sign}</text>
              <text x={DIFF_X + 34} y={y} className="flx-trace-t" fill={minus ? INK : MUTED}>{l.text}</text>
              {l.from ? (
                <text x={DIFF_X + 482} y={y} textAnchor="end" className="flx-trace-t flx-trace-s flx-trace-fade" data-on={step >= 4 ? "" : undefined} fill={l.from === CAUSE.sha ? BAD : MUTED}>{l.from}</text>
              ) : null}
            </g>
          );
        })}
      </g>

      {/* the tally, in each introducer's own column: the most lines regrets */}
      <g className="flx-trace-in" data-on={step >= 5 ? "" : undefined}>
        {TALLY.map((r) => {
          const cx = commitX(r.sha);
          const w = r.lines * 26 - 4;
          return (
            <g key={r.sha}>
              {Array.from({ length: r.lines }, (_, k) => (
                <rect key={k} x={cx - w / 2 + k * 26} y={344} width={22} height={12} rx={3} fill={r.top ? BAD : SOL.base1} opacity={r.top ? 0.9 : 0.6} />
              ))}
              <text x={cx} y={378} textAnchor="middle" className="flx-trace-t flx-trace-b" fill={r.top ? BAD : MUTED}>{r.lines} {r.lines === 1 ? "line" : "lines"}</text>
              <text x={cx} y={396} textAnchor="middle" className="flx-trace-t flx-trace-s" fill={r.top ? BAD : MUTED} fontWeight={r.top ? 700 : 400}>{r.top ? "top introducer, regretted" : "not top"}</text>
            </g>
          );
        })}
        <text x={DIFF_X + 8} y={356} className="flx-trace-t flx-trace-s" fill={MUTED}>
          {CAUSE.sha}.fixed_by += {"{"} {CHANGE.landed}, lines: {CAUSE.lines}, <tspan fill={BAD} fontWeight={700}>top: true</tspan> {"}"}
        </text>
      </g>

      {/* the regretted commit resolves to the session that wrote it */}
      <g className="flx-trace-in" data-on={step >= 6 ? "" : undefined}>
        <line x1={commitX(CAUSE.sha)} y1={404} x2={commitX(CAUSE.sha)} y2={428} stroke={BAD} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
        <rect x={40} y={428} width={300} height={30} rx={15} style={{ fill: tint(LINE, 13) }} />
        <circle cx={58} cy={443} r={4.5} fill={LINE} />
        <text x={70} y={448} className="flx-trace-t" fill={INK} fontWeight={600}>{CAUSE.sessionTitle}</text>
        <text x={326} y={448} textAnchor="end" className="flx-trace-t flx-trace-s" fill={LINE}>{CAUSE.session}</text>
        <text x={354} y={448} className="flx-trace-t flx-trace-s" fill={MUTED}>Codecast-Session, the {ROLE.name} line</text>
      </g>
    </svg>
  );
}

/** The <1024px version: the same model stacked, commit to lines to tally to session. */
function TraceStack({ step }: { step: number }) {
  return (
    <div className="flx-trace-stack">
      <In on={step >= 1} className="flx-trace-srow">
        <span className="flx-trace-nchip">03:30 UTC</span>
        <span className="flx-trace-sdim">reads what landed on main</span>
      </In>
      <div className="flx-trace-sfix" data-on={step >= 2 ? "" : undefined}>
        <div><b>{CHANGE.landed}</b> <span className="flx-trace-fixword">fix(web):</span>{CHANGE.subject.slice("fix(web):".length)}</div>
        <div className="flx-trace-rules">
          {RULES.map((r) => <span key={r} data-hit={r === "fix subject" && step >= 2 ? "" : undefined}>{r}</span>)}
        </div>
      </div>
      <In on={step >= 3} className="flx-trace-sdiff">
        <div className="flx-trace-sdim">total.ts, blamed at {CHANGE.landed}^</div>
        {DIFF.map((l, i) => (
          <div key={i} className="flx-trace-sline" data-sign={l.sign}>
            <span className="flx-trace-sgn">{l.sign}</span>
            <code>{l.text}</code>
            {l.from ? <span className="flx-trace-sfrom" data-on={step >= 4 ? "" : undefined} data-top={l.from === CAUSE.sha ? "" : undefined}>{l.from}</span> : null}
          </div>
        ))}
      </In>
      <In on={step >= 4} className="flx-trace-sdown"><span aria-hidden>↓</span> blame</In>
      <In on={step >= 5} className="flx-trace-stally">
        {TALLY.map((r) => (
          <div key={r.sha} className="flx-trace-trow" data-top={r.top ? "" : undefined}>
            <b>{r.sha}</b>
            <span className="flx-trace-tbars">{Array.from({ length: r.lines }, (_, k) => <i key={k} />)}</span>
            <span>{r.lines} {r.lines === 1 ? "line" : "lines"}, {r.top ? "top, regretted" : "not top"}</span>
          </div>
        ))}
      </In>
      <In on={step >= 6} className="flx-trace-spill">
        <span className="flx-trace-pill"><i aria-hidden />{CAUSE.sessionTitle} <em>{CAUSE.session}</em></span>
        <span className="flx-trace-sdim">Codecast-Session, the {ROLE.name} line</span>
      </In>
    </div>
  );
}

function TraceFigure() {
  const { ref, step, replay, canReplay } = usePlayOnce(TRACE_BEATS);
  return (
    <Card className="flx-trace-fig relative p-4 sm:p-6">
      <div ref={ref} data-step={step}>
        <div className="flex items-start justify-between gap-3">
          <Label>The night after {CHANGE.landed} landed</Label>
          <Replay onClick={replay} show={canReplay} />
        </div>
        <div className="mt-3">
          <TraceDrawing step={step} />
          <TraceStack step={step} />
        </div>
      </div>
    </Card>
  );
}

/** The Loop's foot as the app draws it, and the routine that files confirmed causes. */
function BackToSignals() {
  return (
    <div className="mt-6 grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
      <Card className="p-4 sm:p-5">
        <Label>The Loop</Label>
        <div className="flx-trace-foot mt-3">
          <span className="flx-trace-foothead"><span aria-hidden>↺</span> Back to signals</span>
          <span className="flx-trace-footn"><b>2</b> regressed</span>
          <span className="flx-trace-footn"><b>2</b> reopened by a finding</span>
          <span className="flx-trace-footwin">last 14 days</span>
        </div>
      </Card>
      <Card className="p-4 sm:p-5">
        <Label>Weekly fix-loop routine</Label>
        <div className="flx-trace-route mt-3">
          <span className="flx-trace-chip" style={{ color: BAD, backgroundColor: tint(BAD, 11) }}>confirmed cause</span>
          <span aria-hidden className="flx-trace-arr">→</span>
          <span className="flx-trace-chip" style={{ color: INK, backgroundColor: tint(SOL.base1, 22) }}>szz:{CAUSE.sha}</span>
          <span aria-hidden className="flx-trace-arr">→</span>
          <a href="#signals" className="flx-trace-up"><span aria-hidden>↑</span> Signals, same door</a>
        </div>
      </Card>
    </div>
  );
}

export function TraceSection() {
  return (
    <Section
      id="back"
      tone="sand"
      wide
      title="Production comes back to the change that broke it"
      lede={
        <>
          <p>
            Every night at 03:30 UTC codecast reads what landed on main and blames each fix&apos;s removed lines at the
            commit before it. The commit that gave the fix the most lines is the top introducer, and it is regretted on
            its author&apos;s record.
          </p>
          <p>
            A weekly routine files confirmed causes as signals. The Loop&apos;s Back to signals counts are a separate
            measure: shipped problems a finding reopened in the last 14 days.
          </p>
        </>
      }
    >
      <TraceFigure />
      <BackToSignals />
    </Section>
  );
}
