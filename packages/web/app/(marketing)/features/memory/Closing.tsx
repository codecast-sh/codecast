"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { featureHref, featureDeepDives } from "../catalog";
import { C, VIOLET } from "./kit";
import { Whole } from "../kit";

/** Four real situations, each a short path through the app from a question to its answer. */
const SCENARIOS: { when: string; steps: string[]; get: string }[] = [
  {
    when: "A reviewer asks why the retry cap is 5 and not 3.",
    steps: ["Open retry.ts, Blame: Sessions, line 5", "Ask this session: why 5?"],
    get: "The session that set it, the message where 3 was chosen, and the load test that changed it to 5.",
  },
  {
    when: "Webhooks started failing after this morning's deploy.",
    steps: ["Search commit:4b1c9e2", "Open the session, Show git diff"],
    get: "The session behind the suspect commit, every file it changed, and the conversation explaining each change.",
  },
  {
    when: "An agent picks up a half-finished branch.",
    steps: ["Nothing to do: the agent looks first"],
    get: "The sessions that already touched the changed files, so it starts from their conclusions.",
  },
  {
    when: "Someone proposes removing signature checks to speed up ingest.",
    steps: ["Search repo:payments signature", "Ask your agent what the team decided"],
    get: "The session where the team worked it out, and the recorded decision with its reason.",
  },
];

export function Scenarios() {
  return (
    <section className="py-16 sm:py-24" style={{ backgroundColor: SOL.base03 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-6">
        <h2 className="font-mono text-2xl sm:text-3xl font-bold tracking-tight mb-3" style={{ color: SOL.base3 }}>From a question to the conversation that answers it</h2>
        <p className="text-[16px] sm:text-[17px] leading-7 max-w-2xl mb-10" style={{ color: SOL.base1 }}>Most questions about code are questions about a past conversation. Each of these takes one or two steps.</p>
        <ol className="divide-y" style={{ borderColor: "#0a4352" }}>
          {SCENARIOS.map((s, i) => (
            <li key={s.when} className="grid gap-4 md:grid-cols-[48px_minmax(0,4fr)_minmax(0,5fr)_minmax(0,4fr)] md:gap-6 py-6" style={{ borderColor: "#0a4352" }}>
              <span className="font-mono text-[13px] tabular-nums" style={{ color: VIOLET }}>{String(i + 1).padStart(2, "0")}</span>
              <p className="text-[16px] leading-[1.55]" style={{ color: SOL.base2 }}>{s.when}</p>
              <div className="space-y-1.5 min-w-0">
                {s.steps.map((c, k) => (
                  <div key={c} className="flex items-start gap-2 font-mono text-[12.5px] leading-[1.5]">
                    <span className="shrink-0" style={{ color: k === 0 ? VIOLET : SOL.base01 }}>{k === 0 ? "1" : "→"}</span>
                    <span style={{ color: "#b9bcf0" }}>{c}</span>
                  </div>
                ))}
              </div>
              <p className="text-[14.5px] leading-[1.55]" style={{ color: SOL.base0 }}>{s.get}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const LIMITS: { q: string; a: ReactNode }[] = [
  {
    q: "Who can search my sessions?",
    a: <>Sessions in a project shared with your team are searchable by the team. Sessions in a private project are searchable only by you. Nothing is searchable that you did not choose to share. An agent can widen a search to every team you belong to, never past them.</>,
  },
  {
    q: "How far back does search reach?",
    a: <>Message text is matched in full for the last 30 days. Older sessions still surface by their title and summary, so a session from March is found by what it was about.</>,
  },
  {
    q: "Does every commit get a Codecast-Session trailer?",
    a: <>No. The trailer comes from codecast&apos;s hook in Claude Code, and only for sessions your team can see. Commits from other agents, or without a trailer, are matched by hash, then by subject and time. That match is good but not certain; a trailer is.</>,
  },
  {
    q: "Does cast diff see every change?",
    a: <>It reports what the agent changed through its file editing tools and the commits it made. An edit an agent made by running a shell command can be missing from the file list.</>,
  },
  {
    q: "What does asking cost?",
    a: <>Asking a session runs a small model on the server; the CLI form prints the tokens and cost of each answer. <C>cast ask</C>, which searches across sessions, runs on your machine and needs <C>ANTHROPIC_API_KEY</C> in your environment; it uses the model to expand your question into search terms and returns the matching passages with their sources.</>,
  },
  {
    q: "Do agents search on their own?",
    a: <>Only when they choose to. The installer adds instructions and a command reference; the agent decides when to call them. With <C>cast stable</C> on, each new session also starts with a snapshot of recent sessions, which is a starting point and goes stale as the session runs.</>,
  },
];

export function Limits() {
  return (
    <section id="limits" className="py-16 sm:py-24">
      <div className="max-w-6xl mx-auto px-5 sm:px-6 grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <div className="lg:sticky lg:top-24 self-start">
          <h2 className="font-mono text-2xl sm:text-3xl font-bold tracking-tight mb-4" style={{ color: SOL.base03 }}>Scope and limits</h2>
          <p className="text-[16px] leading-7" style={{ color: SOL.base01 }}>What memory reaches, what it costs, and where its answers stop being exact.</p>
        </div>
        <div className="space-y-2.5">
          {LIMITS.map((l, i) => (
            <details key={l.q} open={i < 2} className="group rounded-xl px-5 py-4" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
              <summary className="cursor-pointer list-none flex items-center justify-between gap-4 font-mono text-[14.5px] font-semibold" style={{ color: SOL.base02 }}>
                {l.q}
                <span aria-hidden className="shrink-0 transition-transform group-open:rotate-45 text-[18px] leading-none" style={{ color: VIOLET }}>+</span>
              </summary>
              <div className="mt-3 text-[15px] leading-[1.65]" style={{ color: SOL.base01 }}>{l.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

const REFERENCE: { group: string; rows: [string, string][] }[] = [
  {
    group: "Find",
    rows: [
      ['cast search "<text> <operators>"', "file: commit: pr: label: author: repo: after: before:"],
      ["cast context [query] [-f file] [--auto]", "sessions relevant to the work you are starting"],
      ['cast ask "<question>"', "passages across sessions that answer a question"],
      ["cast feed", "the team's recent sessions"],
    ],
  },
  {
    group: "Read",
    rows: [
      ['cast read <id> --ask "<question>"', "one session's answer, cited, with later reversals"],
      ["cast read <id> 15:25", "messages 15 to 25; --full shows tool payloads"],
      ["cast summary <id>", "goal, approach, outcome, files"],
      ["cast diff <id> | --today | --week", "files changed, commits, tools used"],
    ],
  },
  {
    group: "Trace",
    rows: [
      ["cast blame <file>[:line] [-L a,b]", "git blame with the session as author"],
      ["cast blame --log <file>", "the sessions that shaped a file, newest first"],
      ["cast blame --open <file>:<line>", "open the line's conversation in the browser"],
      ["cast blame --porcelain <file>", "machine format with codecast-* keys"],
    ],
  },
  {
    group: "Keep",
    rows: [
      ['cast decisions add "<title>" --reason "<why>"', "record a decision; --tags to file it"],
      ['cast decisions [--search q] [--tags t]', "read the log"],
      ["cast stable team | solo | off", "inject recent sessions into each new session"],
      ["cast memory [--disable]", "install or remove the agent instructions"],
    ],
  },
];

export function Reference() {
  return (
    <section id="reference" className="py-16 sm:py-24" style={{ backgroundColor: SOL.base2 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-6">
        <h2 className="font-mono text-2xl sm:text-3xl font-bold tracking-tight mb-3" style={{ color: SOL.base03 }}>For scripts and agents</h2>
        <p className="text-[15.5px] leading-7 max-w-2xl mb-8" style={{ color: SOL.base01 }}>Your agents run these on their own once memory is on. They work from any shell too.</p>
        <div className="grid gap-5 md:grid-cols-2">
          {REFERENCE.map((g) => (
            <div key={g.group} className="rounded-xl overflow-hidden" style={{ backgroundColor: SOL.base3, border: `1px solid color-mix(in srgb, ${SOL.base1} 40%, transparent)` }}>
              <div className="px-5 py-2.5 font-mono text-[13px] font-bold" style={{ color: VIOLET, borderBottom: `1px solid ${SOL.base2}` }}>{g.group}</div>
              <dl>
                {g.rows.map(([c, d]) => (
                  <div key={c} className="mm-row px-5 py-3 hover:bg-[#eee8d5]/50" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
                    <dt className="font-mono text-[12.5px]" style={{ color: SOL.base02 }}><Whole text={c} /></dt>
                    <dd className="text-[13.5px] mt-0.5" style={{ color: SOL.base01 }}>{d}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
        <p className="mt-6 text-[14px]" style={{ color: SOL.base01 }}>
          Common options: <C>--mine</C>, <C>-m &lt;name&gt;</C>, <C>-g</C> (all teams), <C>-s</C> / <C>-e</C> (time range), <C>-n</C> (limit), <C>-p</C> (page). Every command&apos;s <C>--help</C> is the full list.
        </p>
      </div>
    </section>
  );
}

const RELATED = ["decisions", "pull-requests", "agents", "triggers"];

export function Closing() {
  const related = featureDeepDives(RELATED);
  return (
    <section className="mm-strata py-16 sm:py-24">
      <div className="max-w-6xl mx-auto px-5 sm:px-6">
        {related.length > 0 && (
          <div className="mb-16">
            <h2 className="font-mono text-[15px] font-bold mb-4" style={{ color: SOL.base01 }}>Related</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {related.map((f) => (
                <Link key={f.slug} href={featureHref(f.slug)} className="mm-lift block rounded-xl px-4 py-4" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}`, borderTop: `3px solid ${f.color}` }}>
                  <div className="font-mono text-[14px] font-semibold mb-1.5" style={{ color: SOL.base03 }}>{f.name}</div>
                  <div className="text-[13px] leading-[1.5]" style={{ color: SOL.base01 }}>{f.dek}</div>
                </Link>
              ))}
            </div>
          </div>
        )}
        <div id="install" className="grid gap-10 lg:grid-cols-2 items-center rounded-2xl px-6 py-10 sm:px-10 sm:py-12" style={{ backgroundColor: SOL.base03 }}>
          <div>
            <h2 className="font-mono text-2xl sm:text-[32px] font-bold tracking-tight leading-tight mb-4" style={{ color: SOL.base3 }}>Your agents have been taking notes all along.</h2>
            <p className="text-[16px] leading-7 mb-6" style={{ color: SOL.base1 }}>
              Install codecast and your sessions become searchable, askable and blameable. Answer yes to agent memory and your agents start reading it too.
            </p>
          </div>
          <div className="min-w-0">
            <InstallTabs location="feature_memory" />
          </div>
        </div>
      </div>
    </section>
  );
}
