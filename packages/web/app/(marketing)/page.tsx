"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useRef } from "react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/components/ui/button";
import { InstallTabs } from "@/components/install-tabs";
import { Logo, LogoIcon } from "@/components/Logo";

const TYPING_PHRASES = [
  "watching your agent debug a 500 error",
  "sharing how you built that feature",
  "picking up where your teammate left off",
  "searching 'how did we implement auth?'",
];

function TypingEffect() {
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  useEffect(() => {
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
    <span className="text-amber-600">
      {TYPING_PHRASES[phraseIndex].slice(0, charIndex)}
      <span className="animate-pulse">|</span>
    </span>
  );
}

function LiveIndicator() {
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/30 text-green-600 text-xs font-mono">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-500 opacity-75"></span>
        <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
      </span>
      LIVE
    </span>
  );
}

function ConversationDemo() {
  const messages = [
    { type: "user", text: "add dark mode to the settings page", time: "2:34 PM" },
    { type: "tool", name: "Read", file: "src/pages/Settings.tsx" },
    { type: "tool", name: "Edit", file: "src/pages/Settings.tsx", badge: "+47 -12" },
    { type: "tool", name: "Edit", file: "src/styles/theme.css", badge: "+23 -0" },
    { type: "assistant", text: "Added dark mode toggle to Settings. The theme persists to localStorage and syncs with system preferences.", time: "2:35 PM" },
    { type: "user", text: "nice, now run the tests", time: "2:35 PM" },
    { type: "tool", name: "Bash", command: "npm test", result: "42 passed", status: "success" },
  ];

  return (
    <div className="relative">
      <div className="absolute -inset-4 bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-red-500/20 rounded-2xl blur-xl opacity-50"></div>
      <div className="relative bg-[#002b36] rounded-xl border border-[#094959] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2.5 bg-[#073642] border-b border-[#094959]">
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5">
              <div className="w-3 h-3 rounded-full bg-[#dc322f]"></div>
              <div className="w-3 h-3 rounded-full bg-[#b58900]"></div>
              <div className="w-3 h-3 rounded-full bg-[#859900]"></div>
            </div>
            <LogoIcon size={14} className="text-[#586e75] ml-2" />
            <span className="text-xs font-mono text-[#586e75] ml-1">codecast</span>
          </div>
          <LiveIndicator />
        </div>

        <div className="p-4 space-y-3 font-mono text-sm max-h-[400px] overflow-hidden">
          {messages.map((msg, i) => (
            <div
              key={i}
              className="animate-fadeIn"
              style={{ animationDelay: `${i * 150}ms` }}
            >
              {msg.type === "user" && (
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded bg-[#268bd2] flex items-center justify-center text-xs text-white font-bold shrink-0">U</div>
                  <div className="flex-1">
                    <p className="text-[#93a1a1]">{msg.text}</p>
                    <p className="text-xs text-[#586e75] mt-0.5">{msg.time}</p>
                  </div>
                </div>
              )}
              {msg.type === "tool" && (
                <div className="ml-9 flex items-center gap-2 text-xs">
                  <span className={`px-1.5 py-0.5 rounded font-medium ${
                    msg.name === "Read" ? "bg-[#2aa198]/20 text-[#2aa198]" :
                    msg.name === "Edit" ? "bg-[#b58900]/20 text-[#b58900]" :
                    "bg-[#6c71c4]/20 text-[#6c71c4]"
                  }`}>{msg.name}</span>
                  <span className="text-[#657b83]">{msg.file || msg.command}</span>
                  {msg.badge && <span className="text-[#859900]">{msg.badge}</span>}
                  {msg.result && <span className="text-[#859900]">{msg.result}</span>}
                </div>
              )}
              {msg.type === "assistant" && (
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded bg-[#cb4b16] flex items-center justify-center text-xs text-white font-bold shrink-0">C</div>
                  <div className="flex-1">
                    <p className="text-[#eee8d5]">{msg.text}</p>
                    <p className="text-xs text-[#586e75] mt-0.5">{msg.time}</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="text-center">
      <div className="text-3xl font-bold text-stone-900 font-mono">{value}</div>
      <div className="text-sm text-stone-500 mt-1">{label}</div>
    </div>
  );
}

export default function LandingPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/dashboard");
    }
  }, [isAuthenticated, isLoading, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center">
        <div className="text-stone-400 font-mono">Loading...</div>
      </div>
    );
  }

  if (isAuthenticated) {
    return null;
  }

  return (
    <main className="min-h-screen bg-stone-50 w-full">
      {/* Nav */}
      <nav className="border-b border-stone-200 bg-stone-50/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Logo size="md" className="text-stone-900" />
          <div className="flex items-center gap-3">
            <Link href="/login">
              <Button variant="ghost" className="text-stone-600 hover:text-stone-900 hover:bg-stone-100 font-medium">
                Sign in
              </Button>
            </Link>
            <Link href="/signup">
              <Button className="bg-stone-900 text-white hover:bg-stone-800 font-medium">
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-8">
        <div className="text-center max-w-3xl mx-auto">
          <Link href="#mobile-app" className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium mb-6 hover:bg-amber-100 transition-colors">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-500 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
            </span>
            Now with Mobile App
          </Link>

          <h1 className="text-5xl md:text-6xl font-bold text-stone-900 leading-[1.1] tracking-tight mb-6">
            Your AI coding sessions,<br />
            <span className="text-stone-400">accessible everywhere</span>
          </h1>

          <p className="text-xl text-stone-600 leading-relaxed mb-4 max-w-2xl mx-auto">
            Real-time sync for Claude Code. Watch your agent work from any device,
            share sessions with your team, search through your AI coding history.
          </p>

          <p className="text-lg text-stone-500 mb-8 font-mono min-h-[28px]">
            Imagine <TypingEffect />
          </p>

          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center mb-8">
            <Link href="/signup">
              <Button size="lg" className="bg-stone-900 text-white hover:bg-stone-800 text-base px-8 h-12 font-medium">
                Start syncing free
              </Button>
            </Link>
            <Link href="#how-it-works">
              <Button size="lg" variant="outline" className="border-stone-300 bg-transparent text-stone-700 hover:bg-stone-100 hover:text-stone-900 text-base px-8 h-12 font-medium">
                See how it works
              </Button>
            </Link>
          </div>

          <div className="mb-12">
            <InstallTabs />
          </div>
        </div>
      </section>

      {/* Demo */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <ConversationDemo />
      </section>

      {/* Stats */}
      <section className="border-y border-stone-200 bg-white py-12">
        <div className="max-w-4xl mx-auto px-6">
          <div className="grid grid-cols-3 gap-8">
            <StatCard value="12K+" label="Sessions synced" />
            <StatCard value="<50ms" label="Sync latency" />
            <StatCard value="100%" label="Private by default" />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how-it-works" className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold text-stone-900 mb-4">
            Three steps to team-wide visibility
          </h2>
          <p className="text-lg text-stone-500 max-w-2xl mx-auto">
            Install the CLI, start coding with Claude, and watch your sessions sync automatically.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          <div className="relative">
            <div className="absolute -left-4 -top-4 w-12 h-12 rounded-full bg-stone-900 text-white flex items-center justify-center font-mono font-bold text-lg">1</div>
            <div className="bg-white rounded-xl border border-stone-200 p-6 pt-10 h-full">
              <div className="font-mono text-sm text-stone-400 mb-2">$ curl codecast.sh/install | sh</div>
              <h3 className="text-xl font-semibold text-stone-900 mb-2">Install the CLI</h3>
              <p className="text-stone-500">
                One command. No configuration needed. The daemon runs quietly in the background.
              </p>
            </div>
          </div>

          <div className="relative">
            <div className="absolute -left-4 -top-4 w-12 h-12 rounded-full bg-stone-900 text-white flex items-center justify-center font-mono font-bold text-lg">2</div>
            <div className="bg-white rounded-xl border border-stone-200 p-6 pt-10 h-full">
              <div className="font-mono text-sm text-stone-400 mb-2">$ claude</div>
              <h3 className="text-xl font-semibold text-stone-900 mb-2">Code with Claude</h3>
              <p className="text-stone-500">
                Use Claude Code as normal. Every conversation syncs in real-time to your dashboard.
              </p>
            </div>
          </div>

          <div className="relative">
            <div className="absolute -left-4 -top-4 w-12 h-12 rounded-full bg-stone-900 text-white flex items-center justify-center font-mono font-bold text-lg">3</div>
            <div className="bg-white rounded-xl border border-stone-200 p-6 pt-10 h-full">
              <div className="font-mono text-sm text-amber-600 mb-2">codecast.sh/team/...</div>
              <h3 className="text-xl font-semibold text-stone-900 mb-2">Share &amp; search</h3>
              <p className="text-stone-500">
                Access sessions from any device. Share with teammates. Search your AI coding history.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="bg-stone-900 text-white py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="grid md:grid-cols-2 gap-16 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-6">
                Built for developers who ship fast
              </h2>
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg mb-1">Real-time sync</h3>
                    <p className="text-stone-400">Watch your agent work from anywhere. Send messages, approve changes, and keep coding from your phone or tablet.</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg mb-1">Team collaboration</h3>
                    <p className="text-stone-400">See what your teammates are building. Pick up where they left off. Learn from their debugging sessions.</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg mb-1">Searchable history</h3>
                    <p className="text-stone-400">&quot;How did we implement that API?&quot; Search across all conversations, tool calls, and file changes.</p>
                  </div>
                </div>

                <div className="flex gap-4">
                  <div className="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg mb-1">Agent memory</h3>
                    <p className="text-stone-400">Give your AI agent persistent memory across sessions. It can search past conversations to recall context and decisions.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#073642] rounded-xl p-6 font-mono text-sm">
              <div className="text-[#586e75] mb-4"># Your team&apos;s recent sessions</div>
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="text-green-400">●</span>
                  <span className="text-[#93a1a1]">sarah</span>
                  <span className="text-[#586e75]">implementing OAuth flow</span>
                  <span className="text-[#586e75] ml-auto">2m ago</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-green-400">●</span>
                  <span className="text-[#93a1a1]">mike</span>
                  <span className="text-[#586e75]">debugging payment webhook</span>
                  <span className="text-[#586e75] ml-auto">5m ago</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[#586e75]">○</span>
                  <span className="text-[#93a1a1]">alex</span>
                  <span className="text-[#586e75]">added rate limiting middleware</span>
                  <span className="text-[#586e75] ml-auto">1h ago</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-[#586e75]">○</span>
                  <span className="text-[#93a1a1]">you</span>
                  <span className="text-[#586e75]">refactored user service</span>
                  <span className="text-[#586e75] ml-auto">3h ago</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Privacy */}
      <section className="max-w-4xl mx-auto px-6 py-20">
        <div className="bg-gradient-to-br from-stone-100 to-stone-50 rounded-2xl border border-stone-200 p-12 text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-green-700 text-sm font-medium mb-6">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Privacy-first
          </div>
          <h2 className="text-3xl font-bold text-stone-900 mb-4">
            Your code stays yours
          </h2>
          <p className="text-lg text-stone-600 leading-relaxed mb-8 max-w-2xl mx-auto">
            The CLI daemon runs locally and syncs only conversation metadata by default.
            You control exactly what gets shared. Self-host if you want complete control.
          </p>
          <div className="flex flex-wrap gap-4 justify-center text-sm">
            <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-stone-200 text-stone-600">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Opt-in code sharing
            </span>
            <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-stone-200 text-stone-600">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Self-hostable
            </span>
            <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-stone-200 text-stone-600">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              Open source
            </span>
          </div>
        </div>
      </section>

      {/* Mobile App */}
      <section id="mobile-app" className="max-w-6xl mx-auto px-6 py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium mb-4">
              iOS & Android
            </div>
            <h2 className="text-3xl font-bold text-stone-900 mb-4">
              Code on the go
            </h2>
            <p className="text-lg text-stone-600 leading-relaxed mb-6">
              Your AI coding sessions, always in your pocket. Watch your agent work in real-time,
              send messages, review changes, and keep projects moving from anywhere.
            </p>
            <ul className="space-y-3 text-stone-600 mb-8">
              <li className="flex items-center gap-3">
                <svg className="w-5 h-5 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Live session streaming with push notifications
              </li>
              <li className="flex items-center gap-3">
                <svg className="w-5 h-5 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Send messages and prompts to your agent
              </li>
              <li className="flex items-center gap-3">
                <svg className="w-5 h-5 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Review diffs and approve changes remotely
              </li>
              <li className="flex items-center gap-3">
                <svg className="w-5 h-5 text-green-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Search your full session history
              </li>
            </ul>
            <div className="flex gap-3">
              <a href="https://apps.apple.com/app/codecast" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 text-white rounded-lg hover:bg-stone-800 transition-colors font-medium">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                </svg>
                App Store
              </a>
              <a href="https://play.google.com/store/apps/details?id=sh.codecast" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 text-white rounded-lg hover:bg-stone-800 transition-colors font-medium">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 010 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.802 8.99l-2.303 2.303-8.635-8.635z"/>
                </svg>
                Play Store
              </a>
            </div>
          </div>
          <div className="relative">
            <div className="absolute -inset-4 bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-red-500/10 rounded-3xl blur-2xl"></div>
            <div className="relative bg-stone-900 rounded-[2.5rem] p-3 shadow-2xl max-w-[280px] mx-auto">
              <div className="bg-[#002b36] rounded-[2rem] overflow-hidden">
                <div className="h-6 bg-stone-900 flex items-center justify-center">
                  <div className="w-20 h-4 bg-stone-800 rounded-full"></div>
                </div>
                <div className="p-4 space-y-3 font-mono text-xs">
                  <div className="flex items-center gap-2 text-[#586e75]">
                    <span className="text-green-400">●</span>
                    <span>Live session</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="w-5 h-5 rounded bg-[#268bd2] flex items-center justify-center text-[10px] text-white font-bold shrink-0">U</div>
                    <p className="text-[#93a1a1] text-[11px]">add tests for the auth module</p>
                  </div>
                  <div className="ml-7 flex items-center gap-1.5 text-[10px]">
                    <span className="px-1 py-0.5 rounded bg-[#b58900]/20 text-[#b58900]">Edit</span>
                    <span className="text-[#657b83]">auth.test.ts</span>
                    <span className="text-[#859900]">+84</span>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="w-5 h-5 rounded bg-[#cb4b16] flex items-center justify-center text-[10px] text-white font-bold shrink-0">C</div>
                    <p className="text-[#eee8d5] text-[11px]">Added 12 test cases covering login, logout, and token refresh.</p>
                  </div>
                </div>
                <div className="p-3 border-t border-[#094959]">
                  <div className="bg-[#073642] rounded-lg px-3 py-2 text-[11px] text-[#586e75]">
                    Send a message...
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="bg-stone-900 rounded-2xl p-12 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Ready to see what your AI has been up to?
          </h2>
          <p className="text-lg text-stone-400 mb-8 max-w-xl mx-auto">
            Get started in 30 seconds. Free for individuals.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup">
              <Button size="lg" className="bg-white text-stone-900 hover:bg-stone-100 text-base px-8 h-12 font-medium">
                Start syncing free
              </Button>
            </Link>
            <Link href="https://github.com/codecast-sh" target="_blank">
              <Button size="lg" variant="outline" className="border-stone-600 bg-transparent text-white hover:bg-stone-800 hover:text-white text-base px-8 h-12 font-medium">
                View on GitHub
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-stone-200 bg-white">
        <div className="max-w-6xl mx-auto px-6 py-12">
          <div className="grid md:grid-cols-4 gap-8">
            <div>
              <Logo size="md" className="text-stone-900 mb-4" />
              <p className="text-sm text-stone-500">
                Real-time sync for AI coding sessions.
              </p>
            </div>
            <div>
              <h4 className="font-semibold text-stone-900 mb-3 text-sm">Product</h4>
              <ul className="space-y-2 text-sm text-stone-500">
                <li><Link href="#how-it-works" className="hover:text-stone-900">How it works</Link></li>
                <li><Link href="/pricing" className="hover:text-stone-900">Pricing</Link></li>
                <li><Link href="/docs" className="hover:text-stone-900">Documentation</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-stone-900 mb-3 text-sm">Company</h4>
              <ul className="space-y-2 text-sm text-stone-500">
                <li><Link href="/about" className="hover:text-stone-900">About</Link></li>
                <li><Link href="/blog" className="hover:text-stone-900">Blog</Link></li>
                <li><Link href="/privacy" className="hover:text-stone-900">Privacy</Link></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold text-stone-900 mb-3 text-sm">Connect</h4>
              <ul className="space-y-2 text-sm text-stone-500">
                <li><a href="https://github.com/codecast-sh" className="hover:text-stone-900" target="_blank" rel="noopener noreferrer">GitHub</a></li>
                <li><a href="https://x.com/codecastsh" className="hover:text-stone-900" target="_blank" rel="noopener noreferrer">Twitter</a></li>
                <li><a href="https://discord.gg/codecast" className="hover:text-stone-900" target="_blank" rel="noopener noreferrer">Discord</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-stone-200 mt-8 pt-8 text-center text-sm text-stone-400">
            &copy; 2025 Codecast
          </div>
        </div>
      </footer>
    </main>
  );
}
