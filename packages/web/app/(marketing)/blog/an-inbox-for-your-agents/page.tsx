"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// The counts in "One bit per session" are from the author's inbox on
// 2026-08-08, filtered to the codecast repository. Both screenshots were taken
// the same morning by the agent session visible in them.

export default function AnInboxForYourAgentsPost() {
  const post = getPost("an-inbox-for-your-agents");
  useRouteMeta("/blog/an-inbox-for-your-agents");

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <BlogNav />

      <article className="max-w-2xl mx-auto px-6 pt-16 pb-24">
        <Link href="/blog" className="inline-flex items-center gap-1 text-sm font-medium mb-8" style={{ color: SOL.yellow }}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Blog
        </Link>

        <header className="mb-10">
          <h1 className="text-4xl md:text-5xl font-bold leading-[1.12] tracking-tight font-mono" style={{ color: SOL.base03 }}>
            An inbox for your agents
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Agents don&apos;t fail loudly. They finish, or stall, and wait for you to notice. The
            inbox makes the waiting visible — every session, every machine, sorted by who needs
            you.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "August 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>The tab problem</H2>
        <P>
          One agent is easy. You sit in the terminal and watch it work. Then you start a second
          one, because the first is busy and you have more to do. By the time you run four or
          five in parallel — some on your laptop, some on the desktop upstairs — a new job has
          quietly appeared in your day: cycling through terminals asking each one,{" "}
          <em>do you need me?</em>
        </P>
        <P>
          The expensive part is not the checking. It is what happens when you don&apos;t. An
          agent that hit a permission prompt at 2:14 sits frozen until you find it at 2:51. An
          agent that finished an hour ago holds a result you haven&apos;t read. Agents
          don&apos;t page you; they wait. Every minute one waits on an answer you could have
          given instantly is a minute of parallelism you paid for and didn&apos;t get.
        </P>

        <H2>One bit per session</H2>
        <P>
          To triage a fleet you need exactly one bit per session: is the ball in your court?
          Codecast computes that bit continuously, for every session, and calls it{" "}
          <Code>needs input</Code>. A session needs input when its agent finished the turn and
          stopped, asked you a question, hit a permission prompt, or died with output you
          haven&apos;t seen. Everything else is <Code>working</Code> — which means: leave it
          alone.
        </P>
        <P>
          That bit is what turns a pile of terminals into an inbox. Not a log of what
          happened, but a queue of what needs you, with everything else out of the way. In the
          inbox it decides where each card sits: anything that asked you a question goes to
          the top, then <em>Needs Input</em>, then the sessions that are <em>Working</em>, and
          below them the <em>Dormant</em> ones, parked until a timer or another session wakes
          them, each with a line saying what it is waiting for.
        </P>
        <P>
          On the morning this post was written, the codecast repository&apos;s share of that
          inbox read fifteen needing input and five working. One of the five, titled{" "}
          <em>Weekly CodeCast blog posts</em>, was the session writing this post. It filed
          itself under a task, showed up in its own inbox, and counted the queue while it
          worked. (A terminal gets the same grouping from <Code>cast sessions</Code>.)
        </P>

        <H2>Every machine, one surface</H2>
        <P>
          The inbox is the same on the web, on the desktop app and on your phone. The codecast
          daemon watches sessions where they run, in your terminals, on each of your machines,
          so everything lands in one place as it happens: Claude Code, Codex, Cursor, Gemini, laptop and desktop alike. Each card
          carries a title and a running summary the agent keeps current, so you can tell from
          the list what happened while you were gone:
        </P>

        <Screenshot
          src="/blog/an-inbox-for-your-agents/workspace-feed.png"
          alt="The codecast web app showing a workspace feed of agent sessions with titles, summaries, and message counts"
          caption="The codecast workspace, one morning of real sessions — 29 sessions, 7.3k messages."
        />

        <P>
          That is one repository&apos;s view from one real morning: an install flow redesign, an
          image sharing feature, a release deploy, analytics work — each a separate agent, most
          of them running while the others ran.
        </P>

        <H2>Open one and steer</H2>
        <P>
          A card opens into the full conversation, live — the transcript streams as the agent
          works, with the files it changed one click away. At the bottom there is a message box,
          and this is the part that changes how you run agents: what you type lands in the
          agent&apos;s terminal as its next turn. Answer the question it was stuck on. Redirect
          it. Hand it the next task. From the web, or from your phone on the couch — the agent
          neither knows nor cares that the reply didn&apos;t come from the keyboard its terminal
          is attached to.
        </P>

        <Screenshot
          src="/blog/an-inbox-for-your-agents/conversation.png"
          alt="A codecast conversation view showing an agent's report with a session reference chip and a reply box"
          caption="Inside a session: the agent reports, links the follow-up session it spawned, and waits."
        />

        <P>
          This session is mid-handoff: the agent finished an analytics funnel, spawned a second
          session to fix what remained, linked it in its report — the small{" "}
          <em>Session start</em> chip — and told the user where results would land:{" "}
          <em>&ldquo;It will report to your inbox.&rdquo;</em> Sessions referencing sessions,
          agents filing work for other agents, all of it landing in the same queue you triage.
        </P>
        <P>
          Any session you can see, you can steer. Agents and scripts get the same two verbs
          from a terminal: <Code>cast read</Code> for a transcript, <Code>cast send</Code> to
          land a message in another agent&apos;s terminal, wherever it runs.
        </P>

        <H2>Agents watch it too</H2>
        <P>
          The inbox is live. A card moves the moment its session changes state: you answer a
          question and the card slides from <em>Needs Input</em> back to <em>Working</em>{" "}
          before you have looked away. Agents can subscribe to the same changes. An
          orchestrating agent watches its workers with <Code>cast sessions -w --json</Code>,
          which prints one line per state change and nothing otherwise, reads whichever worker
          stopped, and sends it the next step. We ran that watch for ninety seconds while
          drafting this section; it printed exactly one line, a session flipping from needs
          input back to working the moment it was answered. The same inbox that lets you steer
          five agents lets an agent steer fifty, and their workers nest under its card in yours.
        </P>
        <P>
          Either way, the contract is the same: nothing waits unseen. A fleet of agents is only
          as fast as the human — or agent — who unblocks it, and unblocking starts with knowing
          who is blocked.
        </P>

        <blockquote
          className="my-8 border-l-2 pl-5 text-xl leading-relaxed font-mono"
          style={{ borderColor: SOL.yellow, color: SOL.base03 }}
        >
          Codecast is where your team sees, steers, and remembers every coding agent session — any
          agent, any machine.
        </blockquote>

        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link href="/signup">
            <Button size="lg" className="text-white text-base px-8 h-12 font-medium" style={{ backgroundColor: SOL.base03 }}>
              Start free
            </Button>
          </Link>
          <a href="https://github.com/codecast-sh" target="_blank" rel="noopener noreferrer">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              View on GitHub
            </Button>
          </a>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          Both screenshots and the inbox counts are genuine, from the author&apos;s account on
          2026-08-08, taken by the agent session visible in them. The counts are filtered to
          sessions from the codecast repository; the screenshots are cropped to the app&apos;s
          content area.
        </p>
      </article>
    </main>
  );
}
