"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, SOL, H2, P, Code, Figure } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";
import { AttentionFigure, FigureStyles, JumpsFigure, PromptFigure, TraceFigure } from "./figures";

export default function FewerBiggerJumpsPost() {
  const post = getPost("fewer-bigger-jumps");
  useRouteMeta("/blog/fewer-bigger-jumps");

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <FigureStyles />
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
            {post?.title ?? "Fewer, bigger jumps"}
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            {post?.dek}
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 7} min read</span>
          </div>
        </header>

        <P>
          Most advice about prompting coding agents is about getting each answer right. Be
          specific, give context, ask for one thing at a time. That advice optimizes the
          wrong number. It treats the model&apos;s output as the scarce thing, when the
          scarce thing is you: the minutes you spend reading what came back, deciding what
          is wrong with it, and writing the next prompt.
        </P>
        <P>
          Call each of those cycles a jump. Every feature is a distance from where the code
          is to where you want it, and every jump costs a slice of your attention whether it
          moves you an inch or a mile. Tokens are cheap and getting cheaper every quarter.
          Your attention is fixed at a few good hours a day. So the thing to minimize is the
          number of jumps, and the way to do that is to make the first one enormous.
        </P>

        <Figure wide caption="Same start, same target. The left takes sixteen of your turns; the right takes four.">
          <JumpsFigure />
        </Figure>

        <H2>Two ways across</H2>
        <P>
          The familiar way is small hops. You ask for one safe, well specified step, check
          it, ask for the next. Each hop lands roughly where you aimed, which feels like
          control. But a feature of any size is fifteen or twenty of them, and every one
          waits on you. Worse, you are doing the planning, the sequencing and most of the
          verification in your head, which is exactly the work the agent could have done.
        </P>
        <P>
          The other way is one leap. You describe the destination, what done looks like and
          how to check it, and then you tell the agent to keep going on its own: plan, build,
          run it, look at it, find what is wrong, fix it, and go around again. In the figure,
          those coils inside the first orange arc are that loop. They cost tokens and
          wall clock time. They cost you nothing.
        </P>
        <P>
          The leap will not land on the target. It will land somewhere near it, built on a
          few guesses you would have made differently. That is fine, and it is the part
          people underrate.
        </P>

        <H2>Why missing is useful</H2>
        <P>
          A working artifact that is wrong in specific ways is the cheapest thing in the
          world to steer. Before the leap you would have had to specify everything up front,
          including dozens of choices you had no opinion on until you saw one. After it, you
          only have to name the handful you disagree with, and you can name them by pointing.
        </P>
        <P>
          Here is what that looks like in practice, from a session in our own repository this
          week. One prompt asked for a page that tells the story of everything the team is
          shipping. The agent worked through more than 750 messages on that prompt alone, building a
          per-day timeline, wiring it to real data, screenshotting it and fixing what it saw.
          Then came the second real prompt: the correction.
        </P>

        <Figure wide caption="Two real sessions in the codecast repository, read on October 4. Orange is every prompt that carried direction.">
          <TraceFigure />
        </Figure>

        <P>
          The correction is a big jump of its own: a single timeline instead of one page per
          day, plainer copy, fewer features on the surface. It moves a long way, but it moves
          from a place that was already close, so it lands much closer still. The jumps after
          it get smaller: a spacing fix, a label, a tweak to the default zoom. Each one is
          cheaper to write than the one before, because the remaining error is smaller and
          easier to see. The docs audit below it is the same shape at a smaller size: one
          prompt to rewrite the docs with diagrams and screenshots, about 270 messages of
          work, and a three word correction.
        </P>

        <H2>What a leap prompt asks for</H2>
        <P>
          A leap prompt is not a longer hop prompt. It asks for different things. It names
          where you are going rather than the next step. It says how the agent will know it
          has arrived, in terms it can check itself: tests, a browser, a screenshot. It
          explicitly invites the agent to spend more: plan first, fan work out to subagents,
          run a workflow that builds and reviews in parallel, and keep iterating on polish
          after the thing works. And it says when to stop and ask, which should be rarely.
        </P>

        <Figure wide caption="The hop is a fine prompt. It is just one of twenty.">
          <PromptFigure />
        </Figure>

        <P>
          The most important line is the definition of done. Without one, an agent stops at
          the first plausible result, and you become the test suite. With one, the agent
          does the looking for you: it opens the page, notices the overlapping labels, and
          fixes them before you ever see them. Every problem it catches on its own is a jump
          you did not have to make.
        </P>
        <P>
          This deliberately spends more compute per prompt, often a lot more. A leap can run
          for an hour and burn through more tokens than a day of hops. That is the trade, and
          it is a good one. You are buying back the only resource in the loop that does not
          scale.
        </P>

        <H2>Fill the time the leap buys</H2>
        <P>
          A leap that runs for forty minutes is forty minutes in which you are not needed.
          The mistake is to spend them watching. The point of making each session need you
          less is that you can run several, and spend your attention moving between them:
          write the leap for one, launch it, write the leap for the next, then come back to
          the first when it lands and send its correction.
        </P>

        <Figure wide caption="Schematic, not measured. Hops keep you waiting on one agent; leaps keep five agents waiting on you, briefly.">
          <AttentionFigure />
        </Figure>

        <P>
          Throughput here means the share of your attention spent on decisions rather than
          waiting. With small hops it is low no matter how fast the model is, because every
          hop ends in a wait. With leaps it can approach all of it, and the corrections shrink
          as each session converges, so the later rounds go by quickly. Five sessions moving
          in big jumps finish more in an afternoon than one session moving in small ones
          finishes in a week.
        </P>
        <P>
          Running like this needs a place to see who is waiting on you. That is what
          codecast&apos;s <Link href="/blog/an-inbox-for-your-agents" style={{ color: SOL.blue }}>inbox</Link>{" "}
          is for: every session on every machine, sorted by who acts next, so the next jump
          you make is always the one that is ready for it. Long leaps can be given to{" "}
          <Code>cast spawn --subagent</Code> workers, and a session can be woken later with a
          trigger instead of a reminder in your head.
        </P>

        <H2>The rule</H2>
        <P>
          Before you send a prompt, ask whether it could carry the next three prompts too.
          Usually it can: say where you are going, say how to check, say keep going. Expect
          the result to be wrong, and be glad it is wrong somewhere you can point at. Then
          make the big correction, then the smaller ones, and spend the gaps on the next
          leap.
        </P>

        <blockquote
          className="my-8 border-l-2 pl-5 text-xl leading-relaxed font-mono"
          style={{ borderColor: SOL.yellow, color: SOL.base03 }}
        >
          Count your jumps, not your tokens.
        </blockquote>

        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link href="/signup">
            <Button size="lg" className="text-white text-base px-8 h-12 font-medium" style={{ backgroundColor: SOL.base03 }}>
              Start free
            </Button>
          </Link>
          <Link href="/blog/an-inbox-for-your-agents">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              An inbox for your agents
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          The session traces are real: message counts and prompt positions from two codecast
          sessions in this repository, read on 2026-10-04, with the quoted prompts trimmed
          where marked. Bare &quot;continue&quot; messages after a pause are drawn separately
          because they carry no direction. The jump paths and the attention schedule are
          illustrations, not measurements.
        </p>
      </article>
    </main>
  );
}
