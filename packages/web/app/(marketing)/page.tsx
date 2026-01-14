"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
            <Link href="/features" className="text-stone-600 hover:text-stone-900 font-medium text-sm px-3 py-1.5 hidden sm:block">
              CLI
            </Link>
            <Link href="/security" className="text-stone-600 hover:text-stone-900 font-medium text-sm px-3 py-1.5 hidden sm:block">
              Security
            </Link>
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

      {/* CLI Features */}
      <section id="cli" className="max-w-6xl mx-auto px-6 py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <Link href="/features" className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-50 border border-purple-200 text-purple-700 text-sm font-medium mb-4 hover:bg-purple-100 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              Powerful CLI
            </Link>
            <h2 className="text-3xl font-bold text-stone-900 mb-4">
              Your AI agent, with a memory
            </h2>
            <p className="text-lg text-stone-600 leading-relaxed mb-6">
              The codecast CLI gives your AI agent persistent memory across sessions.
              Search past conversations, resume work, track architectural decisions,
              and let your agent learn from its own history.
            </p>
            <div className="space-y-3 mb-6">
              <div className="flex items-center gap-3 text-stone-600">
                <svg className="w-5 h-5 text-purple-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span>Search history like ripgrep: <code className="text-sm bg-stone-100 px-1.5 py-0.5 rounded">codecast search &quot;auth&quot;</code></span>
              </div>
              <div className="flex items-center gap-3 text-stone-600">
                <svg className="w-5 h-5 text-purple-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span>Resume sessions: <code className="text-sm bg-stone-100 px-1.5 py-0.5 rounded">codecast resume &quot;logo&quot;</code></span>
              </div>
              <div className="flex items-center gap-3 text-stone-600">
                <svg className="w-5 h-5 text-purple-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span>Track decisions: <code className="text-sm bg-stone-100 px-1.5 py-0.5 rounded">codecast decisions add &quot;Use Convex&quot;</code></span>
              </div>
              <div className="flex items-center gap-3 text-stone-600">
                <svg className="w-5 h-5 text-purple-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span>File blame: <code className="text-sm bg-stone-100 px-1.5 py-0.5 rounded">codecast blame src/auth.ts</code></span>
              </div>
            </div>
            <Link href="/features" className="text-amber-600 hover:text-amber-700 font-medium flex items-center gap-1">
              Explore all CLI features
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
                <span className="text-[#93a1a1]"> codecast ask &quot;how did we implement auth?&quot;</span>
              </div>
              <div className="text-[#586e75] text-xs">
                Searching 3 relevant sessions...
              </div>
              <div className="border-l-2 border-[#6c71c4] pl-3 py-1">
                <div className="text-[#93a1a1] text-xs">
                  Found in <span className="text-[#b58900]">OAuth implementation</span> (3 days ago):
                </div>
                <div className="text-[#657b83] text-xs mt-1">
                  We use NextAuth with GitHub provider, storing sessions in Convex...
                </div>
              </div>
              <div className="mt-3">
                <span className="text-[#859900]">$</span>
                <span className="text-[#93a1a1]"> codecast blame src/auth/callback.ts</span>
              </div>
              <div className="text-[#586e75] text-xs">
                5 sessions touched this file
              </div>
              <div className="space-y-1 text-xs">
                <div className="text-[#93a1a1]">
                  <span className="text-[#b58900]">abc123</span> Fixed OAuth callback &bull; <span className="text-[#586e75]">2d ago</span>
                </div>
                <div className="text-[#93a1a1]">
                  <span className="text-[#b58900]">def456</span> Add refresh token logic &bull; <span className="text-[#586e75]">5d ago</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Security & Privacy */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-green-50 border border-green-200 text-green-700 text-sm font-medium mb-6">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Privacy-first
          </div>
          <h2 className="text-3xl font-bold text-stone-900 mb-4">
            Your code stays yours
          </h2>
          <p className="text-lg text-stone-600 leading-relaxed max-w-2xl mx-auto">
            The CLI daemon runs locally. Code stays on your machine unless you explicitly share it.
            We never train AI on your data, and you can self-host for complete control.
          </p>
        </div>

        {/* Data Flow Visual */}
        <div className="bg-stone-50 rounded-xl border border-stone-200 p-6 mb-8">
          <div className="flex flex-col md:flex-row items-center justify-center gap-4 md:gap-2 text-sm">
            <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg border border-stone-200">
              <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              <span className="text-stone-700 font-medium">Your Machine</span>
            </div>
            <svg className="w-6 h-6 text-stone-300 rotate-90 md:rotate-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg border border-stone-200">
              <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span className="text-stone-700 font-medium">Encrypted Sync</span>
            </div>
            <svg className="w-6 h-6 text-stone-300 rotate-90 md:rotate-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
            <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg border border-stone-200">
              <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-stone-700 font-medium">Dashboard</span>
            </div>
          </div>
          <p className="text-xs text-stone-400 text-center mt-4">
            Code content synced only if you enable it. Default: metadata only.
          </p>
        </div>

        {/* Security Features Grid */}
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-xl border border-stone-200 p-5">
            <div className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h3 className="font-semibold text-stone-900 text-sm mb-1">Private by default</h3>
            <p className="text-xs text-stone-500">Conversations start private. You choose what to share.</p>
          </div>

          <div className="bg-white rounded-xl border border-stone-200 p-5">
            <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
              </svg>
            </div>
            <h3 className="font-semibold text-stone-900 text-sm mb-1">Secret redaction</h3>
            <p className="text-xs text-stone-500">API keys and tokens stripped before sync.</p>
          </div>

          <div className="bg-white rounded-xl border border-stone-200 p-5">
            <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <h3 className="font-semibold text-stone-900 text-sm mb-1">E2E encryption</h3>
            <p className="text-xs text-stone-500">AES-256-GCM client-side encryption option.</p>
          </div>

          <div className="bg-white rounded-xl border border-stone-200 p-5">
            <div className="w-8 h-8 rounded-lg bg-blue-100 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
              </svg>
            </div>
            <h3 className="font-semibold text-stone-900 text-sm mb-1">Path hashing</h3>
            <p className="text-xs text-stone-500">Project paths hashed to prevent leakage.</p>
          </div>

          <div className="bg-white rounded-xl border border-stone-200 p-5">
            <div className="w-8 h-8 rounded-lg bg-purple-100 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-purple-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
              </svg>
            </div>
            <h3 className="font-semibold text-stone-900 text-sm mb-1">Self-hostable</h3>
            <p className="text-xs text-stone-500">Deploy on your own infrastructure.</p>
          </div>

          <div className="bg-white rounded-xl border border-stone-200 p-5">
            <div className="w-8 h-8 rounded-lg bg-stone-100 flex items-center justify-center mb-3">
              <svg className="w-4 h-4 text-stone-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
              </svg>
            </div>
            <h3 className="font-semibold text-stone-900 text-sm mb-1">Open source</h3>
            <p className="text-xs text-stone-500">Audit the code yourself. MIT license.</p>
          </div>
        </div>

        {/* Trust badges + Learn more */}
        <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
          <div className="flex flex-wrap gap-3 justify-center">
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-stone-200 text-stone-600 text-sm">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              No AI training
            </span>
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-stone-200 text-stone-600 text-sm">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              SOC 2 compliant backend
            </span>
            <span className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white border border-stone-200 text-stone-600 text-sm">
              <svg className="w-4 h-4 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              TLS 1.3
            </span>
          </div>
          <Link href="/security" className="text-amber-600 hover:text-amber-700 font-medium text-sm flex items-center gap-1">
            Learn more about security
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </Link>
        </div>
      </section>

      {/* Mobile App */}
      <section id="mobile-app" className="max-w-6xl mx-auto px-6 py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium mb-4">
              iOS App
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
              <a href="https://apps.apple.com/app/id6757820850" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-900 text-white rounded-lg hover:bg-stone-800 transition-colors font-medium">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
                </svg>
                App Store
              </a>
              <span className="inline-flex items-center gap-2 px-4 py-2.5 bg-stone-200 text-stone-500 rounded-lg font-medium cursor-not-allowed">
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 010 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.802 8.99l-2.303 2.303-8.635-8.635z"/>
                </svg>
                Android Coming Soon
              </span>
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
                <li><Link href="/features" className="hover:text-stone-900">CLI</Link></li>
                <li><Link href="/security" className="hover:text-stone-900">Security</Link></li>
                <li><Link href="/pricing" className="hover:text-stone-900">Pricing</Link></li>
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
