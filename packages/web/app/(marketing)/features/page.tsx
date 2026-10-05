"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { InstallTabs } from "@/components/install-tabs";
import { SITE_LINKS } from "@/lib/siteLinks";
import { useRouteMeta } from "../pageMeta";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { SOL, Terminal, Cmd } from "../blog/blogChrome";
import { SUITE } from "../suite";
import { FEATURE_DEEP_DIVES, featureHref } from "./catalog";

/** The commands an agent (or a person) runs on each surface of the suite, keyed by its name in SUITE. */
const SURFACE_COMMANDS: Record<string, string[]> = {
  Inbox: ["cast sessions -w", "cast feed --state needs-input", 'cast send jx7hero "ship it"'],
  Chat: ['cast chat read --channel eng --since 2h', 'cast chat send --channel eng "PR #482 is up"'],
  Calls: ["cast calls", "cast call <id> --transcript"],
  "Tasks and plans": ['cast task create "Retry webhooks" -p high', "cast task start ct-482", 'cast plan create "Auth overhaul"'],
  Docs: ['cast doc create "Auth flow"', "cast doc grep <id> '^#'"],
  "Pull requests": ["cast pr show", "cast pr threads", "cast pr shepherd on"],
  Decisions: ['cast decide "Backoff?" -o "Exponential" -o "Fixed"', "cast decide ls"],
  Automations: ['cast trigger add "Check CI" --in 30m', "cast workflow run flow.cast --task ct-482"],
  Pages: ["cast publish report.html", "cast publish comments report.html"],
};

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
          One command line<br />
          <span style={{ color: SOL.base1 }}>for the whole workspace</span>
        </h1>
        <p className="text-lg sm:text-xl leading-relaxed max-w-2xl mx-auto mb-8" style={{ color: SOL.base00 }}>
          Every surface in Codecast is a command. Your agents use <code className="font-mono text-[0.9em]">cast</code> to
          pick up tasks, answer threads, open pull requests and ask for decisions, the same way you
          do from the app. Claude Code, Codex, Cursor, Gemini, OpenCode and pi, on any machine.
        </p>
        <div className="max-w-2xl mx-auto text-left">
          <InstallTabs location="features" />
        </div>
      </section>

      {/* Demo */}
      <section className="max-w-3xl mx-auto px-6 pb-16">
        <Terminal label="Terminal">
          <Cmd>cast ask &quot;how did we implement auth?&quot;</Cmd>
          <span style={{ color: SOL.base01 }}>Searching 3 relevant sessions...{"\n"}</span>
          <span style={{ color: SOL.base1 }}>Found in </span>
          <span style={{ color: SOL.yellow }}>OAuth implementation</span>
          <span style={{ color: SOL.base01 }}> (3 days ago, sarah, codex){"\n"}</span>
          <span style={{ color: SOL.base00 }}>  Refresh the token before the redirect, sessions stored in Convex.{"\n\n"}</span>
          <Cmd>cast task start ct-482</Cmd>
          <span style={{ color: SOL.green }}>Started </span>
          <span style={{ color: SOL.base1 }}>Retry failed webhooks</span>
          <span style={{ color: SOL.base01 }}> · bound to this session{"\n\n"}</span>
          <Cmd>cast decide &quot;Exponential or fixed backoff?&quot; -o Exponential -o Fixed</Cmd>
          <span style={{ color: SOL.yellow }}>Queued for @ashot</span>
          <span style={{ color: SOL.base01 }}> · 3 agents keep working while you decide</span>
        </Terminal>
      </section>

      {/* Deep dives */}
      <section className="max-w-6xl mx-auto px-6 pb-16 sm:pb-20">
        <h2 className="text-2xl sm:text-3xl font-bold mb-2 font-mono" style={{ color: SOL.base03 }}>Deep dives</h2>
        <p className="text-base mb-8" style={{ color: SOL.base00 }}>One page per capability: what it does, how it works, and the commands behind it.</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          {FEATURE_DEEP_DIVES.map((f) => (
            <Link
              key={f.slug}
              href={featureHref(f.slug)}
              className="group flex flex-col rounded-xl p-4 transition-all hover:-translate-y-0.5"
              style={{ backgroundColor: `color-mix(in srgb, ${f.color} 7%, ${SOL.base3})`, border: `1px solid color-mix(in srgb, ${f.color} 22%, transparent)` }}
            >
              <span className="font-mono font-semibold text-sm mb-1.5" style={{ color: f.color }}>{f.name}</span>
              <span className="text-xs leading-relaxed mb-3 line-clamp-3" style={{ color: SOL.base00 }}>{f.dek}</span>
              <code className="mt-auto font-mono text-[11px] truncate" style={{ color: SOL.base01 }} title={f.command}>
                <span style={{ color: f.color }} aria-hidden>$ </span>{f.command}
              </code>
            </Link>
          ))}
        </div>
      </section>

      {/* Quick start */}
      <section className="py-16 sm:py-20" style={{ backgroundColor: SOL.base2 }}>
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4 font-mono" style={{ color: SOL.base03 }}>Up in 30 seconds</h2>
            <p className="text-lg" style={{ color: SOL.base00 }}>Install, sign in, and keep running your agents the way you do now.</p>
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

      {/* The suite, with the commands behind each surface */}
      <section className="max-w-6xl mx-auto px-6 py-16 sm:py-20">
        <div className="text-center mb-12 max-w-3xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4 font-mono" style={{ color: SOL.base03 }}>
            Every surface, from the terminal
          </h2>
          <p className="text-lg leading-relaxed" style={{ color: SOL.base00 }}>
            The commands agents run on each part of the workspace. Whatever they do lands where your
            team already looks, linked to the session that did it.
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
              <p className="text-sm leading-relaxed mb-4" style={{ color: SOL.base00 }}>{line}</p>
              <div className="mt-auto space-y-1.5">
                {(SURFACE_COMMANDS[name] ?? []).map((cmd) => (
                  <code key={cmd} className="block font-mono text-xs px-2 py-1 rounded truncate" style={{ backgroundColor: SOL.base2, color: SOL.base02 }} title={cmd}>
                    {cmd}
                  </code>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Command reference */}
      <section className="py-16 sm:py-20" style={{ backgroundColor: SOL.base03 }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4 font-mono" style={{ color: SOL.base3 }}>Command reference</h2>
            <p className="text-lg" style={{ color: SOL.base1 }}>
              The ones you will reach for most. <code className="font-mono">cast --help</code> lists the rest.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {COMMAND_REFERENCE.map((section) => (
              <div key={section.category} className="rounded-xl p-5" style={{ backgroundColor: SOL.base02, border: "1px solid #094959" }}>
                <h3 className="font-mono font-semibold mb-4 text-sm uppercase tracking-wide" style={{ color: section.color }}>
                  {section.category}
                </h3>
                <div className="space-y-3">
                  {section.commands.map(([cmd, desc]) => (
                    <div key={cmd} className="text-sm">
                      <code className="font-mono" style={{ color: SOL.base1 }}>{cmd}</code>
                      <p className="text-xs mt-0.5" style={{ color: SOL.base01 }}>{desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
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
              The installer teaches each agent the commands above, so it reads the team&apos;s past sessions,
              decisions and docs before it starts, not just the conversation in front of it.
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
          <Terminal label="~/.claude/CLAUDE.md" wrap>
            <span style={{ color: SOL.blue }}>## Memory{"\n\n"}</span>
            <span style={{ color: SOL.base1 }}>Past conversations hold the decisions and prior work you need.{"\n"}Search them when starting a task.{"\n\n"}</span>
            <Cmd>cast search &quot;auth&quot; -s 7d</Cmd>
            <Cmd>cast search &quot;file:src/auth.ts&quot;</Cmd>
            <Cmd>cast ask &quot;why did we use Convex?&quot;</Cmd>
            <Cmd>cast blame src/auth.ts</Cmd>
          </Terminal>
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
