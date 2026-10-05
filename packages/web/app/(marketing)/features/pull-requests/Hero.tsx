"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { at, Face, Frame, PAPER, PEOPLE, PrIcon, RadioIcon, SessionPill } from "./kit";
import { AUTHOR, BASE, HEAD, NOTES, PR_NUMBER, PR_TITLE, REVIEWER, SESSION } from "./data";

/**
 * The hero's clock, in seconds. One pull request and its shepherd session:
 * a check fails and wakes the session, it pushes a fix, a review lands as
 * one message, it answers and resolves both threads and goes back to sleep,
 * the reviewer approves, and the merge waits for a person.
 */
const CLOCK = {
  checkPkt: 1.1,
  wake: 2.0,
  run: 2.6,
  fix: 3.2,
  pushPkt: 3.5,
  green: 4.4,
  reviewPkt: 5.2,
  review: 6.1,
  reply: 6.8,
  resolve: 7.4,
  replyPkt: 7.6,
  cleared: 8.5,
  sleep: 8.9,
  approved: 9.7,
};

export function Hero() {
  const [run, setRun] = useState(0);
  return (
    <section className="relative overflow-hidden" style={{ backgroundColor: SOL.base3 }}>
      <div className="prx-gutter absolute inset-0 pointer-events-none" aria-hidden />
      <div className="relative max-w-7xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20 pb-16 sm:pb-24">
        <div className="max-w-4xl">
          <div className="prx-rise inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[12px]" style={{ ...at(0), borderColor: "rgba(42,161,152,0.35)", color: SOL.cyan, backgroundColor: "rgba(42,161,152,0.07)" }}>
            <PrIcon color={SOL.cyan} className="h-3.5 w-3.5" />
            Pull requests in codecast
          </div>
          <h1 className="prx-rise mt-5 font-mono text-[34px] leading-[1.08] sm:text-[52px] lg:text-[60px] font-bold tracking-[-0.03em]" style={{ ...at(0.08), color: SOL.base03 }}>
            The pull request wakes the agent that wrote it.
          </h1>
          <p className="prx-rise mt-6 max-w-2xl text-[17px] sm:text-[19px] leading-[1.6]" style={{ ...at(0.16), color: SOL.base01 }}>
            Every pull request in codecast carries its checks, its review threads and the sessions that made it.
            Bind one session as its shepherd and a red check, a request for changes or a conflict wakes that session
            with a briefing. It fixes, pushes, answers each thread and resolves it. The review and the merge stay yours.
          </p>
          <div className="prx-rise mt-8 flex flex-wrap items-center gap-3" style={at(0.24)}>
            <code className="rounded-lg px-4 py-2.5 font-mono text-[14px]" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
              <span style={{ color: SOL.green }}>$</span> cast pr shepherd on
            </code>
            <a href="#install" className="prx-chip rounded-lg border px-4 py-2.5 font-mono text-[13.5px] font-semibold" style={{ borderColor: SOL.cyan, color: SOL.cyan }}>
              Install codecast
            </a>
            <a href="#batch" className="font-mono text-[13px] underline underline-offset-4 decoration-1" style={{ color: SOL.base00 }}>
              or start with a review
            </a>
          </div>
        </div>

        <div key={run} className="mt-14 sm:mt-16">
          <Stage />
          <Steps onReplay={() => setRun((n) => n + 1)} />
        </div>
      </div>
    </section>
  );
}

// ── the stage: PR card, tether, session ──────────────────────────────────────

function Stage() {
  return (
    <div className="prx-rise grid gap-0 lg:grid-cols-[minmax(0,1fr)_190px_minmax(0,1fr)] items-stretch" style={at(0.35)}>
      <PrCard />
      <Tether />
      <SessionCard />
    </div>
  );
}

function Swap({ children }: { children: ReactNode }) {
  return <span className="prx-swap">{children}</span>;
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[9.5px] uppercase tracking-wider" style={{ color: SOL.base1 }}>{label}</div>
      <div className="mt-1 text-[12px] whitespace-nowrap">{children}</div>
    </div>
  );
}

function PrCard() {
  const c = CLOCK;
  return (
    <Frame label={`The pull request page for ${PR_TITLE}, updating as the shepherd works`} className="flex flex-col">
      <div className="px-4 sm:px-5 pt-4 pb-3" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
        <div className="flex items-start gap-2">
          <PrIcon className="h-4 w-4 mt-[3px]" />
          <div className="min-w-0 text-[14.5px] font-semibold leading-snug" style={{ color: SOL.base03 }}>
            {PR_TITLE} <span style={{ color: SOL.base1, fontWeight: 400 }}>#{PR_NUMBER}</span>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11.5px]" style={{ color: SOL.base00 }}>
          <span className="rounded-full px-2 py-[1px] text-[10.5px] font-semibold" style={{ backgroundColor: "rgba(133,153,0,0.13)", color: SOL.green }}>Open</span>
          <Face name={AUTHOR} color={PEOPLE.lena} size={16} />
          {AUTHOR}
          <span className="rounded border px-1.5 py-[1px] text-[10.5px]" style={{ borderColor: SOL.base2, backgroundColor: SOL.base3 }}>{HEAD} → {BASE}</span>
        </div>
        {/* ShepherdControl: the bound session, what it is working toward, whether changes wake it */}
        <div className="mt-3 inline-flex max-w-full flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border py-1 pl-2.5 pr-1 text-[11px]" style={{ borderColor: SOL.base2, backgroundColor: "rgba(238,232,213,0.4)" }}>
          <span className="inline-flex items-center gap-1.5" style={{ color: SOL.base1 }}>
            <RadioIcon color={SOL.cyan} /> Shepherd
          </span>
          <SessionPill>{SESSION.title}</SessionPill>
          <Swap>
            <span className="prx-a" style={{ ...at(c.green), color: SOL.red }}>fixing failed checks</span>
            <span className="prx-b" style={{ ...at(c.green, c.reviewPkt), color: SOL.yellow }}>waiting for a review</span>
            <span className="prx-b" style={{ ...at(c.reviewPkt, c.approved), color: SOL.orange }}>has changes to make</span>
            <span className="prx-in" style={{ ...at(c.approved), color: SOL.green }}>ready to merge</span>
          </Swap>
          <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-[1px]" style={{ backgroundColor: "rgba(133,153,0,0.12)", color: SOL.green }}>
            <span className="prx-live h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SOL.green }} />
            Wakes on changes
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-7 gap-y-3 px-4 sm:px-5 py-3.5" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
        <Figure label="Checks">
          <Swap>
            <span className="prx-a" style={at(c.green)}><span style={{ color: SOL.red }}>1 failed</span> <span style={{ color: SOL.base00 }}>5 passed</span></span>
            <span className="prx-in" style={{ ...at(c.green), color: SOL.green }}>6 passed</span>
          </Swap>
        </Figure>
        <Figure label="Review">
          <Swap>
            <span className="prx-a" style={{ ...at(c.reviewPkt), color: SOL.base1 }}>Not yet</span>
            <span className="prx-b" style={{ ...at(c.reviewPkt, c.approved), color: SOL.orange }}>Changes</span>
            <span className="prx-in" style={{ ...at(c.approved), color: SOL.green }}>Approved</span>
          </Swap>
        </Figure>
        <Figure label="Merge">
          <span style={{ color: SOL.green }}>Clean</span>
        </Figure>
        <Figure label="Open comments">
          <Swap>
            <span className="prx-a" style={{ ...at(c.reviewPkt), color: SOL.base00 }}>0</span>
            <span className="prx-b" style={{ ...at(c.reviewPkt, c.cleared), color: SOL.yellow }}>2</span>
            <span className="prx-in" style={{ ...at(c.cleared), color: SOL.base00 }}>0</span>
          </Swap>
        </Figure>
        <Figure label="Diff">
          <span style={{ color: SOL.green }}>+184</span><span style={{ color: SOL.base1 }}> / </span><span style={{ color: SOL.red }}>-27</span>
        </Figure>
      </div>

      <ol className="flex-1 px-4 sm:px-5 py-3 space-y-[7px] text-[11px]" style={{ color: SOL.base00 }}>
        <TimelineRow d={0.5} mark="x" color={SOL.red}>CI failed: test (pull_request)</TimelineRow>
        <TimelineRow d={c.green - 0.5} mark="↑" color={SOL.blue}>PR #{PR_NUMBER} updated to 3f2a91c</TimelineRow>
        <TimelineRow d={c.green} mark="✓" color={SOL.green}>CI passed on PR #{PR_NUMBER}</TimelineRow>
        <TimelineRow d={c.reviewPkt} mark="●" color={SOL.orange}>Review: requested changes by {REVIEWER}</TimelineRow>
        <TimelineRow d={c.cleared} mark="↩" color={SOL.cyan}>2 threads answered and resolved</TimelineRow>
        <TimelineRow d={c.approved} mark="●" color={SOL.green}>Review: approved by {REVIEWER}</TimelineRow>
      </ol>

      <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3" style={{ borderTop: `1px solid ${SOL.base2}`, backgroundColor: "rgba(238,232,213,0.35)" }}>
        <span className="text-[10.5px]" style={{ color: SOL.base1 }}>Conversation · Files 4 · Commits 3 · Checks 6</span>
        <Swap>
          <span className="prx-a shrink-0 whitespace-nowrap rounded-md border px-3 py-1 text-[11px] font-semibold" style={{ ...at(c.approved), borderColor: SOL.base2, color: SOL.base1 }}>Merge</span>
          <span className="prx-in" style={at(c.approved)}>
            <span className="prx-flash inline-block shrink-0 whitespace-nowrap rounded-md border px-3 py-1 text-[11px] font-semibold text-white" style={{ ...at(c.approved + 0.2), backgroundColor: SOL.green, borderColor: SOL.green }}>Merge</span>
          </span>
        </Swap>
      </div>
    </Frame>
  );
}

function TimelineRow({ d, mark, color, children }: { d: number; mark: string; color: string; children: ReactNode }) {
  return (
    <li className="prx-in flex items-baseline gap-2" style={at(d)}>
      <span className="w-3 shrink-0 text-center" style={{ color }}>{mark}</span>
      <span className="min-w-0 truncate">{children}</span>
    </li>
  );
}

/** The wire between the two cards. Events cross it; at rest it names both directions. */
function Tether() {
  const c = CLOCK;
  return (
    <div className="relative flex lg:flex-col items-center justify-center py-3 lg:py-0" aria-hidden>
      {/* vertical wire (narrow screens) */}
      <div className="lg:hidden flex items-center gap-4 font-mono text-[10.5px]" style={{ color: SOL.base01 }}>
        <span className="text-right w-36">GitHub event wakes it ↓</span>
        <svg width="8" height="44" className="shrink-0"><line x1="4" y1="0" x2="4" y2="44" stroke={SOL.cyan} strokeWidth="2" strokeDasharray="4 4" className="prx-wire" /></svg>
        <span className="w-36">↑ push, reply, resolve</span>
      </div>

      {/* horizontal wires (wide screens): events in on top, the agent's acts back below */}
      <div className="hidden lg:block relative w-full h-full">
        <div className="absolute inset-x-0 top-[34%] -translate-y-1/2">
          <div className="px-2 text-center font-mono text-[10.5px] leading-tight mb-2" style={{ color: SOL.cyan }}>webhook wakes it</div>
          <Wire />
          <div className="absolute inset-x-0 top-[calc(100%-4px)] h-0">
            <Packet d={c.checkPkt} color={SOL.red}>check failed</Packet>
            <Packet d={c.reviewPkt} color={SOL.orange}>review · 2 notes</Packet>
          </div>
        </div>
        <div className="absolute inset-x-0 top-[66%] -translate-y-1/2">
          <Wire back />
          <div className="px-2 text-center font-mono text-[10.5px] leading-tight mt-2" style={{ color: SOL.base01 }}>push, reply, resolve</div>
          <div className="absolute inset-x-0 top-[4px] h-0">
            <Packet d={c.pushPkt} color={SOL.blue} back>push 3f2a91c</Packet>
            <Packet d={c.replyPkt} color={SOL.cyan} back>2 resolved</Packet>
          </div>
        </div>
      </div>
    </div>
  );
}

/** One wire across the gap: it starts flush against one card and ends in an arrowhead on the other. */
function Wire({ back = false }: { back?: boolean }) {
  const color = back ? SOL.base1 : SOL.cyan;
  return (
    <svg className="block w-full" height="10" viewBox="0 0 190 10" preserveAspectRatio="none">
      <line x1="2" y1="5" x2="188" y2="5" stroke={color} strokeWidth="1.6" strokeDasharray="5 7" className="prx-wire" style={back ? { animationDirection: "reverse" } : undefined} vectorEffect="non-scaling-stroke" />
      {back
        ? <path d="M8 1 L2 5 L8 9" fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
        : <path d="M182 1 L188 5 L182 9" fill="none" stroke={color} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

function Packet({ d, color, back = false, children }: { d: number; color: string; back?: boolean; children: ReactNode }) {
  return (
    <span className={`prx-pkt ${back ? "prx-back" : ""} inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-[2px] font-mono text-[10px] font-semibold shadow-sm`} style={{ ...at(d), borderColor: color, color, backgroundColor: PAPER }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

function SessionCard() {
  const c = CLOCK;
  return (
    <Frame label="The shepherd session's conversation, woken by the pull request" className="flex flex-col">
      <div className="flex flex-wrap items-center gap-2 px-4 sm:px-5 py-3" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
        <SessionPill size="md">{SESSION.id}</SessionPill>
        <span className="min-w-0 truncate text-[13px] font-semibold" style={{ color: SOL.base03 }}>{SESSION.title}</span>
        <span className="text-[10.5px]" style={{ color: SOL.blue }}>claude</span>
        <span className="ml-auto text-[10.5px]">
          <Swap>
            <span className="prx-a" style={{ ...at(c.wake), color: SOL.base1 }}>○ dormant</span>
            <span className="prx-b" style={{ ...at(c.wake, c.sleep), color: SOL.green }}><span className="prx-live">●</span> working</span>
            <span className="prx-in" style={{ ...at(c.sleep), color: SOL.base1 }}>○ dormant</span>
          </Swap>
        </span>
      </div>

      <div className="flex-1 space-y-2.5 px-4 sm:px-5 py-4 text-[11.5px] leading-[1.55]" style={{ color: SOL.base02 }}>
        <WakeBlock d={c.wake} title={`Shepherd PR #${PR_NUMBER}`}>
          <div>Woken because a check failed.</div>
          <div style={{ color: SOL.base00 }}>## Failing checks<br />- test (pull_request): failure</div>
        </WakeBlock>

        <Tool d={c.run} cmd="gh run view 8812 --log-failed">retry.test.ts: expected 5 attempts, got 6</Tool>
        <Said d={c.fix}>The cap was checked before the increment. Fixed, added the case, pushed <b>3f2a91c</b>.</Said>

        <WakeBlock d={c.review} title={`Review from ${REVIEWER}`} tone="review">
          <div><b style={{ color: SOL.orange }}>Changes requested</b> on #{PR_NUMBER}, 2 notes</div>
          {NOTES.map((n) => (
            <div key={n.id} className="truncate" style={{ color: SOL.base00 }}>
              <span style={{ color: SOL.base1 }}>{n.file}:{n.line}</span> {n.text}
            </div>
          ))}
        </WakeBlock>

        <Said d={c.reply}>Clamped the delay after jitter and logged the attempt. Pushed <b>9b04e1d</b>.</Said>
        <Tool d={c.resolve} cmd={`cast pr comment --reply ${NOTES[0].id} "Clamped after jitter in 9b04e1d."`} />
        <Tool d={c.resolve + 0.3} cmd={`cast pr resolve ${NOTES[0].id} && cast pr resolve ${NOTES[1].id}`} />
        <Tool d={c.sleep} cmd={`cast state --status dormant "Shepherding PR #${PR_NUMBER}; waiting on re-review"`} />
      </div>
    </Frame>
  );
}

function WakeBlock({ d, title, tone = "wake", children }: { d: number; title: string; tone?: "wake" | "review"; children: ReactNode }) {
  const color = tone === "wake" ? SOL.cyan : SOL.orange;
  const rgb = tone === "wake" ? "42,161,152" : "203,75,22";
  return (
    <div className="prx-in rounded" style={{ ...at(d), borderLeft: `2px solid rgba(${rgb},0.65)`, backgroundColor: `rgba(${rgb},0.06)` }}>
      <div className="flex items-center gap-1.5 px-2.5 pt-1.5 text-[10px] font-semibold" style={{ color }}>
        {tone === "wake" ? <RadioIcon color={color} /> : <Face name={REVIEWER} color={PEOPLE.omar} size={13} />}
        {title}
      </div>
      <div className="px-2.5 pb-1.5 pt-0.5 space-y-0.5">{children}</div>
    </div>
  );
}

function Tool({ d, cmd, children }: { d: number; cmd: string; children?: ReactNode }) {
  return (
    <div className="prx-in min-w-0" style={at(d)}>
      <div className="truncate" style={{ color: SOL.base01 }}><span style={{ color: SOL.green }}>$</span> {cmd}</div>
      {children && <div className="truncate pl-3" style={{ color: SOL.base1 }}>{children}</div>}
    </div>
  );
}

function Said({ d, children }: { d: number; children: ReactNode }) {
  return <p className="prx-in" style={at(d)}>{children}</p>;
}

// ── the five beats, under the stage ──────────────────────────────────────────

const BEATS: { at: number; text: string }[] = [
  { at: CLOCK.checkPkt, text: "A check fails on GitHub" },
  { at: CLOCK.wake, text: "The shepherd wakes and pushes a fix" },
  { at: CLOCK.review, text: "A review arrives as one message" },
  { at: CLOCK.cleared, text: "Each thread answered, then resolved" },
  { at: CLOCK.approved, text: "Approved. The merge is yours" },
];

function Steps({ onReplay }: { onReplay: () => void }) {
  return (
    <div className="mt-6 flex flex-col lg:flex-row lg:items-start gap-4">
      <ol className="grid flex-1 grid-cols-1 sm:grid-cols-5 gap-x-3 gap-y-2">
        {BEATS.map((b, i) => (
          <li key={b.text} className="min-w-0">
            <div className="h-[3px] rounded-full overflow-hidden" style={{ backgroundColor: SOL.base2 }}>
              <div className="prx-fill h-full" style={{ ...at(b.at), backgroundColor: SOL.cyan }} />
            </div>
            <div className="mt-2 flex gap-2 font-mono text-[11.5px] leading-snug" style={{ color: SOL.base01 }}>
              <span style={{ color: SOL.cyan }}>{i + 1}</span>
              {b.text}
            </div>
          </li>
        ))}
      </ol>
      <button type="button" onClick={onReplay} className="prx-chip self-start shrink-0 rounded-md border px-3 py-1.5 font-mono text-[11.5px]" style={{ borderColor: SOL.base2, color: SOL.base00, backgroundColor: PAPER }}>
        ↻ Replay
      </button>
    </div>
  );
}
