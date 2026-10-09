"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { featureHref } from "../catalog";
import { DecisionSheet, ReportEmbed, LINE, TEXT, MUTED, DIM, type SheetData } from "./mocks";
import { at, Dot, Y, B } from "./kit";

/*
 * The hero: the queue clearing in one sitting. Three asks from three
 * sessions are stacked as the real decision sheet. A digit answers the top
 * one, it leaves, the next rises, and on the left the asking session wakes
 * with the answer as a message. Resting styles are the END state; every
 * animation only plays the way in (decisions.css), so ?static, reduced
 * motion and a background tab that never runs timers all read complete.
 */

const T1 = 3.4; // first answer lands
const T2 = 6.6; // second answer lands

const SHEETS: SheetData[] = [
  {
    session: "Retry webhook deliveries",
    project: "api",
    tier: 1,
    asked: "asked 52m ago · 6 messages since",
    question: "Exponential backoff or a fixed 30s retry?",
    context: (
      <>
        <p>The worker retries every 30s. A 10 minute outage at the provider sends 20 retries per event and trips their rate limit.</p>
        <p>Jitter spreads the load but can hold the first good delivery back by up to 4 minutes.</p>
      </>
    ),
    options: [
      { label: "Exponential with jitter", description: "5 retries over about 30m, the first at 10s" },
      { label: "Fixed 30s, capped at 10", description: "simplest change; still bursts in long outages" },
    ],
  },
  {
    session: "Settings page copy",
    project: "web",
    tier: 3,
    asked: "asked 1h ago · 31 messages since",
    question: "Keep short toggle labels, or write each one as a sentence?",
    context: <p>Both pass review. Sentences read clearer and make each row about a line longer. I am carrying on with labels.</p>,
    options: [
      { label: "Short labels", description: "the current layout, no new strings" },
      { label: "Sentences", description: "clearer; 14 strings to rewrite" },
    ],
    defaultOption: 0,
  },
  {
    session: "Retire agent_runs_v1",
    project: "convex",
    tier: 1,
    asked: "asked 2h ago · 0 messages since",
    question: "Approve dropping agent_runs_v1?",
    context: <p>Nothing has written to it in 40 days and no query reads it. A drop is recoverable only from a backup restore.</p>,
    report: (
      <ReportEmbed
        slug="drop-analysis"
        title="agent_runs_v1: who still touches it"
        rows={[["last write", "40 days ago"], ["readers in code", "0"], ["rows", "1.2M"], ["restore path", "backup only"]]}
      />
    ),
    options: [
      { label: "Approve", description: "frees the last migration on this table" },
      { label: "Hold", description: "keep it one more release" },
    ],
    documentLink: false,
  },
];

const SESSIONS: { title: string; waiting: ReactNode; after: ReactNode; t?: number; tier: 1 | 3 }[] = [
  { title: "Retry webhook deliveries", tier: 1, t: T1, waiting: "waiting on your decision", after: <>working · <b style={{ color: TEXT, fontWeight: 600 }}>Decision: Exponential with jitter</b></> },
  { title: "Settings page copy", tier: 3, t: T2, waiting: "working on its default", after: <>working · <b style={{ color: TEXT, fontWeight: 600 }}>Decision: Sentences</b>, overriding it</> },
  { title: "Retire agent_runs_v1", tier: 1, waiting: "waiting on your decision", after: null },
];

function Swap({ t, before, after }: { t: number; before: ReactNode; after: ReactNode }) {
  return (
    <span className="grid min-w-0">
      <span className="dq-swap-out [grid-area:1/1] truncate" style={at(t)}>{before}</span>
      <span className="dq-swap-in [grid-area:1/1] truncate" style={at(t)}>{after}</span>
    </span>
  );
}

export function SessionsPanel() {
  return (
    <div className="dq-in rounded-xl border overflow-hidden" style={at(0.5, { borderColor: LINE, backgroundColor: "rgba(253,246,227,.7)" })}>
      <div className="px-4 h-9 flex items-center border-b text-[11px] font-mono" style={{ borderColor: LINE, color: DIM }}>
        your sessions
      </div>
      <ul>
        {SESSIONS.map((s, i) => (
          <li key={s.title} className="px-4 py-2.5 flex items-start gap-3 border-b last:border-b-0" style={{ borderColor: LINE }}>
            <span className="mt-[7px] grid">
              {s.t !== undefined ? (
                <>
                  <span className="dq-swap-out [grid-area:1/1]" style={at(s.t)}><Dot tier={s.tier} /></span>
                  <span className="dq-swap-in [grid-area:1/1]" style={at(s.t)}><Dot tier="ok" /></span>
                </>
              ) : <Dot tier={s.tier} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] truncate" style={{ color: TEXT }}>{s.title}</span>
              <span className="block text-[11.5px]" style={{ color: MUTED }}>
                {s.t !== undefined ? <Swap t={s.t} before={s.waiting} after={s.after} /> : s.waiting}
              </span>
            </span>
            {i === 2 && <span className="mt-0.5 text-[10px] font-mono shrink-0" style={{ color: Y }}>on top</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Count() {
  const n = (v: number, cls: string, t?: number) => (
    <span className={`${cls} [grid-area:1/1]`} style={t !== undefined ? at(t) : undefined}>{v}</span>
  );
  return (
    <span className="inline-grid tabular-nums font-semibold" style={{ color: TEXT }}>
      {n(3, "dq-gone-at", T1)}
      <span className="dq-blip [grid-area:1/1]" style={at(T1, { ["--d2" as string]: `${T2}s` } as CSSProperties)}>2</span>
      {n(1, "dq-swap-in", T2)}
    </span>
  );
}

export function QueueStage() {
  return (
    <div className="dq-in relative" style={at(0.2)}>
      <div className="flex items-center gap-3 mb-3 px-1 text-[12px]" style={{ color: DIM }}>
        <span className="text-[15px]" style={{ color: TEXT }}>Questions</span>
        <span className="flex items-center gap-1"><Count /> waiting on you</span>
        <span className="ml-auto hidden sm:inline font-mono text-[11px]">/questions</span>
      </div>
      <div className="grid pb-8">
        {/* back to front: the third ask, the second, the first */}
        <div className="dq-sheet3 [grid-area:1/1]" style={at(T1, { ["--d2" as string]: `${T2}s` } as CSSProperties)}>
          <DecisionSheet d={SHEETS[2]} position={3} total={3} className="h-full" />
        </div>
        <div className="dq-sheet2 [grid-area:1/1]" style={at(T1, { ["--d2" as string]: `${T2}s` } as CSSProperties)}>
          <DecisionSheet d={SHEETS[1]} position={2} total={3} className="h-full" pickAt={1} />
        </div>
        <div className="dq-sheet1 [grid-area:1/1]" style={at(T1)}>
          <DecisionSheet d={SHEETS[0]} position={1} total={3} className="h-full" pickAt={0} />
        </div>
      </div>
    </div>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden" style={{ backgroundColor: SOL.base3 }}>
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(60rem 30rem at 85% -10%, rgba(181,137,0,.13), transparent 60%), repeating-linear-gradient(0deg, transparent 0 31px, rgba(147,161,161,.12) 31px 32px)`,
        }}
      />
      <div className="relative max-w-6xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20 pb-10 sm:pb-14">
        <div className="grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-10 lg:gap-14 items-start">
          <div className="min-w-0 lg:pt-6">
            <Link href="/features" className="dq-in inline-flex items-center gap-2 text-[13px] font-mono hover:underline" style={at(0, { color: SOL.base00 })}>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: Y }} />cast decide
            </Link>
            <h1 className="dq-in mt-5 font-mono font-bold text-[34px] sm:text-[46px] leading-[1.06] tracking-[-0.04em] [text-wrap:balance]" style={at(0.08, { color: SOL.base03 })}>
              The calls only you can make, in one queue.
            </h1>
            <p className="dq-in mt-6 text-[17px] sm:text-[18px] leading-8 max-w-xl" style={at(0.16, { color: SOL.base01 })}>
              When an agent hits a fork it cannot settle alone, it writes the question, the options and its reasoning into a card. The card waits in your queue. You clear the queue when you choose to, and each answer goes back to the session that asked.
            </p>
            <div className="dq-in mt-7 flex flex-wrap items-center gap-3" style={at(0.24)}>
              <code className="font-mono text-[13px] px-3.5 py-2.5 rounded-lg border max-w-full whitespace-normal sm:whitespace-nowrap leading-6" style={{ backgroundColor: SOL.base03, borderColor: "#094959", color: SOL.base1 }}>
                <span style={{ color: SOL.green }}>$ </span>cast decide <span style={{ color: SOL.cyan }}>&quot;Backoff?&quot;</span> <span style={{ color: SOL.yellow }}>-o</span> <span style={{ color: SOL.cyan }}>&quot;Exponential&quot;</span> <span style={{ color: SOL.yellow }}>-o</span> <span style={{ color: SOL.cyan }}>&quot;Fixed&quot;</span>
              </code>
            </div>
            <div className="dq-in mt-5 flex flex-wrap gap-x-6 gap-y-2 text-[14px]" style={at(0.3)}>
              <a href="#install" className="font-semibold underline underline-offset-4" style={{ color: SOL.base02, textDecorationColor: Y }}>Install codecast</a>
              <Link href="/documentation/decisions" className="underline underline-offset-4" style={{ color: SOL.base01, textDecorationColor: LINE }}>Read the guide</Link>
              <Link href={featureHref("triggers")} className="underline underline-offset-4" style={{ color: SOL.base01, textDecorationColor: LINE }}>Triggers</Link>
            </div>
            <div className="mt-10 hidden lg:block"><SessionsPanel /></div>
          </div>
          <div className="min-w-0">
            <QueueStage />
            <div className="mt-2 lg:hidden"><SessionsPanel /></div>
          </div>
        </div>
      </div>
    </section>
  );
}

export { B };
