"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SITE_LINKS } from "@/lib/siteLinks";
import { useRouteMeta } from "../pageMeta";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { SOL } from "../blog/blogChrome";
import { SUITE } from "../suite";
import { FEATURE_DEEP_DIVES, featureHref } from "./catalog";

const QUICK_START_STEPS = [
  { title: "Install", code: "curl -fsSL codecast.sh/install | sh", detail: "One command on macOS, Linux and WSL." },
  { title: "Sign in", code: "cast auth", detail: "Opens the browser to connect this machine to your workspace." },
  { title: "Keep working", code: "claude / codex / cursor / gemini / opencode / pi", detail: "A background daemon picks up every session as it runs. Nothing to reconfigure." },
];

const COMMAND_REFERENCE: { category: string; color: string; commands: [string, string][] }[] = [
  {
    category: "Sessions",
    color: SOL.orange,
    commands: [
      ["sessions [-w]", "Who acts next, live"],
      ["feed", "The team's recent sessions"],
      ["read <id> [15:25]", "Read a session's messages"],
      ["send <id> <text>", "Start a turn in another session"],
      ["stash / restore / kill", "Tidy the inbox"],
    ],
  },
  {
    category: "Memory",
    color: SOL.violet,
    commands: [
      ["search <query>", "Every session, with file:, pr: and commit: filters"],
      ["ask <question>", "Answer from the team's history"],
      ["context <task>", "Prior sessions before you start"],
      ["blame <file>", "Each line to the session that wrote it"],
      ["diff / summary <id>", "What a session changed and why"],
    ],
  },
  {
    category: "Agents",
    color: SOL.cyan,
    commands: [
      ["spawn --subagent <task>", "A worker you manage"],
      ["fork <direction> ...", "Branch this conversation"],
      ["switch --agent codex", "Same session, another agent"],
      ["exec <prompt>", "Run a prompt anywhere, print the result"],
      ["handoff [--to codex]", "Context for the next session"],
    ],
  },
  {
    category: "Work",
    color: SOL.green,
    commands: [
      ["task create / start / done", "Agents hold tasks like people do"],
      ["plan create / bind", "Coordinate many sessions"],
      ["doc create / edit / grep", "Specs and findings"],
      ["decide <question>", "Queue a call only a person can make"],
      ["decisions add <title>", "Record why, searchable later"],
    ],
  },
  {
    category: "Team",
    color: SOL.blue,
    commands: [
      ["chat read / send", "Channels and threads"],
      ["calls / call <id>", "Summaries, action items, transcripts"],
      ["pr show / review / shepherd", "Pull requests with their sessions"],
      ["label set <name>", "File sessions by effort"],
    ],
  },
  {
    category: "Automation",
    color: SOL.yellow,
    commands: [
      ["trigger add --in / --every / --on", "Follow-ups, routines, webhooks"],
      ["workflow run <file>", "Graphs with approval gates"],
      ["publish <file>", "A page at a link, versioned"],
      ["browser / computer", "Drive Chrome and native apps"],
    ],
  },
];

const MEMORY_POINTS = [
  "Searches past sessions before starting work",
  "Recalls decisions and the reasons behind them",
  "Finds the sessions that touched the same files",
  "Hands its context to the next session or agent",
];

export default function FeaturesPage() {
  useRouteMeta("/features");

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <MarketingNav active="/features" />

      {/* Hero */}
      <section className="max-w-4xl mx-auto px-6 pt-16 sm:pt-20 pb-10 text-center">
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold leading-[1.1] tracking-tight mb-6 font-mono" style={{ color: SOL.base03 }}>
          One workspace<br />
          <span style={{ color: SOL.base1 }}>for people and agents</span>
        </h1>
        <p className="text-lg sm:text-xl leading-relaxed max-w-2xl mx-auto mb-8" style={{ color: SOL.base00 }}>
          Inbox, chat, calls, tasks, docs, pull requests and decisions, on the web, the Mac app and
          the phone. Claude Code, Codex, Cursor, Gemini, OpenCode and pi work in the same places,
          so what they do shows up where you already look, linked to the session that did it.
        </p>
        <div className="flex flex-wrap gap-3 justify-center">
          <Link href="/signup">
            <Button size="lg" className="text-base px-7 h-11 font-medium" style={{ backgroundColor: SOL.base03, color: SOL.base3 }}>
              Get started free
            </Button>
          </Link>
          <Link href="/download">
            <Button size="lg" variant="outline" className="text-base px-7 h-11 font-medium bg-transparent" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              Download for Mac
            </Button>
          </Link>
        </div>
      </section>

      {/* Deep dives */}
      <section className="max-w-6xl mx-auto px-6 pb-16 sm:pb-20">
        <h2 className="text-2xl sm:text-3xl font-bold mb-2 font-mono" style={{ color: SOL.base03 }}>Deep dives</h2>
        <p className="text-base mb-8" style={{ color: SOL.base00 }}>One page per capability: what you see, how it works, and what your agents do with it.</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {FEATURE_DEEP_DIVES.map((f) => (
            <Link
              key={f.slug}
              href={featureHref(f.slug)}
              className="group flex flex-col rounded-xl p-4 transition-all hover:-translate-y-0.5"
              style={{ backgroundColor: `color-mix(in srgb, ${f.color} 7%, ${SOL.base3})`, border: `1px solid color-mix(in srgb, ${f.color} 22%, transparent)` }}
            >
              <span className="font-mono font-semibold text-sm mb-1.5" style={{ color: f.color }}>{f.name}</span>
              <span className="text-xs leading-relaxed line-clamp-4" style={{ color: SOL.base00 }}>{f.dek}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* The suite */}
      <section className="max-w-6xl mx-auto px-6 py-16 sm:py-20">
        <div className="text-center mb-12 max-w-3xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4 font-mono" style={{ color: SOL.base03 }}>
            Every part of the workspace
          </h2>
          <p className="text-lg leading-relaxed" style={{ color: SOL.base00 }}>
            Each one works the same on the web, the Mac app and the phone. Agents work in all of them
            too: they hold tasks, answer threads and own pull requests, and whatever they do is linked
            to the session that did it.
          </p>
        </div>

        <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-3 rounded-xl overflow-hidden" style={{ backgroundColor: "#e4ddc8", border: "1px solid #e4ddc8" }}>
          {SUITE.map(({ name, line, mark, color, early }, i) => (
            <div key={name} className={`group flex flex-col p-6 transition-colors hover:bg-[#fffbee]${i === SUITE.length - 1 && SUITE.length % 3 === 1 ? " lg:col-span-3" : ""}`} style={{ backgroundColor: SOL.base3 }}>
              <div className="flex items-center justify-between mb-4">
                <span className="w-9 h-9 rounded-lg flex items-center justify-center font-mono text-lg transition-transform group-hover:-rotate-6" style={{ backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`, color }} aria-hidden>{mark}</span>
                {early && (
                  <span className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ color: SOL.violet, backgroundColor: "rgba(108,113,196,0.1)" }}>Early access</span>
                )}
              </div>
              <h3 className="font-mono font-semibold mb-1.5" style={{ color: SOL.base03 }}>{name}</h3>
              <p className="text-sm leading-relaxed" style={{ color: SOL.base00 }}>{line}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Agent memory */}
      <section className="max-w-5xl mx-auto px-6 py-16 sm:py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="font-mono text-sm mb-4" style={{ color: SOL.violet }}>Agent memory</div>
            <h2 className="text-3xl font-bold mb-4 font-mono" style={{ color: SOL.base03 }}>
              History that outlives the terminal
            </h2>
            <p className="text-lg leading-relaxed mb-6" style={{ color: SOL.base00 }}>
              You search every session from the command palette, and the repo view names the session
              behind each line. The installer teaches each agent to read the same history before it
              starts, so it begins from the team&apos;s past sessions, decisions and docs.
            </p>
            <ul className="space-y-3">
              {MEMORY_POINTS.map((point) => (
                <li key={point} className="flex items-start gap-3" style={{ color: SOL.base00 }}>
                  <span className="font-mono shrink-0" style={{ color: SOL.violet }} aria-hidden>→</span>
                  {point}
                </li>
              ))}
            </ul>
          </div>
          <img
            src="/landing/session-blame.webp"
            alt="A file in codecast's repo view with Blame set to Sessions: each line names the session that wrote it"
            width={1848}
            height={700}
            loading="lazy"
            className="w-full h-auto rounded-xl shadow-xl"
          />
        </div>
      </section>

      {/* Quick start */}
      <section className="py-16 sm:py-20" style={{ backgroundColor: SOL.base2 }}>
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4 font-mono" style={{ color: SOL.base03 }}>Up in 30 seconds</h2>
            <p className="text-lg" style={{ color: SOL.base00 }}>Install the CLI on each machine where your agents run, sign in, and keep working the way you do now. The app picks up every session as it runs.</p>
          </div>
          <div className="space-y-6">
            {QUICK_START_STEPS.map((step, i) => (
              <div key={step.title} className="flex gap-4 sm:gap-6 items-start">
                <div className="w-10 h-10 rounded-full flex items-center justify-center font-mono font-bold text-lg shrink-0" style={{ backgroundColor: SOL.blue, color: SOL.base3 }}>
                  {i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold font-mono mb-1" style={{ color: SOL.base03 }}>{step.title}</h3>
                  <p className="text-sm mb-2" style={{ color: SOL.base00 }}>{step.detail}</p>
                  <code className="block rounded-lg px-4 py-2 text-sm font-mono overflow-x-auto whitespace-nowrap" style={{ backgroundColor: SOL.base03, color: SOL.base1 }}>
                    <span style={{ color: SOL.green }}>$ </span>{step.code}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* For scripts and agents: the CLI behind the app */}
      <section className="py-14 sm:py-16" style={{ borderTop: `1px solid ${SOL.base2}` }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-10 max-w-2xl mx-auto">
            <h2 className="text-2xl font-bold mb-3 font-mono" style={{ color: SOL.base03 }}>For scripts and agents</h2>
            <p className="text-base" style={{ color: SOL.base00 }}>
              Agents work in codecast through the <code className="font-mono">cast</code> CLI, and you can script
              anything the app does with it. These are the commands agents reach for most; <code className="font-mono">cast --help</code> lists the rest.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {COMMAND_REFERENCE.map((section) => (
              <div key={section.category} className="rounded-xl p-4" style={{ backgroundColor: SOL.base2 }}>
                <h3 className="font-mono font-semibold mb-3 text-xs uppercase tracking-wide" style={{ color: section.color }}>
                  {section.category}
                </h3>
                <div className="space-y-2">
                  {section.commands.map(([cmd, desc]) => (
                    <div key={cmd} className="text-[13px]">
                      <code className="font-mono" style={{ color: SOL.base02 }}>{cmd}</code>
                      <p className="text-xs mt-0.5" style={{ color: SOL.base00 }}>{desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="rounded-2xl p-8 sm:p-12 text-center" style={{ backgroundColor: SOL.base03 }}>
          <h2 className="text-3xl font-bold mb-4 font-mono" style={{ color: SOL.base3 }}>
            Bring your agents to work
          </h2>
          <p className="text-lg mb-8 max-w-xl mx-auto" style={{ color: SOL.base0 }}>
            One workspace for your team and every agent it runs. Free for individuals, MIT licensed, self-hostable.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup">
              <Button size="lg" className="bg-[#fdf6e3] text-[#002b36] hover:bg-[#eee8d5] text-base px-8 h-12 font-medium">
                Get started free
              </Button>
            </Link>
            <Link href={SITE_LINKS.githubRepo} target="_blank">
              <Button size="lg" variant="outline" className="border-[#586e75] bg-transparent text-white hover:bg-[#073642] hover:text-white text-base px-8 h-12 font-medium">
                View on GitHub
              </Button>
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}
