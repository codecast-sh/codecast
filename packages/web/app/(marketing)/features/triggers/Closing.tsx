"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { featureHref, featureDeepDives } from "../catalog";
import { Body, C, Section } from "./ui";
import { Whole } from "../kit";

type Ref = { cmd: string; does: ReactNode };
const REFERENCE: { group: string; rows: Ref[] }[] = [
  {
    group: "Arm",
    rows: [
      { cmd: "cast trigger add <prompt>", does: <>Create a trigger. <C>-</C> reads the prompt from stdin; <C>--title</C> names it.</> },
      { cmd: "--in <duration>", does: <>Once, after a delay. With <C>--every</C>, the first run.</> },
      { cmd: "--every <duration>", does: "Repeat on an interval." },
      { cmd: "--on <event>", does: <>Fire on an event. Narrow with <C>--repo</C>, <C>--pr</C>, <C>--source</C>.</> },
      { cmd: "--precheck <command>", does: "Shell gate before each scheduled or repeating firing. Non-zero exit or 60s skips the run." },
    ],
  },
  {
    group: "Where and who",
    rows: [
      { cmd: "--spawn", does: "Each run starts a fresh session nested under this one." },
      { cmd: "--for <session>", does: "Bind runs to a specific session from any shell." },
      { cmd: "--wake", does: <>With <C>--spawn</C> on a one-shot: wake this session for a clean report too.</> },
      { cmd: "--thread", does: "Post each run's result into this conversation, without waking it." },
      { cmd: "--safe", does: "Read-only spawned runs: write tools removed, state-changing commands blocked." },
      { cmd: "--agent · --model · --as", does: <>Claude or Codex, a pinned model, or a saved agent definition for spawned runs.</> },
      { cmd: "--project · --max-runtime", does: <>Working directory; kill cap (default <C>10m</C>).</> },
    ],
  },
  {
    group: "Manage",
    rows: [
      { cmd: "cast trigger ls [--all] [--json]", does: "Active triggers; --all includes completed and failed." },
      { cmd: "cast trigger update <id>", does: "Edit in place. Every effective edit is a new version." },
      { cmd: "cast trigger history <id>", does: "Every version: who changed what, from where." },
      { cmd: "cast trigger log <id>", does: "The last run's conversation and summary, and the last precheck skip." },
      { cmd: "cast trigger run | pause | resume | cancel <id>", does: "Fire now, hold, pick back up, retire." },
      { cmd: "cast trigger complete <id> --summary", does: <>Called by the run. <C>--needs-attention</C> keeps it in your inbox.</> },
      { cmd: "cast trigger install", does: "Teach your agents to arm their own triggers." },
    ],
  },
];

export function Reference() {
  return (
    <Section id="reference" title="Command reference" lede={<>Everything here is in <C>cast trigger --help</C>. IDs take the short form (<C>tr-42</C>), the full id, or its last 8 characters.</>}>
      <div className="grid gap-6 lg:grid-cols-3">
        {REFERENCE.map((g) => (
          <div key={g.group} className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${SOL.base2}` }}>
            <div className="px-4 py-2.5 font-mono text-[13px] font-bold" style={{ backgroundColor: SOL.base2, color: SOL.base03 }}>{g.group}</div>
            <dl>
              {g.rows.map((r, i) => (
                <div key={r.cmd} className="px-4 py-3" style={{ borderTop: i ? `1px solid ${SOL.base2}` : undefined, backgroundColor: "#fffbf0" }}>
                  <dt className="font-mono text-[12.5px] font-semibold break-words" style={{ color: SOL.orange }}>{r.cmd}</dt>
                  <dd className="mt-1 text-[13.5px] leading-6" style={{ color: SOL.base01 }}>{r.does}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </Section>
  );
}

const LIMITS: { q: string; a: ReactNode }[] = [
  {
    q: "Does my laptop need to be on?",
    a: <>Yes, for triggers armed from the CLI. A run executes on the machine where it was armed, in that checkout, through the codecast daemon. If the machine is asleep when a trigger comes due, the trigger waits and runs when the machine wakes. To keep things running around the clock, arm them from a session on a <Link href={featureHref("cloud")} className="underline" style={{ color: SOL.blue }}>cloud host</Link>.</>,
  },
  {
    q: "What do event triggers need?",
    a: <>Pull request and push events need the GitHub integration; issue events need GitHub or Linear. Product events (<C>error_new</C>, <C>metric_alert</C>, <C>deploy</C> and the rest) need a source set up with <C>cast sources add</C>.</>,
  },
  {
    q: "How exact is the schedule?",
    a: <>The daemon polls for due triggers, so a run starts close to its time, not to the second. A repeating trigger stays on its cadence even when individual runs take a while.</>,
  },
  {
    q: "What does a run cost?",
    a: <>A run is a normal agent session on your own Claude or Codex account, so it uses your plan like any other session. A run inline in a long thread reloads that whole thread. That is why repeating work belongs in <C>--spawn</C> runs, and why <C>--precheck</C> exists.</>,
  },
  {
    q: "Is --safe a sandbox?",
    a: <>It removes write tools and blocks state-changing commands for a spawned run. It is a guard on what the agent may do, not an isolated machine. A run injected into an existing session follows that session&apos;s rules, not <C>--safe</C>.</>,
  },
  {
    q: "Who can see my triggers?",
    a: <>Each trigger has a page in the web app, visible to everyone who can see the session it belongs to. The verbs follow the same access, and only the owner may delete one.</>,
  },
];

export function Limits() {
  return (
    <Section id="limits" tint title="Honest limits" lede="What a trigger does not do, and what it depends on.">
      <div className="grid gap-x-10 md:grid-cols-2">
        {LIMITS.map((l) => (
          <div key={l.q} className="py-5" style={{ borderTop: `1px solid ${SOL.base1}` }}>
            <h3 className="text-[16px] font-semibold" style={{ color: SOL.base03 }}>{l.q}</h3>
            <Body className="mt-2">{l.a}</Body>
          </div>
        ))}
      </div>
    </Section>
  );
}

const RELATED = ["pull-requests", "decisions", "agents", "cloud"];

export function Related() {
  const items = featureDeepDives(RELATED);
  return (
    <Section title="Works with">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((f) => (
          <Link
            key={f.slug}
            href={featureHref(f.slug)}
            className="group flex flex-col rounded-2xl p-5 transition-transform hover:-translate-y-1"
            style={{ backgroundColor: "#fffbf0", border: `1px solid ${SOL.base2}`, boxShadow: `inset 0 3px 0 ${f.color}` }}
          >
            <span className="font-mono text-[15px] font-bold" style={{ color: SOL.base03 }}>{f.name}</span>
            <span className="mt-2 flex-1 text-[13.5px] leading-6" style={{ color: SOL.base01 }}>{f.dek}</span>
            <span className="mt-3 font-mono text-[12px] transition-colors" style={{ color: f.color }}>{f.command} <span className="inline-block transition-transform group-hover:translate-x-1">→</span></span>
          </Link>
        ))}
      </div>
    </Section>
  );
}

export function Cta() {
  return (
    <section id="install" className="relative overflow-hidden py-20 sm:py-28" style={{ backgroundColor: SOL.base03 }}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{ backgroundImage: `radial-gradient(1.5px 1.5px at 12% 30%, ${SOL.base1} 50%, transparent 51%), radial-gradient(1px 1px at 34% 70%, ${SOL.base1} 50%, transparent 51%), radial-gradient(1.5px 1.5px at 58% 22%, ${SOL.base1} 50%, transparent 51%), radial-gradient(1px 1px at 77% 62%, ${SOL.base1} 50%, transparent 51%), radial-gradient(1.5px 1.5px at 90% 28%, ${SOL.base1} 50%, transparent 51%)` }}
      />
      <div className="relative max-w-3xl mx-auto px-5 sm:px-6 text-center">
        <h2 className="font-mono text-[30px] sm:text-[42px] font-bold leading-[1.1] tracking-tight [text-wrap:balance]" style={{ color: SOL.base3 }}>
          Arm one before you log off tonight
        </h2>
        <p className="mt-5 text-[17px] leading-8" style={{ color: SOL.base1 }}>
          Install codecast, then give the session you are in a follow-up for tomorrow morning.
        </p>
        <div className="mt-8 text-left">
          <InstallTabs location="feature-triggers" />
        </div>
        <pre className="mt-5 whitespace-pre-wrap break-words rounded-xl px-4 py-3 text-left font-mono text-[12.5px]" style={{ backgroundColor: SOL.base02, color: SOL.base1 }}>
          <span style={{ color: SOL.green }}>$</span> <Whole text={'cast trigger add "Summarize what changed overnight and what needs me" --in 10h'} />
        </pre>
        <div className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[14px]">
          <Link href="/documentation/triggers" className="underline" style={{ color: SOL.base2 }}>Triggers guide</Link>
          <Link href="/documentation/workflows" className="underline" style={{ color: SOL.base2 }}>Workflows guide</Link>
          <Link href="/blog/this-post-wrote-itself" className="underline" style={{ color: SOL.base2 }}>This post wrote itself</Link>
          <Link href="/features" className="underline" style={{ color: SOL.base2 }}>All features</Link>
        </div>
      </div>
    </section>
  );
}
