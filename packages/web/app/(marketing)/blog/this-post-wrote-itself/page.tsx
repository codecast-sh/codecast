"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, BlogFooter, Terminal, Cmd, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Genuine `cast` output captured on 2026-08-22, a few minutes into a run of
// trigger tr-39 — the run that wrote this post. The `cast trigger ls` excerpt is
// trimmed to codecast triggers; every omission is marked with an editorial "…".

const TRIGGER_LS = `  tr-34   scheduled   Google Ads: codecast campaign daily optimization  every 1d
           Reviews yesterday's Google Ads performance (impressions, clicks, spend) and makes small adjustments

  tr-39   scheduled   Weekly blog post  every 7d
           Write and publish a new blog post showcasing an uncovered codecast feature with real terminal output

  tr-120  scheduled   Weekly SEO + AI citations  every 7d
           Verify codecast.sh renders correctly for search engines, track AI citation performance, respond to b
           last: Health: all green (prod crawler HTML with h1 on all 4 spot-checks, sitemap XML,

…  15 more triggers
`;

const TRIGGER_LOG = `Last run conversation: jx76eg3as339k77x4zvqrwgv758c29tv (Weekly CodeCast blog posts)
Ran 1m ago
Use: cast read jx76eg3as339k77x4zvqrwgv758c29tv
`;

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
          Setting one up is one command. The prompt can be a single line or a full markdown
          briefing from stdin:
        </P>

        <Terminal label="cast trigger — the shapes">
          <Cmd>cast trigger add &quot;Check if CI is green on main&quot; --in 30m</Cmd>
          <Cmd>cast trigger add &quot;Respond to new PR review comments&quot; --on pr_comment</Cmd>
          <Cmd>cast trigger add &quot;Review open PRs and summarize findings&quot; --every 4h --spawn</Cmd>
        </Terminal>

        <P>
          Three shapes: a delay (<Code>--in 30m</Code> — follow-up work that should happen
          after you walk away), an event (<Code>--on pr_comment</Code> — fire when the world
          changes, not when the clock does), and a cadence (<Code>--every 4h</Code>). By
          default a trigger&apos;s runs continue an existing session with its full history;{" "}
          <Code>--spawn</Code> starts a fresh session per run instead, briefed only by the
          prompt. Add <Code>--safe</Code> and the run is read-only — it can look and report,
          not act.
        </P>

        <H2>Each run is a session, not a log line</H2>
        <P>
          When a trigger fires, what you get is not a cron mail. It is a full session that
          lands in your inbox like any other agent&apos;s work — watchable live, steerable
          mid-run, searchable forever. From the terminal:
        </P>

        <Terminal label="cast trigger log" wrap>
          <Cmd>cast trigger log tr-39</Cmd>
          {TRIGGER_LOG}
        </Terminal>

        <P>
          <em>Ran 1m ago</em> — that is this run, reporting on itself. The session it names is
          the one writing this sentence, and by the time you read this, its transcript will
          show every command behind every capture on this page. That is the part cron never
          gave you: when a scheduled job does something surprising, the full reasoning is one{" "}
          <Code>cast read</Code> away.
        </P>
        <P>
          The contract runs both directions. A run that finishes calls{" "}
          <Code>cast trigger complete</Code> with a summary, which becomes the{" "}
          <Code>last:</Code> line on the trigger card — so the list of triggers doubles as a
          status board. A run that gets stuck files itself under <em>needs input</em> in your
          inbox, exactly like any blocked agent. Quiet when things work, loud when they
          don&apos;t.
        </P>

        <H2>A team of standing agents</H2>
        <P>
          One trigger is a convenience. A dozen is something else: a roster of recurring jobs
          your team used to carry in their heads, each now owned by an agent with a briefing
          and a paper trail. Here are this repository&apos;s, from <Code>cast trigger ls</Code>:
        </P>

        <Terminal label="cast trigger ls" wrap>
          <Cmd>cast trigger ls</Cmd>
          {TRIGGER_LS}
        </Terminal>

        <P>
          Ads optimization daily, blog weekly, crawler health weekly — and the SEO
          trigger&apos;s <Code>last:</Code> line already reporting <em>all green</em> from its
          latest run. The dashboard draws the same roster as a timeline, every run in the next
          and last twenty-four hours on one axis:
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
          Both screenshots and both terminal captures are genuine, taken on 2026-08-22 by a run
          of trigger <Code>tr-39</Code> — the run that wrote this post — minutes after it
          started. The <Code>cast trigger ls</Code> excerpt is trimmed to triggers for the
          codecast repository, with the omission marked <Code>…</Code>; the trigger card
          screenshot is cropped to the card, and its prompt continues past the crop. The
          example <Code>cast trigger add</Code> commands are shown as commands only, without
          output. In the run history, #2 is the capturing run itself, listed
          mid-flight at six minutes old.
        </p>
      </article>

      <BlogFooter />
    </main>
  );
}
