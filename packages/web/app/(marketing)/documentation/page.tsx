import Link from "next/link";
import { useRef, useState } from "react";
import { useMountEffect } from "@/hooks/useMountEffect";
import { Button } from "@/components/ui/button";
import { InstallTabs } from "@/components/install-tabs";
import { GUIDES, GUIDE_CATEGORIES } from "./guides/guides";
import { GuideCard } from "./guides/GuideCard";
import { TOC } from "./toc";
import { useRouteMeta } from "../pageMeta";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { AppBadge, AndroidSoonBadge } from "@/components/marketing/AppBadges";
import { Screenshot } from "../blog/blogChrome";

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

function CmdRow({ cmd, desc }: { cmd: string; desc: string }) {
  // On a phone the command takes the whole width and the words go under it:
  // side by side, a long command got under half of 342px.
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.2fr] gap-1 sm:gap-4 py-2.5" style={{ borderBottom: `1px solid ${SOL.base2}` }}>
      <code className="font-mono text-sm break-words" style={{ color: SOL.base03 }}>{cmd}</code>
      <span className="text-sm" style={{ color: SOL.base00 }}>{desc}</span>
    </div>
  );
}

function CmdTable({ children }: { children: React.ReactNode }) {
  return <div className="my-4">{children}</div>;
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

/** One numbered setup step: a big numeral in the gutter, the step's content beside it. */
function Step({ n, id, title, children }: { n: number; id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="relative pl-14 pb-8 mb-2" style={{ scrollMarginTop: "6rem" }}>
      <div className="absolute left-0 top-0 w-9 h-9 rounded-full flex items-center justify-center font-mono font-bold" style={{ backgroundColor: SOL.base03, color: SOL.base3 }}>{n}</div>
      <div className="absolute left-[17px] top-10 bottom-0 w-px" style={{ backgroundColor: SOL.base2 }} />
      <h3 className="text-lg font-semibold font-mono mb-3 pt-1" style={{ color: SOL.base03 }}>{title}</h3>
      {children}
    </section>
  );
}

/** A key as it appears in the app's own hints. */
function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ backgroundColor: SOL.base2, color: SOL.base03 }}>{children}</kbd>
  );
}

/** Body copy: one place for the page's paragraph color and spacing. */
function P({ children, className = "mb-3" }: { children: React.ReactNode; className?: string }) {
  return <p className={className} style={{ color: SOL.base00 }}>{children}</p>;
}

/** A link to a guide, in the cyan the page uses for links within the docs. */
function GuideLink({ slug, children }: { slug: string; children: React.ReactNode }) {
  return (
    <Link href={`/documentation/${slug}`} className="underline underline-offset-2" style={{ color: SOL.cyan }}>{children}</Link>
  );
}

/** A phone capture. It arrives phone-framed from the docs shot script, so it
 *  sits on the page at a phone's width with no box of its own. */
function PhoneShot({ src, alt, caption }: { src: string; alt: string; caption: string }) {
  return (
    <figure className="shrink-0 mx-auto sm:mx-0 w-[260px]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} loading="lazy" className="w-full h-auto block" />
      <figcaption className="mt-3 text-center text-sm font-mono" style={{ color: SOL.base1 }}>{caption}</figcaption>
    </figure>
  );
}

/** The thumbnail tour under the hero: each card jumps to its section. */
const TOUR = [
  { id: "inbox", label: "Inbox", line: "Every agent, grouped by what it needs from you", src: "/docs/app/inbox.webp", focus: "97% 22%", zoom: 2.4 },
  { id: "conversations", label: "Conversations", line: "Watch and steer a session live", src: "/docs/app/conversation.webp", focus: "48% 38%", zoom: 1.9 },
  { id: "command-palette", label: "Command palette", line: "Jump to anything with one key", src: "/docs/app/palette.webp", focus: "50% 42%", zoom: 1.7 },
  { id: "changes", label: "Changes", line: "What the team shipped, day by day", src: "/docs/app/changes.webp", focus: "45% 28%", zoom: 1.9 },
  { id: "tasks-plans", label: "Tasks & plans", line: "One board for people and agents", src: "/docs/app/tasks.webp", focus: "45% 28%", zoom: 1.9 },
  { id: "mobile-app", label: "Mobile", line: "Answer an agent from your phone", src: "/docs/app/mobile.webp", focus: "50% 30%", zoom: 1.3 },
];

/** The inbox's sections, top to bottom, in the colors the app draws them. */
const INBOX_GROUPS: [string, string, string][] = [
  ["Decisions", SOL.violet, "A question queued for you"],
  ["Pinned", SOL.magenta, "Sessions you keep at the top"],
  ["New", SOL.blue, "Sessions you just started"],
  ["Needs You", SOL.yellow, "Waiting on your answer or a permission"],
  ["Couldn't finish", SOL.red, "Stopped before the work was done"],
  ["Done", SOL.cyan, "Finished, ready for you to read"],
  ["Working", SOL.green, "Running right now"],
  ["Dormant", SOL.base01, "Asleep until something wakes it"],
  ["Snoozed", SOL.base01, "Hidden until a time you picked"],
  ["Stashed", SOL.base01, "Put away; the agent keeps running"],
];

/** Mac keys; on Windows and Linux, Cmd reads Ctrl. Settings > Keyboard lists
 *  and rebinds every one, so this is the short list. */
const SHORTCUTS: [string, string][] = [
  ["Ctrl+J / Ctrl+K", "Next / previous session"],
  ["Ctrl+I", "Jump to the first session that needs you"],
  ["Ctrl+Backspace", "Stash the session (the agent keeps running)"],
  ["Shift+Backspace", "Defer it and move to the next"],
  ["Option+Z", "Snooze until a time you pick"],
  ["Ctrl+Shift+P", "Pin or unpin"],
  ["Ctrl+L", "File under a label"],
  ["Ctrl+,", "Cycle the inbox view: grouped, by time, by label"],
  ["Ctrl+N", "New session"],
  ["Cmd+K", "Command palette"],
  ["Cmd+/", "Search"],
  ["Y / N", "Approve or deny a permission"],
  ["D / T", "Diff panel / branch map"],
  ["Option+J / K", "Next / previous message you sent"],
  ["Option+F", "Fork from the selected message"],
  ["Ctrl+M", "Focus the composer"],
  ["Ctrl+.", "Zen mode"],
  ["?", "Show every shortcut"],
];

/** The reference for people who script and for agents: the commands they
 *  reach for most, grouped. `cast <command> --help` has every flag. */
const CLI_GROUPS: { title: string; cmds: [string, string][] }[] = [
  { title: "Recall", cmds: [
    ["search <query>", "Search every session you can see, on any machine"],
    ["read <id> [range]", "Read a session's messages, e.g. 10:20"],
    ["context <task>", "Past sessions relevant to what you are about to do"],
    ['ask "<question>"', "A plain-language question over your history"],
    ["blame <file>", "git blame whose author is the session that wrote the line"],
    ["decisions list | add", "Recorded decisions and their reasons"],
  ]},
  { title: "Work tracking", cmds: [
    ['task create "<title>"', "File a task; start, comment and done move it"],
    ["task ready", "Tasks with nothing blocking them"],
    ['plan create "<title>"', "A plan across several tasks and sessions"],
    ['decide "<question>"', "Queue a question in Decisions with options"],
    ['state "<where it stands>"', "Pin a session's state for the inbox card"],
  ]},
  { title: "Automation", cmds: [
    ['trigger add "<prompt>"', "Run later: --in 30m, --every 4h, --on pr_comment"],
    ["workflow run <file>", "Run a workflow graph bound to a task or plan"],
    ["spawn / fork", "Start a worker session, or branch this one"],
    ["send <id> <text>", "Message another session"],
  ]},
  { title: "Team and sharing", cmds: [
    ["teams members | map | lock", "Your teams, their people, and which folders share with them"],
    ["sharing", "Read and change what syncs and who sees it"],
    ["chat send | read", "Post to and read team channels"],
    ["publish <file>", "Publish a page and print its link"],
  ]},
];

/** Pinned under the table of contents: the apps page is one click from any
 *  section, the way the CLI install is one command. */
function AppsCard() {
  return (
    <div className="shrink-0 my-4 rounded-lg p-3" style={{ backgroundColor: SOL.base2 }}>
      <div className="text-xs font-mono font-bold uppercase tracking-wider mb-1" style={{ color: SOL.base01 }}>Get the apps</div>
      <p className="text-xs leading-relaxed mb-2.5" style={{ color: SOL.base00 }}>Native on Mac and iPhone: notifications, shortcuts, a push when an agent needs you.</p>
      <div className="flex flex-col items-start gap-1.5">
        <AppBadge app="mac" size="sm" location="documentation_sidebar" />
        <AppBadge app="ios" size="sm" location="documentation_sidebar" />
      </div>
    </div>
  );
}

/** The sidebar's contents for a screen too narrow for the sidebar: one bar
 *  that names where the reader is and opens the whole list. A pick closes it. */
function PhoneToc({ activeId }: { activeId: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const here =
    TOC.find((s) => s.id === activeId)?.label ??
    TOC.flatMap((s) => s.children).find((c) => c.id === activeId)?.label ??
    "Contents";
  return (
    <details
      ref={ref}
      className="lg:hidden sticky top-[53px] z-30 -mx-6 -mt-8 mb-8 px-6 py-2"
      style={{ backgroundColor: SOL.base3, borderBottom: `1px solid ${SOL.base2}` }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a") && ref.current) ref.current.open = false;
      }}
    >
      <summary className="cursor-pointer select-none py-1.5 font-mono text-sm font-medium" style={{ color: SOL.base03 }}>
        On this page <span style={{ color: SOL.base01 }}>· {here}</span>
      </summary>
      <div className="max-h-[60vh] overflow-y-auto pb-3 pt-1">
        <Sidebar activeId={activeId} />
      </div>
    </details>
  );
}

function Sidebar({ activeId }: { activeId: string }) {
  return (
    <nav className="space-y-1">
      {TOC.map((section) => (
        <div key={section.id}>
          {section.group && (
            <div className="text-mark font-mono font-bold uppercase tracking-wider pt-5 pb-1.5 first:pt-0" style={{ color: SOL.base1 }}>{section.group}</div>
          )}
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
  useRouteMeta("/documentation");
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
      <MarketingNav active="/documentation" crumb="docs" containerClassName="max-w-[90rem]" />

      <div className="max-w-[90rem] mx-auto flex">
        {/* Sidebar */}
        <aside className="hidden lg:flex flex-col w-56 shrink-0 sticky top-[53px] h-[calc(100vh-53px)] pl-6 pr-4" style={{ borderRight: `1px solid ${SOL.base2}` }}>
          <div className="flex-1 min-h-0 overflow-y-auto py-8">
            <Sidebar activeId={activeId} />
          </div>
          <AppsCard />
        </aside>

        {/* Content */}
        <div className="flex-1 min-w-0 max-w-4xl px-6 lg:px-12 py-8 pb-32">
          {/* Below lg the sidebar is gone: the same contents, folded into a
              bar that stays under the nav. */}
          <PhoneToc activeId={activeId} />

          {/* Hero */}
          <div className="mb-10">
            <h1 className="text-4xl font-bold font-mono mb-4" style={{ color: SOL.base03 }}>Documentation</h1>
            <p className="text-lg leading-relaxed" style={{ color: SOL.base00 }}>
              Codecast is where you and your team run coding agents. Every Claude Code, Codex, Cursor, Gemini
              and OpenCode session lands in one inbox you can watch, answer and search, in the browser, on the
              Mac and on your phone. This page walks through the app one screen at a time.
            </p>
          </div>
          <Screenshot
            src="/docs/app/inbox.webp"
            alt="The codecast app: navigation on the left, a running agent conversation in the middle, and the inbox of live sessions on the right"
            caption="The conversation you are in, beside the inbox of everything else that is running."
            eager
          />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-8 mb-4">
            {TOUR.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className="group rounded-lg overflow-hidden block transition-transform hover:-translate-y-0.5"
                style={{ border: `1px solid ${SOL.base2}`, backgroundColor: `${SOL.base2}55` }}
              >
                <div className="aspect-[16/9] overflow-hidden" style={{ backgroundColor: SOL.base2 }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={t.src} alt="" loading="lazy" className="w-full h-full object-cover" style={{ objectPosition: t.focus, transform: `scale(${t.zoom})`, transformOrigin: t.focus }} />
                </div>
                <div className="px-3 py-2.5">
                  <div className="font-mono text-sm font-semibold" style={{ color: SOL.base03 }}>{t.label}</div>
                  <div className="text-xs leading-snug mt-0.5" style={{ color: SOL.base01 }}>{t.line}</div>
                </div>
              </a>
            ))}
          </div>

          {/* Getting started */}
          <Heading id="getting-started" level={2}>Getting started</Heading>
          <P className="mb-6">
            Three steps. Codecast reads the sessions your agents already keep on your computer, so nothing
            changes about how you run them.
          </P>

          <Step n={1} id="open-app" title="Open codecast">
            <P className="mb-4">
              Sign up at <a href="/signup" className="underline underline-offset-2" style={{ color: SOL.blue }}>codecast.sh</a> and
              use it in any browser, or get the apps. The Mac app adds native notifications and global shortcuts;
              the iPhone app pushes to your phone when an agent needs you.
            </P>
            <div className="flex flex-wrap gap-3">
              <AppBadge app="mac" location="documentation_intro" />
              <AppBadge app="ios" location="documentation_intro" />
            </div>
          </Step>

          <Step n={2} id="installation" title="Connect your computer">
            <P>
              Until a computer is connected, the inbox shows a setup card. In the Mac app it has a{" "}
              <strong>Set up this machine</strong> button that does the whole install with one click. In a browser,{" "}
              <strong>Generate install command</strong> gives you a command with your sign-in built in: paste it into a
              terminal on each computer you code on. Sessions start appearing within a second or two, past ones included.
            </P>
            <Screenshot
              src="/docs/app/connect.webp"
              alt="The empty inbox's setup card with the Set up this machine button"
              caption="The setup card in an empty inbox."
            />
            <P className="mb-2">The command, if you would rather copy it from here (macOS, Linux and Windows, no root needed):</P>
            <InstallTabs location="documentation" />
            <p className="mt-3 text-sm" style={{ color: SOL.base01 }}>
              If your account has a cloud machine, the same card also offers <strong>Start a session</strong> there, with nothing to install.
            </p>
          </Step>

          <Step n={3} id="chrome-extension" title="Let agents use your Chrome and Mac apps (optional)">
            <P className="mb-0">
              Open Settings and pick <strong>Agent Features</strong> under Machines, then switch on{" "}
              <strong>Browser</strong> or <strong>Computer</strong>. Each card lists what is left to do on that computer:{" "}
              <strong>Pair</strong> for Chrome, <strong>Open System Settings</strong> for the two Mac permissions.
            </P>
            <p className="mt-3 text-sm" style={{ color: SOL.base01 }}>
              <GuideLink slug="browser">Let agents use your Chrome</GuideLink>
              {" · "}
              <GuideLink slug="computer">Computer use</GuideLink>
              {" · "}
              <GuideLink slug="agent-snippets">Agent features</GuideLink>
            </p>
          </Step>

          {/* Inbox */}
          <Heading id="inbox" level={2}>Inbox</Heading>
          <P>
            The app has the same three columns everywhere: navigation on the left, the page you are on in the
            middle, and your sessions on the right, so the agents that need you stay in view whatever you open.
            Every session you run, on any computer, gets a card there: its title, a line on where it stands, the
            last thing you said to it, its project and how long ago it moved.
          </P>
          <Screenshot
            src="/docs/app/inbox-cards.webp"
            alt="The inbox column: session cards under Decisions, Pinned, Done and Working, each with a title, a status line and the project"
            caption="Session cards, grouped by what each one needs from you."
          />

          <Heading id="inbox-groups" level={3}>How cards are grouped</Heading>
          <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2 mb-4">
            {INBOX_GROUPS.map(([name, color, desc]) => (
              <div key={name} className="flex gap-3 items-baseline text-sm">
                <span className="font-mono text-xs font-bold uppercase tracking-wider shrink-0 w-24" style={{ color }}>{name}</span>
                <span style={{ color: SOL.base00 }}>{desc}</span>
              </div>
            ))}
          </div>
          <P>
            Click a card to open its conversation. When you are done with one, stash it (<Kbd>Ctrl+Backspace</Kbd>) and
            the inbox opens the next, so you can work down a queue without reaching for the mouse. The chips across the top filter by label or project.
          </P>

          <Heading id="decisions" level={3}>Decisions</Heading>
          <P>
            When an agent needs your call, it can queue a question instead of stopping: the question, the
            options with what each one costs, and its reasoning. <strong>Decisions</strong> in the sidebar shows how
            many are waiting. Answer each with a click or a number key, and the answer goes back to the session
            that asked.
          </P>
          <Screenshot
            src="/docs/app/decisions.webp"
            alt="A decision card: the question, the agent's reasoning, and numbered options each with its consequence"
            caption="A queued decision, answerable without reading the thread."
          />
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            <GuideLink slug="decisions">Decisions: asking without interrupting</GuideLink>
          </p>

          <Heading id="inbox-shortcuts" level={3}>Keyboard shortcuts</Heading>
          <P>
            You can work the whole inbox from the keyboard. These are the ones people use most (Mac keys; on Windows
            and Linux, Cmd is Ctrl). Press <Kbd>?</Kbd> for the full list, or open <strong>Settings &gt; Keyboard</strong> to
            change any of them.
          </P>
          <div className="rounded-lg overflow-hidden my-4" style={{ border: `1px solid ${SOL.base2}` }}>
            {SHORTCUTS.map(([key, action], i) => (
              <div
                key={key}
                className="grid grid-cols-[auto_1fr] sm:grid-cols-[160px_1fr] gap-x-4 px-4 py-2.5 text-sm items-center"
                style={{
                  backgroundColor: i % 2 === 0 ? "transparent" : `${SOL.base2}40`,
                  borderBottom: i < SHORTCUTS.length - 1 ? `1px solid ${SOL.base2}` : undefined,
                }}
              >
                <kbd className="font-mono text-xs px-2 py-1 rounded inline-block w-fit" style={{ backgroundColor: SOL.base2, color: SOL.base03 }}>{key}</kbd>
                <span className="min-w-0 break-words" style={{ color: SOL.base00 }}>{action}</span>
              </div>
            ))}
          </div>

          {/* Conversations */}
          <Heading id="conversations" level={2}>Conversations</Heading>
          <P>
            A conversation is the agent&apos;s whole session, live. Its replies render as formatted text, and the work
            between them folds into one line (&ldquo;ran 3 commands&rdquo;, &ldquo;read 2 files&rdquo;) that opens on a click.
            Background commands and scheduled wakeups show what they are waiting on. The header carries the agent,
            model and branch, the task or plan the session is working on, and <strong>Share</strong> to send someone the link.
          </P>
          <Screenshot
            src="/docs/app/conversation.webp"
            alt="A conversation: the agent's replies, collapsed command runs and a background command, with the task and plan in the header"
            caption="A live session, with the task it serves in the header."
          />

          <Heading id="steer" level={3}>Steer a running agent</Heading>
          <P>
            Type into the composer at any time, even mid-run, and the agent reads it next. When the agent is waiting on
            you, a suggested reply appears in grey; <Kbd>Tab</Kbd> takes it. <Kbd>Option+F</Kbd> forks the conversation
            from the message you selected, and <Kbd>A</Kbd> asks the session a question about its own work.
          </P>
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            <GuideLink slug="forks-and-spawn">Workers, forks and switching agents</GuideLink>
          </p>

          <Heading id="permissions" level={3}>Permissions</Heading>
          <P>
            When an agent asks to run a command or edit a file, the request shows as a card in the conversation with
            what it wants to do and <strong>Approve</strong> and <strong>Deny</strong>. <Kbd>Y</Kbd> and <Kbd>N</Kbd> answer
            it from the keyboard. The session sits under Needs You until you do. Commands you always allow are kept
            per project in <strong>Settings &gt; Approvals</strong>.
          </P>
          <Screenshot
            src="/docs/app/permission.webp"
            alt="A permission card in a conversation: the command the agent wants to run, with Approve and Deny buttons"
            caption="A permission request, answered in the conversation."
          />

          <Heading id="diff-panel" level={3}>Diff &amp; branch map</Heading>
          <P>
            <Kbd>D</Kbd> opens the diff panel: every file the session changed, with the edits inline. <Kbd>T</Kbd> opens the
            branch map, which shows where this conversation forked and the sessions it started.
          </P>
          <Screenshot
            src="/docs/app/diff.webp"
            alt="The diff panel beside a conversation: the changed files listed, one file's edits shown inline"
            caption="The diff panel: what this session changed."
          />

          {/* Command palette */}
          <Heading id="command-palette" level={2}>Command palette</Heading>
          <P>
            Press <Kbd>Cmd+K</Kbd> anywhere. The palette searches sessions, tasks, plans, docs, people and pages, grouped
            by kind with the ones you touched most recently first. It also runs actions on the session you have open,
            or on several you selected in the inbox: pin, stash, defer or kill them in one go.
          </P>
          <Screenshot
            src="/docs/app/palette.webp"
            alt="The command palette open over the app, with recent sessions, tasks and actions"
            caption="The palette: jump to anything or act on it."
          />
          <Callout type="tip">
            In the Mac app, <Kbd>Ctrl+Option+Space</Kbd> opens the palette from any app, and{" "}
            <Kbd>Cmd+Option+Space</Kbd> brings the codecast window forward. Change both in <strong>Settings &gt; Desktop</strong>.
          </Callout>

          {/* Changes */}
          <Heading id="changes" level={2}>Changes</Heading>
          <P>
            <strong>Changes</strong> is the team&apos;s timeline of what shipped, newest day first. Each day is one sentence and a
            list of stories, one line each, and each week opens with a summary. Click a story, or press <Kbd>E</Kbd>, to read
            what changed, why, and the commits behind it; <Kbd>O</Kbd> opens the session that did the work. The header holds
            the filters, the work still in progress, and what is live.
          </P>
          <Screenshot
            src="/docs/app/changes.webp"
            alt="The Changes page: a week's summary above a day's stories, each with its size and the release that shipped it"
            caption="Changes: every day's work as a list of stories."
          />
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            Changes is a team feature, off for a new team. An admin switches it on under <strong>Features</strong> in{" "}
            <strong>Settings &gt; Team</strong>.
          </p>

          {/* Tasks & plans */}
          <Heading id="tasks-plans" level={2}>Tasks &amp; plans</Heading>

          <Heading id="tasks" level={3}>Tasks</Heading>
          <P>
            Tasks are the work, whoever does it: you, a teammate or an agent. <strong>Tasks</strong> in the sidebar groups them
            by status (Open, In Progress, In Review, Done) and shows who holds each one, its priority and how long it
            has been open. Agents file and move tasks as they work, so the board stays current without anyone
            updating it. Filter it, then <strong>Save view</strong> to keep that filter one click away.
          </P>
          <Screenshot
            src="/docs/app/tasks.webp"
            alt="The task board grouped into In Progress and Open, with assignees, priorities and ages"
            caption="Tasks: one board for people and agents."
          />

          <Heading id="plans" level={3}>Plans</Heading>
          <P>
            A plan holds a larger goal that takes several tasks and sessions. Its page shows the goal, a progress bar,
            the tasks under it, the sessions working on it, and a timeline of the decisions and findings agents
            posted along the way.
          </P>
          <Screenshot
            src="/docs/app/plan.webp"
            alt="A plan page with its goal, progress, tasks and comment timeline"
            caption="A plan: the goal, its tasks, and what every session learned."
          />
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            <GuideLink slug="tasks-and-plans">Tasks and plans</GuideLink>
            {" · "}
            <GuideLink slug="orchestration">Orchestration</GuideLink>
          </p>

          {/* Triggers & workflows */}
          <Heading id="triggers" level={2}>Triggers &amp; workflows</Heading>
          <P>
            <strong>Triggers</strong> in the sidebar lists everything set to run later: one-time, recurring and event
            triggers. A rail across the top shows the last 24 hours of runs and the next 24 hours of fires. Agents set
            most triggers themselves, so this is where you see them, open a past run, or use <strong>Run now</strong> and{" "}
            <strong>Pause trigger</strong> on a row. <strong>New trigger</strong> takes a prompt and when it runs: now,
            in a set time, every interval, or on an event such as a pull request comment.
          </P>
          <Screenshot
            src="/docs/app/triggers.webp"
            alt="The Triggers page: a 24-hour rail of past runs and upcoming fires above the list of triggers"
            caption="Triggers: what runs later, and what already ran."
          />
          <P>
            <strong>Workflows</strong> holds multi-step runs with approval gates. Its <strong>Routines</strong>,{" "}
            <strong>Runs</strong> and <strong>Dynamic</strong> tabs show the graphs your team keeps, each run&apos;s progress, and
            multi-agent runs.
          </P>
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            <GuideLink slug="triggers">Triggers</GuideLink>
            {" · "}
            <GuideLink slug="workflows">Workflows</GuideLink>
          </p>

          {/* Documents */}
          <Heading id="documents" level={2}>Documents</Heading>
          <P>
            <strong>Docs</strong> holds specs, designs, investigations, handoffs and notes, written by you or by agents. The
            editor is shared: teammates&apos; cursors show as they type, and the comments rail (<Kbd>Ctrl+\</Kbd>) keeps
            discussion beside the text. Type <Kbd>@</Kbd> to mention a session, task, plan or person, and{" "}
            <Kbd>[[</Kbd> to link another doc; each mention shows its live status.
          </P>
          <Screenshot
            src="/docs/app/doc.webp"
            alt="A document open in the editor, with an inline mention of a task showing its status"
            caption="A document with live mentions of the work it describes."
          />

          {/* Chat & calls */}
          <Heading id="chat" level={2}>Chat &amp; calls</Heading>

          <Heading id="channels" level={3}>Channels</Heading>
          <P>
            <strong>Chat</strong> has your team&apos;s channels and direct messages, next to the sessions they talk about. Agents
            post there too: a session can announce what it shipped, and the team&apos;s own agent answers when someone
            mentions it.
          </P>
          <Screenshot
            src="/docs/app/chat.webp"
            alt="A team channel with posts from people and from agent sessions"
            caption="A channel where people and agents both post."
          />

          <Heading id="calls" level={3}>Calls</Heading>
          <P>
            Start a huddle from <strong>Calls</strong> in the sidebar or from the palette. Calls are transcribed by speaker, and each
            one ends with a title, a summary and its action items. The Calls page lists recent calls and what came of
            each action item: the task filed for it, who holds it, and the ones nobody picked up.
          </P>
          <Screenshot
            src="/docs/app/call.webp"
            alt="A finished call: its summary and action items above the transcript, with each line labeled by speaker"
            caption="A call after it ends: summary, action items and transcript."
          />
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            Chat and calls are team features, on for a new team. An admin turns either off under <strong>Features</strong> in{" "}
            <strong>Settings &gt; Team</strong>.{" "}
            <GuideLink slug="team-chat">Team chat</GuideLink>
            {" · "}
            <GuideLink slug="calls">Huddles, transcripts and walkie</GuideLink>
          </p>

          {/* Mobile */}
          <Heading id="mobile-app" level={2}>Mobile app</Heading>
          <P>
            The iPhone app has five tabs: <strong>Inbox</strong>, <strong>Chat</strong>, <strong>Tasks</strong>, <strong>Alerts</strong>{" "}
            and <strong>Settings</strong>. It pushes a notification when an agent needs you, and the tap opens that session.
          </P>

          <Heading id="mobile-inbox" level={3}>Inbox &amp; sessions</Heading>
          <div className="flex flex-col sm:flex-row gap-8 items-start my-6">
            <PhoneShot
              src="/docs/app/mobile.webp"
              alt="codecast on a phone: the inbox of sessions with their status and latest reply"
              caption="The inbox on iPhone."
            />
            <PhoneShot
              src="/docs/app/mobile-session.webp"
              alt="A session on a phone: the agent's latest reply, a permission card with Approve and Deny, and the composer"
              caption="A session waiting on a permission."
            />
          </div>
          <P>
            The inbox groups sessions the same way the web does. Open one to read the agent&apos;s replies, type into the
            composer to steer it, and approve or deny its permission requests. Decisions waiting on you open one at a
            time and move to the next when you answer.
          </P>

          <Heading id="mobile-download" level={3}>Download</Heading>
          <div className="flex flex-wrap gap-3">
            <AppBadge app="ios" location="documentation_mobile" />
            <AndroidSoonBadge />
          </div>

          {/* Teams */}
          <Heading id="teams" level={2}>Teams</Heading>

          <Heading id="team-setup" level={3}>Create or join a team</Heading>
          <P>
            Open <strong>Settings &gt; Team</strong> and click <strong>Create a team</strong>. Once it exists, an admin&apos;s{" "}
            <strong>Invite</strong> button opens <strong>Invite a teammate</strong>: copy the link or send an email, and anyone
            who opens it joins. Someone with an invite code clicks <strong>Join a team</strong> on the same page and enters
            it. The workspace switcher at the top left moves you between the team and your personal workspace, and
            has <strong>Create team</strong> and <strong>Join team</strong> too.
          </P>
          <Screenshot
            src="/docs/app/team-settings.webp"
            alt="Settings > Team: the team's members with their roles, and the invite controls"
            caption="Settings > Team: members, roles and invites."
          />

          <Heading id="team-sharing" level={3}>What your team sees</Heading>
          <P>
            Sessions are private until you share them, and joining a team shares nothing by itself. Open{" "}
            <strong>Settings &gt; Sync &amp; Privacy</strong> to choose, folder by folder, whether a project&apos;s sessions stay{" "}
            <strong>Only me</strong>, are shared with the team, or are set to <strong>Never share</strong>. Before it saves, each choice shows how many sessions it
            covers and whether past ones are included. To share a single session, use <strong>Share</strong> in its header.
          </P>
          <Screenshot
            src="/docs/app/sharing.webp"
            alt="Settings > Sync & Privacy: project folders, each with its sharing choice and session count"
            caption="Sync & Privacy: what syncs from this machine, and who sees it."
          />
          <P>
            Not sure what to share? <strong>Decide with an agent</strong> at the top of that page starts a session that looks
            through your folders, recommends a setting for each, and changes nothing until you agree.
          </P>
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            <GuideLink slug="team-sessions">See your whole team&apos;s sessions</GuideLink>
            {" · "}
            <GuideLink slug="share-a-session">Share a session</GuideLink>
          </p>

          {/* Integrations */}
          <Heading id="integrations" level={2}>Integrations</Heading>

          <Heading id="supported-tools" level={3}>Coding agents</Heading>
          <P>Codecast picks up sessions from these agents with no setup beyond connecting your computer:</P>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 my-4">
            {[
              { name: "Claude Code", color: SOL.orange },
              { name: "OpenAI Codex", color: SOL.green },
              { name: "Cursor", color: SOL.blue },
              { name: "Gemini CLI", color: SOL.magenta },
              { name: "OpenCode", color: SOL.violet },
              { name: "T3 Code", color: SOL.cyan },
            ].map((tool) => (
              <div key={tool.name} className="p-3 rounded-lg font-mono text-sm font-medium" style={{ backgroundColor: `${SOL.base2}80`, borderLeft: `3px solid ${tool.color}`, color: SOL.base03 }}>
                {tool.name}
              </div>
            ))}
          </div>
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            <GuideLink slug="opencode">OpenCode</GuideLink>
            {" · "}
            <GuideLink slug="t3-code">T3 Code</GuideLink>
            {" · "}
            <GuideLink slug="codex-cloud">Codex Cloud</GuideLink>
          </p>

          <Heading id="connected-apps" level={3}>GitHub, Slack &amp; more</Heading>
          <P>
            <strong>Settings &gt; Integrations</strong> has a card for each app with a <strong>Connect</strong> button and what the
            connection lets agents do. A connection belongs to the team you are looking at, or to you personally.
          </P>
          <ul className="list-disc pl-5 mb-4 space-y-1.5 text-sm" style={{ color: SOL.base00 }}>
            <li><strong>GitHub</strong>: run triggers when a pull request opens, gets a comment or merges, and import a repository&apos;s issues as tasks. Agents see only the repositories you pick at install.</li>
            <li><strong>Slack</strong>: post a summary to a linked channel, and answer in the thread when someone mentions the agent.</li>
            <li><strong>Linear</strong>: import a team or project, its issues as tasks, and write status and comments back.</li>
            <li><strong>Gmail</strong>, <strong>Notion</strong>, <strong>Sentry</strong> and <strong>PostHog</strong> each have a card of their own.</li>
          </ul>
          <Screenshot
            src="/docs/app/integrations.webp"
            alt="Settings > Integrations: cards for GitHub, Slack and Linear, each with a Connect button"
            caption="Settings > Integrations."
          />
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            <GuideLink slug="pull-requests">Pull requests and issues</GuideLink>
            {" · "}
            <GuideLink slug="triggers">Triggers</GuideLink>
          </p>

          {/* Mac app */}
          <Heading id="desktop-download" level={2}>Mac app</Heading>
          <P className="mb-4">
            Everything on this page works the same in the browser and in the Mac app. The Mac app adds native
            notifications, the global palette, and one-click setup of the background app that syncs your sessions.
          </P>
          <AppBadge app="mac" location="documentation_desktop" />

          {/* Guides */}
          <Heading id="guides" level={2}>Guides</Heading>
          <P className="mb-5">
            One feature at a time: what it does for you, how to turn it on, what to ask your agents, and what you will
            see when they use it.
          </P>
          {GUIDE_CATEGORIES.map((cat) => {
            const inCat = GUIDES.filter((g) => g.category === cat);
            if (inCat.length === 0) return null;
            return (
              <div key={cat} className="mb-6">
                <div className="text-mark font-mono uppercase tracking-wider mb-2.5" style={{ color: SOL.base01 }}>
                  {cat}
                </div>
                <div className="grid sm:grid-cols-2 gap-3">
                  {inCat.map((g) => <GuideCard key={g.slug} guide={g} />)}
                </div>
              </div>
            );
          })}

          {/* For agents and scripts */}
          <Heading id="cli" level={2}>For agents and scripts</Heading>
          <P>
            Connecting a computer also installs <InlineCode>cast</InlineCode>, a command-line tool. Your agents use it to search past
            sessions, file tasks, queue decisions and set triggers from their own terminal, and the switches in{" "}
            <strong>Agent Features</strong> decide which of these they know about. You never need to type it yourself. This
            section is for people who script codecast or want to see what their agents run.
          </P>

          <Heading id="cli-background" level={3}>The background app</Heading>
          <P>
            The install runs a small background app (the daemon) that watches your agents&apos; session files and syncs
            them as they change. It starts at login. <strong>Settings &gt; Devices</strong> and <strong>Settings &gt; Daemon</strong> show
            each machine, its version and its health. From a terminal:
          </P>
          <CmdTable>
            <CmdRow cmd="cast status" desc="Whether the daemon is running and what it has synced" />
            <CmdRow cmd="cast restart" desc="Restart it (also picks up an update)" />
            <CmdRow cmd="cast logs -f" desc="Follow its log" />
            <CmdRow cmd="cast auth" desc="Sign this machine in through the browser" />
            <CmdRow cmd="cast update" desc="Install the latest version" />
          </CmdTable>

          <Heading id="cli-reference" level={3}>Command reference</Heading>
          <P>The commands agents reach for most. Each takes <InlineCode>--help</InlineCode> for its flags.</P>
          {CLI_GROUPS.map((group) => (
            <div key={group.title} className="mb-5">
              <div className="text-mark font-mono uppercase tracking-wider mb-1" style={{ color: SOL.base01 }}>{group.title}</div>
              <CmdTable>
                {group.cmds.map(([cmd, desc]) => <CmdRow key={cmd} cmd={`cast ${cmd}`} desc={desc} />)}
              </CmdTable>
            </div>
          ))}

          <Heading id="editor-integration" level={3}>Editor blame</Heading>
          <P>
            <InlineCode>cast blame</InlineCode> is a drop-in <InlineCode>git blame</InlineCode> whose author column is the session, and
            person, that wrote each line. Two editor integrations sit on top of it, and both need the CLI signed in.
          </P>
          <P>
            <strong>VS Code and Cursor</strong>:{" "}
            <a href="https://dl.codecast.sh/codecast-blame.vsix" className="underline underline-offset-2" style={{ color: SOL.blue }}>download the extension</a>,
            then install it with <InlineCode>code --install-extension codecast-blame.vsix</InlineCode> (or <InlineCode>cursor</InlineCode>).
            It shows the session behind the current line at the end of the line; <Kbd>Cmd+Alt+B</Kbd> opens that conversation
            and <Kbd>Cmd+Alt+L</Kbd> lists the sessions that shaped the file.
          </P>
          <P>
            <strong>Vim and Neovim</strong> with vim-fugitive: run <InlineCode>cast blame --install-fugitive</InlineCode> and add{" "}
            <InlineCode>source ~/.codecast/fugitive.vim</InlineCode> to your vimrc. <InlineCode>:Git blame</InlineCode> then shows sessions,
            Enter on a line opens its conversation, and <InlineCode>:Gslog</InlineCode> lists the file&apos;s sessions.
          </P>
          <p className="text-sm mb-2" style={{ color: SOL.base01 }}>
            <GuideLink slug="which-session-wrote-this-line">See which agent session wrote a line</GuideLink>
          </p>

          {/* CTA */}
          <div className="mt-20 rounded-xl p-10 text-center" style={{ backgroundColor: SOL.base03 }}>
            <h2 className="text-2xl font-bold font-mono mb-3" style={{ color: SOL.base3 }}>Ready to get started?</h2>
            <p className="mb-6" style={{ color: SOL.base1 }}>Free for individuals. Sign up, then connect your computer.</p>
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
