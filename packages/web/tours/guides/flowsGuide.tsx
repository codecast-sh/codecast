"use client";
// The Flows guide: one Tidepool change through the team's flow, start to
// ship, then flows that find their own work, watch what they shipped, and get
// better (docs/architecture/flows.md, line-workspace.md, the-line.md). The
// flow on the stage is the real Change flow drawn by the real FlowDiagram, so
// the guide shows the steps a team's changes will actually take.
import { useMemo } from "react";
import { Bot, Check, ChevronRight, GitMerge, GitPullRequest, Route, SquareTerminal, ThumbsDown, ThumbsUp, User } from "lucide-react";
import { Switch } from "../../components/ui/switch";
import { FlowDiagram } from "../../components/line/widgets/FlowDiagram";
import { SHIPPED_FLOWS } from "../../lib/line/shippedFlows.generated";
import { flowDiagram } from "../../lib/line/flowDiagram";
import "../../components/line/workspace/workspace.css";
import { Chip, Count, Dot, Face, Msg, Person, RoleCard, Show, StageButton, Win, Wires, useArrived } from "./kit";
import type { GuideDef, SceneProps } from "./types";

const ACCENT = "var(--sol-cyan)";
const CHANGE = SHIPPED_FLOWS.find((f) => f.slug === "change") ?? SHIPPED_FLOWS[0];

/** A run of the Change flow standing at step `at` (0-based), every earlier step done. A segment's
 *  state is read from its own steps' ids, so the run names leaves, the way a real run's visits do. */
function useChangeRun(at: number | null, finished = false) {
  return useMemo(() => {
    if (at === null) return null;
    const leaves = flowDiagram(CHANGE).steps.map((s) => (s.inner.length ? s.inner.map((i) => i.id) : [s.id]));
    const upTo = finished ? leaves.length : Math.min(at, leaves.length - 1);
    return {
      status: finished ? "completed" : "running",
      current_node_id: finished ? null : leaves[upTo][0],
      node_statuses: leaves.slice(0, upTo).flat().map((id) => ({ node_id: id, status: "completed" })),
    };
  }, [at, finished]);
}

const stepCount = () => flowDiagram(CHANGE).steps.length;

// ------------------------------------------------------------ 1. a flow

function AFlow({ beat }: SceneProps) {
  const library = [...SHIPPED_FLOWS].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "line" ? -1 : 1));
  return (
    <div className="gs">
      <div className="absolute" style={{ left: 60, top: 36, width: 920 }}>
        <div className="flex items-baseline gap-3">
          <span className="gs-serif text-[28px] font-semibold">Change</span>
          <span className="text-[12.5px] gs-muted">the flow every Tidepool change runs before it ships</span>
        </div>
        <div className="gs-card mt-4 overflow-hidden" style={{ animation: "guide-say-in 500ms 150ms both" }}>
          <FlowDiagram flow={CHANGE} compact={beat === 0} />
        </div>
      </div>
      <Show on={beat >= 2} at={{ x: 60, y: 446, w: 920 }}>
        <div className="gs-label mb-2">THE TEAM'S LIBRARY</div>
        <div className="flex flex-wrap gap-2">
          {library.map((f, i) => (
            <span key={f.slug} className="gs-card inline-flex items-center gap-2 h-[34px] px-3 text-[12.5px]" style={{ animation: beat >= 2 ? `guide-say-in 400ms ${i * 70}ms both` : undefined }}>
              <Route className="w-3.5 h-3.5" style={{ color: f.kind === "line" ? ACCENT : "var(--sol-text-dim)" }} />
              <span className="font-semibold">{f.label}</span>
              <span className="text-[10.5px] gs-dim">{f.kind === "line" ? "whole flow" : "segment"}</span>
            </span>
          ))}
          <span className="gs-card gs-ghost inline-flex items-center gap-2 h-[34px] px-3 text-[12.5px]"><Route className="w-3.5 h-3.5" /> <span className="font-semibold">Tidepool release</span><span className="text-[10.5px] gs-dim">yours</span></span>
        </div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ 2. run a change

function RunChange({ beat, act, waiting }: SceneProps) {
  const picked = beat >= 2 || (beat === 1 && !waiting);
  const running = beat >= 3;
  const run = useChangeRun(running ? (beat >= 4 ? Math.max(0, stepCount() - 2) : 1) : null);
  return (
    <div className="gs">
      <Win title={<><Dot state={running ? "working" : "done"} /><b>Fix double booking on slot release</b><span className="gs-dim">· claude · tidepool/app</span></>} at={{ x: 36, y: 60, w: 968, h: 480 }}
        right={<button type="button" onClick={waiting ? act : undefined} data-wait={waiting ? "" : undefined} data-guide-stage-act={waiting ? "" : undefined} className={`gs-btn ${waiting ? "" : ""}`} style={{ borderColor: picked ? "var(--guide-accent)" : undefined, color: picked ? ACCENT : undefined }}><Route className="w-3.5 h-3.5" /> Run through</button>}>
        <div className="absolute left-6 right-6 top-5 flex flex-col gap-3">
          <Msg from={<Person name="You" you size={24} color="var(--sol-blue)" />} you>Two people can book the same surf slot when one cancels. Fix it.</Msg>
          <Msg from={<span className="gs-face" style={{ width: 24, height: 24, background: "var(--sol-orange)", fontSize: 11 }}>A</span>}>
            Done. Releasing a slot now locks its row, so a second booking waits for the first to finish. Added a test that books the same slot from two clients.
            <div className="mt-2 flex gap-2"><Chip color="var(--sol-green)">+42</Chip><Chip color="var(--sol-red)">−9</Chip><Chip>4 files</Chip></div>
          </Msg>
        </div>
        <Show on={beat === 1 || (beat === 2 && false)} at={{ x: 600, y: 4, w: 350 }} style={{ zIndex: 4 }}>
          <div className="gs-card p-2 flex flex-col" style={{ boxShadow: "0 20px 50px -20px rgba(0,0,0,.55)" }}>
            <div className="gs-label px-2 pt-1 pb-2">RUN THIS CHANGE THROUGH</div>
            {["change", "review", "check", "ship"].map((slug) => SHIPPED_FLOWS.find((f) => f.slug === slug)!).filter(Boolean).map((f) => (
              <div key={f.slug} className={`flex items-center gap-2 px-2.5 h-[40px] rounded-lg ${f.slug === "change" && waiting ? "gs-spot" : ""}`} style={{ background: f.slug === "change" ? "var(--sol-bg-alt)" : "transparent" }}>
                <Route className="w-3.5 h-3.5" style={{ color: f.slug === "change" ? ACCENT : "var(--sol-text-dim)" }} />
                <span className="text-[12.5px] font-semibold w-[70px]">{f.label}</span>
                <span className="text-[11px] gs-dim truncate flex-1">{f.description ?? ""}</span>
                {f.slug === "change" && waiting && <StageButton primary wait onPress={act}>Run</StageButton>}
              </div>
            ))}
          </div>
        </Show>
        <Show on={beat === 2} at={{ x: 260, y: 150, w: 450 }} style={{ zIndex: 4 }}>
          <div className="gs-card p-5" style={{ boxShadow: "0 30px 70px -30px rgba(0,0,0,.6)" }}>
            <div className="text-[15px] font-semibold">Run this change through Change?</div>
            <div className="mt-3 flex flex-col gap-2 text-[12.5px]">
              {[["Starts", "1 review session, on this machine"], ["Asks you", "1 decision, at Decide"], ["Can end", "merged, held, or sent back with a reason"], ["Stop", "any time, from the run card"]].map(([k, v]) => (
                <div key={k} className="flex gap-3"><span className="w-[72px] shrink-0 gs-dim">{k}</span><span>{v}</span></div>
              ))}
            </div>
            <div className="mt-4 flex gap-2 justify-end"><StageButton>Cancel</StageButton><StageButton primary>Run it</StageButton></div>
          </div>
        </Show>
        <Show on={running} at={{ x: 24, y: 196, w: 920 }}>
          <div className="gs-card p-3" style={{ borderColor: "color-mix(in srgb, var(--guide-accent) 40%, transparent)" }}>
            <div className="flex items-center gap-2 px-1 pb-2">
              <Route className="w-4 h-4" style={{ color: ACCENT }} />
              <span className="text-[13px] font-semibold">Change</span>
              <span className="text-[11.5px] gs-dim">· run 1 · ct-412 Fix double booking</span>
              <span className="ml-auto text-[11.5px] font-semibold" style={{ color: beat >= 4 ? "var(--sol-orange)" : ACCENT }}>{beat >= 4 ? "Waiting on you at Decide" : "Reviewing"}</span>
              <StageButton>Stop</StageButton>
            </div>
            <FlowDiagram flow={CHANGE} run={run} compact />
            <div className="mt-2 px-1 flex flex-col gap-1 text-[12px]">
              <div className="flex items-center gap-2"><Check className="w-3.5 h-3.5" style={{ color: "var(--sol-green)" }} /> Check: 212 tests passed, types clean</div>
              <Show on={beat >= 4}><div className="flex items-center gap-2"><Check className="w-3.5 h-3.5" style={{ color: "var(--sol-green)" }} /> Review: an independent session found a missing index; fixed and re-checked</div></Show>
            </div>
          </div>
        </Show>
      </Win>
    </div>
  );
}

// ------------------------------------------------------------ 3. you decide

function Decide({ beat, act, waiting }: SceneProps) {
  const shipped = beat >= 3 || (beat === 2 && !waiting);
  const run = useChangeRun(shipped ? stepCount() - 1 : stepCount() - 2, beat >= 3);
  const spot = beat === 1;
  return (
    <div className="gs">
      <div className="gs-card absolute px-2 py-1" style={{ left: 60, top: 28, width: 920 }}>
        <FlowDiagram flow={CHANGE} run={run} compact />
      </div>
      <div className="gs-card absolute p-5" style={{ left: 60, top: 146, width: 560, height: 426, borderColor: "color-mix(in srgb, var(--guide-accent) 45%, transparent)" }}>
        <div className="flex items-center gap-2"><span className="gs-pill" style={{ color: "var(--sol-orange)", background: "color-mix(in srgb, var(--sol-orange) 14%, transparent)" }}>DECIDE</span><span className="text-[11.5px] gs-dim">Change · ct-412</span></div>
        <div className="mt-2 gs-serif text-[21px] font-semibold leading-snug">Ship: fix double booking on slot release</div>
        <p className="mt-2 text-[12.5px] gs-muted leading-relaxed">Releasing a slot locks its row, so a second booking waits instead of landing on the same slot.</p>
        <div className="gs-label mt-4 mb-2">EVIDENCE</div>
        <div className="flex flex-col gap-1.5">
          {[["Reproduced", "Two clients booked one slot before the fix; 0 of 50 tries after"], ["Check", "212 tests passed, including the new two-client test"], ["Review", "Approved by an independent session after a missing index was added"]].map(([k, v], i) => (
            <div key={k} className={`flex gap-3 items-start p-2 rounded-lg text-[12px] ${spot ? "gs-spot" : ""}`} style={{ background: "var(--sol-bg)", transitionDelay: `${i * 120}ms` }}>
              <Check className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: "var(--sol-green)" }} />
              <span className="w-[78px] shrink-0 font-semibold">{k}</span><span className="gs-muted">{v}</span>
            </div>
          ))}
        </div>
        <div className="absolute left-5 right-5 bottom-5 flex items-center gap-2">
          {shipped ? (
            <span className="text-[13px] font-semibold flex items-center gap-1.5" style={{ color: "var(--sol-green)" }}><Check className="w-4 h-4" /> You shipped it</span>
          ) : (
            <>
              <StageButton primary wait={waiting} onPress={act}>Ship</StageButton>
              <StageButton>Hold</StageButton>
              <StageButton>Send back with a note</StageButton>
            </>
          )}
        </div>
      </div>
      <div className="absolute flex flex-col gap-3" style={{ left: 650, top: 146, width: 330 }}>
        <div className="gs-label">SHIP</div>
        {[[GitPullRequest, "Pull request #482 opened", "tidepool/app"], [Check, "Checks green", "CI · 4m 12s"], [GitMerge, "Merged to main", "2:14 pm"]].map(([Icon, k, v]: any, i) => (
          <Show key={k} on={beat >= 3} style={{ transitionDelay: `${i * 450}ms` }}>
            <div className="gs-card flex items-center gap-3 px-3 h-[48px]">
              <Icon className="w-4 h-4" style={{ color: i === 2 ? "var(--sol-violet)" : "var(--sol-green)" }} />
              <span className="text-[12.5px] font-semibold flex-1">{k}</span><span className="text-[11px] gs-dim">{v}</span>
            </div>
          </Show>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ 4. problems come in

const SOURCES = [
  { name: "Errors", sub: "Sentry", color: "var(--sol-red)" },
  { name: "Support", sub: "help@ inbox", color: "var(--sol-blue)" },
  { name: "Replays", sub: "PostHog", color: "var(--sol-yellow)" },
  { name: "Agent review", sub: "reads every conversation", color: "var(--sol-violet)" },
];
const PROBLEMS = [
  { title: "Double booking on slot release", findings: 23, people: 11, trend: [1, 2, 2, 4, 3, 5, 6], color: "var(--sol-red)" },
  { title: "Checkout times out on slow 3G", findings: 9, people: 7, trend: [0, 1, 1, 2, 1, 2, 2], color: "var(--sol-orange)" },
  { title: "Refund email missing the receipt", findings: 4, people: 4, trend: [0, 0, 1, 0, 1, 1, 1], color: "var(--sol-yellow)" },
];

function Spark({ data, color }: { data: number[]; color: string }) {
  const max = Math.max(...data, 1);
  return <svg width="84" height="24" aria-hidden><polyline fill="none" stroke={color} strokeWidth="1.6" points={data.map((v, i) => `${i * 14},${22 - (v / max) * 20}`).join(" ")} /></svg>;
}

function ProblemsIn({ beat }: SceneProps) {
  const arrived = useArrived();
  return (
    <div className="gs">
      {SOURCES.map((s, i) => (
        <div key={s.name} className="gs-card absolute flex items-center gap-2.5 px-3" style={{ left: 40, top: 70 + i * 116, width: 210, height: 64, animation: `guide-say-in 450ms ${i * 90}ms both` }}>
          <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
          <div><div className="text-[13px] font-semibold">{s.name}</div><div className="text-[11px] gs-dim">{s.sub}</div></div>
        </div>
      ))}
      <Wires>
        {SOURCES.map((s, i) => PROBLEMS.map((p, j) => (
          <path key={`${i}-${j}`} d={`M250,${102 + i * 116} C340,${102 + i * 116} 360,${150 + j * 120} 430,${150 + j * 120}`} className="gs-wire" style={{ opacity: arrived && beat >= 1 && (i + j) % 2 === 0 ? 0.55 : 0.12 }} />
        )))}
      </Wires>
      {/* Findings in flight from the sources. */}
      {arrived && Array.from({ length: 10 }, (_, k) => (
        <span key={k} className="absolute w-2 h-2 rounded-full" style={{ left: 252, top: 98 + (k % 4) * 116, background: SOURCES[k % 4].color, animation: `gs-fly 2.4s ${k * 0.35}s ease-in infinite` }} />
      ))}
      {PROBLEMS.map((p, j) => (
        <div key={p.title} className="gs-card absolute px-4 flex items-center gap-4" style={{ left: 430, top: 118 + j * 120, width: 570, height: 64, opacity: beat >= 1 ? 1 : 0.25, transition: "opacity 600ms", transitionDelay: `${j * 120}ms`, boxShadow: beat >= 2 && j === 0 ? "0 0 0 2px var(--guide-accent)" : undefined }}>
          <span className="gs-serif text-[22px] font-semibold w-6 text-center" style={{ color: beat >= 2 ? "var(--sol-text)" : "var(--sol-text-dim)" }}>{j + 1}</span>
          <div className="flex-1 min-w-0">
            <div className="text-[13px] font-semibold truncate">{p.title}</div>
            <div className="text-[11.5px] gs-dim mt-0.5"><Count value={beat >= 1 ? p.findings : 0} /> findings · {p.people} customers</div>
          </div>
          <Spark data={p.trend} color={p.color} />
          <Show on={beat >= 2}><span className="text-[11px] font-semibold tabular-nums" style={{ color: p.color }}>{[91, 64, 38][j]}</span></Show>
        </div>
      ))}
      <Show on={beat >= 1} at={{ x: 430, y: 452, w: 570 }} style={{ transitionDelay: "500ms" }}>
        <div className="flex items-end gap-[10px] h-[92px] px-4">
          {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full flex flex-col-reverse rounded-[3px] overflow-hidden">
                {PROBLEMS.map((p) => <span key={p.title} style={{ height: p.trend[i] * 9, background: p.color, opacity: 0.85 }} />)}
              </div>
              <span className="text-[10px] gs-dim">{d}</span>
            </div>
          ))}
        </div>
      </Show>
      <Show on={beat >= 2} at={{ x: 430, y: 66, w: 570 }}>
        <div className="flex items-center text-[11px] gs-dim px-4"><span className="flex-1">PROBLEMS, WORST FIRST</span><span>7 DAYS</span><span className="w-[60px] text-right">SCORE</span></div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ 5. live flows

const LIVE_STEPS = ["Investigate", "Propose", "Prove", "Build", "Verify", "Review", "Decide"];

function LiveFlow({ beat }: SceneProps) {
  const on = true;
  // The run the camera follows: just started, then through the agent steps, then waiting on a person.
  const at = beat === 0 ? 0 : beat === 1 ? 5 : 6;
  return (
    <div className="gs">
      <div className="gs-card absolute p-5" style={{ left: 40, top: 46, width: 960, height: 200 }}>
        <div className="flex items-center gap-3">
          <span className="gs-pill" style={{ color: "var(--sol-green)", background: "color-mix(in srgb, var(--sol-green) 14%, transparent)" }}>LIVE</span>
          <span className="gs-serif text-[20px] font-semibold">Tidepool fix flow</span>
          <span className="text-[12px] gs-muted flex items-center gap-1.5">run by <Face avatar="hedgehog" size={18} /> QA Lead</span>
          <span className="ml-auto flex items-center gap-2 text-[12px]">{on ? "On" : "Off"} <Switch checked={on} onCheckedChange={() => {}} aria-label="Live flow" /></span>
        </div>
        <div className="mt-9 flex items-center relative">
          <span className="absolute z-[1] gs-pill" style={{ top: -30, left: at * 126 + 50, transform: "translateX(-50%)", transition: `left ${beat === 1 ? 2600 : 900}ms cubic-bezier(.4,0,.2,1)`, color: "var(--sol-bg)", background: ACCENT }}>ct-412</span>
          {LIVE_STEPS.map((s, i) => {
            const here = i === at;
            const person = s === "Decide";
            return (
              <div key={s} className="flex items-center">
                {i > 0 && <span className="w-[26px] h-[2px]" style={{ background: "color-mix(in srgb, var(--guide-accent) 45%, transparent)" }} />}
                <div className="flex flex-col items-center gap-1.5 w-[100px]">
                  <span className={`w-[34px] h-[34px] rounded-full inline-flex items-center justify-center transition-all duration-500 ${here ? "gs-live" : ""}`} style={{ background: here ? "color-mix(in srgb, var(--guide-accent) 22%, var(--sol-card))" : "var(--sol-bg)", border: `1.5px solid ${here ? "var(--guide-accent)" : "color-mix(in srgb, var(--sol-border) 80%, transparent)"}`, color: person ? "var(--sol-orange)" : ACCENT }}>
                    {person ? <User className="w-4 h-4" /> : s === "Verify" || s === "Prove" ? <SquareTerminal className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
                  </span>
                  <span className="text-[11.5px] font-semibold">{s}</span>
                  <span className="text-[10.5px] tabular-nums" style={{ color: person ? "var(--sol-orange)" : "var(--sol-text-dim)" }}>{[3, 2, 1, 4, 2, 1, 2][i]} {person ? "on you" : "running"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="absolute flex flex-col gap-2" style={{ left: 40, top: 280, width: 470 }}>
        <div className="gs-label">QUEUE, BEST FIRST</div>
        {["Double booking on slot release", "Checkout times out on slow 3G", "Refund email missing the receipt", "Instructor calendar shows UTC"].map((t, i) => (
          <div key={t} className="gs-card flex items-center gap-3 px-3 h-[40px] transition-all duration-700" style={{ opacity: i < beat ? 0.35 : 1 }}>
            <span className="text-[11px] gs-dim w-4">{i + 1}</span><span className="text-[12.5px] flex-1 truncate">{t}</span>
            <span className="text-[11px]" style={{ color: i < beat ? ACCENT : "var(--sol-text-dim)" }}>{i < beat ? "started" : "queued"}</span>
          </div>
        ))}
      </div>
      <Show on={beat >= 2} at={{ x: 540, y: 300, w: 460 }}>
        <div className="gs-card p-3.5 flex gap-3 items-start">
          <Face avatar="hedgehog" size={30} />
          <div className="text-[12.5px] leading-snug"><b>QA Lead</b> <span className="gs-muted">answers what the run asks inside its charter, and recommends on the cards that go to you.</span></div>
        </div>
      </Show>
      <Show on={beat >= 3} at={{ x: 540, y: 402, w: 460 }}>
        <div className="flex gap-2 flex-wrap">
          <Chip color={ACCENT}>Takes from: Errors, Support, Agent review</Chip>
          <Chip>12 runs a day at most</Chip>
          <Chip>Hold until a time</Chip>
          <Chip>Off switch</Chip>
        </div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ 6. shipped and watched

const DAYS = 14;
const HELD = [3, 4, 3, 5, 6, 5, 7, 2, 0, 0, 0, 0, 0, 0];
const CAME_BACK = [2, 2, 3, 2, 1, 0, 0, 0, 1, 2, 3, 2, 1, 0];

function Timeline({ data, ship, close, back, beat }: { data: number[]; ship: number; close?: number; back?: boolean; beat: number }) {
  const W = 880, H = 96, bw = W / DAYS;
  const max = Math.max(...data, 1);
  return (
    <svg width={W} height={H + 24} aria-hidden>
      <rect x={ship * bw} y={0} width={(DAYS - ship) * bw} height={H} fill={back ? "color-mix(in srgb, var(--sol-red) 7%, transparent)" : "color-mix(in srgb, var(--sol-green) 7%, transparent)"} />
      {data.map((v, i) => {
        const after = i >= ship;
        const h = (v / max) * (H - 12);
        return <rect key={i} x={i * bw + 6} y={H - h} width={bw - 12} height={h} rx={3} fill={after && back && v ? "var(--sol-red)" : "color-mix(in srgb, var(--sol-text-dim) 55%, transparent)"} style={{ transition: "height 600ms, y 600ms", opacity: beat >= 0 ? 1 : 0 }} />;
      })}
      <line x1={ship * bw} x2={ship * bw} y1={0} y2={H} stroke="var(--guide-accent)" strokeWidth={2} />
      <text x={ship * bw + 6} y={H + 16} fontSize="11" fill="var(--sol-text-muted)">{close !== undefined ? "closed: no change needed" : "fix live"}</text>
      <text x={W - 4} y={H + 16} fontSize="11" fill="var(--sol-text-dim)" textAnchor="end">watching 7 days</text>
    </svg>
  );
}

function Watched({ beat }: SceneProps) {
  return (
    <div className="gs">
      <div className="gs-card absolute p-4" style={{ left: 60, top: 40, width: 920 }}>
        <div className="flex items-center gap-2"><span className="text-[13.5px] font-semibold">Double booking on slot release</span><span className="ml-auto gs-pill" style={{ color: "var(--sol-green)", background: "color-mix(in srgb, var(--sol-green) 14%, transparent)" }}>{beat >= 1 ? "HELD · QUIET 6 DAYS" : "WATCHING"}</span></div>
        <div className="mt-3"><Timeline data={HELD} ship={8} beat={beat} /></div>
      </div>
      <Show on={beat >= 1} at={{ x: 60, y: 232, w: 920 }}>
        <div className="gs-card p-4">
          <div className="flex items-center gap-2"><span className="text-[13.5px] font-semibold">Checkout times out on slow 3G</span><span className="ml-auto gs-pill" style={{ color: "var(--sol-red)", background: "color-mix(in srgb, var(--sol-red) 14%, transparent)" }}>CAME BACK · REOPENED</span></div>
          <div className="mt-3"><Timeline data={CAME_BACK} ship={6} close={6} back beat={beat} /></div>
        </div>
      </Show>
      <Show on={beat >= 2} at={{ x: 60, y: 424, w: 920 }}>
        <div className="gs-card p-4 flex gap-4 items-start" style={{ borderColor: "color-mix(in srgb, var(--guide-accent) 45%, transparent)" }}>
          <div className="gs-label w-[110px] shrink-0 mt-0.5">ALREADY TRIED</div>
          <div className="flex-1 text-[12.5px] leading-relaxed">
            <div><span className="gs-dim">Run 1 ·</span> closed as a slow network, no change needed. <span style={{ color: "var(--sol-red)" }}>It came back 3 days later.</span></div>
            <div className="mt-1"><span className="gs-dim">Run 2 ·</span> starts from that: the payment call has no timeout, so a slow response holds checkout open. Proposes a 10s timeout with a retry.</div>
          </div>
        </div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ 7. make it yours

function MakeItYours({ beat }: SceneProps) {
  return (
    <div className="gs">
      <Win title={<><b>Propose</b><span className="gs-dim">· a step's instructions</span></>} at={{ x: 36, y: 36, w: 470, h: 290 }}>
        <div className="absolute inset-0 p-4 text-[12px] leading-[1.65] font-mono">
          <div className="gs-muted">Read the problem and what was tried before.</div>
          <div className="gs-muted">Propose the smallest change that fixes the cause.</div>
          <div className="rounded px-1 -mx-1 transition-colors duration-500" style={{ background: beat >= 0 ? "color-mix(in srgb, var(--sol-green) 16%, transparent)" : undefined }}>+ If an earlier fix shipped and the problem came back,</div>
          <div className="rounded px-1 -mx-1" style={{ background: "color-mix(in srgb, var(--sol-green) 16%, transparent)" }}>+ say why it did not hold before proposing anything.</div>
          <div className="gs-muted">Name the test that will prove it.</div>
          <div className="absolute left-4 bottom-4 flex gap-2"><StageButton primary>Test this edit</StageButton><StageButton>Save</StageButton><span className="text-[11px] gs-dim self-center ml-2">v7 · every save is a version</span></div>
        </div>
      </Win>
      <Show on={beat >= 1} at={{ x: 530, y: 36, w: 474 }}>
        <div className="gs-card p-4">
          <div className="gs-label">TRIED ON 5 PAST CASES</div>
          <div className="mt-2 grid text-[11.5px]" style={{ gridTemplateColumns: "1.3fr 1fr 1fr" }}>
            <span className="gs-dim pb-1.5">Case</span><span className="gs-dim pb-1.5">It said</span><span className="gs-dim pb-1.5">It says now</span>
            {[["3G timeout", "Close it", "Add a timeout", true], ["Double booking", "Lock the row", "Lock the row", false], ["Refund receipt", "Resend email", "Resend email", false], ["Calendar UTC", "Close it", "Store the timezone", true], ["Promo code", "Fix rounding", "Fix rounding", false]].map(([c, a, b, changed]) => (
              <div key={c as string} className="contents">
                <span className="py-1.5 font-semibold" style={{ borderTop: "1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)" }}>{c as string}</span>
                <span className="py-1.5 gs-muted" style={{ borderTop: "1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)", textDecoration: changed ? "line-through" : undefined }}>{a as string}</span>
                <span className="py-1.5" style={{ borderTop: "1px solid color-mix(in srgb, var(--sol-border) 50%, transparent)", color: changed ? "var(--sol-green)" : undefined, fontWeight: changed ? 600 : 400 }}>{b as string}</span>
              </div>
            ))}
          </div>
          <div className="mt-2 text-[11.5px]" style={{ color: "var(--sol-green)" }}>2 answers better · 3 the same · nothing ships from a test</div>
        </div>
      </Show>
      <Show on={beat >= 2} at={{ x: 36, y: 346, w: 470 }}>
        <div className="gs-card p-4">
          <div className="gs-label">MARK WHAT IT GOT RIGHT</div>
          {[["Calendar UTC → store the timezone", "right"], ["3G timeout → close it", "wrong"]].map(([t, v]) => (
            <div key={t} className="flex items-center gap-2 mt-2 text-[12px]">
              <span className="flex-1 truncate">{t}</span>
              <span className="w-7 h-7 rounded-md inline-flex items-center justify-center" style={{ background: v === "right" ? "color-mix(in srgb, var(--sol-green) 18%, transparent)" : "transparent", color: v === "right" ? "var(--sol-green)" : "var(--sol-text-dim)" }}><ThumbsUp className="w-3.5 h-3.5" /></span>
              <span className="w-7 h-7 rounded-md inline-flex items-center justify-center" style={{ background: v === "wrong" ? "color-mix(in srgb, var(--sol-red) 18%, transparent)" : "transparent", color: v === "wrong" ? "var(--sol-red)" : "var(--sol-text-dim)" }}><ThumbsDown className="w-3.5 h-3.5" /></span>
            </div>
          ))}
          <div className="mt-2 text-[11px] gs-dim">Marked answers become this step's test set.</div>
        </div>
      </Show>
      <Show on={beat >= 3} at={{ x: 530, y: 346, w: 474 }}>
        <div className="gs-card p-4">
          <div className="gs-label">FROM A SESSION TO THE LIBRARY</div>
          <div className="mt-3 flex items-center gap-1.5 text-[11.5px] whitespace-nowrap">
            <span className="gs-card px-2.5 h-[30px] inline-flex items-center">An agent's workflow</span>
            <ChevronRight className="w-4 h-4 gs-dim" />
            <span className="gs-card px-2.5 h-[30px] inline-flex items-center">Add to flows</span>
            <ChevronRight className="w-4 h-4 gs-dim" />
            <span className="gs-card px-2.5 h-[30px] inline-flex items-center font-semibold" style={{ color: ACCENT }}><Route className="w-3.5 h-3.5 mr-1" /> Tidepool release</span>
          </div>
          <div className="mt-3 text-[11.5px] gs-muted">The team's library gains a flow, and every member can run it.</div>
        </div>
      </Show>
    </div>
  );
}

// ------------------------------------------------------------ the guide

export const FLOWS_GUIDE: GuideDef = {
  id: "flows-guide",
  feature: "line",
  name: "Flows",
  accent: ACCENT,
  home: "/flows",
  pageTour: "flows-page",
  chapters: [
    {
      id: "flow",
      title: "A flow",
      Scene: AFlow,
      beats: [
        { say: "A flow is the path a change takes before it ships: the same steps, in the same order, every time." },
        { say: "Each step shows who does it (an agent session, a command, or a person) and where the work goes when it does not pass.", hold: 5000 },
        { say: "Your team keeps a library: whole flows like Change, and segments like Review that any flow can reuse.", hold: 4400 },
      ],
    },
    {
      id: "run",
      title: "Run a change",
      Scene: RunChange,
      beats: [
        { say: "An agent at Tidepool finished a fix. Before it ships, it goes through the team's flow." },
        { say: "Run through on the session's header lists the flows a change can take.", act: "Run it through Change" },
        { say: "Before anything starts you see what will: the sessions it starts, what it will ask you, and how it can end.", hold: 4400 },
        { say: "The run moves in the conversation, live. Check runs the tests; Review is an independent session reading the diff.", hold: 4400 },
        { say: "It stops at Decide, the one step that is yours.", hold: 3400 },
      ],
    },
    {
      id: "decide",
      title: "You decide",
      Scene: Decide,
      beats: [
        { say: "Decide brings one card: what changed, and the evidence for it." },
        { say: "Each claim comes with its proof: the bug reproduced, the tests, the review.", hold: 3800 },
        { say: "Ship it, hold it, or send it back with a note.", act: "Ship it" },
        { say: "Ship opens the pull request, waits for checks, merges, and tells the session that asked.", hold: 4400 },
      ],
    },
    {
      id: "problems",
      title: "Problems come in",
      Scene: ProblemsIn,
      beats: [
        { say: "Flows can find their own work too. Sources send in what goes wrong: errors, support email, replays, an agent reading every conversation." },
        { say: "Findings about the same thing group into one problem, with a count, a trend and the customers behind it.", hold: 4400 },
        { say: "Problems are scored by how many people they hit, worst first.", hold: 3600 },
      ],
    },
    {
      id: "live",
      title: "Live flows",
      Scene: LiveFlow,
      beats: [
        { say: "A live flow is switched on and takes problems from the queue by itself, best first." },
        { say: "Each run investigates, proposes, proves the bug, builds and verifies the fix before it asks anything.", hold: 4400 },
        { say: "A live flow runs as a role from Org. QA Lead answers what it can and recommends on the rest.", hold: 4400 },
        { say: "It takes only the sources you pick, within a daily limit, and a hold or its switch stops it.", hold: 4000 },
      ],
    },
    {
      id: "watch",
      title: "Shipped and watched",
      Scene: Watched,
      beats: [
        { say: "After a fix ships, the flow watches its problem for a week. Quiet means the fix held." },
        { say: "Findings after a close mean it came back, so the problem reopens by itself.", hold: 4000 },
        { say: "The next run starts from what was tried before, and explains why the last answer did not hold.", hold: 4600 },
      ],
    },
    {
      id: "yours",
      title: "Make it yours",
      Scene: MakeItYours,
      beats: [
        { say: "Every step's instructions are open. Edit them where you read them; each save is a version." },
        { say: "Test an edit on past cases before it goes live: the old answer next to the new one.", hold: 4400 },
        { say: "Mark answers right or wrong, and they become that step's test set.", hold: 3600 },
        { say: "A workflow an agent ran well can join the library as a flow every member can run.", hold: 4000 },
      ],
    },
  ],
  gives: [
    "Every change runs the same visible steps before it ships",
    "One card to decide each change, with its evidence",
    "Problems from your sources, fixed and watched (live flows run as an Org role)",
    "Steps you can edit, test on past cases, and reuse",
  ],
};
