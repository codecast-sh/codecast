"use client";

import Link from "next/link";
import { EveryoneFooter, ForEveryone } from "../../components/marketing/ForEveryone";
import { Shot } from "./features/kit";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/components/ui/button";
import { InstallTabs } from "@/components/install-tabs";
import { AppLoader } from "@/components/AppLoader";
import { isDesktopShell } from "@/lib/desktop";
import { track } from "@/lib/analytics";
import { useLocalAuth } from "@/lib/localAuth";
import { takeAuthReturn } from "@/lib/authReturn";
import { useWatchEffect } from "@/hooks/useWatchEffect";
import { useRouteMeta } from "./pageMeta";
import { PhoneFrame } from "./productMocks";
import { HeroFlythrough } from "./HeroFlythrough";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { AppBadges } from "@/components/marketing/AppBadges";
import { TourSection, WatchChapter } from "./TourFilm";
import { SUITE } from "./suite";
import { earlyAccessMailto } from "@/lib/siteLinks";

/** The agents codecast reads today: the hero's list and the stats row both count this one list. */
const AGENTS = ["Claude Code", "Codex", "Cursor", "OpenCode", "pi"];

/** The surfaces the hero names, in the suite's own order and marks: the team half of the pitch, drawn as the workspace's parts. */
const HERO_SURFACES = new Set(["Chat", "Calls", "Tasks and plans", "Docs", "Pull requests", "Decisions"]);

/** One highlighter stroke behind a phrase: the page's single hand-drawn mark. */
function Marker({ children }: { children: React.ReactNode }) {
  return (
    <span className="relative inline-block">
      <span
        aria-hidden
        className="absolute mk-swipe"
        style={{ inset: "-0.1em -0.18em -0.04em", backgroundColor: "rgba(181,137,0,0.26)", transform: "rotate(-1.4deg)", clipPath: "polygon(1% 10%, 99% 3%, 98% 93%, 2% 97%)" }}
      />
      <span className="relative">{children}</span>
    </span>
  );
}

/** The hero's entrance: each block rises in turn on first paint, once. */
const ENTRANCE_CSS = [
  "@keyframes mk-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
  "@keyframes mk-swipe{from{clip-path:polygon(1% 10%,1% 3%,2% 93%,2% 97%)}}",
  ".mk-rise{animation:mk-rise 700ms cubic-bezier(0.16,1,0.3,1) both}",
  ".mk-swipe{animation:mk-swipe 650ms cubic-bezier(0.65,0,0.35,1) 350ms both}",
  "@media (prefers-reduced-motion:reduce){.mk-rise,.mk-swipe{animation:none}}",
].join("");
const rise = (i: number) => ({ animationDelay: `${i * 90}ms` });

const INK = "#002b36";
const BODY = "#586e75";
const MUTED = "#93a1a1";
const RULE = "#e4ddc8";
const ACCENT = "#cb4b16";
/** Prose sets in the bundled interface sans; headings, code and product mocks keep the mono. */
const SANS = { fontFamily: '"Instrument Sans Variable", "Instrument Sans", ui-sans-serif, system-ui, sans-serif' } as const;

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-2xl font-semibold font-mono tracking-tight" style={{ color: INK }}>{value}</div>
      <div className="text-sm mt-1" style={{ color: BODY }}>{label}</div>
    </div>
  );
}

/** A list row's marker: a short rule, quieter than a check icon. */
function Bullet() {
  return <span aria-hidden className="mt-[0.75em] h-px w-3 shrink-0" style={{ backgroundColor: MUTED }} />;
}

function ArrowLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-1.5 text-sm font-medium transition-colors hover:text-[#cb4b16]" style={{ color: INK }}>
      {children}
      <svg className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
      </svg>
    </Link>
  );
}

export default function LandingPage() {
  useRouteMeta("/");
  const { isAuthenticated, isLoading } = useConvexAuth();
  // Local-first: a stored token is enough to route the desktop shell to the
  // inbox without waiting for the server — offline that confirmation never
  // comes.
  const localAuthed = useLocalAuth();
  const router = useRouter();
  const [desktop, setDesktop] = useState(false);
  // A visitor from a non-developer link (/everyone, a campaign's
  // ?for=assistant) meets the For everyone section as its whole page; the
  // developer home page never shows it. Read once, as pricing's door is (cameForAssistant).
  const [assistantFirst] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("for") === "assistant");

  // The root is the marketing site for every browser, signed in or not (the
  // nav offers "Open app"). Only the desktop shell never shows it: a build
  // that boots at the site root is routed on to the app or the sign-in here.
  // Signed in again after a moment that only looked signed out: back to the
  // page AuthGuard left (lib/authReturn), never the marketing page.
  // A campaign link (?for=assistant) shows the page it promises even to a
  // signed-in browser; Open app is one click away in the nav.
  useWatchEffect(() => {
    if (!localAuthed || assistantFirst) return;
    const back = takeAuthReturn();
    if (back) router.replace(back);
  }, [localAuthed, router, assistantFirst]);

  useWatchEffect(() => {
    if (!isDesktopShell()) return;
    setDesktop(true);
    router.replace(localAuthed || (!isLoading && isAuthenticated) ? "/inbox" : "/login");
  }, [localAuthed, isAuthenticated, isLoading, router]);

  if (desktop) {
    return (
      <AppLoader className="bg-[#fdf6e3] text-[#93a1a1]" />
    );
  }

  // The assistant's door is a page of its own: the For everyone section and
  // a short foot. The developer hero (an install command, the agent fleet)
  // never follows the promise that nothing needs installing.
  if (assistantFirst) {
    return (
      <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: "var(--pd-bg, #f6f1e7)" }}>
        <MarketingNav active="/" door="assistant" />
        <ForEveryone />
        <EveryoneFooter />
      </main>
    );
  }

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: '#fdf6e3' }}>
      <MarketingNav active="/" />

      {/* Hero: the claim, what it works with, one primary action and the install strip, then the film. */}
      <section className="mx-auto px-6 pt-10 lg:pt-14 pb-6">
        <style>{ENTRANCE_CSS}</style>
        <div className="text-center max-w-5xl mx-auto">
          <h1 className="mk-rise font-mono font-bold text-[34px] sm:text-[44px] lg:text-[54px] leading-[1.08] tracking-[-0.045em] [text-wrap:balance]" style={{ color: INK, ...rise(0) }}>
            Your team and its <span className="whitespace-nowrap"><Marker>coding agents</Marker>,</span> in one workspace<span aria-hidden className="inline-block w-[0.46em] h-[0.78em] ml-[0.12em] align-baseline translate-y-[0.06em] motion-safe:animate-pulse" style={{ backgroundColor: ACCENT }} />
          </h1>
          <p className="mk-rise mt-6 text-lg sm:text-xl leading-relaxed max-w-2xl mx-auto [text-wrap:pretty]" style={{ ...SANS, color: BODY, ...rise(1) }}>
            Every {AGENTS.slice(0, -1).join(", ")} and {AGENTS[AGENTS.length - 1]} session, on any machine, searchable and
            linked to the code it wrote. Start on your own. Bring your team in, and the agents work beside you.
          </p>
          <ul className="mk-rise mt-7 flex flex-wrap justify-center gap-2" style={rise(2)} aria-label="What the workspace holds">
            {SUITE.filter((x) => HERO_SURFACES.has(x.name)).map(({ name, mark, color, href }) => (
              <li key={name}>
                <Link
                  href={href ?? "#suite"}
                  className="inline-flex items-center gap-2 h-8 px-3 rounded-full font-mono text-[13px] transition-colors hover:bg-[#eee8d5]"
                  style={{ border: `1px solid ${RULE}`, color: INK }}
                >
                  <span aria-hidden style={{ color }}>{mark}</span>
                  {name === "Tasks and plans" ? "Tasks" : name}
                </Link>
              </li>
            ))}
          </ul>

          <div className="mk-rise mt-9 flex flex-col sm:flex-row items-center justify-center gap-4" style={rise(3)}>
            <Button asChild className="shrink-0 text-[15px] px-6 h-11 font-semibold text-[#fdf6e3] border-0 transition-colors hover:bg-[#073642]" style={{ backgroundColor: INK }}>
              <Link href="/signup">Get started free</Link>
            </Button>
            <div className="w-full sm:max-w-md text-left">
              <InstallTabs location="landing_hero" showAlternatives={false} compact />
            </div>
          </div>
          <p className="mk-rise mt-2.5 text-xs" style={{ ...SANS, color: MUTED, ...rise(3) }}>No config. Sessions you already run show up.</p>
        </div>
        {/* The first screen goes to the film: its width follows the viewport's height (the headline, pitch, surface row and the button beside the install strip take about 470px; on a short laptop screen the scrubber sits at the fold, so the windows stay readable), between 640px and 1240px, and a phone gets the full width. */}
        <div className="relative mx-auto mt-10" style={{ width: "min(100%, clamp(640px, min(100vw - 96px, (100svh - 470px) * 1280 / 760), 1240px))" }}>
          <HeroFlythrough />
        </div>
      </section>

      <div className="[&_h2]:[text-wrap:balance] [&_p]:[text-wrap:pretty]" style={SANS}>
      <TourSection />

      {/* ── The suite: one tile per surface ─────────────────────────────── */}
      <section id="suite" className="max-w-6xl mx-auto px-6 py-20" style={{ borderTop: `1px solid ${RULE}` }}>
        <div className="mb-12 max-w-2xl">
          <h2 className="text-3xl font-bold mb-4 font-mono tracking-tight" style={{ color: INK }}>
            One workspace for people and agents
          </h2>
          <p className="text-lg leading-relaxed" style={{ color: BODY }}>
            Chat, calls, tasks, docs, pull requests and pages on one record. Agents are members. They get
            mentioned, assigned and reviewed like anyone else, and everything they touch links back to its session.
          </p>
        </div>

        <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-5 rounded-lg overflow-hidden" style={{ backgroundColor: RULE, border: `1px solid ${RULE}` }}>
          {SUITE.map(({ name, line, mark, color, chapter, early }) => (
            <div key={name} className="relative flex flex-col p-5 transition-colors hover:bg-[#fffbee]" style={{ backgroundColor: '#fdf6e3' }}>
              <div className="flex items-center justify-between mb-4">
                <span className="w-8 h-8 rounded-md flex items-center justify-center font-mono text-base" style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`, color }} aria-hidden>{mark}</span>
                {early ? (
                  <a href="#org" className="font-mono text-meta hover:underline" style={{ color: MUTED }}>Early access</a>
                ) : chapter ? (
                  <WatchChapter title={chapter} compact />
                ) : null}
              </div>
              <h3 className="font-mono font-semibold mb-1.5" style={{ color: INK }}>{name}</h3>
              <p className="text-sm leading-relaxed" style={{ color: BODY }}>{line}</p>
            </div>
          ))}
        </div>

        <p className="text-sm mt-6" style={{ color: MUTED }}>
          Also: search across every session, fork a session to try two directions, switch agent or model mid-run,
          run agents on cloud hosts, and sync issues both ways with Linear and GitHub.
        </p>
      </section>

      {/* ── Agents work where people work ──────────────────────────────── */}
      <section id="agents" className="py-20" style={{ backgroundColor: INK }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-5 font-mono tracking-tight" style={{ color: '#fdf6e3' }}>
                Agents work where your team works
              </h2>
              <p className="text-lg leading-relaxed mb-6" style={{ color: MUTED }}>
                The agent that wrote the code is the one answering in the thread, holding the task and fixing its
                own pull request, with the same verbs a person gets.
              </p>
              <div className="mb-8"><WatchChapter title="Agents together" tone="dark" /></div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-3 font-mono text-sm mb-8">
                {[
                  ["assigned", "a task on the board"],
                  ["mentioned", "in a channel thread"],
                  ["messaged", "by another session"],
                  ["owner", "of a pull request"],
                  ["transcribed", "on the team call"],
                  ["holder", "of a standing role"],
                ].map(([verb, rest]) => (
                  <div key={verb}>
                    <span style={{ color: '#eee8d5' }}>{verb}</span> <span style={{ color: '#839496' }}>{rest}</span>
                  </div>
                ))}
              </div>
              <p className="text-sm leading-relaxed" style={{ color: '#839496' }}>
                {AGENTS.join(", ")}, on your laptop or a cloud host. Your agents run on your own subscriptions.
                Codecast never resells their tokens.
              </p>
            </div>

            <div className="rounded-lg overflow-hidden font-mono text-sm" style={{ backgroundColor: '#073642', border: '1px solid #0b4a5a' }} role="img" aria-label="A team channel where people and agent sessions talk in one thread">
              <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: '1px solid #0b4a5a' }}>
                <span style={{ color: '#586e75' }}>#</span>
                <span style={{ color: '#eee8d5' }}>eng</span>
                <span className="ml-auto text-xs" style={{ color: '#586e75' }}>4 people, 3 agents</span>
              </div>
              <div className="p-5 space-y-4 text-[13px]">
                {[
                  { who: "sarah", kind: "", text: <>webhooks are failing for acme again. <span style={{ color: '#eee8d5' }}>@jx7hero</span> can you take it?</> },
                  { who: "Retry failed webhooks", kind: "claude", text: <>On it. Split it: the API half went to a Codex session, the dashboard to Cursor. Filed as <span style={{ color: '#eee8d5' }}>ct-482</span>.</> },
                  { who: "Webhook API half", kind: "codex", text: <>Retry queue is in. PR <span style={{ color: '#eee8d5' }}>#482</span> is open, CI green.</> },
                  { who: "Retry failed webhooks", kind: "claude", text: <>One call for a person: exponential or fixed backoff? Queued for <span style={{ color: '#eee8d5' }}>@ashot</span>.</> },
                ].map((m, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="w-6 h-6 rounded flex items-center justify-center text-meta font-bold shrink-0" style={{ backgroundColor: m.kind ? '#0b4a5a' : '#586e75', color: '#eee8d5' }}>{m.who[0].toUpperCase()}</div>
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span style={{ color: '#eee8d5' }}>{m.who}</span>
                        <span className="text-meta" style={{ color: '#586e75' }}>{m.kind}</span>
                      </div>
                      <p className="leading-relaxed" style={{ color: MUTED }}>{m.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Every piece of work traces back ─────────────────────────────── */}
      <section id="remember" className="max-w-6xl mx-auto px-6 py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl font-bold mb-4 font-mono tracking-tight" style={{ color: INK }}>
              Every piece of work traces back to its session
            </h2>
            <p className="text-lg leading-relaxed mb-6" style={{ color: BODY }}>
              A line of code, a doc edit, a task, a decision or a published page leads back to the
              conversation that produced it. The record spans every agent and every teammate, so the next
              session starts from the answer instead of a blank context.
            </p>
            <div className="-mt-1 mb-6"><WatchChapter title="Memory" /></div>
            <ul className="space-y-3 mb-8">
              {[
                <>Search every session from the command palette, with <code className="font-mono text-sm px-1 rounded" style={{ backgroundColor: '#eee8d5' }}>file:</code> and <code className="font-mono text-sm px-1 rounded" style={{ backgroundColor: '#eee8d5' }}>pr:</code> filters</>,
                <>Set Blame to Sessions in the repo view, and each line names the session that wrote it</>,
                <>Agents read the same history before they start, so they begin from what the team already decided</>,
              ].map((item, i) => (
                <li key={i} className="flex items-start gap-3" style={{ color: BODY }}>
                  <Bullet />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <ArrowLink href="/features/memory">How team memory works</ArrowLink>
          </div>

          <Shot
            dark
            src="/landing/session-blame.webp"
            alt="A file in codecast's repo view with Blame set to Sessions: a strip names the three sessions behind the file, and the gutter labels each line with its session and age"
            width={1848}
            height={700}
            caption="Blame set to Sessions. The strip lists the sessions behind this file, and each line names the one that wrote it."
          />
        </div>
      </section>

      {/* ── The inbox ───────────────────────────────────────────────────── */}
      <section id="anywhere" className="max-w-6xl mx-auto px-6 py-20" style={{ borderTop: `1px solid ${RULE}` }}>
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <h2 className="text-3xl font-bold mb-4 font-mono tracking-tight" style={{ color: INK }}>
              An inbox sorted by who acts next
            </h2>
            <p className="text-lg leading-relaxed mb-6" style={{ color: BODY }}>
              Twenty agents running should not mean twenty tabs to watch. The inbox shows what needs a
              person, across every agent and machine, and keeps everything else moving.
            </p>
            <div className="-mt-1 mb-6"><WatchChapter title="The inbox" /></div>
            <ul className="space-y-3 mb-8" style={{ color: BODY }}>
              {[
                "Decisions arrive as cards with the context to answer them cold",
                "Push notifications, and steering from web, desktop or phone",
                "Triggers and routines keep agents going overnight",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <Bullet />
                  {item}
                </li>
              ))}
            </ul>
            <AppBadges location="landing" />
          </div>
          <div className="relative">
            <PhoneFrame className="max-w-[280px] mx-auto">
                <div className="p-4 space-y-3 font-mono text-xs">
                  <div className="flex items-center gap-2 text-[#586e75]">
                    <span className="text-[#93a1a1]">◇</span>
                    <span>Decision &middot; Retry failed webhooks</span>
                  </div>
                  <p className="text-[#eee8d5] text-[13px] leading-snug">Exponential or fixed backoff?</p>
                  <p className="text-[#839496] text-meta leading-relaxed">
                    A fork tried both. Fixed backoff retried 40% faster but hammered acme&apos;s endpoint during their outage.
                  </p>
                  <div className="space-y-1.5 pt-1 text-meta">
                    <div className="px-2.5 py-1.5 rounded bg-[#eee8d5] text-[#002b36]">Exponential, cap at 10 min</div>
                    <div className="px-2.5 py-1.5 rounded bg-[#073642] text-[#839496]">Fixed, every 30s</div>
                  </div>
                  <p className="text-[#586e75] text-meta pt-1">3 agents keep working while you decide</p>
                </div>
            </PhoneFrame>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="max-w-6xl mx-auto px-6 py-20" style={{ borderTop: `1px solid ${RULE}` }}>
        <div className="mb-12 max-w-2xl">
          <h2 className="text-3xl font-bold mb-4 font-mono tracking-tight" style={{ color: INK }}>
            Up and running in three steps
          </h2>
          <p className="text-lg" style={{ color: BODY }}>
            Install the CLI, keep running your agents the way you do now, and bring your team in.
          </p>
        </div>

        <ol className="grid md:grid-cols-3 gap-px rounded-lg overflow-hidden" style={{ backgroundColor: RULE, border: `1px solid ${RULE}` }}>
          {[
            { cmd: "curl -fsSL codecast.sh/install | sh", title: "Install the CLI", body: "A daemon runs in the background and watches the real sessions on your machine." },
            { cmd: "claude / codex / cursor / opencode / pi", title: "Work with your agents", body: "Nothing to reconfigure. Every session joins the workspace live, with the tasks, docs and threads around it." },
            { cmd: "invite / assign / mention / decide", title: "Bring in your team", body: "Share what you choose. Teammates and their agents meet in the same channels, boards and pull requests." },
          ].map((step, i) => (
            <li key={step.title} className="p-6 flex flex-col" style={{ backgroundColor: '#fdf6e3' }}>
              <div className="font-mono text-sm mb-6" style={{ color: MUTED }}>{i + 1}</div>
              <h3 className="text-lg font-semibold mb-2 font-mono" style={{ color: INK }}>{step.title}</h3>
              <p className="mb-4" style={{ color: BODY }}>{step.body}</p>
              <code className="mt-auto block font-mono text-[13px]" style={{ color: MUTED }}>$ {step.cmd}</code>
            </li>
          ))}
        </ol>
      </section>

      {/* ── The org: the next step ──────────────────────────────────────── */}
      <section id="org" className="max-w-6xl mx-auto px-6 py-20" style={{ borderTop: `1px solid ${RULE}` }}>
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="font-mono text-meta mb-3" style={{ color: MUTED }}>Early access</div>
            <h2 className="text-3xl font-bold mb-4 font-mono tracking-tight [text-wrap:balance]" style={{ color: INK }}>
              From a team of agents to an org
            </h2>
            <p className="text-lg leading-relaxed mb-8" style={{ color: BODY }}>
              A session ends when its task does. A role stays. It is a standing agent that looks after
              one area: it checks on it every day, starts the sessions the work needs, and comes to you
              only with a decision that is yours.
            </p>
            <div className="flex flex-wrap items-center gap-5">
              <a href={earlyAccessMailto("Org")} onClick={() => track("early_access_requested", { what: "org", location: "landing" })}>
                <Button variant="outline" className="h-10 px-5 text-sm font-medium bg-transparent border-[#93a1a1] text-[#002b36] hover:bg-[#eee8d5]">
                  Request early access
                </Button>
              </a>
              <ArrowLink href="/features/org">How roles work</ArrowLink>
            </div>
          </div>

          <div className="font-mono text-[13px]" role="img" aria-label="An org chart: you at the top, a Head of People, an Executive Assistant and two leads with their sessions, and a proposal to split one lead in two">
            <div className="rounded-lg p-5" style={{ backgroundColor: '#fdf6e3', border: `1px solid ${RULE}` }}>
              <div className="flex items-center gap-2.5 mb-3">
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-meta font-bold" style={{ backgroundColor: INK, color: '#fdf6e3' }}>Y</span>
                <span style={{ color: INK }}>You</span>
              </div>
              <div className="ml-3.5 pl-5 space-y-2.5" style={{ borderLeft: '1px solid #d6cfb8' }}>
                {[
                  { name: "Head of People", note: "reviews the org weekly", ok: true },
                  { name: "Executive Assistant", note: "your right hand", ok: true },
                  { name: "Release lead", note: "2 sessions", ok: true },
                  { name: "Growth lead", note: "5 sessions", ok: false },
                ].map((r) => (
                  <div key={r.name} className="flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-md flex items-center justify-center text-meta font-bold shrink-0" style={{ backgroundColor: '#eee8d5', color: INK }}>{r.name[0]}</span>
                    <span style={{ color: '#073642' }}>{r.name}</span>
                    <span className="text-meta hidden sm:inline" style={{ color: MUTED }}>{r.note}</span>
                    <span className="ml-auto text-meta" style={{ color: r.ok ? MUTED : ACCENT }}>{r.ok ? "on track" : "overloaded"}</span>
                  </div>
                ))}
                <div className="ml-8 pl-4 space-y-2" style={{ borderLeft: `1px dashed ${MUTED}` }}>
                  {["Paid lead", "Organic lead"].map((name) => (
                    <div key={name} className="flex items-center gap-2.5 rounded-md px-2 py-1" style={{ border: `1px dashed ${MUTED}`, color: BODY }}>
                      <span>+ {name}</span>
                      <span className="ml-auto text-meta" style={{ color: MUTED }}>proposed</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-lg p-5 -mt-3 ml-6 sm:ml-12 relative" style={{ backgroundColor: '#fffbee', border: `1px solid #d6cfb8`, boxShadow: '0 12px 30px -18px rgba(0,43,54,0.35)' }}>
              <div className="text-meta mb-2" style={{ color: MUTED }}>Head of People proposes</div>
              <p className="text-[14px] mb-1.5" style={{ color: INK }}>Split Growth into Paid and Organic</p>
              <p className="text-[12px] leading-relaxed mb-3" style={{ ...SANS, color: BODY }}>
                More reached the growth lead this week than one role can answer, and most of it was ad spend.
                Three sessions move to the paid lead. Nothing changes until you accept.
              </p>
              <div className="flex gap-2 text-[12px]">
                <span className="px-3 py-1 rounded" style={{ backgroundColor: INK, color: '#fdf6e3' }}>Accept</span>
                <span className="px-3 py-1 rounded" style={{ border: '1px solid #d6cfb8', color: BODY }}>Skip</span>
                <span className="px-3 py-1 rounded" style={{ border: '1px solid #d6cfb8', color: BODY }}>Ask</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Facts */}
      <section className="py-12" style={{ borderTop: `1px solid ${RULE}`, borderBottom: `1px solid ${RULE}` }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <StatCard value={String(AGENTS.length)} label="Agents that join today" />
            <StatCard value="Web · Mac · iOS" label="Plus the CLI" />
            <StatCard value="MIT" label="Open source, self-hostable" />
            <StatCard value="$0" label="Free for individuals" />
          </div>
        </div>
      </section>

      {/* Security & Privacy */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-12">
          <div>
            <h2 className="text-3xl font-bold mb-4 font-mono tracking-tight" style={{ color: INK }}>
              Your code stays yours
            </h2>
            <p className="text-lg leading-relaxed mb-6" style={{ color: BODY }}>
              The CLI daemon runs locally. Code stays on your machine unless you share it. We never train AI
              on your data, and you can self-host the whole thing.
            </p>
            <ArrowLink href="/security">How security works</ArrowLink>
          </div>
          <dl className="grid sm:grid-cols-2 gap-px rounded-lg overflow-hidden self-start" style={{ backgroundColor: RULE, border: `1px solid ${RULE}` }}>
            {[
              ["Private by default", "Conversations start private. You choose what to share."],
              ["Metadata only", "Code content syncs only if you turn it on."],
              ["Secret redaction", "API keys and tokens are stripped before sync."],
              ["Self-hostable", "Run the backend on your own infrastructure."],
              ["Open source", "Audit the code yourself. MIT license."],
              ["No AI training", "Nothing you sync trains a model."],
            ].map(([term, detail]) => (
              <div key={term} className="p-5" style={{ backgroundColor: '#fdf6e3' }}>
                <dt className="font-mono font-semibold text-sm mb-1" style={{ color: INK }}>{term}</dt>
                <dd className="text-sm" style={{ color: BODY }}>{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-6xl mx-auto px-6 pb-20">
        <div className="rounded-lg px-8 py-12 sm:px-12 grid md:grid-cols-[minmax(0,1fr)_auto] gap-8 items-center" style={{ backgroundColor: INK }}>
          <div>
            <h2 className="text-3xl font-bold mb-3 font-mono tracking-tight" style={{ color: '#fdf6e3' }}>
              Start with the agents you already run
            </h2>
            <p className="text-lg" style={{ color: MUTED }}>
              Free for individuals. Install the CLI and your sessions show up in about 30 seconds.
            </p>
            <div className="mt-6 inline-block rounded-md px-4 py-2.5 font-mono text-sm" style={{ backgroundColor: '#073642', border: '1px solid #586e75', color: '#eee8d5' }}>
              <span style={{ color: '#586e75' }}>$ </span>curl -fsSL codecast.sh/install | sh
            </div>
          </div>
          <div className="flex flex-col sm:flex-row md:flex-col gap-3">
            <Button asChild size="lg" className="bg-[#fdf6e3] text-[#002b36] hover:bg-[#eee8d5] text-base px-8 h-12 font-semibold">
              <Link href="/signup">Get started free</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="border-[#586e75] bg-transparent text-[#eee8d5] hover:bg-[#073642] hover:text-white text-base px-8 h-12 font-medium">
              <Link href="https://github.com/codecast-sh/codecast" target="_blank">View on GitHub</Link>
            </Button>
          </div>
        </div>
      </section>
      </div>
    </main>
  );
}
