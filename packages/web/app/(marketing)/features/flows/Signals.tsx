"use client";

import { useState, type CSSProperties } from "react";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { BAD, DIM, GOOD, LINE, MUTED, PERSON, Section, TEXT, at, tint, usePlayOnView, useStepClock, useStill } from "./kit";
import { CHANGE, PROBLEM } from "./story";
import "./signals.css";

/*
 * Signals and the two ways a change enters. Figures model real rules:
 * signals.ingest's four attach rules (convex/signals.ts), the silent-source
 * rule (shared/contracts/flowMap.ts sourceState), and the line's Ground,
 * queue order and slot placement (convex/liveFlows.ts, lib/linePlacement.ts).
 */

// ─────────────────────────────── Signals: one door ───────────────────────────────

type Sig = { id: string; source: string; title: string; key: string; judge?: string; opener?: string };
type Problem = { key: string; title: string; count: number; fresh?: boolean };

/** Problem names shared by the door and the line's queue (none of them the story's). */
const ONBOARD = "Onboarding skips a tool";
const SEARCH = "Archived docs rank first";
const EXPORT = "Export fails in Safari";
const LOOP = "Agent loops on cast check";
const RETRY = "Retries hide flaky deploys";

const SIGS: Sig[] = [
  { id: "sentry", source: PROBLEM.source, title: "TypeError in cart/total.ts", key: PROBLEM.key },
  { id: "eval", source: "evals", title: "Onboarding eval red", key: "eval:onboarding-tool-v2", judge: "eval:onboarding-tool" },
  { id: "report", source: "person", title: EXPORT, key: "report:export-safari", opener: "a person filed it" },
  { id: "posthog", source: "posthog", title: "Signups down 9% on /pricing", key: "posthog:pricing-signups" },
  { id: "lesson", source: "lesson", title: RETRY, key: "lesson:retry-deploy", opener: "a lesson did" },
  { id: "search", source: "sentry", title: "Timeout on /api/search", key: "sentry:api-search-timeout", judge: "issue:search-archived" },
  { id: "agentwatch", source: "agentwatch", title: LOOP, key: "agentwatch:check-loop", opener: "its finder opens them" },
];
const sigIndex = (id: string) => SIGS.findIndex((s) => s.id === id);

const START: Problem[] = [
  { key: PROBLEM.key, title: PROBLEM.title, count: PROBLEM.signals - 1 },
  { key: "eval:onboarding-tool", title: ONBOARD, count: 6 },
  { key: "issue:search-archived", title: SEARCH, count: 3 },
];
const START_HELD = 128;
/**
 * The auto pass. "report" comes twice: the second time its own new problem
 * holds the key. It ends on the story's Sentry signal joining its problem,
 * which is the still frame.
 */
const SCRIPT = ["eval", "report", "posthog", "lesson", "report", "search", "agentwatch", "sentry"].map(sigIndex);

const GATES = [
  { name: "Fingerprint", rule: "same key on an open problem" },
  { name: "Judge", rule: "a small model picks one, or unsure" },
  { name: "New", rule: "a person, a lesson, or a finder" },
  { name: "Held", rule: "evidence only, no task" },
] as const;

type Door = { problems: Problem[]; held: number; sig: number; exit: number; frame: number; next: number; bump: string | null; n: number };
type Phase = "enter" | "test" | "pass" | "match" | "done";

function exitFor(sig: Sig, problems: Problem[]): number {
  if (problems.some((p) => p.key === sig.key)) return 0;
  if (sig.judge && problems.slice(0, 5).some((p) => p.key === sig.judge)) return 1;
  if (sig.opener) return 2;
  return 3;
}
const framesFor = (exit: number) => 2 * (exit + 1) + 2;
function frameInfo(frame: number, exit: number): { gate: number; phase: Phase } {
  if (frame === 0) return { gate: -1, phase: "enter" };
  if (frame >= framesFor(exit) - 1) return { gate: exit, phase: "done" };
  const g = (frame - 1) >> 1;
  if ((frame - 1) % 2 === 0) return { gate: g, phase: "test" };
  return { gate: g, phase: g === exit ? "match" : "pass" };
}
function begin(d: Door, sig: number, next: number): Door {
  return { ...d, sig, next, exit: exitFor(SIGS[sig], d.problems), frame: 0, bump: null, n: d.n + 1 };
}
function deliver(d: Door): Door {
  const sig = SIGS[d.sig];
  if (d.exit === 3) return { ...d, held: d.held + 1, bump: "held" };
  if (d.exit === 2) return { ...d, problems: [...d.problems, { key: sig.key, title: sig.title, count: 1, fresh: true }], bump: sig.key };
  const key = d.exit === 0 ? sig.key : sig.judge!;
  return { ...d, problems: d.problems.map((p) => (p.key === key ? { ...p, count: p.count + 1 } : p)), bump: key };
}
const initialDoor = (n = 0): Door => begin({ problems: START, held: START_HELD, sig: 0, exit: 0, frame: 0, next: 0, bump: null, n }, SCRIPT[0], 1);
function stepDoor(d: Door): Door {
  const last = framesFor(d.exit) - 1;
  if (d.frame < last) {
    const nd = { ...d, frame: d.frame + 1 };
    return nd.frame === last ? deliver(nd) : nd;
  }
  if (d.next >= SCRIPT.length) return initialDoor(d.n);
  return begin(d, SCRIPT[d.next], d.next + 1);
}
/** The still frame: the whole pass delivered, the last signal resting at its exit. */
const FINAL: Door = (() => {
  let d = initialDoor();
  for (let i = 0; i < 200; i++) {
    if (d.next >= SCRIPT.length && d.frame === framesFor(d.exit) - 1) break;
    d = stepDoor(d);
  }
  return d;
})();
function durationOf(d: Door): number {
  const { gate, phase } = frameInfo(d.frame, d.exit);
  if (phase === "enter") return 800;
  if (phase === "test") return gate === 1 ? 1300 : 800;
  if (phase === "pass") return 550;
  if (phase === "match") return 750;
  return d.next >= SCRIPT.length ? 3200 : 1700;
}

const sourceColor = (source: string) => (source === "person" ? PERSON : TEXT);

function SourceChip({ source }: { source: string }) {
  const c = sourceColor(source);
  return <span className="flx-sig-src" style={{ color: c, backgroundColor: tint(c, source === "person" ? 12 : 9) }}>{source}</span>;
}

function OneDoor() {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const still = useStill();
  const [door, setDoor] = useState<Door>(() => initialDoor());
  const [touched, setTouched] = useState(false);

  useWatchEffect(() => {
    if (still || !playing) return;
    const t = setTimeout(() => setDoor(stepDoor), durationOf(door));
    return () => clearTimeout(t);
  }, [door, still, playing]);

  const view = still && !touched ? FINAL : door;
  const sig = SIGS[view.sig];
  const { gate, phase } = frameInfo(view.frame, view.exit);
  const judgePick = sig.judge ? view.problems.slice(0, 5).findIndex((p) => p.key === sig.judge) : -1;
  const target = view.exit === 0 ? sig.key : view.exit === 1 ? sig.judge : view.exit === 2 ? sig.key : null;
  const targetTitle = view.problems.find((p) => p.key === target)?.title ?? sig.title;

  const send = (i: number) => {
    if (still) {
      setTouched(true);
      const from = touched ? door : FINAL;
      const d = begin(from, i, from.next);
      setDoor(deliver({ ...d, frame: framesFor(d.exit) - 1 }));
      return;
    }
    setDoor((d) => begin(d, i, d.next));
  };

  const verdict = (g: number): { text: string; tone: "idle" | "test" | "pass" | "match" } => {
    if (g > gate || gate < 0) return { text: "", tone: "idle" };
    if (g < gate) return { text: ["no match", "unsure", "nobody decided"][g] ?? "", tone: "pass" };
    if (phase === "test") return { text: "checking", tone: "test" };
    if (phase === "pass") return { text: ["no match", "unsure", "nobody decided"][g] ?? "", tone: "pass" };
    return { text: [`same key`, `picks #${judgePick + 1}`, sig.opener ?? "", "held"][g] ?? "", tone: "match" };
  };
  const exitLine = (g: number) => {
    if (g !== view.exit || (phase !== "match" && phase !== "done")) return null;
    if (g === 3) return "kept as evidence";
    if (g === 2) return "opens a problem, suggested";
    return `joins: ${targetTitle}`;
  };
  const pips = Math.min(5, view.problems.length);

  return (
    <div ref={ref} data-play={playing ? "" : undefined} className="flx-sig-door">
      <div className="flx-sig-door-grid">
        {/* The chute: the arriving signal, then the four gates in order. */}
        <div className="flx-sig-chute">
          <div className="flx-sig-hopper">
            <div className="flx-sig-hopper-head">
              <span>Arriving</span>
              <code>signals.ingest</code>
            </div>
            <div key={view.n} className="flx-sig-card" data-phase={phase}>
              <div className="flex items-center gap-2 min-w-0">
                <SourceChip source={sig.source} />
                <span className="flx-sig-card-title">{sig.title}</span>
              </div>
              <div className="flx-sig-card-key">{sig.key}</div>
            </div>
          </div>
          <ol className="flx-sig-gates">
            {GATES.map((g, i) => {
              const v = verdict(i);
              const active = i === gate;
              const exit = exitLine(i);
              return (
                <li key={g.name} className="flx-sig-gate" data-active={active ? "" : undefined} data-tone={v.tone} data-exit={exit ? "" : undefined}>
                  <span className="flx-sig-gate-n">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="flx-sig-gate-name">{g.name}</span>
                      {i === 1 ? (
                        <span className="flx-sig-pips" aria-label={`${pips} closest open problems`}>
                          {Array.from({ length: pips }, (_, k) => (
                            <span key={k} data-on={active && phase === "test" ? "scan" : (active || i < gate) && k === judgePick && view.exit === 1 ? "pick" : undefined} style={at(k * 0.12)} />
                          ))}
                          <em>{pips} closest</em>
                        </span>
                      ) : null}
                    </div>
                    <div className="flx-sig-gate-rule">{g.rule}</div>
                    {exit ? <div className="flx-sig-gate-exit">{exit}</div> : null}
                  </div>
                  <span className="flx-sig-verdict" data-tone={v.tone}>{v.text}</span>
                </li>
              );
            })}
          </ol>
          <div className="flx-sig-send">
            <span className="flx-sig-send-l">Send one through</span>
            <div className="flex flex-wrap gap-2">
              {SIGS.map((s, i) => (
                <button key={s.id} type="button" className="flx-sig-send-b" aria-pressed={i === view.sig} onClick={() => send(i)}>
                  <SourceChip source={s.source} />
                  <span>{s.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Where signals end up: open problems with their signal counts, and the evidence pile. */}
        <div className="flx-sig-board">
          <div className="flx-sig-board-head">
            <span>Open problems</span>
            <span className="flx-sig-board-n">{view.problems.length}</span>
          </div>
          <ul className="flx-sig-problems">
            {view.problems.map((p) => {
              const hit = view.bump === p.key;
              return (
                <li key={p.key} className={`flx-sig-problem ${p.fresh ? "flx-sig-fresh" : ""}`} data-hit={hit ? "" : undefined}>
                  {hit && !still ? <span key={view.n} className="flx-sig-flash" aria-hidden /> : null}
                  <div className="min-w-0 flex-1">
                    <div className="flx-sig-problem-title">{p.title}</div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      <code className="flx-sig-problem-key">{p.key}</code>
                      {p.fresh ? <span className="flx-sig-suggested">suggested</span> : null}
                    </div>
                  </div>
                  <div className="flx-sig-count">
                    {hit && !still ? <span key={view.n} className="flx-sig-plus" aria-hidden>+1</span> : null}
                    <span className="flx-sig-count-n">{p.count}</span>
                    <span className="flx-sig-count-l">signals</span>
                  </div>
                </li>
              );
            })}
          </ul>
          {still ? null : <div className="flx-sig-ghost" aria-hidden>new problems open here</div>}
          <div className="flx-sig-held" data-hit={view.bump === "held" ? "" : undefined}>
            {view.bump === "held" && !still ? <span key={view.n} className="flx-sig-flash" aria-hidden /> : null}
            <span className="flx-sig-held-stack" aria-hidden><i /><i /><i /></span>
            <div className="min-w-0 flex-1">
              <div className="flx-sig-problem-title">Held as evidence</div>
              <div className="flx-sig-gate-rule">no task</div>
            </div>
            <div className="flx-sig-count">
              {view.bump === "held" && !still ? <span key={view.n} className="flx-sig-plus" aria-hidden>+1</span> : null}
              <span className="flx-sig-count-n" style={{ color: MUTED }}>{view.held}</span>
              <span className="flx-sig-count-l">signals</span>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}

// ─────────────────────────────── Signals: source health ───────────────────────────────

type Src = { name: string; source: string; days: number[]; broken?: "erroring" | "paused" };
const WINDOW = 14;
const SOURCES: Src[] = [
  { name: "New issues", source: "sentry", days: [5, 8, 3, 6, 9, 4, 7, 5, 6, 8, 4, 6, 7, 5] },
  { name: "Eval reds", source: "evals", days: [0, 3, 0, 2, 0, 4, 0, 2, 0, 3, 0, 2, 0, 3] },
  { name: "Teammate reports", source: "person", days: [1, 0, 0, 2, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0] },
  { name: "Metric alerts", source: "posthog", days: [2, 1, 3, 1, 2, 2, 1, 3, 2, 0, 0, 0, 0, 0] },
  { name: "AgentWatch findings", source: "agentwatch", days: Array(WINDOW).fill(0) },
  { name: "Failed jobs", source: "ci", days: [0, 0, 1, 0, 2, 1, 0, 1, 0, 0, 1, 0, 1, 0], broken: "erroring" },
];
type SrcState = "flowing" | "quiet" | "stopped";

/** sourceState in day units: stopped if broken or empty; quiet past max(1, 2 × the lower-median gap). */
function readSource(src: Src, shift: number) {
  const days = [...src.days, 0, 0, 0].slice(shift, shift + WINDOW);
  const active = days.flatMap((d, i) => (d > 0 ? [i] : []));
  const last = active.length ? active[active.length - 1] : null;
  const gaps = active.slice(1).map((d, i) => d - active[i]).sort((a, b) => a - b);
  const usual = gaps.length ? gaps[(gaps.length - 1) >> 1] : 1;
  const limit = Math.max(1, 2 * usual);
  const gap = last === null ? WINDOW : WINDOW - 1 - last;
  const state: SrcState = src.broken || last === null ? "stopped" : gap > limit ? "quiet" : "flowing";
  return { days, last, usual, limit, gap, state, max: Math.max(1, ...src.days) };
}
const STATE_COLOR: Record<SrcState, string> = { flowing: LINE, quiet: DIM, stopped: BAD };

function SourceHealth() {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  const [later, setLater] = useState(false);
  const rows = SOURCES.map((s) => ({ src: s, r: readSource(s, later ? 3 : 0) }));
  const feeding = rows.filter((x) => x.r.state === "flowing").length;
  return (
    <div ref={ref} data-play={playing ? "" : undefined} className="flx-sig-health">
      <div className="flx-sig-health-head">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="flx-sig-health-title"><span className="flx-sig-crumb">Loop ›</span> Sources to watch</span>
          <span className="flx-sig-tally"><b>{feeding}</b> feeding</span>
          <span className="flx-sig-tally"><b>{rows.length - feeding}</b> silent</span>
        </div>
        <div className="flx-sig-toggle" role="group" aria-label="When">
          <button type="button" aria-pressed={!later} onClick={() => setLater(false)}>Today</button>
          <button type="button" aria-pressed={later} onClick={() => setLater(true)}>3 quiet days later</button>
        </div>
      </div>
      <div className="flx-sig-rows">
        {rows.map(({ src, r }, ri) => {
          const c = STATE_COLOR[r.state];
          const edge = r.last === null ? null : r.last + r.limit + 1;
          return (
            <div key={src.name} className="flx-sig-row" data-state={r.state}>
              <div className="flx-sig-row-name">
                <span>{src.name}</span>
                <code>{src.source}</code>
              </div>
              <div className="flx-sig-strip" style={{ ["--n" as string]: WINDOW } as CSSProperties}>
                {r.days.map((d, i) => (
                  <span key={i} className="flx-sig-day">
                    <i
                      className="flx-sig-bar"
                      style={at(0.25 + ri * 0.08 + i * 0.03, {
                        height: d > 0 ? `${Math.max(18, (d / r.max) * 100)}%` : 0,
                        backgroundColor: r.state === "stopped" ? tint(BAD, 55) : tint(LINE, 70),
                      })}
                    />
                  </span>
                ))}
                {r.last !== null && r.gap > 0 && r.state !== "stopped" ? (
                  <span
                    className="flx-sig-gap"
                    style={at(0.9 + ri * 0.08, { left: `${((r.last + 1) / WINDOW) * 100}%`, width: `${(r.gap / WINDOW) * 100}%`, ["--c" as string]: c })}
                  >
                    <em>now {r.gap}d</em>
                  </span>
                ) : null}
                {edge !== null && edge <= WINDOW && r.state !== "stopped" ? (
                  <span className="flx-sig-limit" style={at(1.1 + ri * 0.08, { left: `${(edge / WINDOW) * 100}%` })}>
                    <em>limit 2×{r.usual}d</em>
                  </span>
                ) : null}
                {edge !== null && edge < WINDOW && r.state === "quiet" ? (
                  <span className="flx-sig-over" style={at(1.3 + ri * 0.08, { left: `${(edge / WINDOW) * 100}%`, width: `${((WINDOW - edge) / WINDOW) * 100}%` })} />
                ) : null}
                {r.state === "stopped" ? (
                  <span className="flx-sig-dead" style={at(0.9 + ri * 0.08)}>
                    <em>{src.broken ?? "nothing in 14 days"}</em>
                  </span>
                ) : null}
              </div>
              <div className="flx-sig-row-state">
                <span className="flx-sig-pill" style={{ color: r.state === "quiet" ? MUTED : c, backgroundColor: tint(c, r.state === "quiet" ? 18 : 13) }}>{r.state}</span>
                {r.state !== "stopped" ? (
                  <span className="flx-sig-row-num" data-over={r.state === "quiet" ? "" : undefined}>
                    {r.gap}d <b>{r.state === "quiet" ? ">" : "≤"}</b> 2×{r.usual}d
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flx-sig-axis" aria-hidden>
        <span />
        <div className="flex justify-between"><span>14 days ago</span><span>today</span></div>
        <span />
      </div>
    </div>
  );
}

export function SignalsSection() {
  return (
    <Section
      id="signals"
      tone="paper"
      wide
      title="Signals"
      lede={
        <>
          <p>
            A signal is one piece of evidence: a Sentry error, a red eval, a PostHog alert, a teammate&apos;s report. You choose the
            sources. Every signal goes through one door, <b>signals.ingest</b>, where four rules in order decide whether it joins an
            open problem, opens a new one, or stays as evidence.
          </p>
          <p>
            A source that sends nothing for 14 days, or reports erroring or paused, turns red. One that is late against its own
            rhythm, but not stopped, turns grey.
          </p>
        </>
      }
    >
      <OneDoor />
      <div className="mt-16 sm:mt-20">
        <SourceHealth />
      </div>
    </Section>
  );
}

// ─────────────────────────────── Ways in: a person's session ───────────────────────────────

const PERSON_STEPS = [1700, 1500, 1700, 1700, 3200];
const WAYS_BACK = ["Fix check", "Address review", "Revise", "Resolve conflict"];
const EDITS = [
  { name: "web/lib/cart/total.ts", add: 9, del: 2 },
  { name: "convex/checkout.ts", add: 4, del: 1 },
];

function TermIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x={1} y={2} width={14} height={12} rx={2.5} />
      <path d="M4.5 6l2.5 2-2.5 2M8.5 10.5H12" />
    </svg>
  );
}

function PersonLane({ playing }: { playing: boolean }) {
  const still = useStill();
  const [clock] = useStepClock(PERSON_STEPS, still, playing);
  const step = playing ? clock : PERSON_STEPS.length - 1;
  const on = (s: number) => (step >= s ? "" : undefined);
  return (
    <div className="flx-sig-lane" style={{ ["--lane" as string]: PERSON } as CSSProperties}>
      <div className="flx-sig-lane-head">
        <span className="flx-sig-lane-dot" />
        <span>A person&apos;s session</span>
        <code className="flx-sig-lane-id">{CHANGE.session}</code>
      </div>

      <div className="flx-sig-task">
        <span className="flx-sig-task-id">{PROBLEM.task}</span>
        <span className="min-w-0 flex-1">{PROBLEM.title}</span>
        <span className="flx-sig-task-b" data-on={on(3)}>{step >= 3 ? "run bound" : "picked up"}</span>
      </div>

      <div className="flx-sig-pstep" data-on={on(1)}>
        <div className="flex items-center gap-2 flex-wrap">
          <code className="flx-sig-cmd">cast flow run change</code>
          <span className="flx-sig-or">or</span>
          <span className="flx-sig-ship" data-press={step === 1 ? "" : undefined}>Ship</span>
        </div>
        <div className="flx-sig-flags">
          {["--session", "--task", "--branch", "--pr"].map((f, i) => (
            <span key={f} data-def={i === 0 ? "" : undefined}>{f}{i === 0 ? " (default)" : ""}</span>
          ))}
        </div>
      </div>

      {/* Edits → a frozen commit → its own branch. */}
      <ol className="flx-sig-strip3">
        <li className="flx-sig-pstep" data-on={on(0)}>
          <span className="flx-sig-cap">edits</span>
          {EDITS.map((e) => (
            <span key={e.name} className="flx-sig-edit">
              <span className="min-w-0">{e.name}</span>
              <span><b style={{ color: GOOD }}>+{e.add}</b> <b style={{ color: BAD }}>−{e.del}</b></span>
            </span>
          ))}
        </li>
        <li className="flx-sig-pstep" data-on={on(2)}>
          <span className="flx-sig-cap">commit</span>
          <span className="flx-sig-sha">{CHANGE.frozen}</span>
          <span className="flx-sig-dimv">{EDITS.length} files frozen</span>
        </li>
        <li className="flx-sig-pstep" data-on={on(2)}>
          <span className="flx-sig-cap">branch</span>
          <span className="flx-sig-branch">{CHANGE.branch}</span>
        </li>
      </ol>

      <div className="flx-sig-shared flx-sig-pstep" data-on={on(2)} data-ping={step === 2 ? "" : undefined}>
        <span>shared checkout</span>
        <code>main 7c2e1f0</code>
        <span>unchanged</span>
      </div>

      <div className="flx-sig-pstep flx-sig-back" data-on={on(4)}>
        <div className="flx-sig-mini-l flex justify-between gap-2 flex-wrap">
          <span>Findings come back to this session</span>
          <span style={{ color: DIM }}>3 visits each</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {WAYS_BACK.map((w, i) => (
            <span key={w} className="flx-sig-backchip" style={at(0.15 + i * 0.12)}>{w}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

type QItem = { id: string; title: string; tag: string; score: number | null; findings: number; age: number };
const QUEUE: QItem[] = [
  { id: "q1", title: RETRY, tag: "retries", score: 82, findings: 5, age: 2 },
  { id: "q2", title: ONBOARD, tag: "onboarding", score: 64, findings: 7, age: 3 },
  { id: "q3", title: SEARCH, tag: "archived-docs", score: 64, findings: 4, age: 5 },
  { id: "q4", title: EXPORT, tag: "safari-export", score: null, findings: 3, age: 1 },
];
const NEWCOMER: QItem = { id: "q5", title: LOOP, tag: "check-loop", score: null, findings: 6, age: 0 };
const GROUND = [
  { field: "goal", value: "line" },
  { field: "category", value: "prompt" },
  { field: "risk", value: "low" },
  { field: "readiness", value: "ready" },
];
// 0 new problem · 1-4 Ground stamps (4 joins the queue) · 5 pick top → mini-1 · 6 placed
// 7 laptop's run stops at a card, slot frees · 8 pick next → laptop · 9 placed · 10 rest
const LINE_STEPS = [1500, 850, 850, 850, 1500, 1500, 1300, 2000, 1500, 1300, 3200];

const rankOf = (q: QItem) => q.score ?? 50;
const byQueue = (a: QItem, b: QItem) => rankOf(b) - rankOf(a) || b.findings - a.findings || b.age - a.age;

function lineAt(f: number) {
  const started = [...(f >= 6 ? ["q1"] : []), ...(f >= 9 ? ["q2"] : [])];
  const pool = [...QUEUE, ...(f >= 4 ? [NEWCOMER] : [])];
  const queue = pool.filter((q) => !started.includes(q.id)).sort(byQueue);
  const picking = f === 5 ? "q1" : f === 8 ? "q2" : null;
  const machines = [
    { name: "mini-1", runs: 3, online: true, jobs: ["billing", ...(f >= 6 ? [QUEUE[0].tag] : [])] },
    { name: "laptop", runs: 2, online: true, jobs: [...(f < 7 ? ["docs-404"] : []), ...(f >= 9 ? [QUEUE[1].tag] : [])] },
    { name: "studio", runs: 4, online: false, jobs: [] as string[] },
  ];
  const chosen = f === 5 || f === 6 ? "mini-1" : f === 8 || f === 9 ? "laptop" : null;
  const onPerson = ["banner-copy", ...(f >= 7 ? ["docs-404"] : [])];
  return { queue, picking, machines, chosen, onPerson, stamped: Math.min(4, f) };
}

function LineLane({ playing }: { playing: boolean }) {
  const still = useStill();
  const [clock] = useStepClock(LINE_STEPS, still, playing);
  const f = playing ? clock : LINE_STEPS.length - 1;
  const s = lineAt(f);
  return (
    <div className="flx-sig-lane" style={{ ["--lane" as string]: LINE } as CSSProperties}>
      <div className="flx-sig-lane-head">
        <span className="flx-sig-lane-dot" />
        <span>The line</span>
      </div>

      {/* Ground: four fields on each new problem. */}
      <div className="flx-sig-ground">
        <div className="flx-sig-mini-l flex justify-between gap-2">
          <span>Ground</span>
          <span style={{ color: DIM }}>every 2 min</span>
        </div>
        <div className="flx-sig-ground-title">
          <SourceChip source="agentwatch" />
          <span className="min-w-0">{NEWCOMER.title}</span>
        </div>
        <div className="flx-sig-fields">
          {GROUND.map((g, i) => {
            const set = s.stamped > i;
            return (
              <div key={g.field} className="flx-sig-field" data-set={set ? "" : undefined} data-now={set && f === i + 1 && playing ? "" : undefined}>
                <span>{g.field}</span>
                <b>{set ? g.value : "·"}</b>
              </div>
            );
          })}
        </div>
      </div>

      {/* The queue, in the live flow's order. */}
      <div className="flx-sig-queue">
        <div className="flx-sig-mini-l flex justify-between gap-2 flex-wrap">
          <span>Queue</span>
          <span style={{ color: DIM }}>score, findings, age</span>
        </div>
        <div className="flx-sig-qlist" style={{ ["--n" as string]: s.queue.length } as CSSProperties}>
          {[...QUEUE, NEWCOMER].map((q) => {
            const idx = s.queue.findIndex((x) => x.id === q.id);
            if (idx < 0) return null;
            return (
              <div
                key={q.id}
                className={`flx-sig-qrow ${q.id === NEWCOMER.id ? "flx-sig-qnew" : ""}`}
                data-pick={s.picking === q.id ? "" : undefined}
                style={{ ["--i" as string]: idx } as CSSProperties}
              >
                <span className="flx-sig-qrank">{idx + 1}</span>
                <span className="flx-sig-qtitle">{q.title}</span>
                <span className="flx-sig-qscore" data-unscored={q.score === null ? "" : undefined} title={q.score === null ? "unscored, ranks as 50" : undefined}>
                  {rankOf(q)}
                </span>
                <span className="flx-sig-qmeta">{q.findings}f</span>
                <span className="flx-sig-qmeta">{q.age}d</span>
              </div>
            );
          })}
        </div>
        <div className="flx-sig-qkey"><span className="flx-sig-qscore" data-unscored="">50</span> unscored</div>
      </div>

      {/* Machines and their run slots. */}
      <div>
        <div className="flx-sig-mini-l flex justify-between gap-2 flex-wrap">
          <span>Machines</span>
          <span style={{ color: DIM }}>most free slots wins</span>
        </div>
        <div className="flx-sig-machines">
          {s.machines.map((m) => {
            const free = m.online ? m.runs - m.jobs.length : 0;
            return (
              <div key={m.name} className="flx-sig-machine" data-off={m.online ? undefined : ""} data-chosen={s.chosen === m.name ? "" : undefined}>
                <div className="flx-sig-machine-head">
                  <span>{m.name}</span>
                  <span className="flx-sig-free">{m.online ? `${free} free` : "offline"}</span>
                </div>
                <div className="flx-sig-slots">
                  {Array.from({ length: m.runs }, (_, i) => {
                    const job = m.jobs[i];
                    return (
                      <span key={job ?? `free-${i}`} className="flx-sig-slot" data-run={job ? "" : undefined}>
                        {job ?? null}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="flx-sig-person">
        <span className="flx-sig-person-l">On a person</span>
        <span className="flx-sig-person-sub">no slot</span>
        <div className="flex flex-wrap gap-1.5 min-w-0">
          {s.onPerson.map((t) => (
            <span key={t} className="flx-sig-card-chip">{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function WaysIn() {
  const [ref, playing] = usePlayOnView<HTMLDivElement>();
  return (
    <div ref={ref} data-play={playing ? "" : undefined} className="flx-sig-ways">
      <div className="flx-sig-lanes">
        <div className="flx-sig-lanecol">
          <PersonLane playing={playing} />
          <span className="flx-sig-wire" style={{ backgroundColor: PERSON }} aria-hidden />
        </div>
        <div className="flx-sig-lanecol">
          <LineLane playing={playing} />
          <span className="flx-sig-wire" style={{ backgroundColor: LINE }} aria-hidden />
        </div>
      </div>
      <svg className="flx-sig-merge" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden>
        <path d="M245 0 C245 36 500 24 500 60" style={{ stroke: PERSON }} />
        <path d="M755 0 C755 36 500 24 500 60" style={{ stroke: LINE }} />
        <path className="flx-sig-march" d="M245 0 C245 36 500 24 500 60" style={{ stroke: PERSON }} />
        <path className="flx-sig-march" d="M755 0 C755 36 500 24 500 60" style={{ stroke: LINE }} />
      </svg>
      <a href="#checks" className="flx-sig-check">
        <TermIcon />
        <span>Check</span>
      </a>
      <div className="flx-sig-check-sub">same checks, every change</div>
    </div>
  );
}

export function WaysInSection() {
  return (
    <Section
      id="ways-in"
      tone="sand"
      wide
      title="Triage and build"
      lede={
        <>
          <p>
            A person sends finished work with <b>cast flow run change</b>, or Ship in the app. The session&apos;s edits freeze into a
            commit on its own branch, so nothing moves in the shared checkout.
          </p>
          <p>
            The line starts the rest from the problems signals open. Ground labels each new problem, ready ones queue by score, and
            each run takes a free slot on a machine.
          </p>
        </>
      }
    >
      <WaysIn />
    </Section>
  );
}
