"use client";

import Link from "next/link";
import { AssistantWayIn } from "../../components/simple/AssistantWayIn";
import { ForEveryone } from "../../components/marketing/ForEveryone";
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
import { AppBadges, AppleIcon } from "@/components/marketing/AppBadges";
import { TourSection, WatchChapter } from "./TourFilm";
import { SUITE } from "./suite";
import { earlyAccessMailto } from "@/lib/siteLinks";

function Highlight({ children, color }: { children: React.ReactNode; color: "amber" | "green" | "blue" | "rose" | "violet" | "cyan" }) {
  const colors: Record<string, string> = {
    amber: "bg-[#b58900]/30",
    green: "bg-[#859900]/30",
    blue: "bg-[#268bd2]/30",
    rose: "bg-[#d33682]/30",
    violet: "bg-[#6c71c4]/30",
    cyan: "bg-[#2aa198]/30",
  };
  const transforms: Record<string, { rotate: number; translate: string }> = {
    amber: { rotate: -2.1, translate: "-2px, 1px" },
    green: { rotate: 1.8, translate: "1px, -2px" },
    blue: { rotate: -1.5, translate: "2px, 1px" },
    rose: { rotate: 2.2, translate: "-1px, -1px" },
    violet: { rotate: -1.8, translate: "1px, 1px" },
    cyan: { rotate: 1.6, translate: "-2px, -1px" },
  };
  const t = transforms[color];
  return (
    <span className="relative inline-block">
      <span
        className={`absolute inset-0 ${colors[color]}`}
        style={{
          transform: `rotate(${t.rotate}deg) translate(${t.translate})`,
          top: "-0.28em",
          bottom: "-0.25em",
          left: "-0.4em",
          right: "-0.4em",
          clipPath: "polygon(1% 8%, 99% 2%, 98% 94%, 2% 97%)",
        }}
      />
      <span className="relative">{children}</span>
    </span>
  );
}

const TYPING_PHRASES = [
  "a call's action items filed as tasks, each linked to the line that was said",
  "an agent fixing the review comments on its own pull request",
  "mentioning a session in #eng and getting the answer from the agent that wrote the code",
  "approving a migration from your phone while three agents keep going",
  "asking the team's history how auth works, across every agent",
  "a Codex session handing the API half of a plan to a Cursor session",
];

const PLATFORM_CHIPS = [
  { label: "Web", href: "/signup", color: "#268bd2" },
  { label: "Mac", href: "/download", color: "#2aa198" },
  { label: "iOS", href: "https://apps.apple.com/app/id6757820850", color: "#b58900", external: true },
  { label: "CLI", href: "/features", color: "#6c71c4" },
];

function TypingEffect() {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  useWatchEffect(() => {
    const phrase = TYPING_PHRASES[phraseIndex];

    if (isPaused) {
      const pauseTimeout = setTimeout(() => {
        setIsPaused(false);
        setIsDeleting(true);
      }, 2000);
      return () => clearTimeout(pauseTimeout);
    }

    if (isDeleting) {
      if (charIndex === 0) {
        setIsDeleting(false);
        setPhraseIndex((prev) => (prev + 1) % TYPING_PHRASES.length);
        return;
      }
      const deleteTimeout = setTimeout(() => {
        setCharIndex((prev) => prev - 1);
      }, 30);
      return () => clearTimeout(deleteTimeout);
    }

    if (charIndex === phrase.length) {
      setIsPaused(true);
      return;
    }

    const typeTimeout = setTimeout(() => {
      setCharIndex((prev) => prev + 1);
    }, 50);
    return () => clearTimeout(typeTimeout);
  }, [charIndex, isDeleting, isPaused, phraseIndex]);

  return (
    <span style={{ color: '#cb4b16' }}>
      {TYPING_PHRASES[phraseIndex].slice(0, charIndex)}
      <span className="animate-pulse">|</span>
    </span>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="text-3xl font-bold font-mono" style={{ color: '#002b36' }}>{value}</div>
      <div className="text-sm mt-1" style={{ color: '#657b83' }}>{label}</div>
    </div>
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

  // The root is the marketing site for every browser, signed in or not (the
  // nav offers "Open app"). Only the desktop shell never shows it: a build
  // that boots at the site root is routed on to the app or the sign-in here.
  // Signed in again after a moment that only looked signed out: back to the
  // page AuthGuard left (lib/authReturn), never the marketing page.
  useWatchEffect(() => {
    if (!localAuthed) return;
    const back = takeAuthReturn();
    if (back) router.replace(back);
  }, [localAuthed, router]);

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

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: '#fdf6e3' }}>
      <MarketingNav active="/" />

      {/* Hero: the headline, the pitch and the install strip, then the film, then the ways in. */}
      <section className="mx-auto px-6 pt-6 pb-6">
        <div className="text-center max-w-3xl mx-auto">
          {/* One line from 1280px up, two balanced lines below it. */}
          <h1 className="font-mono font-bold text-[32px] sm:text-[40px] lg:text-[44px] leading-[1.12] tracking-[-0.035em] mb-5 [text-wrap:balance] xl:whitespace-nowrap xl:-mx-56" style={{ color: '#002b36' }}>
            Run your team and <Highlight color="amber">its agents</Highlight> in one workspace<span aria-hidden className="inline-block w-[0.48em] h-[0.8em] ml-[0.14em] align-baseline translate-y-[0.08em] motion-safe:animate-pulse" style={{ backgroundColor: '#cb4b16' }} />
            <span className="block mt-3 font-normal text-lg sm:text-[21px] tracking-normal whitespace-normal" style={{ color: '#657b83' }}>Raise your AI army. Stay in command.</span>
          </h1>

          <p className="text-[15px] leading-relaxed mb-4 lg:-mx-24" style={{ color: '#657b83' }}>
            Chat, calls, tasks, docs, pull requests and decisions, with <span className="whitespace-nowrap"><Highlight color="amber">Claude Code</Highlight>,</span> <span className="whitespace-nowrap"><Highlight color="green">Codex</Highlight>,</span> <span className="whitespace-nowrap"><Highlight color="blue">Cursor</Highlight>,</span> <Highlight color="violet">OpenCode</Highlight> and <Highlight color="cyan">pi</Highlight> as teammates in every one. Everything links back to the session that did it.
          </p>
          {/* The second path, in the first screen and above the install
              command: a visitor who does not write code meets their way in
              before a terminal line that is not for them. */}
          <div className="mb-4 flex justify-center">
            <AssistantWayIn location="landing_top" tone="marketing" compact />
          </div>
          <div className="max-w-xl mx-auto mb-2">
            <div className="relative">
              <div className="absolute -inset-2 bg-gradient-to-r from-[#b58900]/25 via-[#cb4b16]/25 to-[#dc322f]/25 rounded-2xl blur-lg opacity-60"></div>
              <div className="relative">
                <InstallTabs location="landing_hero" showAlternatives={false} compact />
              </div>
            </div>
            <p className="mt-2 text-xs" style={{ color: '#93a1a1' }}>One command. Your agents join as they are.</p>
          </div>
        </div>
        {/* The first screen goes to the film: its width follows the viewport's height (about 170px of headline, 48px of pitch and 152px of install strip and the assistant's line above; on a short laptop screen the scrubber sits at the fold, so the windows stay readable; the buttons follow the film), between 640px and 1240px, and a phone gets the full width. */}
        <div className="relative mx-auto" style={{ width: "min(100%, clamp(640px, min(100vw - 96px, (100svh - 420px) * 1280 / 760), 1240px))" }}>
          <HeroFlythrough />
        </div>
        <div className="flex flex-wrap gap-3 justify-center items-center mt-8">
          <Link href="/signup">
            <Button className="text-[15px] px-6 h-11 font-semibold text-[#fdf6e3] border-0 transition-all hover:-translate-y-px hover:brightness-110" style={{ background: 'linear-gradient(135deg, #e86c5d 0%, #cb4b16 100%)', boxShadow: '0 6px 20px -6px rgba(203,75,22,0.55)' }}>
              Get started free
            </Button>
          </Link>
          <Link href="/download">
            <Button className="text-[15px] px-6 h-11 font-semibold gap-2 text-[#fdf6e3] border-0 transition-all hover:-translate-y-px hover:brightness-125" style={{ backgroundColor: '#002b36', boxShadow: '0 6px 20px -8px rgba(0,43,54,0.6)' }}>
              <AppleIcon className="w-4 h-4" />
              Download for Mac
            </Button>
          </Link>
          <Link href="#tour">
            <Button variant="outline" className="bg-transparent text-[15px] px-6 h-11 font-semibold gap-2 border-[#93a1a1] text-[#586e75] hover:bg-[#eee8d5] hover:text-[#002b36] transition-colors">
              <svg className="w-3 h-3" viewBox="0 0 10 10" fill="currentColor" aria-hidden><path d="M2 1.2v7.6a.6.6 0 0 0 .9.5l6.1-3.8a.6.6 0 0 0 0-1L2.9.7a.6.6 0 0 0-.9.5z" /></svg>
              Watch the tour
            </Button>
          </Link>
        </div>
      </section>

      <ForEveryone />

      {/* The page turns to developers here, said plainly, so a reader from
          the section above knows what follows is not for them. */}
      <p className="text-center text-[15px] pt-4" style={{ color: '#586e75' }}>
        For developers: one place for every coding agent you run.
      </p>

      <section className="max-w-6xl mx-auto px-6 pt-6 pb-20">
        <div className="text-center max-w-3xl mx-auto">
          <p className="text-lg mb-8 font-mono min-h-[28px]" style={{ color: '#586e75' }}>
            Imagine <TypingEffect />
          </p>

          <div className="flex flex-wrap gap-3 justify-center">
            {PLATFORM_CHIPS.map(({ label, href, color, external }) => {
              const chip = (
                <>
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }}></span>
                  <span className="tracking-wider font-mono text-[11px] uppercase font-medium">{label}</span>
                </>
              );
              const className = "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md transition-all hover:brightness-95";
              const style = { backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`, color };
              return external ? (
                <a key={label} href={href} onClick={() => track("ios_app_clicked", { location: "landing_chip" })} target="_blank" rel="noopener noreferrer" className={className} style={style}>{chip}</a>
              ) : (
                <Link key={label} href={href} className={className} style={style}>{chip}</Link>
              );
            })}
          </div>
        </div>
      </section>

      <TourSection />

      {/* ── The suite: one tile per surface ─────────────────────────────── */}
      <section id="suite" className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-12 max-w-3xl mx-auto">
          <h2 className="text-3xl sm:text-4xl font-bold mb-4 font-mono" style={{ color: '#002b36' }}>
            Everything your team works in. Agents included.
          </h2>
          <p className="text-lg leading-relaxed" style={{ color: '#657b83' }}>
            Not a chat app, a tracker, a docs tool and a terminal that never talk to each other.
            One workspace on one record, where agents use every surface the way people do.
          </p>
        </div>

        <div className="grid gap-px sm:grid-cols-2 lg:grid-cols-5 rounded-xl overflow-hidden" style={{ backgroundColor: '#e4ddc8', border: '1px solid #e4ddc8' }}>
          {SUITE.map(({ name, line, mark, color, chapter, early }) => (
            <div key={name} className="group relative flex flex-col p-5 transition-colors hover:bg-[#fffbee]" style={{ backgroundColor: '#fdf6e3' }}>
              <div className="flex items-center justify-between mb-4">
                <span className="w-9 h-9 rounded-lg flex items-center justify-center font-mono text-lg transition-transform group-hover:-rotate-6" style={{ backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`, color }} aria-hidden>{mark}</span>
                {early ? (
                  <a href="#org" className="font-mono text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded hover:brightness-95" style={{ color: '#6c71c4', backgroundColor: 'rgba(108,113,196,0.1)' }}>Early access</a>
                ) : chapter ? (
                  <WatchChapter title={chapter} compact />
                ) : null}
              </div>
              <h3 className="font-mono font-semibold mb-1.5" style={{ color: '#002b36' }}>{name}</h3>
              <p className="text-sm leading-relaxed" style={{ color: '#657b83' }}>{line}</p>
            </div>
          ))}
        </div>

        <p className="text-center text-sm mt-8 max-w-2xl mx-auto" style={{ color: '#93a1a1' }}>
          Around it: search across every session, fork a session to try two directions, switch agent or model mid-run,
          run agents on cloud hosts, and sync issues both ways with Linear and GitHub.
        </p>
      </section>

      {/* ── 1. Agents are members ──────────────────────────────────────── */}
      <section id="agents" className="text-white py-20" style={{ backgroundColor: '#002b36' }}>
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <div className="font-mono text-sm mb-4" style={{ color: '#268bd2' }}>01</div>
              <h2 className="text-3xl font-bold mb-5 font-mono" style={{ color: '#fdf6e3' }}>
                Agents are members, not a feature
              </h2>
              <p className="text-lg leading-relaxed mb-6" style={{ color: '#93a1a1' }}>
                Other tools put an AI button inside each app. Here the agent that wrote the code is the one
                answering in the thread, holding the task and fixing its own pull request, with the same verbs
                a person gets.
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
                    <span style={{ color: '#2aa198' }}>{verb}</span> <span style={{ color: '#839496' }}>{rest}</span>
                  </div>
                ))}
              </div>
              <p className="text-sm leading-relaxed" style={{ color: '#839496' }}>
                Claude Code, Codex, Cursor, OpenCode and pi, on your laptop or a cloud host.
                Your coding agents run on your own subscriptions: Codecast never resells their tokens.
              </p>
            </div>

            <div className="rounded-xl overflow-hidden font-mono text-sm" style={{ backgroundColor: '#073642' }} role="img" aria-label="A team channel where people and agent sessions talk in one thread">
              <div className="flex items-center gap-2 px-5 py-3" style={{ borderBottom: '1px solid #094959' }}>
                <span style={{ color: '#586e75' }}>#</span>
                <span style={{ color: '#eee8d5' }}>eng</span>
                <span className="ml-auto text-xs" style={{ color: '#586e75' }}>4 people, 3 agents</span>
              </div>
              <div className="p-5 space-y-4 text-[13px]">
                {[
                  { who: "sarah", kind: "person", color: "#268bd2", text: <>webhooks are failing for acme again. <span style={{ color: '#2aa198' }}>@jx7hero</span> can you take it?</> },
                  { who: "Retry failed webhooks", kind: "claude", color: "#cb4b16", text: <>On it. Split it: the API half went to a Codex session, the dashboard to Cursor. Filed as <span style={{ color: '#859900' }}>ct-482</span>.</> },
                  { who: "Webhook API half", kind: "codex", color: "#859900", text: <>Retry queue is in. PR <span style={{ color: '#2aa198' }}>#482</span> is open, CI green.</> },
                  { who: "Retry failed webhooks", kind: "claude", color: "#cb4b16", text: <>One call for a person: exponential or fixed backoff? Queued for <span style={{ color: '#b58900' }}>@ashot</span>.</> },
                ].map((m, i) => (
                  <div key={i} className="flex gap-3">
                    <div className="w-6 h-6 rounded flex items-center justify-center text-[11px] font-bold shrink-0" style={{ backgroundColor: m.color, color: '#fdf6e3' }}>{m.who[0].toUpperCase()}</div>
                    <div className="min-w-0">
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span style={{ color: '#eee8d5' }}>{m.who}</span>
                        <span className="text-[11px]" style={{ color: '#586e75' }}>{m.kind === "person" ? "" : m.kind}</span>
                      </div>
                      <p className="leading-relaxed" style={{ color: '#93a1a1' }}>{m.text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 2. Every piece of work traces back ─────────────────────────── */}
      <section id="remember" className="max-w-6xl mx-auto px-6 py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="font-mono text-sm mb-4" style={{ color: '#6c71c4' }}>02</div>
            <h2 className="text-3xl font-bold text-[#002b36] mb-4 font-mono">
              Every piece of work traces back to its session
            </h2>
            <p className="text-lg text-[#657b83] leading-relaxed mb-6">
              A line of code, a doc edit, a task, a decision, a published page: each one leads back to the
              conversation that produced it. The record spans every agent and every teammate, so the next
              session starts from the answer instead of a blank context.
            </p>
            <div className="-mt-1 mb-6"><WatchChapter title="Memory" /></div>
            <div className="space-y-3 mb-6">
              {[
                ["Search every session", 'cast search "auth"'],
                ["Ask the team's history", 'cast ask "how did we do auth?"'],
                ["Line to conversation", "cast blame src/auth.ts"],
              ].map(([label, cmd]) => (
                <div key={cmd} className="flex items-center gap-3 text-[#657b83]">
                  <svg className="w-5 h-5 text-[#6c71c4] shrink-0" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  <span>{label}: <code className="text-sm bg-[#eee8d5] px-1.5 py-0.5 rounded">{cmd}</code></span>
                </div>
              ))}
            </div>
            <Link href="/features" className="text-[#b58900] hover:text-[#cb4b16] font-medium flex items-center gap-1">
              Explore the CLI
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
              </svg>
            </Link>
          </div>

          <div className="bg-[#002b36] rounded-xl border border-[#094959] shadow-xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-[#073642] border-b border-[#094959]">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-[#dc322f]"></div>
                <div className="w-3 h-3 rounded-full bg-[#b58900]"></div>
                <div className="w-3 h-3 rounded-full bg-[#859900]"></div>
              </div>
              <span className="text-xs font-mono text-[#586e75] ml-2">Terminal</span>
            </div>
            <div className="p-4 font-mono text-sm space-y-3">
              <div>
                <span className="text-[#859900]">$</span>
                <span className="text-[#93a1a1]"> cast ask &quot;how did we implement auth?&quot;</span>
              </div>
              <div className="text-[#586e75] text-xs">
                Searching 3 relevant sessions...
              </div>
              <div className="border-l-2 border-[#6c71c4] pl-3 py-1">
                <div className="text-[#93a1a1] text-xs">
                  Found in <span className="text-[#b58900]">OAuth implementation</span> (3 days ago, sarah, codex):
                </div>
                <div className="text-[#657b83] text-xs mt-1">
                  We use NextAuth with GitHub provider, storing sessions in Convex...
                </div>
              </div>
              <div className="mt-3">
                <span className="text-[#859900]">$</span>
                <span className="text-[#93a1a1]"> cast blame src/auth/callback.ts:42</span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="text-[#93a1a1]">
                  <span className="text-[#b58900]">abc123</span> Fixed OAuth callback &bull; <span className="text-[#586e75]">codex &middot; sarah &middot; 2d ago</span>
                </div>
                <div className="text-[#586e75]">
                  &rarr; decided in message 41: &quot;refresh before the redirect, not after&quot;
                </div>
                <div className="text-[#586e75]">
                  &rarr; PR #377 &middot; task ct-212 &middot; doc &quot;Auth flow&quot;
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 3. People make the calls ───────────────────────────────────── */}
      <section id="anywhere" className="max-w-6xl mx-auto px-6 py-20" style={{ borderTop: '1px solid #eee8d5' }}>
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="font-mono text-sm mb-4" style={{ color: '#b58900' }}>03</div>
            <h2 className="text-3xl font-bold text-[#002b36] mb-4 font-mono">
              Built around your attention
            </h2>
            <p className="text-lg text-[#657b83] leading-relaxed mb-6">
              Twenty agents running should not mean twenty tabs to watch. The workspace shows you
              what needs a person and keeps everything else moving.
            </p>
            <div className="-mt-1 mb-6"><WatchChapter title="The inbox" /></div>
            <ul className="space-y-3 text-[#657b83] mb-8">
              {[
                "An inbox sorted by who acts next, across every agent and machine",
                "Decisions arrive as cards with the context to answer them cold",
                "Push notifications, and steering from web, desktop or phone",
                "Triggers and routines keep agents going overnight",
                "Roles keep their sessions out of your inbox until a lead needs you (early access)",
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <svg className="w-5 h-5 text-[#859900] shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                  </svg>
                  {item}
                </li>
              ))}
            </ul>
            <AppBadges location="landing" />
            <p className="text-sm text-[#657b83] mt-3">
              Native macOS and iOS apps available now. Android coming soon.
            </p>
          </div>
          <div className="relative">
            <div className="absolute -inset-4 bg-gradient-to-r from-[#b58900]/10 via-[#cb4b16]/10 to-[#dc322f]/10 rounded-3xl blur-2xl"></div>
            <PhoneFrame className="max-w-[280px] mx-auto">
                <div className="p-4 space-y-3 font-mono text-xs">
                  <div className="flex items-center gap-2 text-[#586e75]">
                    <span className="text-[#b58900]">◇</span>
                    <span>Decision &middot; Retry failed webhooks</span>
                  </div>
                  <p className="text-[#eee8d5] text-[13px] leading-snug">Exponential or fixed backoff?</p>
                  <p className="text-[#839496] text-[11px] leading-relaxed">
                    A fork tried both. Fixed backoff retried 40% faster but hammered acme&apos;s endpoint during their outage.
                  </p>
                  <div className="space-y-1.5 pt-1 text-[11px]">
                    <div className="px-2.5 py-1.5 rounded" style={{ backgroundColor: 'rgba(133,153,0,0.18)', color: '#859900' }}>Exponential, cap at 10 min</div>
                    <div className="px-2.5 py-1.5 rounded bg-[#073642] text-[#839496]">Fixed, every 30s</div>
                  </div>
                  <p className="text-[#586e75] text-[10px] pt-1">3 agents keep working while you decide</p>
                </div>
            </PhoneFrame>
          </div>
        </div>
      </section>

      {/* ── 4. The org: the next step ──────────────────────────────────── */}
      <section id="org" className="py-20" style={{ backgroundColor: 'rgba(108,113,196,0.07)', borderTop: '1px solid rgba(108,113,196,0.18)', borderBottom: '1px solid rgba(108,113,196,0.18)' }}>
        <div className="max-w-6xl mx-auto px-6 grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="flex items-center gap-3 font-mono text-sm mb-4" style={{ color: '#6c71c4' }}>
              <span>04</span>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(108,113,196,0.14)' }}>Next &middot; early access</span>
            </div>
            <h2 className="text-3xl font-bold text-[#002b36] mb-4 font-mono [text-wrap:balance]">
              From a team of agents to an org
            </h2>
            <p className="text-lg text-[#657b83] leading-relaxed mb-6">
              A session ends when its task does. A role stays. It is a standing agent that looks after
              one area: it checks on it every day, starts the sessions the work needs, and comes to you
              only with a decision that is yours.
            </p>
            <dl className="space-y-4 mb-8">
              {[
                ["Roles look after areas", "A release lead, a growth lead, an infra lead. Each has a brief and a daily check you can edit, pause or cancel, and its sessions stay out of your inbox."],
                ["A Head of People keeps the structure true", "It reviews the org every week and proposes small changes: a new lead, a split, a goal. You accept, skip or ask. It applies nothing on its own."],
                ["An Executive Assistant is your right hand", "It answers anything across your workspaces and routes the rest to the role that owns it."],
                ["Requests travel up the reporting line", "A stuck session asks its lead first. Only a lead that reports to you reaches you."],
              ].map(([term, detail]) => (
                <div key={term} className="pl-4" style={{ borderLeft: '2px solid rgba(108,113,196,0.45)' }}>
                  <dt className="font-mono font-semibold text-[15px]" style={{ color: '#002b36' }}>{term}</dt>
                  <dd className="text-sm leading-relaxed mt-1" style={{ color: '#657b83' }}>{detail}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-wrap items-center gap-4">
              <a href={earlyAccessMailto("Org")} onClick={() => track("early_access_requested", { what: "org", location: "landing" })}>
                <Button className="h-10 px-5 text-sm font-medium text-[#fdf6e3] bg-[#6c71c4] hover:bg-[#5a5fb0]">
                  Request early access
                </Button>
              </a>
              <span className="text-sm" style={{ color: '#93a1a1' }}>Running on our own teams today.</span>
            </div>
          </div>

          <div className="font-mono text-[13px]" role="img" aria-label="An org chart: you at the top, a Head of People, an Executive Assistant and two leads with their sessions, and a proposal to split one lead in two">
            <div className="rounded-xl p-5" style={{ backgroundColor: '#fdf6e3', border: '1px solid #e4ddc8' }}>
              <div className="flex items-center gap-2.5 mb-3">
                <span className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold" style={{ backgroundColor: '#268bd2', color: '#fdf6e3' }}>Y</span>
                <span style={{ color: '#002b36' }}>You</span>
              </div>
              <div className="ml-3.5 pl-5 space-y-2.5" style={{ borderLeft: '1px solid #d6cfb8' }}>
                {[
                  { name: "Head of People", note: "reviews the org weekly", status: "on track", color: "#6c71c4" },
                  { name: "Executive Assistant", note: "your right hand", status: "on track", color: "#2aa198" },
                  { name: "Release lead", note: "2 sessions", status: "on track", color: "#859900" },
                  { name: "Growth lead", note: "5 sessions", status: "overloaded", color: "#cb4b16" },
                ].map((r) => (
                  <div key={r.name} className="flex items-center gap-2.5">
                    <span className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-bold shrink-0" style={{ backgroundColor: `color-mix(in srgb, ${r.color} 16%, transparent)`, color: r.color }}>{r.name[0]}</span>
                    <span style={{ color: '#073642' }}>{r.name}</span>
                    <span className="text-[11px] hidden sm:inline" style={{ color: '#93a1a1' }}>{r.note}</span>
                    <span className="ml-auto text-[11px]" style={{ color: r.status === "on track" ? '#859900' : '#cb4b16' }}>{r.status}</span>
                  </div>
                ))}
                <div className="ml-8 pl-4 space-y-2" style={{ borderLeft: '1px dashed #6c71c4' }}>
                  {["Paid lead", "Organic lead"].map((name) => (
                    <div key={name} className="flex items-center gap-2.5 rounded-md px-2 py-1" style={{ border: '1px dashed rgba(108,113,196,0.6)', color: '#6c71c4' }}>
                      <span>+ {name}</span>
                      <span className="ml-auto text-[11px]">proposed</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-xl p-5 -mt-3 ml-6 sm:ml-12 relative shadow-lg" style={{ backgroundColor: '#fffbee', border: '1px solid rgba(108,113,196,0.45)' }}>
              <div className="text-[11px] mb-2" style={{ color: '#6c71c4' }}>Head of People proposes</div>
              <p className="text-[14px] mb-1.5" style={{ color: '#002b36' }}>Split Growth into Paid and Organic</p>
              <p className="text-[12px] leading-relaxed mb-3 font-sans" style={{ color: '#657b83' }}>
                More reached the growth lead this week than one role can answer, and most of it was ad spend.
                Three sessions move to the paid lead. Nothing changes until you accept.
              </p>
              <div className="flex gap-2 text-[12px]">
                <span className="px-3 py-1 rounded" style={{ backgroundColor: '#6c71c4', color: '#fdf6e3' }}>Accept</span>
                <span className="px-3 py-1 rounded" style={{ border: '1px solid #d6cfb8', color: '#586e75' }}>Skip</span>
                <span className="px-3 py-1 rounded" style={{ border: '1px solid #d6cfb8', color: '#586e75' }}>Ask</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="max-w-6xl mx-auto px-6 py-20" style={{ borderTop: '1px solid #eee8d5' }}>
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold mb-4 font-mono" style={{ color: '#002b36' }}>
            Up and running in three steps
          </h2>
          <p className="text-lg max-w-2xl mx-auto" style={{ color: '#657b83' }}>
            Install the CLI, keep running your agents the way you do now, and bring your team in.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {[
            { cmd: "$ curl codecast.sh/install | sh", cmdColor: "#93a1a1", title: "Install the CLI", body: "One command. A daemon runs quietly in the background and watches the real sessions on your machine." },
            { cmd: "$ claude / codex / cursor / opencode / pi", cmdColor: "#93a1a1", title: "Work with your agents", body: "Nothing to reconfigure. Every session joins the workspace live, with the tasks, docs and threads around it." },
            { cmd: "invite / assign / mention / decide", cmdColor: "#b58900", title: "Bring in your team", body: "Share what you choose. Teammates and their agents meet in the same channels, boards and pull requests." },
          ].map((step, i) => (
            <div key={step.title} className="relative">
              <div className="absolute -left-4 -top-4 w-12 h-12 rounded-full text-white flex items-center justify-center font-mono font-bold text-lg" style={{ backgroundColor: '#268bd2' }}>{i + 1}</div>
              <div className="rounded-xl p-6 pt-10 h-full" style={{ backgroundColor: '#fdf6e3', border: '1px solid #eee8d5' }}>
                <div className="font-mono text-sm mb-2" style={{ color: step.cmdColor }}>{step.cmd}</div>
                <h3 className="text-xl font-semibold mb-2 font-mono" style={{ color: '#002b36' }}>{step.title}</h3>
                <p style={{ color: '#657b83' }}>{step.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Honest facts */}
      <section className="py-12" style={{ borderTop: '1px solid #eee8d5', borderBottom: '1px solid #eee8d5', backgroundColor: '#eee8d5' }}>
        <div className="max-w-5xl mx-auto px-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <StatCard value="6" label="Agents that join today" />
            <StatCard value="Web · Mac · iOS" label="Plus the CLI" />
            <StatCard value="MIT" label="Open source, self-hostable" />
            <StatCard value="$0" label="Free for individuals" />
          </div>
        </div>
      </section>

      {/* Security & Privacy */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-md mb-6" style={{ backgroundColor: 'rgba(133,153,0,0.1)', color: '#859900' }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: '#859900' }}></span>
            <span className="tracking-wider font-mono text-[11px] uppercase font-medium">Privacy-first</span>
          </div>
          <h2 className="text-3xl font-bold text-[#002b36] mb-4 font-mono">
            Your code stays yours
          </h2>
          <p className="text-lg text-[#657b83] leading-relaxed max-w-2xl mx-auto">
            The CLI daemon runs locally. Code stays on your machine unless you explicitly share it.
            We never train AI on your data, and you can self-host for complete control.
          </p>
        </div>

        {/* Data Flow Visual */}
        <div className="bg-[#fdf6e3] rounded-xl border border-[#eee8d5] p-6 mb-8">
          <div className="flex flex-col md:flex-row items-center justify-center gap-4 md:gap-2 text-sm">
            <div className="flex items-center gap-2 px-4 py-2 bg-[#fdf6e3] rounded-lg border border-[#eee8d5]">
              <svg className="w-5 h-5 text-[#b58900]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span className="text-[#073642] font-medium">Your Machine</span>
            </div>
            <svg className="w-6 h-6 text-[#93a1a1] rotate-90 md:rotate-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div className="flex items-center gap-2 px-4 py-2 bg-[#fdf6e3] rounded-lg border border-[#eee8d5]">
              <svg className="w-5 h-5 text-[#268bd2]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span className="text-[#073642] font-medium">Encrypted Sync</span>
            </div>
            <svg className="w-6 h-6 text-[#93a1a1] rotate-90 md:rotate-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div className="flex items-center gap-2 px-4 py-2 bg-[#fdf6e3] rounded-lg border border-[#eee8d5]">
              <svg className="w-5 h-5 text-[#859900]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-[#073642] font-medium">Your Inbox</span>
            </div>
          </div>
          <p className="text-xs text-[#839496] text-center mt-4">
            Code content synced only if you enable it. Default: metadata only.
          </p>
        </div>

        {/* Security Features Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          <div className="bg-[#fdf6e3] rounded-xl border border-[#eee8d5] p-5">
            <div className="w-8 h-8 rounded-lg bg-[#b58900]/20 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-[#b58900]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h3 className="font-semibold text-[#002b36] text-sm mb-1">Private by default</h3>
            <p className="text-xs text-[#657b83]">Conversations start private. You choose what to share.</p>
          </div>

          <div className="bg-[#fdf6e3] rounded-xl border border-[#eee8d5] p-5">
            <div className="w-8 h-8 rounded-lg bg-[#dc322f]/20 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-[#dc322f]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            </div>
            <h3 className="font-semibold text-[#002b36] text-sm mb-1">Secret redaction</h3>
            <p className="text-xs text-[#657b83]">API keys and tokens stripped before sync.</p>
          </div>

          <div className="bg-[#fdf6e3] rounded-xl border border-[#eee8d5] p-5">
            <div className="w-8 h-8 rounded-lg bg-[#859900]/20 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-[#859900]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <h3 className="font-semibold text-[#002b36] text-sm mb-1">E2E encryption</h3>
            <p className="text-xs text-[#657b83]">AES-256-GCM client-side encryption option.</p>
          </div>

          <div className="bg-[#fdf6e3] rounded-xl border border-[#eee8d5] p-5">
            <div className="w-8 h-8 rounded-lg bg-[#268bd2]/20 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-[#268bd2]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
              </svg>
            </div>
            <h3 className="font-semibold text-[#002b36] text-sm mb-1">Path hashing</h3>
            <p className="text-xs text-[#657b83]">Project paths hashed to prevent leakage.</p>
          </div>

          <div className="bg-[#fdf6e3] rounded-xl border border-[#eee8d5] p-5">
            <div className="w-8 h-8 rounded-lg bg-[#6c71c4]/20 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-[#6c71c4]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
            <h3 className="font-semibold text-[#002b36] text-sm mb-1">Self-hostable</h3>
            <p className="text-xs text-[#657b83]">Deploy on your own infrastructure.</p>
          </div>

          <div className="bg-[#fdf6e3] rounded-xl border border-[#eee8d5] p-5">
            <div className="w-8 h-8 rounded-lg bg-[#2aa198]/20 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-[#2aa198]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </div>
            <h3 className="font-semibold text-[#002b36] text-sm mb-1">Open source</h3>
            <p className="text-xs text-[#657b83]">Audit the code yourself. MIT license.</p>
          </div>
        </div>

        {/* Trust badges + Learn more */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
          <div className="flex flex-wrap gap-3 justify-center">
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#fdf6e3] border border-[#eee8d5] text-[#657b83] text-sm">
              <svg className="w-4 h-4 text-[#859900]" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              No AI training
            </span>
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#fdf6e3] border border-[#eee8d5] text-[#657b83] text-sm">
              <svg className="w-4 h-4 text-[#859900]" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Self-hostable
            </span>
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#fdf6e3] border border-[#eee8d5] text-[#657b83] text-sm">
              <svg className="w-4 h-4 text-[#859900]" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              TLS 1.3
            </span>
          </div>
          <Link href="/security" className="text-[#b58900] hover:text-[#cb4b16] font-medium text-sm flex items-center gap-1">
            Learn more about security
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </Link>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="bg-[#002b36] rounded-2xl p-12 text-center">
          <h2 className="text-3xl font-bold text-white mb-4 font-mono">
            Bring your agents to work
          </h2>
          <p className="text-lg text-[#839496] mb-8 max-w-xl mx-auto">
            One workspace for your team and every agent it runs.
            Any agent, any machine. Free for individuals. 30 seconds to install.
          </p>
          <div className="inline-block rounded-lg px-5 py-3 mb-8 font-mono text-base text-[#eee8d5]" style={{ backgroundColor: '#073642', border: '1px solid #586e75' }}>
            <span className="text-[#586e75]">$ </span>curl -fsSL codecast.sh/install | sh
          </div>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup">
              <Button size="lg" className="bg-[#fdf6e3] text-[#002b36] hover:bg-[#eee8d5] text-base px-8 h-12 font-medium">
                Get started free
              </Button>
            </Link>
            <Link href="https://github.com/codecast-sh/codecast" target="_blank">
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
