"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { copyToClipboard } from "@/lib/utils";
import { useRouteMeta } from "../pageMeta";
import { SOL, BlogNav, BlogFooter, Terminal, Cmd, Code } from "../blog/blogChrome";

const SUPPORT_EMAIL = "support@codecast.sh";
const DISCORD_URL = "https://discord.gg/S7V5Wnfq";
const ISSUES_URL = "https://github.com/codecast-sh/codecast/issues";

/** One shell line that collects everything a bug report needs. */
const REPORT_COMMAND = "cast --version; cast status; cast doctor --no-e2e; cast logs -n 200";

const CHANNELS = [
  {
    label: "Email",
    value: SUPPORT_EMAIL,
    note: "A person reads every message.",
    href: `mailto:${SUPPORT_EMAIL}`,
    accent: SOL.orange,
  },
  {
    label: "Discord",
    value: "Community server",
    note: "Fastest for quick questions.",
    href: DISCORD_URL,
    accent: SOL.violet,
  },
  {
    label: "GitHub",
    value: "codecast-sh/codecast",
    note: "Bugs and feature requests.",
    href: ISSUES_URL,
    accent: SOL.blue,
  },
];

const LADDER = [
  {
    cmd: "cast status",
    what: "Is the daemon running, and is this machine signed in? The answer is on the first two lines.",
  },
  {
    cmd: "cast doctor",
    what: "Proves the whole loop: daemon, server, and a live message round trip through a throwaway agent. It names the first thing that fails.",
  },
  {
    cmd: "cast logs -n 100",
    what: "The daemon writes down why it did what it did. Read the last hundred lines before you guess.",
  },
  {
    cmd: "cast restart",
    what: "Restarts the daemon and installs a pending update first. Fixes most of what the first three commands find.",
  },
];

const PROBLEMS: { symptom: string; fix: ReactNode }[] = [
  {
    symptom: "New sessions never show up in the inbox",
    fix: (
      <>
        The daemon is not running. Start it with <Code>cast start</Code>, then run <Code>cast setup</Code> once so it
        starts at login and you never think about it again.
      </>
    ),
  },
  {
    symptom: "The CLI says this machine is not authenticated",
    fix: (
      <>
        Run <Code>cast auth</Code> to sign in through the browser. On a machine with no browser, create a setup token
        under Settings, then CLI, and run <Code>cast login &lt;token&gt;</Code>.
      </>
    ),
  },
  {
    symptom: "A message sent from the web never reaches the agent",
    fix: (
      <>
        The agent&apos;s terminal pane is gone. Use Restart session in the conversation header, or run{" "}
        <Code>cast restart &lt;session&gt;</Code>. The daemon resumes the transcript in a fresh pane.
      </>
    ),
  },
  {
    symptom: "The CLI is behind the dashboard",
    fix: (
      <>
        Run <Code>cast update</Code>, then <Code>cast restart</Code>. The CLI updates itself on a schedule, and this
        forces the update now.
      </>
    ),
  },
  {
    symptom: "The desktop app is stuck on an old version",
    fix: (
      <>
        Run <Code>cast desktop-update</Code> from any terminal. It replaces the app outside the macOS updater. You can
        also get the current build from the <Link href="/download" className="underline underline-offset-4">download page</Link>.
      </>
    ),
  },
  {
    symptom: "Remove Codecast from a machine",
    fix: (
      <>
        Run <Code>cast uninstall</Code>. It removes the CLI, the daemon, and its login item. Add{" "}
        <Code>--keep-config</Code> to keep <Code>~/.codecast</Code> for a later reinstall.
      </>
    ),
  },
];

const REPORT_ITEMS = [
  "Which agent: Claude Code, Codex, Cursor, Gemini, OpenCode, Pi, or Grok.",
  "Your OS, and whether the daemon runs on a laptop or a remote box.",
  "A link to the session, if the problem is about one session.",
  "What you expected, what happened instead, and when it started.",
  "The output of the diagnostics command.",
];

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "Which agents does Codecast capture?",
    a: "Claude Code, Codex, Cursor, Gemini, OpenCode, Pi, and Grok. The daemon watches each agent's own session files, so there is nothing to change in how you run them.",
  },
  {
    q: "Does it work offline?",
    a: "Yes. The daemon keeps watching and queues what it cannot send. The web and desktop apps paint from a local cache, so your inbox opens before the network answers. Everything catches up when you are back online.",
  },
  {
    q: "Who can see my sessions?",
    a: (
      <>
        Only you, until you share. Every session starts private. You share one conversation at a time, with a
        teammate or with a link. Secrets are redacted before anything leaves your machine, and you can self host the
        backend. The <Link href="/security" className="underline underline-offset-4">security page</Link> has the full
        answer.
      </>
    ),
  },
  {
    q: "Where are the desktop and mobile apps?",
    a: (
      <>
        The Mac app is on the <Link href="/download" className="underline underline-offset-4">download page</Link>, and
        the iOS app is on the{" "}
        <a href="https://apps.apple.com/app/id6757820850" target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">
          App Store
        </a>
        . Both sign in with the same account as the web.
      </>
    ),
  },
  {
    q: "How do I delete my data?",
    a: (
      <>
        Open Settings, then Accounts, and choose Delete account. That removes your account and everything under it, and
        it cannot be undone. To clear one machine, run <Code>cast uninstall</Code>.
      </>
    ),
  },
  {
    q: "I found a security issue. Where do I send it?",
    a: (
      <>
        Email{" "}
        <a href="mailto:security@codecast.sh" className="underline underline-offset-4">security@codecast.sh</a>.
        Please do not open a public issue for it.
      </>
    ),
  },
  {
    q: "Billing, invoices, or an enterprise plan?",
    a: (
      <>
        Email{" "}
        <a href="mailto:enterprise@codecast.sh" className="underline underline-offset-4">enterprise@codecast.sh</a>.
        Plans and prices are on the <Link href="/pricing" className="underline underline-offset-4">pricing page</Link>.
      </>
    ),
  },
];

/** Staggered entrance: reuses the fadeSlideIn keyframe from tailwind.config. */
function Reveal({ delay, className = "", children }: { delay: number; className?: string; children: ReactNode }) {
  return (
    <div className={`animate-fadeSlideIn ${className}`} style={{ animationDelay: `${delay}ms`, animationFillMode: "both" }}>
      {children}
    </div>
  );
}

function SectionTitle({ children, lede }: { children: ReactNode; lede?: ReactNode }) {
  return (
    <div className="mb-8">
      <h2 className="text-2xl md:text-3xl font-bold font-mono tracking-tight" style={{ color: SOL.base03 }}>
        {children}
      </h2>
      {lede && <p className="mt-3 text-[17px] leading-8 max-w-2xl" style={{ color: SOL.base01 }}>{lede}</p>}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await copyToClipboard(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="text-xs font-mono px-2.5 py-1 rounded transition-colors"
      style={{
        color: copied ? SOL.base03 : SOL.base1,
        backgroundColor: copied ? SOL.green : "transparent",
        border: `1px solid ${copied ? SOL.green : SOL.base01}`,
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

export default function SupportPage() {
  useRouteMeta("/support");

  return (
    <main className="min-h-screen w-full" style={{ backgroundColor: SOL.base3 }}>
      <BlogNav active="/support" />

      {/* Hero: the promise on the left, proof it is checkable on the right */}
      <section className="max-w-5xl mx-auto px-6 pt-16 pb-12 md:pt-24 md:pb-20">
        <div className="grid lg:grid-cols-[1.05fr_1fr] gap-10 lg:gap-14 items-start">
          <div>
            <Reveal delay={0}>
              <h1 className="text-4xl md:text-5xl font-bold font-mono tracking-tight leading-[1.1]" style={{ color: SOL.base03 }}>
                Stuck?
                <br />
                Start here.
              </h1>
            </Reveal>
            <Reveal delay={80}>
              <p className="mt-6 text-lg md:text-xl leading-8" style={{ color: SOL.base01 }}>
                Most problems are a daemon that stopped or a login that expired. Two commands tell you which one.
                When they do not, a person answers.
              </p>
            </Reveal>
            <Reveal delay={160} className="mt-8">
              <ul className="space-y-3">
                {CHANNELS.map((c) => (
                  <li key={c.label}>
                    <a
                      href={c.href}
                      target={c.href.startsWith("http") ? "_blank" : undefined}
                      rel={c.href.startsWith("http") ? "noopener noreferrer" : undefined}
                      className="group flex items-center gap-4 rounded-xl px-4 py-3 transition-colors"
                      style={{ border: `1px solid ${SOL.base2}`, backgroundColor: "rgba(255,255,255,0.35)" }}
                      onMouseEnter={(e) => (e.currentTarget.style.borderColor = c.accent)}
                      onMouseLeave={(e) => (e.currentTarget.style.borderColor = SOL.base2)}
                    >
                      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: c.accent }} />
                      <span className="font-mono text-sm w-16 shrink-0" style={{ color: SOL.base00 }}>{c.label}</span>
                      <span className="flex flex-col min-w-0">
                        <span className="font-medium text-sm truncate" style={{ color: SOL.base03 }}>{c.value}</span>
                        <span className="text-xs" style={{ color: SOL.base0 }}>{c.note}</span>
                      </span>
                      <span className="ml-auto text-sm transition-transform group-hover:translate-x-0.5" style={{ color: c.accent }}>
                        &rarr;
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>

          <Reveal delay={240}>
            <Terminal label="first aid">
              <Cmd>cast status</Cmd>
              {"\n"}
              <span style={{ color: SOL.base01 }}>  Version   </span>v1.1.132{"\n"}
              <span style={{ color: SOL.base01 }}>  Auth      </span><span style={{ color: SOL.green }}>*</span> authenticated{"\n"}
              <span style={{ color: SOL.base01 }}>  Daemon    </span><span style={{ color: SOL.green }}>*</span> running (PID 23887){"\n"}
              <span style={{ color: SOL.base01 }}>  Last sync </span>0 seconds ago{"\n"}
              <span style={{ color: SOL.base01 }}>  Queue     </span>empty{"\n"}
              <span style={{ color: SOL.base01 }}>  Convex    </span><span style={{ color: SOL.green }}>*</span> connected{"\n"}
              {"\n"}
              <Cmd>cast doctor</Cmd>
              {"\n"}
              <span style={{ color: SOL.base01 }}>  Codecast Doctor  (v1.1.132)</span>{"\n"}
              {"\n"}
              <span style={{ color: SOL.green }}>  ✓</span> auth          authenticated{"\n"}
              <span style={{ color: SOL.green }}>  ✓</span> daemon        running, heartbeat 2s ago{"\n"}
              <span style={{ color: SOL.green }}>  ✓</span> convex        connected (last sync 2s ago){"\n"}
              <span style={{ color: SOL.green }}>  ✓</span> sync backlog  clear{"\n"}
              <span style={{ color: SOL.yellow }}>  !</span> guidance      run `cast install --all`{"\n"}
              <span style={{ color: SOL.green }}>  ✓</span> end-to-end    round trip 1.4s{"\n"}
              {"\n"}
              <span style={{ color: SOL.green }}>  ✓ codecast is healthy</span>
            </Terminal>
          </Reveal>
        </div>
      </section>

      {/* The ladder: four commands, in the order to run them */}
      <section className="max-w-5xl mx-auto px-6 py-12 md:py-16" style={{ borderTop: `1px solid ${SOL.base2}` }}>
        <SectionTitle lede="Run them in this order. Each one either fixes the problem or tells the next one where to look.">
          Four commands before you write in
        </SectionTitle>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {LADDER.map((step, i) => (
            <li
              key={step.cmd}
              className="relative rounded-xl p-5 flex flex-col gap-3"
              style={{ backgroundColor: "rgba(255,255,255,0.45)", border: `1px solid ${SOL.base2}` }}
            >
              <span className="font-mono text-xs" style={{ color: SOL.orange }}>0{i + 1}</span>
              <code className="font-mono text-[15px] font-semibold" style={{ color: SOL.base03 }}>{step.cmd}</code>
              <p className="text-sm leading-6" style={{ color: SOL.base01 }}>{step.what}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Symptom to fix */}
      <section className="max-w-5xl mx-auto px-6 py-12 md:py-16" style={{ borderTop: `1px solid ${SOL.base2}` }}>
        <SectionTitle>Common problems</SectionTitle>
        <div className="grid md:grid-cols-2 gap-x-10 gap-y-2">
          {PROBLEMS.map((p) => (
            <div key={p.symptom} className="py-5" style={{ borderTop: `1px solid ${SOL.base2}` }}>
              <h3 className="font-semibold text-[15px] mb-2" style={{ color: SOL.base03 }}>{p.symptom}</h3>
              <p className="text-[15px] leading-7" style={{ color: SOL.base01 }}>{p.fix}</p>
            </div>
          ))}
        </div>
      </section>

      {/* A report we can act on */}
      <section className="max-w-5xl mx-auto px-6 py-12 md:py-16" style={{ borderTop: `1px solid ${SOL.base2}` }}>
        <SectionTitle lede="A report with these five things usually gets fixed on the first reply.">
          Send a report we can act on
        </SectionTitle>
        <div className="grid lg:grid-cols-[1fr_1.1fr] gap-8 lg:gap-12 items-start">
          <ol className="space-y-3">
            {REPORT_ITEMS.map((item, i) => (
              <li key={item} className="flex gap-4 text-[15px] leading-7" style={{ color: SOL.base01 }}>
                <span className="font-mono text-sm pt-0.5 shrink-0" style={{ color: SOL.orange }}>0{i + 1}</span>
                <span>{item}</span>
              </li>
            ))}
          </ol>
          <div className="rounded-xl overflow-hidden shadow-xl" style={{ backgroundColor: SOL.base03, border: "1px solid #094959" }}>
            <div className="flex items-center justify-between px-4 py-2.5" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #094959" }}>
              <span className="text-xs font-mono" style={{ color: SOL.base01 }}>diagnostics command</span>
              <CopyButton text={REPORT_COMMAND} />
            </div>
            <pre className="p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words" style={{ color: SOL.base0 }}>
              <Cmd>{REPORT_COMMAND}</Cmd>
            </pre>
            <p className="px-4 pb-4 text-xs leading-5" style={{ color: SOL.base01 }}>
              The logs describe what the daemon did, not what your agent said. Skim them before you send if your project names are sensitive.
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="max-w-5xl mx-auto px-6 py-12 md:py-16" style={{ borderTop: `1px solid ${SOL.base2}` }}>
        <SectionTitle>Questions we get</SectionTitle>
        <div className="max-w-3xl">
          {FAQ.map((item) => (
            <details key={item.q} className="group" style={{ borderTop: `1px solid ${SOL.base2}` }}>
              <summary className="flex items-center justify-between gap-6 py-5 cursor-pointer list-none select-none">
                <span className="font-semibold text-[15px]" style={{ color: SOL.base03 }}>{item.q}</span>
                <span
                  className="font-mono text-lg leading-none shrink-0 transition-transform group-open:rotate-45"
                  style={{ color: SOL.orange }}
                  aria-hidden
                >
                  +
                </span>
              </summary>
              <p className="pb-6 -mt-1 text-[15px] leading-7 max-w-2xl" style={{ color: SOL.base01 }}>{item.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* Closing contact */}
      <section className="max-w-5xl mx-auto px-6 pb-20 pt-4">
        <div
          className="rounded-2xl px-8 py-10 md:px-12 md:py-12 flex flex-col md:flex-row md:items-center gap-6 md:gap-10"
          style={{ backgroundColor: SOL.base03 }}
        >
          <div className="flex-1">
            <h2 className="text-2xl font-bold font-mono tracking-tight" style={{ color: SOL.base3 }}>Still stuck?</h2>
            <p className="mt-2 text-[15px] leading-7" style={{ color: SOL.base1 }}>
              Write to us with the output above. We read every message and reply from a real inbox.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="font-medium text-sm px-5 py-2.5 rounded-lg transition-colors"
              style={{ backgroundColor: SOL.orange, color: SOL.base3 }}
            >
              Email support
            </a>
            <a
              href={DISCORD_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-sm px-5 py-2.5 rounded-lg transition-colors hover:bg-[#094959]"
              style={{ border: `1px solid ${SOL.base01}`, color: SOL.base1 }}
            >
              Join Discord
            </a>
          </div>
        </div>
      </section>

      <BlogFooter />
    </main>
  );
}
