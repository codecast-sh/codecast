import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { InstallTabs } from "@/components/install-tabs";

function TerminalIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function SearchIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
    </svg>
  );
}

function BrainIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
    </svg>
  );
}

function GitIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}


function LightbulbIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
    </svg>
  );
}

function CodeBlock({ children, title }: { children: string; title?: string }) {
  return (
    <div className="bg-[#002b36] rounded-lg overflow-hidden">
      {title && (
        <div className="px-4 py-2 bg-[#073642] border-b border-[#094959] text-xs text-[#586e75] font-mono">
          {title}
        </div>
      )}
      <pre className="p-4 text-sm font-mono text-[#93a1a1] overflow-x-auto">
        {children}
      </pre>
    </div>
  );
}

const FEATURE_CATEGORIES = [
  {
    title: "Agent Memory",
    problem: "Every AI session starts fresh",
    description: "Give your AI agent persistent memory. It searches past sessions automatically when starting new work, recalls decisions, and learns from its own history.",
    icon: BrainIcon,
    color: "purple",
    commands: [
      { cmd: "codecast memory", desc: "Install agent memory component" },
      { cmd: "codecast ask \"how did we implement auth?\"", desc: "Natural language query" },
      { cmd: "codecast context \"add stripe\"", desc: "Pre-work intelligence" },
    ],
  },
  {
    title: "Search & Browse",
    problem: "\"How did we do this before?\"",
    description: "Stop re-solving the same problems. Search your AI coding history like ripgrep - full text, time filters, context lines. Find that one session from last month.",
    icon: SearchIcon,
    color: "blue",
    commands: [
      { cmd: "codecast search \"auth\" -s 7d", desc: "Search last 7 days" },
      { cmd: "codecast feed -g", desc: "Browse all sessions" },
      { cmd: "codecast read abc123 10:20", desc: "Read messages 10-20" },
    ],
  },
  {
    title: "Session Resume",
    problem: "Lost context when picking up work",
    description: "Resume any session with full history. Generate handoff docs for continuity. Your agent picks up exactly where you (or it) left off.",
    icon: TerminalIcon,
    color: "amber",
    commands: [
      { cmd: "codecast resume \"logo design\"", desc: "Search and resume" },
      { cmd: "codecast handoff", desc: "Generate context transfer" },
      { cmd: "codecast summary --today", desc: "Summarize today's work" },
    ],
  },
  {
    title: "File Intelligence",
    problem: "\"Who changed this file and why?\"",
    description: "Trace what your AI has touched. See which sessions modified a file, understand the intent behind changes, and find related work across your codebase.",
    icon: GitIcon,
    color: "green",
    commands: [
      { cmd: "codecast blame src/auth.ts", desc: "Who touched this file" },
      { cmd: "codecast similar --file src/api.ts", desc: "Related sessions" },
      { cmd: "codecast diff --today", desc: "Today's file changes" },
    ],
  },
  {
    title: "Team Collaboration",
    problem: "Invisible work and duplicated effort",
    description: "See what teammates are building in real-time. Share sessions without copy-pasting. Learn from their debugging. Stop duplicating solved problems.",
    icon: UsersIcon,
    color: "orange",
    commands: [
      { cmd: "codecast links", desc: "Get shareable URLs" },
      { cmd: "codecast private abc123", desc: "Mark session private" },
      { cmd: "codecast bookmark abc123 42", desc: "Bookmark a message" },
    ],
  },
  {
    title: "Knowledge Management",
    problem: "Decisions live in people's heads",
    description: "Make architectural decisions searchable. Track rationale. Save code patterns for reuse. Build institutional knowledge from AI sessions.",
    icon: LightbulbIcon,
    color: "red",
    commands: [
      { cmd: "codecast decisions add \"Use Convex\"", desc: "Record decision" },
      { cmd: "codecast learn add \"http-pattern\"", desc: "Save code pattern" },
      { cmd: "codecast decisions --search \"db\"", desc: "Search decisions" },
    ],
  },
];

const QUICK_START_STEPS = [
  {
    step: 1,
    title: "Install",
    code: "curl -fsSL https://codecast.sh/install | sh",
    detail: "Single command install. Works on macOS, Linux, and WSL.",
  },
  {
    step: 2,
    title: "Authenticate",
    code: "codecast auth",
    detail: "Opens browser for OAuth. Takes 10 seconds.",
  },
  {
    step: 3,
    title: "Start syncing",
    code: "codecast start",
    detail: "Background daemon watches and syncs automatically.",
  },
];

const COMMAND_REFERENCE = [
  {
    category: "Core",
    commands: [
      { cmd: "auth", desc: "Browser OAuth authentication" },
      { cmd: "start / stop / status", desc: "Daemon management" },
      { cmd: "sync", desc: "Manual sync all conversations" },
      { cmd: "config [key] [value]", desc: "View or set configuration" },
      { cmd: "logs -f", desc: "View daemon logs (follow mode)" },
      { cmd: "setup", desc: "Auto-start daemon on login" },
    ],
  },
  {
    category: "Search & Browse",
    commands: [
      { cmd: "search <query>", desc: "Full-text search with -s/-e time filters" },
      { cmd: "feed", desc: "Browse recent sessions (-g for global)" },
      { cmd: "read <id> [range]", desc: "Read messages (e.g., 10:20)" },
      { cmd: "resume <query>", desc: "Search and resume a session" },
    ],
  },
  {
    category: "Analysis",
    commands: [
      { cmd: "diff [id]", desc: "Files changed, commits, tools used" },
      { cmd: "summary [id]", desc: "Generate session summary" },
      { cmd: "handoff", desc: "Context transfer document" },
      { cmd: "context <query>", desc: "Pre-work intelligence" },
      { cmd: "ask <question>", desc: "Natural language query" },
    ],
  },
  {
    category: "File Intelligence",
    commands: [
      { cmd: "blame <file>", desc: "Sessions that touched a file" },
      { cmd: "similar --file <path>", desc: "Sessions with related files" },
    ],
  },
  {
    category: "Collaboration",
    commands: [
      { cmd: "links", desc: "Dashboard and share URLs" },
      { cmd: "private [id]", desc: "Manage private sessions" },
      { cmd: "bookmark <id> <msg>", desc: "Bookmark specific messages" },
    ],
  },
  {
    category: "Knowledge",
    commands: [
      { cmd: "decisions [add|delete]", desc: "Track architectural decisions" },
      { cmd: "learn [add|show|search]", desc: "Save code patterns" },
      { cmd: "memory", desc: "Install agent memory component" },
    ],
  },
];

export default function CLIPage() {
  return (
    <main className="min-h-screen bg-stone-50 w-full">
      {/* Nav */}
      <nav className="border-b border-stone-200 bg-stone-50/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          <Link href="/">
            <Logo size="md" className="text-stone-900" />
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/features" className="text-amber-600 font-medium text-sm px-3 py-1.5">
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
      <section className="max-w-6xl mx-auto px-6 pt-20 pb-16">
        <div className="text-center max-w-3xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium mb-6">
            <TerminalIcon className="w-4 h-4" />
            Command Line Interface
          </div>

          <h1 className="text-5xl md:text-6xl font-bold text-stone-900 leading-[1.1] tracking-tight mb-6">
            Your AI agent,<br />
            <span className="text-stone-400">with a memory</span>
          </h1>

          <p className="text-xl text-stone-600 leading-relaxed max-w-2xl mx-auto mb-8">
            The codecast CLI gives your AI agent persistent memory, searchable history,
            and context transfer. Search past sessions, resume work, track decisions.
          </p>

          <div className="mb-8">
            <InstallTabs />
          </div>
        </div>
      </section>

      {/* Demo Terminal */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="relative">
          <div className="absolute -inset-4 bg-gradient-to-r from-amber-500/20 via-orange-500/20 to-red-500/20 rounded-2xl blur-xl opacity-50"></div>
          <div className="relative bg-[#002b36] rounded-xl border border-[#094959] shadow-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 bg-[#073642] border-b border-[#094959]">
              <div className="flex gap-1.5">
                <div className="w-3 h-3 rounded-full bg-[#dc322f]"></div>
                <div className="w-3 h-3 rounded-full bg-[#b58900]"></div>
                <div className="w-3 h-3 rounded-full bg-[#859900]"></div>
              </div>
              <span className="text-xs font-mono text-[#586e75] ml-2">Terminal</span>
            </div>
            <div className="p-4 font-mono text-sm space-y-4">
              <div>
                <span className="text-[#859900]">$</span>
                <span className="text-[#93a1a1]"> codecast search &quot;auth bug&quot; -s 7d</span>
              </div>
              <div className="text-[#586e75] text-xs">
                Searching sessions from last 7 days...
              </div>
              <div className="border-l-2 border-[#268bd2] pl-3 space-y-1">
                <div className="text-[#93a1a1]">
                  <span className="text-[#b58900]">[abc123]</span> Fixed OAuth callback error
                </div>
                <div className="text-[#586e75] text-xs">
                  2 days ago | 34 messages | src/auth/callback.ts
                </div>
                <div className="text-[#657b83] text-xs mt-1">
                  ... found the <span className="text-[#cb4b16]">auth bug</span> in the token refresh logic...
                </div>
              </div>
              <div className="border-l-2 border-[#268bd2] pl-3 space-y-1">
                <div className="text-[#93a1a1]">
                  <span className="text-[#b58900]">[def456]</span> Implement session management
                </div>
                <div className="text-[#586e75] text-xs">
                  5 days ago | 67 messages | src/auth/session.ts
                </div>
              </div>
              <div className="mt-4">
                <span className="text-[#859900]">$</span>
                <span className="text-[#93a1a1]"> codecast resume &quot;OAuth callback&quot;</span>
              </div>
              <div className="text-[#859900]">
                Opening: Fixed OAuth callback error
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Quick Start */}
      <section className="bg-white border-y border-stone-200 py-20">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold text-stone-900 mb-4">Get started in 30 seconds</h2>
            <p className="text-lg text-stone-500">Three commands to persistent AI memory</p>
          </div>

          <div className="space-y-6">
            {QUICK_START_STEPS.map((step) => (
              <div key={step.step} className="flex gap-6 items-start">
                <div className="w-10 h-10 rounded-full bg-stone-900 text-white flex items-center justify-center font-mono font-bold text-lg shrink-0">
                  {step.step}
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold text-stone-900 mb-1">{step.title}</h3>
                  <p className="text-sm text-stone-500 mb-2">{step.detail}</p>
                  <code className="block bg-stone-100 rounded-lg px-4 py-2 text-sm font-mono text-stone-800">
                    {step.code}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Feature Categories */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-16">
          <h2 className="text-3xl font-bold text-stone-900 mb-4">
            Everything you need for AI-assisted development
          </h2>
          <p className="text-lg text-stone-500 max-w-2xl mx-auto">
            Search, resume, analyze, and share your AI coding sessions.
            Built for developers who want their AI to remember.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {FEATURE_CATEGORIES.map((category) => (
            <div key={category.title} className="bg-white rounded-xl border border-stone-200 p-6">
              <div className={`w-12 h-12 rounded-lg flex items-center justify-center mb-4 ${
                category.color === "purple" ? "bg-purple-100" :
                category.color === "blue" ? "bg-blue-100" :
                category.color === "amber" ? "bg-amber-100" :
                category.color === "green" ? "bg-green-100" :
                category.color === "orange" ? "bg-orange-100" :
                "bg-red-100"
              }`}>
                <category.icon className={`w-6 h-6 ${
                  category.color === "purple" ? "text-purple-600" :
                  category.color === "blue" ? "text-blue-600" :
                  category.color === "amber" ? "text-amber-600" :
                  category.color === "green" ? "text-green-600" :
                  category.color === "orange" ? "text-orange-600" :
                  "text-red-600"
                }`} />
              </div>
              <p className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-1">{category.problem}</p>
              <h3 className="text-lg font-semibold text-stone-900 mb-2">{category.title}</h3>
              <p className="text-sm text-stone-500 mb-4">{category.description}</p>
              <div className="space-y-2">
                {category.commands.map((cmd) => (
                  <div key={cmd.cmd} className="flex items-start gap-2 text-xs">
                    <code className="bg-stone-100 px-2 py-1 rounded font-mono text-stone-700 shrink-0">
                      {cmd.cmd.length > 30 ? cmd.cmd.slice(0, 30) + "..." : cmd.cmd}
                    </code>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Command Reference */}
      <section className="bg-stone-900 text-white py-20">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Command reference</h2>
            <p className="text-lg text-stone-400">All commands at a glance</p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {COMMAND_REFERENCE.map((section) => (
              <div key={section.category} className="bg-[#073642] rounded-xl p-5">
                <h3 className="font-semibold text-amber-400 mb-4 text-sm uppercase tracking-wide">
                  {section.category}
                </h3>
                <div className="space-y-3">
                  {section.commands.map((cmd) => (
                    <div key={cmd.cmd} className="text-sm">
                      <code className="text-[#93a1a1] font-mono">{cmd.cmd}</code>
                      <p className="text-[#586e75] text-xs mt-0.5">{cmd.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Agent Memory Deep Dive */}
      <section className="max-w-5xl mx-auto px-6 py-20">
        <div className="grid md:grid-cols-2 gap-12 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-purple-50 border border-purple-200 text-purple-700 text-sm font-medium mb-4">
              <BrainIcon className="w-4 h-4" />
              Agent Memory
            </div>
            <h2 className="text-3xl font-bold text-stone-900 mb-4">
              Your AI remembers everything
            </h2>
            <p className="text-lg text-stone-600 leading-relaxed mb-6">
              Install the memory component and your AI agent gains access to all past sessions.
              It can search for relevant context, recall decisions, and learn from previous work.
            </p>
            <ul className="space-y-3 text-stone-600">
              <li className="flex items-center gap-3">
                <svg className="w-5 h-5 text-purple-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Search past sessions automatically when starting work
              </li>
              <li className="flex items-center gap-3">
                <svg className="w-5 h-5 text-purple-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Recall architectural decisions and rationale
              </li>
              <li className="flex items-center gap-3">
                <svg className="w-5 h-5 text-purple-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Find sessions that touched the same files
              </li>
              <li className="flex items-center gap-3">
                <svg className="w-5 h-5 text-purple-500 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                Generate handoff docs for session continuity
              </li>
            </ul>
          </div>
          <div>
            <CodeBlock title="~/.claude/CLAUDE.md">{`## Memory

You have access to past sessions via codecast.
Search proactively when starting tasks.

\`\`\`bash
# Search & Browse
codecast search "auth" -s 7d
codecast context "stripe integration"
codecast ask "why did we use Convex?"

# Recall & Resume
codecast handoff
codecast decisions list
codecast blame src/auth.ts
\`\`\``}</CodeBlock>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-6 pb-20">
        <div className="bg-stone-900 rounded-2xl p-12 text-center">
          <h2 className="text-3xl font-bold text-white mb-4">
            Give your AI a memory
          </h2>
          <p className="text-lg text-stone-400 mb-8 max-w-xl mx-auto">
            Install in 30 seconds. Free for individuals.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link href="/signup">
              <Button size="lg" className="bg-white text-stone-900 hover:bg-stone-100 text-base px-8 h-12 font-medium">
                Get started free
              </Button>
            </Link>
            <Link href="https://github.com/codecast-sh/features" target="_blank">
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
                <li><Link href="/#how-it-works" className="hover:text-stone-900">How it works</Link></li>
                <li><Link href="/features" className="hover:text-stone-900">CLI</Link></li>
                <li><Link href="/security" className="hover:text-stone-900">Security</Link></li>
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
