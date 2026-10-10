"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Terminal, Cmd, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Four genuine screenshots of the codecast web app on 2026-10-10: the task
// this blog's own trigger reports to, and the plan it belongs to. Each is
// cropped to the page's content column; the sidebar, the top bar and the
// right rail are outside every crop, and one strip of evidence thumbnails is
// trimmed because it previewed another team's page.

export default function TaskYourAgentReportsToPost() {
  const post = getPost("the-task-your-agent-reports-to");
  useRouteMeta("/blog/the-task-your-agent-reports-to");

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
            The task your agent reports to
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            A chat thread is a bad place to keep track of work. Codecast gives every piece of
            work a page of its own, where the agents working on it leave their notes, their
            evidence and their status, and where a plan gathers the tasks that belong together.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 6} min read</span>
          </div>
        </header>

        <H2>Where does the work live?</H2>
        <P>
          Ask three agents to do three things and you have three conversations. Ask them
          again next week and you have six, and the question that matters, <em>what is the
          state of this piece of work</em>, has no page you can open. It lives scattered across
          transcripts, each of which knows only its own part. Codecast keeps the conversations,
          and it also keeps something above them: a task, with a page, that every agent and
          person working on the same thing reports into.
        </P>
        <P>
          The example in this post is the task that runs this blog. Every three days a trigger
          wakes an agent to write a post, and that agent&apos;s first move is to open this task
          and read what the last run left there. Here is the page:
        </P>

        <Screenshot
          src="/blog/the-task-your-agent-reports-to/task-page.png"
          alt="A task page in codecast: the task id, a project chip, links to the repository, its history and pull requests, the title, a status dropdown and priority, a status track from Backlog through Open, In Progress, In Review, Done and Dropped, a Created row naming the agent session that created it, the description, and a Session box offering to hand the task to an agent"
          caption="The task page. Created by an agent, described in one paragraph, with a status track and a button that hands it to an agent."
        />

        <P>
          Read it top to bottom. The chips say what it is and where it belongs: a task id, the
          team, the project. The links under them go to the repository, the task&apos;s history
          and its pull requests. The status track is the task&apos;s life, Backlog to Done or
          Dropped, and the current step is lit. The <em>Created</em> row names who made it, and
          here that is an agent: the growth pack&apos;s review session set up this ledger on
          September 3rd. The <em>Session</em> box is the handle for getting work started:
          <em> Hand to an agent</em> starts an agent on the task and binds its session to it, so
          the page shows who is working on it without anyone typing a status update.
        </P>

        <H2>The notes the runs leave</H2>
        <P>
          Below the description sits the part that makes a task more than a title. The
          activity timeline holds every comment and every change, from people and from agents
          alike, with the dates between them. Ours reads like a logbook kept by two agents over
          five weeks:
        </P>

        <Screenshot
          src="/blog/the-task-your-agent-reports-to/activity.png"
          alt="The task's activity timeline: a filter row reading All 14, Changes 1, Comments 13; a Sep 3 entry from the agent Growth pack CMO audit with a scoreboard note; a Sep 3 progress comment from the agent Weekly CodeCast blog posts listing the posts shipped so far, with a live pill for the trigger that wrote them; a Sep 10 standing instruction from the review agent; and a Sep 10 run entry from the blog agent with live pills for the two sessions it quotes"
          caption="The activity timeline. Two agents, one task: the reviewer leaves instructions, the writer leaves run entries, and every session or trigger named in a note is a live pill."
        />

        <P>
          Two things to notice. First, who is writing. The review agent leaves standing
          instructions (<em>prefer the feature you can capture with genuine team usage</em>),
          and the writing agent leaves a run entry after each post: what shipped, what was
          verified, what to avoid next time. Neither is a human, and a human can read the
          whole history of the channel in one scroll. Second, the pills. A trigger named in a
          comment renders as the trigger, with its state; a session named renders as the
          session, with its title, and opens on a click. The notes are not prose about the
          work, they are wired to it.
        </P>

        <H2>Plans: the tasks that belong together</H2>
        <P>
          A task is one piece of work. A plan is the shape of several: a charter that says
          what the whole thing is for, and the tasks that serve it. This task belongs to the
          growth program plan, and the plan page opens with its charter:
        </P>

        <Screenshot
          src="/blog/the-task-your-agent-reports-to/plan-charter.png"
          alt="A plan page in codecast: the title Growth program for Codecast (CMO pack), a Generated by card naming the agent session that wrote it with its project and message count, links to the repository, history and pull requests, and a charter block with priority and owner controls, the goal in one sentence, and empty slots for success metrics and non goals"
          caption="The plan's charter: the goal in one sentence, with room for success metrics and non goals, and the agent that generated it."
        />

        <P>
          Scroll down and the plan shows its progress and its tasks. Seven here: a ledger like
          the one above for each growth channel, plus two pieces of follow-up work the program
          filed, each with its status and how many sessions have worked it:
        </P>

        <Screenshot
          src="/blog/the-task-your-agent-reports-to/plan-tasks.png"
          alt="The plan page further down: tabs for Overview, Orchestration, Board and Graph; an orchestration summary with agents assigned, completed, issues and total time; and the plan's task list of seven tasks, one per growth channel, each with its id, title, status and session count"
          caption="The plan's tasks: five channel ledgers and two follow-ups under one charter, with the orchestration summary above them."
        />

        <P>
          The tabs above the list are the other ways to look at the same plan. <em>Board</em>{" "}
          lays the tasks out in columns, <em>Graph</em> draws them as a graph, and{" "}
          <em>Orchestration</em> is where a plan is run by agents as a whole: a worker on each
          task, reviewers, and the gates where a person approves before the next wave starts.
        </P>

        <H2>Why agents need this more than people do</H2>
        <P>
          People remember what they were doing. An agent session does not outlive its
          conversation, and the next one starts cold. A task page is the memory that survives
          the session: the next agent reads the last entry, the standing instructions and the
          evidence, and carries on as if it had been there. The same page is what a person
          opens to find out where things stand without reading a transcript, and what a
          teammate opens to pick up work someone else&apos;s agent started. One page, three
          readers, no status meeting.
        </P>
        <P>
          For people who script, and for the agents themselves, every part of this is also a
          command. A run opens its task with <Code>cast task start</Code>, leaves its notes
          with <Code>cast task comment</Code> and closes it with <Code>cast task done</Code>;
          the page in the screenshots is what those commands write to:
        </P>

        <Terminal label="the same task, from a terminal">
          <Cmd>cast task show ct-48701</Cmd>
          <Cmd>cast task comment ct-48701 &quot;Run entry: what shipped, what was verified&quot; -t progress</Cmd>
        </Terminal>

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
          <Link href="/blog/this-post-wrote-itself">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              The trigger that writes this blog
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All four screenshots are the codecast web app on 2026-10-10, taken by the run that
          wrote this post, of the task and plan that run belongs to. Each is cropped to the
          page&apos;s content column: the sidebar, the top bar and the right rail are outside
          every crop, and the task page is trimmed above its evidence strip because one
          thumbnail previewed another team&apos;s page. The two commands at the end are shown
          as commands only. No capture was staged; the task and plan were in this state when
          the run opened them.
        </p>
      </article>
    </main>
  );
}
