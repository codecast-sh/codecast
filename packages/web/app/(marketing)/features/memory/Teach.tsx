"use client";

import type { CSSProperties, ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Layer, Pane, Run, C, t, Note, VIOLET } from "./kit";

/** Layer 06: the decisions log. A ledger of calls, each with its reason. */
export function DecisionsLayer() {
  return (
    <Layer
      n="06"
      id="decisions"
      tint
      title={<>Decisions, written down where agents look</>}
      lede={
        <>
          <p>
            Some conclusions should not depend on anyone finding the right session. <C>cast decisions add</C> records one with its reason, tags and project. Name the session that settled it in the reason, so the next reader can open the whole argument with <C>cast read</C>.
          </p>
          <p>
            Agents and people read the same log: list it, filter by tags or project, or search titles before relitigating a choice the team already made.
          </p>
        </>
      }
    >
      <Pane label="recording">
        <Run>cast decisions add &quot;Webhook retries cap at 5 attempts&quot; \</Run>
        {"    "}--reason &quot;Stripe retries for 3 days; ours covers our own{"\n"}
        {"    "}outages. A deploy outlasts 3 attempts (load test, jx7k2qa).&quot; \{"\n"}
        {"    "}--tags webhooks,reliability
      </Pane>
      <div className="mt-4 rounded-xl overflow-hidden" style={{ border: `1px solid ${SOL.base2}`, backgroundColor: SOL.base3 }}>
        <div className="flex items-center gap-2 px-4 py-2.5 font-mono text-[12px]" style={{ borderBottom: `1px solid ${SOL.base2}`, color: SOL.base01 }}>
          <span style={{ color: SOL.green }}>$</span> cast decisions --tags webhooks
        </div>
        <Ledger id="qd7c2m1" date="2026-09-18" title="Webhook retries cap at 5 attempts" why="Stripe retries for 3 days; ours covers our own outages. A deploy outlasts 3 attempts (load test, jx7k2qa)." tags="webhooks, reliability" fresh />
        <Ledger id="qd79f0a" date="2026-08-30" title="Verify the Stripe signature before parsing JSON" why="The signature covers the raw body; re-serialized JSON does not match it. Found in jx7f9de." tags="webhooks, security" />
      </div>
      <div className="flex flex-wrap gap-2 mt-5 font-mono text-[12px]">
        {[["--search \"retry\"", "titles"], ["--project .", "this repo only"], ["delete <id>", "retire one"]].map(([c, d]) => (
          <div key={c} className="rounded-lg px-3 py-2 flex items-baseline gap-2" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
            <span style={{ color: SOL.base02 }}>{c}</span>
            <span className="text-[11.5px]" style={{ color: SOL.base1 }}>{d}</span>
          </div>
        ))}
      </div>
    </Layer>
  );
}

function Ledger({ id, date, title, why, tags, fresh = false }: { id: string; date: string; title: string; why: string; tags: string; fresh?: boolean }) {
  return (
    <div className={`mm-row grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 px-4 py-3.5 ${fresh ? "mm-anim mm-glow" : ""}`} style={{ borderBottom: `1px solid ${SOL.base2}`, "--d": ".3s" } as CSSProperties}>
      <div className="font-mono text-[11.5px] leading-6" style={{ color: SOL.base1 }}>
        <div style={{ color: VIOLET }}>{id}</div>
        <div>{date}</div>
      </div>
      <div className="min-w-0">
        <div className="font-mono text-[13.5px] font-semibold leading-6" style={{ color: SOL.base03 }}>{title}</div>
        <div className="text-[13.5px] leading-[1.55] mt-0.5" style={{ color: SOL.base01 }}><span className="font-mono text-[12px] mr-1.5" style={{ color: SOL.base1 }}>Why:</span>{why}</div>
        <div className="flex flex-wrap gap-x-4 mt-1.5 font-mono text-[11.5px]" style={{ color: SOL.base1 }}>
          <span>Tags: {tags}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Layer 07: how agents learn any of this. Three stages, left to right: the
 * installer's question, the section it writes into the agent's instruction
 * file, and an agent's turn using it.
 */
export function TeachLayer() {
  return (
    <Layer
      n="07"
      id="teach"
      wide
      title={<>How your agents learn to use it</>}
      lede={
        <>
          <p>
            None of this helps if agents never run it. The installer asks one question, <em>Enable agent memory?</em>, defaulting to yes, and writes a <C>## Memory</C> section into the instruction file of each agent on the machine: <C>~/.claude/CLAUDE.md</C>, <C>~/.codex/AGENTS.md</C>, a Cursor rule, and so on.
          </p>
          <p>
            The section is a command reference with one instruction: search past conversations liberally, when starting a task, when debugging, and when the user refers to earlier work. Nothing runs on its own; the agent decides when to call it. When codecast updates and the section&apos;s text changed, it is rewritten in place.
          </p>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-3">
        <Stage n="1" title="install">
          <Pane label="the installer" wrap>
            {t.head("--- Agent Memory ---")}{"\n"}
            Lets your agents search and learn from past conversations.{"\n"}
            {t.dim("Adds cast commands to your agent config so they can recall prior work.")}{"\n\n"}
            {t.g("?")} Enable agent memory? {t.dim("(Y/n)")} {t.ink("Y")}{"\n\n"}
            Memory enabled. Added to:{"\n"}
            {"  "}~/.claude/CLAUDE.md{"\n"}
            {"  "}~/.codex/AGENTS.md
          </Pane>
        </Stage>
        <Stage n="2" title="the agent's instructions">
          <div className="rounded-xl px-5 py-4 font-mono text-[12px] leading-[1.75] overflow-x-auto" style={{ backgroundColor: "#fffdf6", border: `1px solid ${SOL.base2}`, color: SOL.base00, boxShadow: "0 18px 40px -28px rgba(0,43,54,.45)" }}>
            <div className="text-[11px] mb-2" style={{ color: SOL.base1 }}>~/.claude/CLAUDE.md</div>
            <div className="font-bold" style={{ color: SOL.base03 }}>## Memory</div>
            <div className="mt-1 font-sans text-[13px] leading-[1.6]" style={{ color: SOL.base01 }}>
              You are one session among many, and past conversations hold the decisions, patterns and prior work you need. Search them liberally…
            </div>
            <pre className="mt-2 whitespace-pre" style={{ color: SOL.base02 }}>
{`cast search "file:src/auth.ts"
cast read <id> --ask "<question>"
cast context "implement auth"
cast blame <file>`}
            </pre>
          </div>
        </Stage>
        <Stage n="3" title="a turn, later">
          <div className="rounded-xl px-4 py-3.5 space-y-2.5" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
            <Turn who="you">Make webhook retries back off harder.</Turn>
            <Turn who="agent">Before changing the backoff, checking who worked on this file and what they settled.</Turn>
            <div className="font-mono text-[12px] rounded-md px-3 py-2" style={{ backgroundColor: SOL.base03, color: SOL.base0 }}>
              <span style={{ color: SOL.green }}>$</span> cast search file:src/webhooks/retry.ts{"\n"}
            </div>
            <Turn who="agent">The cap of 5 was set on purpose in jx7k2qa after a load test (msg 141), so I will leave it and change only the delay curve.</Turn>
          </div>
        </Stage>
      </div>
      <h3 className="font-mono text-[17px] font-bold mt-14 mb-2" style={{ color: SOL.base03 }}>Know what is in flight before the first message</h3>
      <p className="text-[15.5px] leading-7 mb-5 max-w-3xl" style={{ color: SOL.base01 }}>Turn on <C>cast stable team</C> and every new session starts with a snapshot of the team&apos;s recent sessions in this project.</p>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] items-start">
        <Pane label="the top of a new session, with cast stable team on">
          {t.dim('<stable-context mode="team">')}{"\n"}
          {t.ink("This gives you bigger-picture visibility on what has been and")}{"\n"}
          {t.ink("is being worked on by the team.")}{"\n\n"}
          {t.head("── Add jitter to webhook backoff ──────────────")}{"\n"}
          {"   "}{t.id("jx7m41c")} | {t.g("● working")} | just now | 96 msgs | ~/src/payments{"\n\n"}
          {t.head("── Refund webhooks ────────────────────────────")}{"\n"}
          {"   "}{t.id("jx7r0pd")} | {t.dim("○ done")} | 2h ago | 151 msgs | ~/src/payments{"\n"}
          {t.dim("…")}{"\n"}
          {t.dim("</stable-context>")}
        </Pane>
        <div className="space-y-3">
          <Note label="cast stable team">The team&apos;s last 14 days, up to 15 sessions, in this project. <C>-g</C> for every project.</Note>
          <Note label="cast stable solo" color={SOL.cyan}>Only your own last 7 days, up to 10 sessions. <C>cast stable off</C> stops it.</Note>
          <p className="text-[13.5px] leading-6 px-1" style={{ color: SOL.base01 }}>
            Injected at session start for Claude Code, Codex, Cursor and OpenCode. It is a snapshot: the agent is told to check <C>cast diff</C> and <C>cast read</C> before crediting work to a session. Skipped memory at install? <C>cast memory</C> turns it on later.
          </p>
        </div>
      </div>
    </Layer>
  );
}

function Stage({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-3">
      <div className="flex flex-col items-center">
        <span className="font-mono text-[12px] font-bold w-7 h-7 rounded-full flex items-center justify-center" style={{ border: `2px solid ${VIOLET}`, color: VIOLET, backgroundColor: SOL.base3 }}>{n}</span>
        <span className="flex-1 w-[2px] mt-1" style={{ backgroundColor: `color-mix(in srgb, ${VIOLET} 25%, transparent)` }} />
      </div>
      <div className="min-w-0 pb-1">
        <div className="font-mono text-[12px] mb-2 mt-1" style={{ color: SOL.base01 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function Turn({ who, children }: { who: "you" | "agent"; children: ReactNode }) {
  const me = who === "you";
  return (
    <div className="flex gap-2.5 text-[13.5px] leading-[1.55]">
      <span className="font-mono text-[11px] w-11 shrink-0 pt-0.5" style={{ color: me ? SOL.blue : VIOLET }}>{who}</span>
      <span style={{ color: me ? SOL.base02 : SOL.base01 }}>{children}</span>
    </div>
  );
}
