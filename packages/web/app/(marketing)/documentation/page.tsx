import Link from "next/link";
import { useState } from "react";
import { useMountEffect } from "@/hooks/useMountEffect";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/Logo";
import { InstallTabs } from "@/components/install-tabs";

const SOL = {
  base03: "#002b36",
  base02: "#073642",
  base01: "#586e75",
  base00: "#657b83",
  base0: "#839496",
  base1: "#93a1a1",
  base2: "#eee8d5",
  base3: "#fdf6e3",
  yellow: "#b58900",
  orange: "#cb4b16",
  red: "#dc322f",
  magenta: "#d33682",
  violet: "#6c71c4",
  blue: "#268bd2",
  cyan: "#2aa198",
  green: "#859900",
};

function Code({ children, title }: { children: string; title?: string }) {
  const lines = children.trim().split("\n");
  return (
    <div className="rounded-lg overflow-hidden my-4" style={{ backgroundColor: SOL.base03, border: `1px solid ${SOL.base02}` }}>
      {title && (
        <div className="px-4 py-2 text-xs font-mono" style={{ backgroundColor: SOL.base02, borderBottom: `1px solid ${SOL.base01}30`, color: SOL.base01 }}>
          {title}
        </div>
      )}
      <pre className="p-4 text-sm font-mono overflow-x-auto leading-relaxed" style={{ color: SOL.base1 }}>
        {lines.map((line, i) => {
          if (line.startsWith("$ ")) {
            return (
              <div key={i}>
                <span style={{ color: SOL.green }}>$ </span>
                <span style={{ color: SOL.base1 }}>{line.slice(2)}</span>
              </div>
            );
          }
          if (line.startsWith("# ")) {
            return <div key={i} style={{ color: SOL.base01 }}>{line}</div>;
          }
          if (line.startsWith("  ")) {
            return <div key={i} style={{ color: SOL.base00 }}>{line}</div>;
          }
          return <div key={i}>{line}</div>;
        })}
      </pre>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="px-1.5 py-0.5 rounded text-sm font-mono" style={{ backgroundColor: SOL.base2, color: SOL.base03 }}>
      {children}
    </code>
  );
}

function Heading({ id, level, children }: { id: string; level: 2 | 3; children: React.ReactNode }) {
  const Tag = level === 2 ? "h2" : "h3";
  const styles = level === 2
    ? "text-2xl font-bold font-mono mt-16 mb-6 pt-8"
    : "text-lg font-semibold font-mono mt-10 mb-4";
  return (
    <Tag id={id} className={styles} style={{ color: SOL.base03, borderTop: level === 2 ? `1px solid ${SOL.base2}` : undefined, scrollMarginTop: "6rem" }}>
      {children}
    </Tag>
  );
}

function Param({ name, desc }: { name: string; desc: string }) {
  return (
    <div className="flex gap-3 items-baseline py-1.5">
      <code className="font-mono text-sm shrink-0" style={{ color: SOL.yellow }}>{name}</code>
      <span className="text-sm" style={{ color: SOL.base00 }}>{desc}</span>
    </div>
  );
}

function CmdRow({ cmd, desc }: { cmd: string; desc: string }) {
  return (
    <div className="grid grid-cols-[1fr_1.2fr] gap-4 py-2.5" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
      <code className="font-mono text-sm" style={{ color: SOL.base03 }}>{cmd}</code>
      <span className="text-sm" style={{ color: SOL.base00 }}>{desc}</span>
    </div>
  );
}

function CmdTable({ children }: { children: React.ReactNode }) {
  return <div className="my-4">{children}</div>;
}

function Screenshot({ src, alt, caption }: { src: string; alt: string; caption?: string }) {
  return (
    <figure className="my-8">
      <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${SOL.base2}`, boxShadow: `0 4px 24px ${SOL.base01}18` }}>
        <div className="flex items-center gap-1.5 px-4 py-2.5" style={{ backgroundColor: SOL.base2 }}>
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: `${SOL.red}90` }} />
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: `${SOL.yellow}90` }} />
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: `${SOL.green}90` }} />
          <span className="ml-2 text-xs font-mono" style={{ color: SOL.base01 }}>codecast.sh</span>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="w-full block" style={{ backgroundColor: SOL.base03 }} />
      </div>
      {caption && (
        <figcaption className="mt-3 text-center text-sm font-mono" style={{ color: SOL.base01 }}>{caption}</figcaption>
      )}
    </figure>
  );
}

function Callout({ type, children }: { type: "info" | "tip" | "warn"; children: React.ReactNode }) {
  const colors = {
    info: { bg: `${SOL.blue}10`, border: SOL.blue, label: "Note" },
    tip: { bg: `${SOL.green}10`, border: SOL.green, label: "Tip" },
    warn: { bg: `${SOL.yellow}10`, border: SOL.yellow, label: "Important" },
  };
  const c = colors[type];
  return (
    <div className="rounded-lg p-4 my-4" style={{ backgroundColor: c.bg, borderLeft: `3px solid ${c.border}` }}>
      <div className="text-xs font-mono font-bold uppercase tracking-wider mb-1.5" style={{ color: c.border }}>{c.label}</div>
      <div className="text-sm leading-relaxed" style={{ color: SOL.base03 }}>{children}</div>
    </div>
  );
}

const TOC = [
  { id: "getting-started", label: "Getting Started", children: [
    { id: "installation", label: "Installation" },
    { id: "authentication", label: "Authentication" },
    { id: "daemon", label: "The Daemon" },
  ]},
  { id: "desktop-app", label: "Desktop App", children: [
    { id: "inbox", label: "Inbox & Orchestration" },
    { id: "inbox-shortcuts", label: "Keyboard Shortcuts" },
    { id: "conversations", label: "Conversations" },
    { id: "dashboard-plans", label: "Plans & Tasks" },
    { id: "desktop-download", label: "Download" },
  ]},
  { id: "mobile-app", label: "Mobile App", children: [
    { id: "mobile-features", label: "Features" },
    { id: "mobile-download", label: "Download" },
  ]},
  { id: "agent-memory", label: "Agent Memory", children: [
    { id: "memory-setup", label: "Setup" },
    { id: "memory-commands", label: "Commands" },
    { id: "memory-how-it-works", label: "How It Works" },
  ]},
  { id: "search-browse", label: "Search & Browse", children: [
    { id: "search", label: "Search" },
    { id: "feed-list", label: "Feed & List" },
    { id: "read", label: "Read Messages" },
  ]},
  { id: "session-analysis", label: "Session Analysis", children: [
    { id: "diff-summary", label: "Diff & Summary" },
    { id: "context-handoff", label: "Context & Handoff" },
    { id: "blame-similar", label: "Blame & Similar" },
  ]},
  { id: "plans", label: "Plans", children: [
    { id: "plans-overview", label: "Overview" },
    { id: "plans-commands", label: "Commands" },
    { id: "plans-workflow", label: "Workflow" },
  ]},
  { id: "tasks", label: "Tasks", children: [
    { id: "tasks-overview", label: "Overview" },
    { id: "tasks-commands", label: "Commands" },
  ]},
  { id: "agent-scheduling", label: "Agent Scheduling", children: [
    { id: "schedule-overview", label: "Overview" },
    { id: "schedule-commands", label: "Commands" },
    { id: "schedule-events", label: "Event Triggers" },
  ]},
  { id: "teams", label: "Teams", children: [
    { id: "team-setup", label: "Setup" },
    { id: "team-sharing", label: "Sharing & Privacy" },
  ]},
  { id: "knowledge", label: "Knowledge", children: [
    { id: "decisions", label: "Decisions" },
    { id: "bookmarks", label: "Bookmarks" },
  ]},
  { id: "integrations", label: "Integrations", children: [
    { id: "supported-tools", label: "Supported Tools" },
    { id: "github-integration", label: "GitHub" },
  ]},
  { id: "reference", label: "CLI Reference", children: [] },
];

function Sidebar({ activeId }: { activeId: string }) {
  return (
    <nav className="space-y-1">
      {TOC.map((section) => (
        <div key={section.id}>
          <a
            href={`#${section.id}`}
            className="block py-1.5 text-sm font-medium transition-colors"
            style={{ color: activeId === section.id ? SOL.blue : SOL.base00 }}
          >
            {section.label}
          </a>
          {section.children.length > 0 && (
            <div className="ml-3 space-y-0.5">
              {section.children.map((child) => (
                <a
                  key={child.id}
                  href={`#${child.id}`}
                  className="block py-1 text-xs transition-colors"
                  style={{ color: activeId === child.id ? SOL.blue : SOL.base01 }}
                >
                  {child.label}
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}

export default function DocsPage() {
  const [activeId, setActiveId] = useState("getting-started");

  useMountEffect(() => {
    const allIds = TOC.flatMap((s) => [s.id, ...s.children.map((c) => c.id)]);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting);
        if (visible.length > 0) {
          const sorted = visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          setActiveId(sorted[0].target.id);
        }
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: 0 }
    );
    allIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  });

  return (
    <main className="min-h-screen w-full" style={{ backgroundColor: SOL.base3 }}>
      {/* Nav */}
      <nav className="backdrop-blur-sm sticky top-0 z-50" style={{ borderBottom: `1px solid ${SOL.base2}`, backgroundColor: "rgba(253,246,227,0.85)" }}>
        <div className="max-w-[90rem] mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/">
              <Logo size="md" className="text-[#002b36]" />
            </Link>
            <div className="hidden md:flex items-center gap-1">
              <span style={{ color: SOL.base01 }}>/</span>
              <span className="font-mono text-sm font-medium" style={{ color: SOL.base03 }}>docs</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/features" className="font-medium text-sm px-3 py-1.5 hidden sm:block" style={{ color: SOL.base00 }}>
              CLI
            </Link>
            <Link href="/security" className="font-medium text-sm px-3 py-1.5 hidden sm:block" style={{ color: SOL.base00 }}>
              Security
            </Link>
            <Link href="/signup">
              <Button className="font-medium text-white text-sm" style={{ backgroundColor: SOL.base03 }}>
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      <div className="max-w-[90rem] mx-auto flex">
        {/* Sidebar */}
        <aside className="hidden lg:block w-56 shrink-0 sticky top-[53px] h-[calc(100vh-53px)] overflow-y-auto py-8 pl-6 pr-4" style={{ borderRight: `1px solid ${SOL.base2}` }}>
          <Sidebar activeId={activeId} />
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 max-w-4xl px-6 lg:px-12 py-8 pb-32">

          {/* Hero */}
          <div className="mb-12">
            <h1 className="text-4xl font-bold font-mono mb-4" style={{ color: SOL.base03 }}>Documentation</h1>
            <p className="text-lg leading-relaxed" style={{ color: SOL.base00 }}>
              Everything you need to sync, search, and orchestrate your AI coding sessions.
              Codecast works with Claude Code, Codex, Gemini CLI, and Cursor.
            </p>
          </div>

          {/* Getting Started */}
          <Heading id="getting-started" level={2}>Getting Started</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Codecast is a CLI daemon that runs in the background, syncing your AI coding sessions to a shared database.
            Once installed, every Claude Code, Codex, Gemini, or Cursor session is automatically captured -- searchable, shareable, and accessible from any device.
          </p>

          <Heading id="installation" level={3}>Installation</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>One command. Works on macOS, Linux, and WSL.</p>
          <InstallTabs />
          <p className="mt-4 text-sm" style={{ color: SOL.base01 }}>
            This installs the <InlineCode>cast</InlineCode> CLI and background daemon. No root access required.
          </p>

          <Heading id="authentication" level={3}>Authentication</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            Authenticate via browser OAuth. This links your machine to your codecast account.
          </p>
          <Code>{`$ cast auth
Opening browser for authentication...
Authenticated as ashot@codecast.sh`}</Code>
          <p className="text-sm" style={{ color: SOL.base01 }}>
            Alternatively, generate a setup token on the web dashboard at <InlineCode>Settings &gt; CLI</InlineCode> and run <InlineCode>cast login &lt;token&gt;</InlineCode>.
          </p>

          <Heading id="daemon" level={3}>The Daemon</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            The daemon watches your local session files and syncs them in real-time. It runs quietly in the background with no impact on your workflow.
          </p>
          <Code>{`$ cast start
Daemon started (pid 42891)
Watching for sessions...

$ cast status
Daemon: running (pid 42891)
Sessions: 847 synced, 0 pending
Latency: 38ms avg
Uptime: 4d 12h`}</Code>
          <CmdTable>
            <CmdRow cmd="cast start" desc="Start the background daemon" />
            <CmdRow cmd="cast stop" desc="Stop the daemon" />
            <CmdRow cmd="cast restart" desc="Restart (also checks for updates)" />
            <CmdRow cmd="cast status" desc="Show daemon status, sync info" />
            <CmdRow cmd="cast logs -f" desc="Tail daemon logs" />
            <CmdRow cmd="cast setup" desc="Auto-start daemon on login" />
          </CmdTable>
          <Callout type="tip">
            Run <InlineCode>cast setup</InlineCode> after install to auto-start the daemon on login. You won&apos;t need to think about it again.
          </Callout>

          {/* Agent Memory */}
          <Heading id="agent-memory" level={2}>Agent Memory</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Every AI coding session starts from scratch. Agent memory changes that -- your agent can search
            all past sessions, recall decisions, and understand context from work done days or weeks ago.
            Memory works across all tools: a Claude Code session can recall what you built in Cursor.
          </p>

          <Heading id="memory-setup" level={3}>Setup</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            Run <InlineCode>cast memory</InlineCode> to install the memory component into your project&apos;s <InlineCode>CLAUDE.md</InlineCode>.
            This gives your agent instructions on how to use codecast for context retrieval.
          </p>
          <Code title="CLAUDE.md (added by cast memory)">{`## Memory

You have access to past sessions via cast CLI.
Search proactively when starting new tasks.

# Search & Browse
cast search "auth" -s 7d          # keyword search
cast context "stripe integration"  # pre-work intelligence
cast ask "why did we use Convex?"  # natural language query

# Recall
cast handoff                       # context transfer doc
cast decisions list                # architectural decisions
cast blame src/auth.ts             # sessions that touched a file`}</Code>
          <Callout type="info">
            The <InlineCode>cast ask</InlineCode> command uses RAG with your session history and requires an <InlineCode>ANTHROPIC_API_KEY</InlineCode> environment variable.
          </Callout>

          <Heading id="memory-commands" level={3}>Commands</Heading>
          <CmdTable>
            <CmdRow cmd="cast memory" desc="Install memory component into CLAUDE.md" />
            <CmdRow cmd='cast ask "question"' desc="Natural language query over all sessions (RAG)" />
            <CmdRow cmd='cast context "query"' desc="Pre-work intelligence: find relevant context before starting" />
            <CmdRow cmd="cast search ..." desc="Full-text search across sessions (see Search)" />
            <CmdRow cmd="cast decisions list" desc="Recall architectural decisions" />
            <CmdRow cmd="cast blame <file>" desc="Which sessions touched a file" />
          </CmdTable>

          <Heading id="memory-how-it-works" level={3}>How It Works</Heading>
          <p style={{ color: SOL.base00 }}>
            Codecast builds a hybrid search index over your sessions -- combining keyword matching with semantic embeddings.
            When your agent calls <InlineCode>cast search</InlineCode> or <InlineCode>cast ask</InlineCode>, it queries this index
            and returns relevant messages with full context. The agent sees the original conversation fragments,
            not summaries, so it gets precise, actionable information.
          </p>

          {/* Search & Browse */}
          <Heading id="search-browse" level={2}>Search & Browse</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Find any session, message, or file change across your entire history. Supports exact phrases,
            time range filters, team member filters, and context lines around matches.
          </p>

          <Heading id="search" level={3}>Search</Heading>
          <Code>{`# Basic search
$ cast search "auth bug"

# Exact phrase (quotes = phrase match)
$ cast search "token refresh logic"

# Time range
$ cast search auth -s 7d
$ cast search auth -s 2025-01-01 -e 2025-02-01

# Global (all projects)
$ cast search auth -g

# By team member
$ cast search auth -m sarah

# User messages only
$ cast search auth -u

# With context lines
$ cast search "webhook" -C 3

# Keyword-only or semantic-only
$ cast search auth --keyword
$ cast search "how does auth work" --semantic`}</Code>
          <Callout type="tip">
            Use quotes for exact phrase matching: <InlineCode>cast search &quot;error handling&quot;</InlineCode> matches
            the exact phrase, while <InlineCode>cast search error handling</InlineCode> matches both words anywhere.
          </Callout>

          <Heading id="feed-list" level={3}>Feed & List</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>Browse recent sessions chronologically.</p>
          <Code>{`# Recent sessions feed
$ cast feed

# Global feed (all projects)
$ cast feed -g

# Filter by keyword
$ cast feed -q "payments"

# Filter by team member
$ cast feed -m alex

# Paginated
$ cast feed -n 20 -p 2`}</Code>

          <Heading id="read" level={3}>Read Messages</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>Read specific messages from any session by ID and range.</p>
          <Code>{`# Read full conversation
$ cast read abc123

# Read messages 10 through 20
$ cast read abc123 10:20

# Read from message 50 onward
$ cast read abc123 50:`}</Code>

          {/* Session Analysis */}
          <Heading id="session-analysis" level={2}>Session Analysis</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Understand what happened in any session -- files changed, commits made, tools used.
            Generate summaries and handoff documents for continuity between sessions.
          </p>

          <Heading id="diff-summary" level={3}>Diff & Summary</Heading>
          <Code>{`# Files changed, commits, tools used in a session
$ cast diff abc123

# Aggregate today's changes across all sessions
$ cast diff --today

# Generate session summary
$ cast summary abc123

# Summarize today's work
$ cast summary --today`}</Code>

          <Heading id="context-handoff" level={3}>Context & Handoff</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            <InlineCode>cast context</InlineCode> gathers relevant prior work before you start something new.
            <InlineCode>cast handoff</InlineCode> generates a context transfer document for session continuity.
          </p>
          <Code>{`# Pre-work intelligence
$ cast context "add stripe payments"
  Found 3 relevant sessions:
  - Payment webhook debugging (2d ago)
  - Stripe SDK integration (1w ago)
  - Billing page UI (1w ago)

# Generate handoff doc
$ cast handoff
  Handoff document generated.
  Goal: Implement dark mode across settings
  Approach: CSS variables with system preference sync
  Status: Tests passing, 2 edge cases remaining
  Next: Fix mobile viewport handling`}</Code>

          <Heading id="blame-similar" level={3}>Blame & Similar</Heading>
          <Code>{`# Which sessions touched a file
$ cast blame src/auth/callback.ts
  5 sessions touched this file
  abc123 Fixed OAuth callback     2d ago
  def456 Add refresh token logic  5d ago
  ...

# Find sessions with related files
$ cast similar --file src/api.ts`}</Code>

          {/* Plans */}
          <Heading id="plans" level={2}>Plans</Heading>

          <Heading id="plans-overview" level={3}>Overview</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Plans are multi-session features. Create a plan, define goals and acceptance criteria,
            then bind sessions to it as you work. Each session logs decisions and discoveries
            that other sessions can reference -- so parallel agents stay coordinated.
          </p>

          <Heading id="plans-commands" level={3}>Commands</Heading>
          <Code>{`# Create a plan
$ cast plan create "Add payments" -g "Stripe integration with subscriptions" -a "Checkout works, webhooks verified, tests pass"

# List plans
$ cast plan ls --active
$ cast plan ls --draft

# Show plan details (tasks, decisions, progress)
$ cast plan show ct-a1b2

# Bind current session to a plan
$ cast plan bind ct-a1b2

# Log decisions and discoveries
$ cast plan decide ct-a1b2 "Use Stripe Checkout" --rationale "Simpler than custom flow, handles SCA"
$ cast plan discover ct-a1b2 "Stripe webhooks need idempotency keys for retries"

# Add context pointers
$ cast plan pointer ct-a1b2 "API schema" docs/api.md

# Lifecycle
$ cast plan activate ct-a1b2
$ cast plan pause ct-a1b2
$ cast plan done ct-a1b2`}</Code>

          <Heading id="plans-workflow" level={3}>Workflow</Heading>
          <p style={{ color: SOL.base00 }}>
            A typical plan lifecycle: create in <InlineCode>draft</InlineCode>, move
            to <InlineCode>active</InlineCode> when work begins, bind sessions as agents work on it,
            log decisions and discoveries along the way, and mark <InlineCode>done</InlineCode> when
            acceptance criteria are met. Plans are visible in the web dashboard with progress bars,
            linked sessions, and full decision history.
          </p>

          {/* Tasks */}
          <Heading id="tasks" level={2}>Tasks</Heading>

          <Heading id="tasks-overview" level={3}>Overview</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Tasks are work items -- features, bugs, chores. They can belong to a plan or stand alone.
            Tasks have priorities, dependencies, and a status workflow: <InlineCode>draft</InlineCode> &rarr; <InlineCode>open</InlineCode> &rarr; <InlineCode>in_progress</InlineCode> &rarr; <InlineCode>in_review</InlineCode> &rarr; <InlineCode>done</InlineCode>.
          </p>

          <Heading id="tasks-commands" level={3}>Commands</Heading>
          <Code>{`# Create a task
$ cast task create "Add password reset" -t feature -p high --plan ct-a1b2

# List tasks
$ cast task ls --status open -p high
$ cast task ready                  # unblocked tasks ready to work

# Work on a task
$ cast task start ct-x1y2          # marks in_progress
$ cast task comment ct-x1y2 "Implemented reset flow" -t progress
$ cast task done ct-x1y2           # marks done

# Dependencies
$ cast task create "Email templates" --blocked-by ct-x1y2`}</Code>
          <Callout type="info">
            Tasks are synced to the web dashboard and visible in the Plans view. Team members can see task status in real-time.
          </Callout>

          {/* Agent Scheduling */}
          <Heading id="agent-scheduling" level={2}>Agent Scheduling</Heading>

          <Heading id="schedule-overview" level={3}>Overview</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Schedule autonomous agent tasks that run without your involvement. One-shot tasks
            fire after a delay, recurring tasks run on an interval, and event-triggered tasks
            fire in response to GitHub webhooks.
          </p>

          <Heading id="schedule-commands" level={3}>Commands</Heading>
          <Code>{`# One-shot: check CI in 30 minutes
$ cast schedule add "Check if CI is green on main" --in 30m

# Recurring: review PRs every 4 hours
$ cast schedule add "Review open PRs and summarize" --every 4h

# With context from current session
$ cast schedule add "Continue auth refactor" --in 2h --context current --mode apply

# Manage scheduled tasks
$ cast schedule ls                 # list active
$ cast schedule ls --all           # include completed/failed
$ cast schedule run ct-s1          # run immediately
$ cast schedule pause ct-s1        # pause
$ cast schedule cancel ct-s1       # cancel
$ cast schedule log ct-s1          # view last run output`}</Code>

          <Heading id="schedule-events" level={3}>Event Triggers</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            With the GitHub integration installed, you can trigger agent tasks on repository events.
          </p>
          <Code>{`# Respond to new PR comments
$ cast schedule add "Respond to PR review comments" --on pr_comment

# Run on new PRs
$ cast schedule add "Review PR for security issues" --on pr_opened

# Run after merge
$ cast schedule add "Verify deployment after merge" --on pr_merged

# Run on push to main
$ cast schedule add "Check for broken tests" --on push`}</Code>
          <CmdTable>
            <Param name="--in <duration>" desc="Delay before run: 30m, 2h, 1d" />
            <Param name="--every <duration>" desc="Recurring interval" />
            <Param name="--on <event>" desc="GitHub event: pr_comment, pr_opened, pr_merged, push" />
            <Param name="--context current" desc="Capture current session context for the task" />
            <Param name="--mode apply" desc="Allow agent to make changes (default: propose = read-only)" />
            <Param name="--max-runtime <dur>" desc="Override max runtime (default: 10m)" />
          </CmdTable>

          {/* Desktop App */}
          <Heading id="desktop-app" level={2}>Desktop App</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            The codecast desktop app is your command center for managing sessions, orchestrating agents,
            and staying on top of team activity. Available as a native macOS app and at{" "}
            <a href="https://codecast.sh" className="font-mono underline" style={{ color: SOL.blue }}>codecast.sh</a>.
          </p>

          <Screenshot
            src="/docs/dashboard.png"
            alt="Codecast dashboard showing the session feed with live agent status, sidebar navigation, team members, and project bookmarks"
            caption="The dashboard feed -- all your sessions with live status, summaries, and team activity"
          />

          <Heading id="inbox" level={3}>Inbox & Orchestration</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            The inbox is where you orchestrate your agents. It shows all running and recent sessions with
            live status updates -- <InlineCode>working</InlineCode>, <InlineCode>idle</InlineCode>, <InlineCode>permission_blocked</InlineCode>, <InlineCode>thinking</InlineCode>, <InlineCode>compacting</InlineCode> -- organized
            by priority: sessions needing your input float to the top, pinned sessions stay accessible,
            and working sessions update in real-time.
          </p>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            From the inbox you can send messages to agents, approve pending permissions, pin important sessions,
            defer sessions for later, and dismiss completed work. The keyboard-driven workflow lets you
            fly through a queue of active sessions without touching the mouse.
          </p>

          <Screenshot
            src="/docs/inbox.png"
            alt="Codecast inbox showing live agent sessions with status indicators, pinned sessions, and working/needs-input categories"
            caption="The inbox -- orchestrate multiple agents with live status, summaries, and direct messaging"
          />

          <Heading id="inbox-shortcuts" level={3}>Keyboard Shortcuts</Heading>
          <p className="mb-3" style={{ color: SOL.base00 }}>
            The inbox is designed for keyboard-first orchestration. Navigate, triage, and respond to
            agents without leaving the keyboard.
          </p>
          <div className="rounded-lg overflow-hidden my-4" style={{ border: `1px solid ${SOL.base2}` }}>
            {[
              ["Ctrl+J", "Next session", "Move down in the session queue"],
              ["Ctrl+K", "Previous session", "Move up in the session queue"],
              ["Ctrl+I", "Jump to needs input", "Jump to the first session waiting for your input"],
              ["Ctrl+Backspace", "Dismiss", "Stash the current session (remove from queue)"],
              ["Shift+Backspace", "Defer", "Defer the current session for later review"],
              ["Ctrl+Shift+P", "Pin/unpin", "Pin or unpin the current session"],
              ["Ctrl+P", "Jump to pinned", "Jump to first pinned session"],
              ["?", "Toggle shortcuts", "Show or hide the keyboard shortcut overlay"],
            ].map(([key, action, desc], i) => (
              <div
                key={key}
                className="grid grid-cols-[120px_140px_1fr] gap-4 px-4 py-2.5 text-sm items-center"
                style={{
                  backgroundColor: i % 2 === 0 ? "transparent" : `${SOL.base2}40`,
                  borderBottom: i < 7 ? `1px solid ${SOL.base2}` : undefined,
                }}
              >
                <kbd className="font-mono text-xs px-2 py-1 rounded inline-block w-fit" style={{ backgroundColor: SOL.base2, color: SOL.base03 }}>{key}</kbd>
                <span className="font-medium" style={{ color: SOL.base03 }}>{action}</span>
                <span style={{ color: SOL.base00 }}>{desc}</span>
              </div>
            ))}
          </div>
          <Callout type="tip">
            The inbox remembers your position. Dismiss a session with <kbd className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: SOL.base2, color: SOL.base03 }}>Ctrl+Backspace</kbd> and
            it automatically advances to the next one -- perfect for triaging a queue of agent sessions.
          </Callout>

          <Heading id="conversations" level={3}>Conversations</Heading>
          <p style={{ color: SOL.base00 }}>
            The conversation view shows the full message history with syntax-highlighted code blocks,
            inline tool calls (Read, Edit, Bash, etc.), file diffs, and screenshots. You can share
            specific messages via link, bookmark important moments, and view the session timeline.
          </p>

          <Screenshot
            src="/docs/conversation.png"
            alt="Codecast conversation view showing message history with code blocks, tool calls, and file diffs"
            caption="Conversation view -- full session history with syntax highlighting, tool calls, and inline diffs"
          />

          <Heading id="dashboard-plans" level={3}>Plans & Tasks</Heading>
          <p style={{ color: SOL.base00 }}>
            The Plans page shows all plans with status filters (draft, active, paused, done).
            Each plan displays its goal, acceptance criteria, progress bar, linked sessions,
            decision log, discoveries, and context pointers. Tasks are visible within their
            parent plan or as a standalone list with priority and status filtering.
          </p>

          <Screenshot
            src="/docs/plans.png"
            alt="Codecast plans page showing active plans with status badges, task counts, and plan IDs"
            caption="Plans view -- track multi-session features with goals, tasks, and decision history"
          />

          <Heading id="desktop-download" level={3}>Download</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            The desktop app provides native macOS integration with system notifications, menu bar access,
            and a dedicated window. Everything in the web app works identically in the desktop app.
          </p>
          <a
            href="https://codecast.sh/download/mac"
            className="inline-flex items-center gap-3 px-5 py-3 rounded-lg font-medium transition-colors"
            style={{ backgroundColor: SOL.base03, color: SOL.base3 }}
          >
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
            </svg>
            Download for macOS
          </a>

          {/* Mobile App */}
          <Heading id="mobile-app" level={2}>Mobile App</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Your AI coding sessions, always in your pocket. The iOS app gives you full access
            to your sessions, agents, and team activity from anywhere.
          </p>

          <Heading id="mobile-features" level={3}>Features</Heading>
          <div className="space-y-3 mb-4">
            {[
              ["Live session streaming", "Watch your agents work in real-time with push notifications when they need input"],
              ["Send messages", "Send prompts and messages to running agents directly from your phone"],
              ["Review diffs", "Review code changes and approve permissions remotely"],
              ["Full search", "Search your entire session history on the go"],
            ].map(([title, desc]) => (
              <div key={title} className="flex gap-3 items-start">
                <svg className="w-5 h-5 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20" style={{ color: SOL.green }}>
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <div>
                  <div className="font-medium text-sm" style={{ color: SOL.base03 }}>{title}</div>
                  <div className="text-sm" style={{ color: SOL.base00 }}>{desc}</div>
                </div>
              </div>
            ))}
          </div>

          <Heading id="mobile-download" level={3}>Download</Heading>
          <div className="flex flex-wrap gap-3">
            <a
              href="https://apps.apple.com/app/id6757820850"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-3 px-5 py-3 rounded-lg font-medium transition-colors"
              style={{ backgroundColor: SOL.base03, color: SOL.base3 }}
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
              </svg>
              App Store (iOS)
            </a>
            <span className="inline-flex items-center gap-2 px-5 py-3 rounded-lg font-medium" style={{ backgroundColor: `${SOL.base2}`, color: SOL.base01 }}>
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M3.609 1.814L13.792 12 3.61 22.186a.996.996 0 01-.61-.92V2.734a1 1 0 01.609-.92zm10.89 10.893l2.302 2.302-10.937 6.333 8.635-8.635zm3.199-3.198l2.807 1.626a1 1 0 010 1.73l-2.808 1.626L15.206 12l2.492-2.491zM5.864 2.658L16.802 8.99l-2.303 2.303-8.635-8.635z"/>
              </svg>
              Android coming soon
            </span>
          </div>

          {/* Teams */}
          <Heading id="teams" level={2}>Teams</Heading>

          <Heading id="team-setup" level={3}>Setup</Heading>
          <Code>{`# Create a team
$ cast teams create "acme-eng" --icon "🚀"

# Invite members
$ cast teams invite sarah@acme.com -r admin
$ cast teams invite mike@acme.com

# Join with invite code
$ cast teams join abc123

# Sync settings
$ cast teams sync-settings`}</Code>

          <Heading id="team-sharing" level={3}>Sharing & Privacy</Heading>
          <p className="mb-4" style={{ color: SOL.base00 }}>
            Sessions are private by default. Sharing is controlled at three levels:
          </p>
          <div className="space-y-3 mb-4">
            <div className="p-3 rounded-lg" style={{ backgroundColor: `${SOL.base2}80` }}>
              <div className="font-mono text-sm font-medium mb-1" style={{ color: SOL.base03 }}>Directory mappings</div>
              <p className="text-sm" style={{ color: SOL.base00 }}>
                Map project directories to teams with <InlineCode>auto_share: true</InlineCode>. All sessions in that directory are automatically shared.
              </p>
            </div>
            <div className="p-3 rounded-lg" style={{ backgroundColor: `${SOL.base2}80` }}>
              <div className="font-mono text-sm font-medium mb-1" style={{ color: SOL.base03 }}>Team share paths</div>
              <p className="text-sm" style={{ color: SOL.base00 }}>
                Configure paths that auto-share with your active team via user settings.
              </p>
            </div>
            <div className="p-3 rounded-lg" style={{ backgroundColor: `${SOL.base2}80` }}>
              <div className="font-mono text-sm font-medium mb-1" style={{ color: SOL.base03 }}>Manual sharing</div>
              <p className="text-sm" style={{ color: SOL.base00 }}>
                Share individual sessions or messages via link with <InlineCode>cast links</InlineCode>.
                Mark sessions private with <InlineCode>cast private</InlineCode>.
              </p>
            </div>
          </div>
          <Callout type="warn">
            Setting an <InlineCode>active_team_id</InlineCode> alone does NOT share sessions. You must also
            configure directory mappings or team share paths for sessions to be visible to teammates.
          </Callout>

          {/* Knowledge */}
          <Heading id="knowledge" level={2}>Knowledge</Heading>

          <Heading id="decisions" level={3}>Decisions</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            Track architectural decisions with rationale. Searchable by your agent and your team.
          </p>
          <Code>{`# Record a decision
$ cast decisions add "Use Convex for backend" --reason "Real-time subscriptions, no WebSocket infra needed" --tags "backend,database"

# List recent decisions
$ cast decisions

# Search decisions
$ cast decisions --search "database"

# Filter by project
$ cast decisions --project /Users/me/src/app

# Delete
$ cast decisions delete ct-d1`}</Code>

          <Heading id="bookmarks" level={3}>Bookmarks</Heading>
          <Code>{`# Bookmark a specific message
$ cast bookmark abc123 42 --name "auth-pattern" --note "Good pattern for OAuth callback"

# List bookmarks
$ cast bookmark --list

# Delete
$ cast bookmark --delete auth-pattern`}</Code>

          {/* Integrations */}
          <Heading id="integrations" level={2}>Integrations</Heading>

          <Heading id="supported-tools" level={3}>Supported Tools</Heading>
          <div className="grid grid-cols-2 gap-3 my-4">
            {[
              { name: "Claude Code", color: SOL.orange, desc: "Full sync with live status" },
              { name: "OpenAI Codex", color: SOL.green, desc: "Session sync and memory" },
              { name: "Gemini CLI", color: SOL.magenta, desc: "Session sync and memory" },
              { name: "Cursor", color: SOL.blue, desc: "Session sync and memory" },
            ].map((tool) => (
              <div key={tool.name} className="p-3 rounded-lg" style={{ backgroundColor: `${SOL.base2}80`, borderLeft: `3px solid ${tool.color}` }}>
                <div className="font-mono text-sm font-medium" style={{ color: SOL.base03 }}>{tool.name}</div>
                <div className="text-xs mt-0.5" style={{ color: SOL.base01 }}>{tool.desc}</div>
              </div>
            ))}
          </div>

          <Heading id="github-integration" level={3}>GitHub</Heading>
          <p className="mb-2" style={{ color: SOL.base00 }}>
            Install the GitHub app to link PRs with sessions, process webhook events,
            and trigger scheduled agent tasks on repository activity.
          </p>
          <p style={{ color: SOL.base00 }}>
            Configure at <InlineCode>Settings &gt; Integrations &gt; GitHub App</InlineCode> on the web dashboard.
            Once installed, PRs are automatically linked to the sessions that created them,
            and you can set up event-triggered agent tasks.
          </p>

          {/* CLI Reference */}
          <Heading id="reference" level={2}>CLI Reference</Heading>
          <p className="mb-6" style={{ color: SOL.base00 }}>
            Complete command reference. All commands use the <InlineCode>cast</InlineCode> prefix.
          </p>

          {[
            {
              title: "Core",
              color: SOL.base03,
              cmds: [
                ["auth", "Browser OAuth authentication"],
                ["login <token>", "Link device with setup token"],
                ["start / stop / restart", "Daemon lifecycle management"],
                ["status", "Daemon status, sync info, uptime"],
                ["sync", "Manual sync all unsynced sessions"],
                ["logs -f", "View daemon logs with follow mode"],
                ["setup", "Auto-start daemon on login"],
                ["config [key] [value]", "View or set configuration"],
                ["health", "Sync health: dropped ops, pending, retry queue"],
                ["repair [--dry-run]", "Repair incorrectly stored project paths"],
                ["update", "Check and install updates"],
              ],
            },
            {
              title: "Search & Browse",
              color: SOL.blue,
              cmds: [
                ["search <query>", "Hybrid search with filters: -s, -e, -g, -m, -u, -C, --keyword, --semantic"],
                ["feed", "Browse recent sessions: -g, -q, -m, -n, -p, -s, -e"],
                ["list", "Chronological list with title, summary, link"],
                ["read <id> [range]", "Read messages from a session (e.g., 10:20)"],
                ["resume <query>", "Search and resume a session"],
              ],
            },
            {
              title: "Analysis",
              color: SOL.cyan,
              cmds: [
                ["diff [id]", "Files changed, commits, tools used"],
                ["diff --today", "Aggregate today's file changes"],
                ["summary [id]", "Generate session summary: goal, approach, outcome"],
                ["context <query>", "Pre-work intelligence from related sessions"],
                ['ask "<question>"', "Natural language RAG query (needs ANTHROPIC_API_KEY)"],
                ["handoff", "Generate context transfer document"],
              ],
            },
            {
              title: "File Intelligence",
              color: SOL.green,
              cmds: [
                ["blame <file>", "Which sessions touched a file"],
                ["similar [--file <path>]", "Sessions with related files"],
              ],
            },
            {
              title: "Plans",
              color: SOL.violet,
              cmds: [
                ['plan create "<title>"', "Create plan with -g goal, -a criteria"],
                ["plan ls", "List plans: --active, --draft, --done, --all"],
                ["plan show <id>", "Plan details with tasks, decisions, progress"],
                ["plan bind / unbind <id>", "Bind/unbind current session to plan"],
                ["plan decide <id> ...", "Log decision with --rationale"],
                ["plan discover <id> ...", "Log discovery"],
                ["plan pointer <id> ...", "Add context pointer"],
                ["plan activate / pause / done / drop <id>", "Lifecycle transitions"],
              ],
            },
            {
              title: "Tasks",
              color: SOL.yellow,
              cmds: [
                ['task create "<title>"', "Create task: -t type, -p priority, --plan, --blocked-by"],
                ["task ls", "List tasks: --status, -p priority, --project, --plan"],
                ["task ready", "Unblocked tasks ready to work"],
                ["task start / done / drop <id>", "Status transitions"],
                ['task comment <id> "text"', "Add comment: -t type"],
              ],
            },
            {
              title: "Scheduling",
              color: SOL.orange,
              cmds: [
                ['schedule add "<prompt>"', "Schedule task: --in, --every, --on, --context, --mode"],
                ["schedule ls", "List scheduled tasks: -s status, -a all"],
                ["schedule run / pause / cancel <id>", "Manage scheduled task"],
                ["schedule log <id>", "View last run conversation"],
                ["schedule complete <id>", "Report completion with --summary"],
              ],
            },
            {
              title: "Collaboration",
              color: SOL.magenta,
              cmds: [
                ["links", "Get dashboard and share URLs"],
                ["private [id]", "Mark session as private"],
                ["bookmark <id> <msg>", "Bookmark message: --name, --note"],
                ["teams", "List teams"],
                ["teams create / join / invite", "Team management"],
              ],
            },
            {
              title: "Knowledge",
              color: SOL.red,
              cmds: [
                ["decisions [add|delete]", "Track architectural decisions"],
                ["learn [add|show|search]", "Save and search code patterns"],
                ["memory", "Install agent memory component"],
              ],
            },
          ].map((section) => (
            <div key={section.title} className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: section.color }} />
                <h3 className="font-mono text-sm font-bold uppercase tracking-wider" style={{ color: section.color }}>{section.title}</h3>
              </div>
              <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${SOL.base2}` }}>
                {section.cmds.map(([cmd, desc], i) => (
                  <div
                    key={cmd}
                    className="grid grid-cols-[1fr_1.4fr] gap-4 px-4 py-2.5 text-sm"
                    style={{
                      backgroundColor: i % 2 === 0 ? "transparent" : `${SOL.base2}40`,
                      borderBottom: i < section.cmds.length - 1 ? `1px solid ${SOL.base2}` : undefined,
                    }}
                  >
                    <code className="font-mono" style={{ color: SOL.base03 }}>{cmd}</code>
                    <span style={{ color: SOL.base00 }}>{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* CTA */}
          <div className="mt-20 rounded-xl p-10 text-center" style={{ backgroundColor: SOL.base03 }}>
            <h2 className="text-2xl font-bold font-mono mb-3" style={{ color: SOL.base3 }}>Ready to get started?</h2>
            <p className="mb-6" style={{ color: SOL.base1 }}>Free for individuals. One command to install.</p>
            <div className="flex gap-4 justify-center">
              <Link href="/signup">
                <Button size="lg" className="text-base px-8 h-12 font-medium" style={{ backgroundColor: SOL.base3, color: SOL.base03 }}>
                  Get started free
                </Button>
              </Link>
              <a href="https://github.com/codecast-sh" target="_blank" rel="noopener noreferrer">
                <Button size="lg" variant="outline" className="text-base px-8 h-12 font-medium bg-transparent text-white" style={{ borderColor: SOL.base01 }}>
                  View on GitHub
                </Button>
              </a>
            </div>
          </div>
        </div>

        {/* Right gutter - empty for balance */}
        <div className="hidden xl:block w-48 shrink-0" />
      </div>
    </main>
  );
}
