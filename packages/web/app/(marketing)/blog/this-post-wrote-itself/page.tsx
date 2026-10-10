"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// The trigger card and dashboard screenshots were taken on 2026-08-22 by a run
// of trigger tr-39, the run that wrote this post. The New trigger form was
// captured on 2026-10-09.

export default function ThisPostWroteItselfPost() {
  const post = getPost("this-post-wrote-itself");
  useRouteMeta("/blog/this-post-wrote-itself");

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
            This post wrote itself (on a schedule)
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Codecast triggers run full agent sessions on a timer. The proof is this blog:
            last week&apos;s post and this one were both written, unattended, by runs of the
            same weekly trigger.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "August 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>Work that has a cadence</H2>
        <P>
          Some work is not a task; it is a rhythm. Check the ads spend every morning. Sweep for
          stalled sessions daily. Verify the site still renders for crawlers once a week. Write
          a blog post every Friday. Nobody forgets this work because it is hard — they forget it
          because it is <em>periodic</em>, and human attention is terrible at periodic.
        </P>
        <P>
          The classic answer is cron, and cron runs scripts. A script can check a number and
          send an alert. It cannot read yesterday&apos;s campaign performance and decide which
          keywords to adjust, or notice that a verification failed and investigate why. A
          codecast trigger is cron for agents: on schedule, it starts a real agent session —
          tools, judgment, the full CLI — pointed at a briefing you wrote once.
        </P>

        <H2>The trigger that wrote this post</H2>
        <P>
          On August 8th we gave codecast a standing instruction: every seven days, write a blog
          post that shows off one feature, with real captures, and escalate if anything fails
          verification. Here is that trigger in the dashboard, photographed mid-run by the
          run that wrote it, a few minutes before these words were written:
        </P>

        <Screenshot
          src="/blog/this-post-wrote-itself/trigger-card.png"
          alt="The Weekly blog post trigger card in the codecast Triggers page, showing its every-7-days cadence, next run time, two past runs, and the prompt briefing with numbered steps"
          caption="Trigger tr-39. Run #1 wrote last week's post. Run #2, six minutes old, is taking the screenshot."
        />

        <P>
          The anatomy is all visible. A cadence (<Code>every 7d</Code>) and the exact next
          firing time. A run count with history — run #1, seven days ago, wrote the post about
          team memory; run #2 is this one, six minutes old at capture time. And the prompt,
          rendered as markdown, because the prompt is not a config string: it is the
          agent&apos;s entire briefing, and humans read it in the dashboard to know what their
          robot colleague has been told to do. Ours names the candidate features, the honesty
          rules for captures, a privacy gate for screenshots, and the verification steps that
          must pass before the post counts as done.
        </P>
        <P>
          Setting one up is a short form. On the <em>Triggers</em> page, <em>New trigger</em>{" "}
          opens it at the top:
        </P>

        <Screenshot
          src="/blog/this-post-wrote-itself/new-trigger.png"
          alt="The New trigger form on the codecast Triggers page: a Prompt box, an optional Title, When with the choices now, in, every and on event, an Agent choice of claude or codex with a read-only checkbox, an optional Project path, and a Set trigger button"
          caption="New trigger: what the agent should do, when, with which agent, and whether it may change anything."
        />

        <P>
          The <em>When</em> row holds the three shapes. A delay (<em>in…</em>) is follow-up
          work that should happen after you walk away. An event (<em>on event</em>, such as a
          pull request opening or its checks going red) fires when the world changes, not when
          the clock does. A cadence (<em>every…</em>) is the weekly blog post. Tick{" "}
          <em>read-only: report, don&apos;t change anything</em> and the run can look and
          report, not act. A trigger&apos;s runs can continue one session with its full
          history, or start a fresh session each time, briefed only by the prompt; the list
          marks the second kind <em>Fresh session per run</em>. Agents set the same triggers
          from a terminal with <Code>cast trigger add</Code>, which is how most of ours were
          made: an agent finishing a job arms its own follow-up.
        </P>

        <H2>Each run is a session, not a log line</H2>
        <P>
          When a trigger fires, what you get is not a cron mail. It is a full session that
          lands in your inbox like any other agent&apos;s work — watchable live, steerable
          mid-run, searchable forever. Open a trigger and its page lists every run under{" "}
          <em>Run history</em>; click a run and you are in its session, at the message the
          trigger sent.
        </P>
        <P>
          When we captured this page, the newest row in that history was one minute old: this
          run, the session writing this sentence. By the time you read this, its transcript
          shows every step behind every capture on this page. That is the part cron never gave
          you: when a scheduled job does something surprising, the full reasoning is one click
          away.
        </P>
        <P>
          The contract runs both directions. A run that finishes reports a summary, which
          becomes the last-result line on the trigger&apos;s row, so the list of triggers
          doubles as a status board. A run that gets stuck files itself under <em>needs input</em> in your
          inbox, exactly like any blocked agent. Quiet when things work, loud when they
          don&apos;t.
        </P>

        <H2>A team of standing agents</H2>
        <P>
          One trigger is a convenience. A dozen is something else: a roster of recurring jobs
          your team used to carry in their heads, each now owned by an agent with a briefing
          and a paper trail. This repository&apos;s list, the day this post was written, had
          an ads optimization run every day, this blog every week, and a crawler health check
          every week, its last-result line already reporting <em>all green</em> from its latest
          run. The top of the page draws the whole roster as a timeline, every run in the
          next and last twenty-four hours on one axis:
        </P>

        <Screenshot
          src="/blog/this-post-wrote-itself/trigger-header.png"
          alt="The Triggers page header showing 18 active triggers, 15 recurring, 3 one-time, next run in 11h 58m, 1077 total runs, health ok, and a 24-hour timeline of past and upcoming runs"
          caption="The account's trigger dashboard at capture time: 1,077 runs to date, next one in about twelve hours."
        />

        <P>
          One thousand and seventy-seven runs. Each one was a moment somebody did not have to
          remember something.
        </P>

        <H2>The loop closes</H2>
        <P>
          There is something pleasingly circular about a scheduled agent writing the post that
          explains scheduled agents, photographing its own briefing, and citing its own run
          history as evidence. But the circularity is the point. The feature is not
          &ldquo;agents can run on a timer&rdquo; — it is that recurring work can be delegated
          whole: the doing, the verifying, and the reporting back. If this post had failed its
          checks, the run would have escalated instead of publishing, and you would be reading
          silence.
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
          The trigger card and the dashboard header are genuine screenshots taken on 2026-08-22
          by a run of trigger <Code>tr-39</Code>, the run that wrote this post, minutes after
          it started; the card is cropped, and its prompt continues past the crop. In the run
          history, #2 is the capturing run itself, listed mid-flight at six minutes old. The
          roster described above is the codecast repository&apos;s share of the trigger list
          that day. The New trigger form was captured empty on 2026-10-09 and cancelled.
        </p>
      </article>
    </main>
  );
}
