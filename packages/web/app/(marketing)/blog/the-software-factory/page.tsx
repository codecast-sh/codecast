"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Screenshot, SOL, H2, P, Code, Figure } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";
import { FactoryFigure, FigureStyles, LoopFigure } from "./figures";

// Genuine screenshots of the Codecast web app (a local build of this repo,
// signed in to the founder's account) in Chrome on 2026-11-15, all from the
// Codecast team's own workspace. The Flows views (Loop, sources, the Codecast
// fix flow) were drawn at 1500px wide so their text reads in the column; the
// components and data are as the app renders them. The decision is sd-3295,
// the card of run th70m5ab on problem ct-73216, open and unanswered when shot.
// Its story (three error groups, two causes, prove 2 of 3 failing on base,
// review round 1 changes on 3 of 5 criteria, round 2 approved) is from the
// task's own comments and the run record. The Ship popover is the header of
// the session that wrote this post, closed without shipping. Mechanics were
// checked against docs/architecture (the-line-end-to-end.md, the-line-model.md,
// flows.md) and packages/cli/src/workflow/templates. Nothing was composited or
// retouched.

const DIR = "/blog/the-software-factory";

export default function SoftwareFactoryPost() {
  const post = getPost("the-software-factory");
  useRouteMeta("/blog/the-software-factory");

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <BlogNav />
      <FigureStyles />

      <article className="max-w-2xl mx-auto px-6 pt-16 pb-24">
        <Link href="/blog" className="inline-flex items-center gap-1 text-sm font-medium mb-8" style={{ color: SOL.yellow }}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Blog
        </Link>

        <header className="mb-10">
          <h1 className="text-4xl md:text-5xl font-bold leading-[1.12] tracking-tight font-mono" style={{ color: SOL.base03 }}>
            The software factory
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            {post?.dek}
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "November 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 11} min read</span>
          </div>
        </header>

        <H2>Writing the code is the fast part</H2>
        <P>
          A coding agent can fix a bug in fifteen minutes. Everything around those fifteen minutes
          is still slow. Someone has to notice the bug, in an error tracker or a failing check or a
          customer&apos;s message. Someone has to decide it matters more than the forty other
          things in the tracker, show that it is real, check the fix, read it, ship it, and look
          again a week later to see whether it stayed fixed. Give a team ten agents and the agents
          wait on the people doing all that.
        </P>
        <P>
          Codecast runs that whole path as one machine. Your product&apos;s errors, analytics,
          checks and evals come in as signals. Signals that share a root become one problem. A
          flow your team owns picks up problems in order of what they threaten, proves each one
          with a failing test, builds the fix, checks and reviews it, and brings you one card. You
          answer it. The change ships, and the factory watches for the same signal to come back.
          We call it the factory. This post walks through it on our own product, with one real
          change from start to finish.
        </P>

        <Figure wide caption="The factory. Many signals collapse into a few problems; each problem is proven, built, checked and reviewed before it reaches you; a shipped fix is watched, and a signal that comes back reopens it.">
          <FactoryFigure />
        </Figure>

        <H2>The whole loop on one screen</H2>
        <P>
          The <strong>Flows</strong> page opens on the loop. This is Codecast&apos;s own, the
          workspace our team ships Codecast from.
        </P>

        <Screenshot
          src={`${DIR}/factory-loop.png`}
          alt="The Loop view on Codecast's Flows page. The header reads Live, Codecast fix flow, On, 50 queued, 2 started today. A row of panels reads Sources to watch 5 feeding 1 silent 2 not filed, Goals and owners 2 owners 5 projects, Skills 9 prompts, Review and gates 2 checks 1 person gate, Autonomy 0 of 2 roles merge without a person. Below, five numbered stages: 1 Signals, 63 today, from Eval reds 43, codecast-web 10, Lessons 6, github-ci failing checks 3, codecast-posthog metric alerts 1. 2 Triage, with a person's session that ships through a flow above the line from signals, 50 queued, 245 open. 3 Build, 4 on a person. 4 Checks, the same checks for every change: Check, Review, Decide. 5 Ship and watch: Land, Deploy 46 live today 13 failed, Watch, Production. Under all of it, Back to signals, nothing came back."
          caption="Codecast's own factory. Five stages, left to right, and the way back to signals underneath."
          wide
        />

        <P>
          Read it left to right. <strong>Signals</strong> lists what came in today and from where.{" "}
          <strong>Triage</strong> holds the problems those signals opened, in a queue.{" "}
          <strong>Build</strong> is where a flow works on one. <strong>Checks</strong> is the same
          three gates for every change, whoever made it. <strong>Ship and watch</strong> lands it,
          follows the deploy, and watches production. The row along the bottom closes the loop: a
          shipped fix whose signal comes back goes back to the start.
        </P>
        <P>
          The panels above the stages are the factory&apos;s settings, each one opening where
          it&apos;s edited: which sources it watches, whose goals rank the work and who owns each
          area, the prompts its agents run, its review gates, and how much it may do without a
          person.
        </P>

        <H2>Sources: what the factory listens to</H2>
        <P>
          A source is anything that observes your product: the error tracker, product analytics,
          your CI, the nightly evals. Each one sends what it saw through one door, already typed
          (a bug, a regression, a prompt that gave a wrong answer) and with a fingerprint it
          computes itself, such as the error group or the eval scenario. Nothing downstream tries
          to guess what a line of free text meant.
        </P>

        <Screenshot
          src={`${DIR}/sources.png`}
          alt="Codecast's sources table: 4 flowing, 1 silent, 2 not filed. Under Product health: codecast-web, issues the sdk source codecast-web opens, 10 today, goes to Codecast fix flow, 96 never filed, 184 problems in 30 days. Eval reds, an eval scenario turns red, 43 today, goes to Codecast fix flow, 88 problems. codecast-backend, last seen 27 days ago, marked silent. codecast-posthog, 0 today. codecast-posthog metric alerts and github-ci failing checks, marked Not filed. Under AgentWatch itself: Lessons, a lesson a finished run wrote down, 6 today, 23 problems."
          caption="Codecast's sources: how much each sent in 14 days, where its signals go, and what became of their problems."
          wide
        />

        <P>
          Each row says whether the source is still talking (codecast-backend has been quiet for 27
          days, so it is red), how much it sent, which flow its signals go to, and what happened to
          the problems it opened over the last month. A source whose signals no flow takes says{" "}
          <strong>Not filed</strong>, so a feed nobody acts on is visible instead of silently
          piling up. The last row is the factory listening to itself: <strong>Lessons</strong> are
          what a finished run wrote down after a person sent its change back, which we come to
          below.
        </P>

        <H2>Problems: many signals, one root</H2>
        <P>
          An error tracker reports far more than anyone works on. So a signal opens nothing by
          itself. It first looks for a problem that already holds its fingerprint. Failing that,
          one small model call compares it with the five closest open problems and answers
          &ldquo;same as this one&rdquo; or &ldquo;none&rdquo;. Only when a source is set to open
          problems, or a person files it, does a new one start. Everything else waits as evidence,
          and counts toward a problem later.
        </P>
        <P>
          A new problem is then grounded: one call reads it with your team&apos;s goals and each
          project&apos;s charter, and writes down which goal it threatens, what kind of change it
          needs (code, prompt, interface, infrastructure, data), how risky it is, and whether it
          is ready to work on. Priority is arithmetic on those answers: the goal&apos;s priority
          times the severity times the number of signals. A problem that threatens no goal waits.
          Our flow also has a bar: it starts problems scoring 60 or more, or holding three
          findings; the rest wait for another finding and close after 14 quiet days.
        </P>

        <H2>Flows: who runs the work, and how</H2>
        <P>
          A flow is the sequence of steps a problem goes through, and it belongs to a role on your
          team, the way an area of the product does. Turned on, it starts problems from its queue
          by itself, highest priority first, whenever one of the machines it runs on has a free
          slot. It can be held for a few hours, capped at so many starts a day, and switched off
          with one press.
        </P>

        <Screenshot
          src={`${DIR}/fix-flow.png`}
          alt="The Codecast fix flow's page. Its steps are drawn in two rows: Ground, Plan, Analyze, Prove, Red, Implement, then Verify, Green, Eval, Review, Card draft, Present, Card, with side routes under each such as Park, Dissolve, Unproven, still failing back to Implement, changes back to Implement, Rejected. Below: Extends Standard; Changes, a list of the prompts and scripts it changed; Takes a task. Then Changes run through it, 22, with rows such as Waiting at Decide for a CONVEX dispatch error, Should teams with chat off stop being offered a chat that always fails, and Failed at Prove, Prove is waiting on a person."
          caption="Codecast's fix flow: its steps, what it changes from the standard flow, and the changes that ran through it."
          wide
        />

        <P>
          Our flow starts by <strong>proving</strong> the problem. For code, that means a test
          that fails on the current code for the reason the problem describes. For a prompt, it
          means replaying the moments that went wrong and showing the current prompt gets them
          wrong while getting a few guard cases right. <strong>Red</strong> runs that proof and
          requires it to fail. A problem that cannot be reproduced closes as dissolved, which
          counts as a success: nothing was built for a problem that isn&apos;t there. A problem
          that cannot be proven either way stops and waits for a person, which is what most of
          the red &ldquo;Failed at Prove&rdquo; rows above are.
        </P>
        <P>
          Then <strong>Implement</strong> builds one change, inside a size budget.{" "}
          <strong>Verify</strong> runs the project&apos;s checks, <strong>Green</strong> runs the
          proof again and requires it to pass, and <strong>Eval</strong> replays the affected
          prompts against the old and new version when the change touches one.{" "}
          <strong>Review</strong> is a separate agent that sees only the diff and the
          problem&apos;s criteria, and a failure at any of these goes back to Implement. Last,{" "}
          <strong>Present</strong> writes the card you will read.
        </P>
        <P>
          A flow is a file in your repository, reviewed and versioned like your code. Ours extends
          the standard one and changes most of its prompts and scripts, and the page lists exactly
          which. Every change that ran through it is listed under it, with where it stands.
        </P>

        <H2>One change, from an error to your card</H2>
        <P>
          Here is one of those rows from start to finish. Our web app had been reporting a server
          error from chat: three error groups, ten reports. The factory merged them into one
          problem, and the analysis found two causes. Clicking the chat button on a conversation
          in a team with chat turned off asked the server for a conversation it would always
          refuse. Separately, marking a chat as read failed when the last message had been
          deleted. Both ended in a red error toast for the person, and a report for us.
        </P>
        <P>
          Prove wrote a test file with three cases, one per cause plus a guard that chat still
          opens where it is turned on. On the current code it failed two of three, the two
          causes. Implement fixed both in the web app, about thirty lines. Review sent it back:
          the fix met two of the five criteria the problem had been given, and left the server
          side alone. The second round changed thirteen files, including the server, every place
          in the web and mobile apps that opens a chat, and a regression test that real failures
          still reach the error tracker. Review approved it, and Present wrote this card.
        </P>

        <Screenshot
          src={`${DIR}/card-question.png`}
          alt="Decision sd-3295, waiting on Ashot Petrosian, from the Codecast fix flow. The question: Should teams with chat off stop being offered a chat that always fails, and should a read mark on a deleted message stop raising an error? The summary says what people saw, what the change does, the cost (a deleted mark now counts newer messages as read too), and recommends shipping because 18 error reports stop and no working feature is lost. A panel titled What people got: an error for something they never asked for shows the exact toast text next to With the change: no chat button is drawn in a team with chat off. A row of linked objects reads Error eg-3067, a signal, Problem ct-73216, Run, Asks you sd-3295."
          caption="The card for that change, waiting on our founder as this was written. The row of links is the whole trace, from the error to this question."
        />

        <P>
          Three things about this card are deliberate. The question is about people, not code:
          whether teams with chat off should stop being offered a chat that always fails. The
          summary names the cost of saying yes, that a read mark on a deleted message now counts
          newer messages as read. And the panel shows what people actually saw, the exact toast,
          next to what they see after. Where the card could not show something, it says so: no
          screen was captured, because the local app did not finish loading. The code, the
          diff and the test runs sit one click further in, for whoever wants them.
        </P>
        <P>
          The row of links under it is the trace. The error report, the signal it became, the
          problem, the run and the card each open in one click, so a question about why this
          change exists is answered by following the row, not by asking around.
        </P>

        <Screenshot
          src={`${DIR}/card-options.png`}
          alt="The card's options. 1, recommended: Ship: no chat entry points in chat-off teams, stale read marks accepted quietly; covers 18 error reports from 4 report groups; 12 of 12 tests pass. 2: Keep the server as is and only silence the two errors in the app; nothing ships yet; a deleted read mark leaves the old mark standing. 3: Drop: leave it; nothing ships; chat-off teams keep seeing the toast, last reported 10 days ago. Below: Or answer in your own words, Pass to, Escalate, Dismiss."
          caption="Each answer says what happens if you pick it. The engineering lead, an agent role, recommends the first."
        />

        <P>
          Every option says what follows from it: what ships, how many reports it covers, what
          stays broken. The engineering lead, an agent that owns this area, reads the card first
          and adds its recommendation. You can also answer in your own words, which goes back to the
          builder as your note, talk the change over with the session that wrote the card, or
          pass it to a teammate.
        </P>

        <H2>Ship, watch, learn</H2>
        <P>
          Ship lands the change the project&apos;s way. The problem is then watched for seven
          days, counted from the moment the deploy carrying the fix went live. A signal with one of its fingerprints during that window reopens it, with the new
          evidence attached. A watch that ends quiet closes the problem as fixed. That is what the
          bottom row of the loop counts: on our screen, nothing came back.
        </P>
        <P>
          When you answer Revise or Drop with a note, the note doesn&apos;t just go back to the
          builder. The factory files it as a lesson: a signal proposing the instruction, lint rule
          or test that would have prevented the miss. That is the Lessons source in the table
          above. The factory learns from the cards you send back, in the same pipeline as
          everything else.
        </P>
        <P>
          We judge the factory by three numbers, none of them a count of open findings, since
          that only tracks traffic. How many times a day the product breaks one of its written
          expectations, which should fall. What share of new signals land on a problem the
          factory already knows, which should be high. And of the watches that ended, what share
          ended quiet, which says whether shipped fixes actually fix things.
        </P>

        <H2>Your own sessions use the same checks</H2>
        <P>
          Most changes don&apos;t start as an error report. Someone asks an agent for a feature,
          or fixes something they noticed. Those go through the same checks. Every session you
          own has a <strong>Ship</strong> button that sends its change through a flow, with your
          team&apos;s default picked.
        </P>

        <Screenshot
          src={`${DIR}/ship-popover.png`}
          alt="The Ship popover on a Codecast session titled Change flow article. Change is picked as the default, marked You approve, with the path Check, Review, Decide, Land, Deploy, Live. Quick is the other option, marked No approval. Below, the six steps with who does each, and a bracket under Check to Land reading findings come back to this session."
          caption="The Ship popover on the session that wrote this post. Nothing was shipped from it."
        />

        <P>
          The <strong>Change</strong> flow skips proving, since the session that made the change
          already knows what it is for, and goes straight to the checks. What they find goes back
          to that session, in its own thread, and the fixed change starts again at Check, so what
          lands is exactly what was reviewed and approved. <strong>Quick</strong> is the same
          without Decide, for small changes in areas where you trust the checks.
        </P>

        <Figure wide caption="The Change flow. Each dashed red line is a stop the session can fix; it goes back as a message in the session's own thread, and the fixed change starts again at Check.">
          <LoopFigure />
        </Figure>

        <H2>Where ours stands</H2>
        <P>
          Our own factory was switched on yesterday, which is why the screens
          above show nothing shipped by it yet: four cards are waiting on a person, and the first
          watch hasn&apos;t started. Another product our team builds has run on it for weeks.
          There, 365 signals came in on a single day, the factory holds 12,269 problems from
          them, 59 changes have shipped and are being watched, and 7 of those came back and
          reopened. Nine of its seventeen roles are trusted to merge their own changes without a
          person; the rest still ask.
        </P>
        <P>
          The numbers that don&apos;t flatter us are on the screen on purpose. Codecast-backend
          has been silent for 27 days, two sources file nowhere, and most of the failed runs in
          our flow stopped at Prove. Each of those is now a thing someone can act on.
        </P>

        <H2>What you need</H2>
        <P>
          The Codecast app on the computers where your agents run, with{" "}
          <strong>Workflows</strong> switched on in <strong>Agent features</strong>. Connect a
          source or two from <strong>Sources to watch</strong>: your error tracker, product
          analytics, CI. Give your repository a check command, the one you would run before
          pushing. Then pick a flow from the library, give it an owner, and turn it on. You
          don&apos;t need a team for any of it: on your own, every card comes to you. The{" "}
          <Link href="/documentation/workflows" className="underline" style={{ color: SOL.blue }}>
            workflows guide
          </Link>{" "}
          covers runs, gates and writing a flow of your own.
        </P>
        <P>
          For people who script: <Code>cast flow ls</Code> lists the flows and the live ones with
          their queues, <Code>cast flow run change</Code> sends a session&apos;s own edits through
          the Change flow, and <Code>cast signal add</Code> files a signal by hand.
        </P>

        <blockquote
          className="my-8 border-l-2 pl-5 text-xl leading-relaxed font-mono"
          style={{ borderColor: SOL.yellow, color: SOL.base03 }}
        >
          Codecast records every coding agent session you run, on any machine, and gives you one
          place to see them, steer them and answer them, on your own or with your team.
        </blockquote>

        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link href="/signup">
            <Button size="lg" className="text-white text-base px-8 h-12 font-medium" style={{ backgroundColor: SOL.base03 }}>
              Start free
            </Button>
          </Link>
          <Link href="/documentation/workflows">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              Read the workflows guide
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          The screenshots are the Codecast web app in Chrome on 2026-11-15, signed in to the
          founder&apos;s account, from a local build of the app and the Codecast team&apos;s own
          workspace. The three Flows screens were drawn at a narrower width than the window so
          their text reads here; nothing else about them was changed. The card is decision
          sd-3295 on problem ct-73216, unanswered when it was captured, cropped to its question
          and its options. The change&apos;s story is told from the problem&apos;s own record
          and its run. The other product&apos;s numbers are from its Flows page on the same day.
          The two diagrams are drawn from the flows&apos; definitions. Nothing was composited or
          retouched.
        </p>
      </article>
    </main>
  );
}
