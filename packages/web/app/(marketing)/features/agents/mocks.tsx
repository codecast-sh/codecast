"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { AGENT_COLOR, AgentTag } from "./parts";

const PAPER = "#fffdf6";
const frame = { backgroundColor: PAPER, border: `1px solid ${SOL.base2}`, boxShadow: "0 22px 44px -32px rgba(0,43,54,0.45)" };

const STATE: Record<string, string> = {
  working: SOL.yellow,
  done: SOL.green,
  dormant: SOL.violet,
  "needs input": SOL.orange,
};

function StateDot({ state }: { state: string }) {
  const c = STATE[state];
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px]" style={{ color: c }}>
      <span className={`h-1.5 w-1.5 rounded-full${state === "working" ? " agx-pulse" : ""}`} style={{ backgroundColor: c }} />
      {state}
    </span>
  );
}

/** The inbox with a parent and its nested workers: workers hang under the row that spawned them. */
export function InboxNestMock() {
  const workers = [
    { agent: "codex", title: "Load test for the retry pileup", state: "done", id: "jx7aa21" },
    { agent: "gemini", title: "Audit every caller of enqueue()", state: "working", id: "jx7bb34" },
    { agent: "cursor", title: "Draft the backoff docs", state: "needs input", id: "jx7cc58" },
  ];
  return (
    <div className="rounded-xl overflow-hidden font-mono" style={frame} role="img" aria-label="An inbox row with three nested worker sessions on Codex, Gemini and Cursor">
      <div className="flex items-center gap-2 px-3.5 py-2 text-[11px]" style={{ borderBottom: `1px solid ${SOL.base2}`, color: SOL.base1 }}>
        <span className="font-semibold" style={{ color: SOL.base01 }}>Inbox</span>
        <span className="ml-auto">workers stay nested</span>
      </div>
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-2">
          <AgentTag agent="claude" size="xs" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" style={{ color: SOL.base03 }}>Webhook retries</span>
          <StateDot state="dormant" />
        </div>
        <div className="mt-1 pl-1 text-[11.5px]" style={{ color: SOL.base1 }}>waiting on 3 workers; woken when they settle</div>
        <div className="mt-2.5 ml-3 pl-4" style={{ borderLeft: `2px dashed ${SOL.base2}` }}>
          {workers.map((w) => (
            <div key={w.id} className="flex items-center gap-2 py-1.5">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: AGENT_COLOR[w.agent] }} />
              <span className="min-w-0 flex-1 truncate text-[12px]" style={{ color: SOL.base02 }}>{w.title}</span>
              <span className="hidden sm:inline text-[10.5px]" style={{ color: SOL.base1 }}>{w.id}</span>
              <StateDot state={w.state} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The parent's view when its workers settle together: one message, one turn. */
export function SettleMock() {
  const rows = [
    { agent: "codex", id: "jx7aa21", title: "Load test for the retry pileup", why: "finished", state: "Reproduces the pileup: 400 retries behind 12 workers." },
    { agent: "cursor", id: "jx7cc58", title: "Draft the backoff docs", why: "is blocked", state: "Needs the final max delay before it can write the table." },
  ];
  return (
    <div className="rounded-xl overflow-hidden" style={frame} role="img" aria-label="Two workers settled, reported to the parent as one message">
      <div className="px-3.5 py-3" style={{ borderLeft: `3px solid ${SOL.cyan}`, backgroundColor: "rgba(42,161,152,0.05)" }}>
        <div className="font-mono text-[12px] font-semibold" style={{ color: SOL.cyan }}>2 workers settled</div>
        <div className="mt-2 grid grid-cols-1 gap-2">
          {rows.map((r) => (
            <div key={r.id} className="rounded-lg px-3 py-2" style={{ backgroundColor: PAPER, border: `1px solid ${SOL.base2}` }}>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[11.5px]">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: AGENT_COLOR[r.agent] }} />
                <span style={{ color: SOL.base02 }}>{r.title}</span>
                <span style={{ color: r.why === "finished" ? SOL.green : SOL.orange }}>{r.why}</span>
              </div>
              <div className="mt-1 text-[12.5px]" style={{ color: SOL.base00 }}>{r.state}</div>
            </div>
          ))}
        </div>
        <div className="mt-2.5 text-[12.5px]" style={{ color: SOL.base01 }}>Read the result with <span className="font-mono">cast read &lt;id&gt;</span> and act on it.</div>
      </div>
    </div>
  );
}

/** What the five work states mean: they answer who acts next. */
export function StatesLegend() {
  const rows: [string, string][] = [
    ["needs input", "A person has to unblock it: a question, a permission prompt, a dead process with output."],
    ["working", "The agent is producing right now."],
    ["dormant", "Parked on a wake the system will deliver: a trigger, a background task, its workers."],
    ["done", "The agent delivered. Read it when you like."],
  ];
  return (
    <div className="grid grid-cols-1 gap-2.5">
      {rows.map(([s, d]) => (
        <div key={s} className="grid grid-cols-[96px_1fr] gap-3 items-baseline">
          <StateDot state={s} />
          <span className="text-[13.5px] leading-[1.55]" style={{ color: SOL.base01 }}>{d}</span>
        </div>
      ))}
    </div>
  );
}

/** Fork: the history up to the fork point is copied into every branch; the fork request is not. */
export function ForkHistoryMock() {
  const history: [string, string][] = [
    ["you", "Webhook retries pile up under load."],
    ["claude", "Read the worker pool and the retry path."],
    ["claude", "Two suspects: backoff, and shared workers."],
    ["you", "Agreed. Show me both."],
  ];
  const branches = [
    { dir: "fix the backoff", who: "this thread", note: "continues in place" },
    { dir: "move retries to a queue", who: "branch", note: "new inbox card" },
    { dir: "cap retries per endpoint", who: "branch", note: "new inbox card" },
  ];
  return (
    <div className="rounded-xl p-4 sm:p-5" style={frame} role="img" aria-label="A fork copies four messages of history into three branches; the fork request is left out">
      <div className="grid grid-cols-1 gap-1.5">
        {history.map(([who, text], i) => (
          <div key={i} className="flex items-baseline gap-2.5 text-[12.5px]">
            <span className="w-5 shrink-0 text-right font-mono text-[10.5px]" style={{ color: SOL.base1 }}>{i + 1}</span>
            <span className="w-12 shrink-0 font-mono text-[11px] font-semibold" style={{ color: who === "you" ? SOL.orange : AGENT_COLOR.claude }}>{who}</span>
            <span style={{ color: SOL.base01 }}>{text}</span>
          </div>
        ))}
        <div className="flex items-baseline gap-2.5 text-[12.5px]">
          <span className="w-5 shrink-0 text-right font-mono text-[10.5px]" style={{ color: SOL.base1 }}>5</span>
          <span className="w-12 shrink-0 font-mono text-[11px] font-semibold" style={{ color: SOL.orange }}>you</span>
          <span className="line-through decoration-1" style={{ color: SOL.base1 }}>fork it three ways</span>
          <span className="ml-1 rounded px-1.5 font-mono text-[10px]" style={{ color: SOL.base1, backgroundColor: SOL.base2 }}>not copied</span>
        </div>
      </div>
      <svg className="my-2 block w-full" height="36" viewBox="0 0 300 36" preserveAspectRatio="none" aria-hidden>
        <path d="M150 0 V12 C150 24, 50 18, 50 36" fill="none" stroke={AGENT_COLOR.claude} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <path d="M150 0 V36" fill="none" stroke={AGENT_COLOR.claude} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <path d="M150 0 V12 C150 24, 250 18, 250 36" fill="none" stroke={AGENT_COLOR.claude} strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="grid grid-cols-3 gap-2">
        {branches.map((b, i) => (
          <div key={b.dir} className="rounded-lg px-2.5 py-2" style={{ backgroundColor: i === 0 ? "rgba(38,139,210,0.08)" : SOL.base3, border: `1px solid ${i === 0 ? "rgba(38,139,210,0.35)" : SOL.base2}` }}>
            <div className="font-mono text-[10px]" style={{ color: i === 0 ? AGENT_COLOR.claude : SOL.base1 }}>{b.who}</div>
            <div className="mt-0.5 text-[12px] font-medium leading-snug" style={{ color: SOL.base02 }}>{b.dir}</div>
            <div className="mt-1 font-mono text-[10px]" style={{ color: SOL.base1 }}>1–4 carried · {b.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Msg({ who, children }: { who: string; children: ReactNode }) {
  return (
    <div className="text-[13px] leading-[1.6]" style={{ color: SOL.base01 }}>
      <span className="mr-2 font-mono text-[11px] font-semibold" style={{ color: who === "you" ? SOL.orange : AGENT_COLOR[who] }}>{who}</span>
      {children}
    </div>
  );
}

/** A thread that changed agent mid-conversation: one id, one history, a divider. */
export function SwitchMock() {
  return (
    <div className="rounded-xl overflow-hidden" style={frame} role="img" aria-label="A conversation that continues on Codex after a switch, with a divider marking the change">
      <div className="flex items-center gap-2 px-3.5 py-2 font-mono text-[11px]" style={{ borderBottom: `1px solid ${SOL.base2}`, color: SOL.base1 }}>
        <span className="font-semibold" style={{ color: SOL.base02 }}>Webhook retries</span>
        <span className="ml-auto">jx7r3tq</span>
      </div>
      <div className="grid grid-cols-1 gap-3 px-3.5 py-3.5">
        <Msg who="claude">Backoff doubles up to 60s now. Load test passes.</Msg>
        <Msg who="you">Get a second pair of eyes on it before I merge.</Msg>
        <div className="rounded-md px-2.5 py-1.5 font-mono text-[11.5px]" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
          <span style={{ color: SOL.green }}>$ </span>cast switch --agent codex
        </div>
        <div className="flex items-center gap-2 font-mono text-[10.5px]" style={{ color: SOL.base1 }}>
          <span className="h-px flex-1" style={{ backgroundColor: SOL.base2 }} />
          now using Codex
          <span className="h-px flex-1" style={{ backgroundColor: SOL.base2 }} />
        </div>
        <Msg who="codex">Read the thread. The 60s cap holds, but jitter is missing, so every retry fires on the same tick. Adding it.</Msg>
      </div>
    </div>
  );
}

/** cast handoff --to: the brief the server writes, and where it goes. */
export function HandoffMock() {
  const sections: [string, string][] = [
    ["Goal", "Stop webhook retries from piling up under load."],
    ["Decisions", "Exponential backoff, capped at 60s. Queue approach parked until the schema change is approved."],
    ["Verified", "Load test passes at 400 retries."],
    ["Open questions", "Does the billing caller need its own cap?"],
    ["Next steps", "1. Add jitter. 2. Route the three direct callers through enqueue()."],
  ];
  return (
    <div className="rounded-xl overflow-hidden" style={frame} role="img" aria-label="A handoff brief with goal, decisions, verified, open questions and next steps, starting a linked Codex session">
      <div className="flex items-center gap-2 px-3.5 py-2 font-mono text-[11px]" style={{ borderBottom: `1px solid ${SOL.base2}`, color: SOL.base1 }}>
        <span style={{ color: SOL.base02 }}>cast handoff --to codex</span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 px-3.5 py-3.5">
        {sections.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[104px_1fr] gap-2 text-[12.5px] leading-[1.5]">
            <span className="font-mono text-[11px] font-semibold pt-px" style={{ color: SOL.base00 }}>{k}</span>
            <span style={{ color: SOL.base01 }}>{v}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-2.5 font-mono text-[11px]" style={{ borderTop: `1px solid ${SOL.base2}`, backgroundColor: SOL.base3 }}>
        <span className="inline-flex items-center gap-1.5" style={{ color: SOL.base1 }}>
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: AGENT_COLOR.claude }} />source <span style={{ color: SOL.green }}>done</span>
        </span>
        <span style={{ color: SOL.base1 }}>→</span>
        <AgentTag agent="codex" size="xs" />
        <span style={{ color: SOL.base1 }}>new session · linked · same task</span>
      </div>
    </div>
  );
}
