"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Terminal, Cmd, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Five genuine screenshots of the codecast web app on 2026-10-15, of two real
// answered decisions about codecast's own work: sd-25 (the ads check cadence,
// asked and answered on Sep 13) and sd-177 (how to fix messages arriving as
// pasted text). Each is cropped to the content column. The sidebar, top bar
// and right rail are outside every crop. The open queue itself is not
// pictured: on the day of capture it held only other projects' questions.
// sd-25's last context paragraph and the agent's status line under the card
// are outside the crops because they carry dollar figures; sd-177's third
// option is below its crop because it names another project.

export default function QuestionsYourAgentsSaveForYouPost() {
  const post = getPost("the-questions-your-agents-save-for-you");
  useRouteMeta("/blog/the-questions-your-agents-save-for-you");

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
            The questions your agents save for you
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Run several agents and each one will, sooner or later, need you to choose. Codecast
            lets an agent write that choice up as a card, put it in one queue with every
            other agent&apos;s, and wait. You answer the lot in one sitting, and each agent picks up
            from your answer.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 6} min read</span>
          </div>
        </header>

        <H2>Asking without interrupting</H2>
        <P>
          An agent that stops to ask you something has two bad options. It can ask in its own
          chat and hope you look, so the question sits in one of six terminals while the agent
          idles. Or it can guess, and you find the guess a day later, built on. Neither is what
          you want when you are running several agents at once and your attention is the thing
          in short supply.
        </P>
        <P>
          Codecast gives the agent a third option. It writes the choice up as a decision: one
          question, the options with what each one costs, and the reasoning you need to pick
          without opening its session. The decision goes into your queue, the agent ends its
          turn, and by default nothing more happens in that session until you answer. Your other agents
          keep working.
        </P>

        <H2>What the card carries</H2>
        <P>
          Here is a real one. On September 13th the agent that runs our Google Ads check had
          been checking a campaign that was not serving for ten days. It had run out of useful
          work, and rather than keep reporting the same three facts every day, it asked:
        </P>

        <Screenshot
          src="/blog/the-questions-your-agents-save-for-you/decision-page.png"
          alt="A decision page in codecast: marked answered, asked Sep 13, resolved Sep 13, sd-25. The question reads: The ads channel has nothing to do until it serves again. Should the daily check keep running every day? Below it: asked of Ashot Petrosian, asked by the session Codecast Google Ads campaign, in codecast; Thread and Discuss buttons; and four paragraphs of context explaining why the campaign is dark, what the earlier checks found, what a daily check still buys, and that the agent will restore the daily rhythm itself"
          caption="The decision's own page: the question, who asked it and of whom, and the agent's reasoning. The context's last paragraph is outside the crop."
        />

        <P>
          The question is a question, not a status report. Under it, the page names the
          session that asked and the person it was asked of. Then the context, written for
          someone who was not there: why the campaign is dark, what the earlier checks found
          (Google was serving the bare query &quot;claude code&quot; off one of our keywords),
          why a daily check still has some value, and what the agent will do either way. You
          can decide from this page without opening the session. If you would rather talk it
          over first, <em>Discuss</em> opens a thread with that agent about this decision.
        </P>
        <P>
          Below the context are the options, and each one says what happens if you pick it:
        </P>

        <Screenshot
          src="/blog/the-questions-your-agents-save-for-you/decision-answered.png"
          alt="The options on the same decision. Option 1, Check every 3 days while dark, is ticked: I widen tr-462 now and put it straight back to daily the first day it serves; saves about a dozen near-empty passes; a restart would be noticed within three days instead of one. Option 2, Keep it daily: no change; resumption is caught within a day, at the cost of roughly eighteen more passes that will say what the last four said. Below, The answer: Check every 3 days while dark, answered by Ashot Petrosian"
          caption="Two options, each with its cost written out, and the answer underneath."
        />

        <P>
          The costs cut both ways. Checking every three days saves about a dozen empty runs,
          and it means a restarted campaign could go unnoticed for up to three days instead of
          one. Keeping it daily catches a restart within a day and spends about eighteen more
          runs saying nothing new. Neither option is padding. Each one is something the agent
          would actually do.
        </P>
        <P>
          When the agent has a preference, it says so. Here is another decision from the same
          month, about how to fix a delivery problem in codecast itself. The agent marked its
          pick, and the card shows the mark as <em>Suggested</em> at the end of that row:
        </P>

        <Screenshot
          src="/blog/the-questions-your-agents-save-for-you/recommended-option.png"
          alt="The options block of a second decision, sd-177. Option 1, Instruction line, proven by ablation, is ticked and tagged Suggested: add one line to the codecast section of the installed CLAUDE.md, then measure with and without it; cheap, reversible. Option 2, Also move machine messages to Claude's socket channel: a medium change in the daemon delivery path"
          caption="The agent's recommendation shows as a Suggested tag on its row. A third option, to leave things as they are, is below the crop because it names another project."
        />

        <H2>Answering in one sitting</H2>
        <P>
          Every open decision from every agent lands in one queue, <em>Questions</em> in the
          sidebar, with a count of how many are waiting on you. The order is deliberate.
          Questions whose agent is stopped and still reachable come first, because answering
          one restarts work right away. Questions whose session has gone away come next.
          Advisory questions, where the agent named a default and kept working, come last.
          Within each group the oldest comes first, so the queue does not reshuffle while you
          work through it.
        </P>
        <P>
          You can read the queue as a list or step through it one decision at a time. In the
          one-at-a-time view the keyboard does the work: a number key picks that option and
          moves on to the next decision, <Code>T</Code> lets you answer in your own words,{" "}
          <Code>P</Code> passes a decision to someone else, <Code>X</Code> dismisses one that no
          longer matters, and <Code>Esc</Code> takes you back to the inbox. When an option does
          not fit, the answer you type goes to the agent as a message. The desktop app shows
          the same queue, and the phone app has a <em>Decisions</em> screen with the same order:
          tap an option and it moves to the next one.
        </P>
        <P>
          The queue is not pictured here. On the day we wrote this it held five open
          questions, all from other projects, and this blog only shows codecast&apos;s own
          work. The decisions in this post were answered weeks ago, so they have left it.
        </P>

        <H2>What happens after you answer</H2>
        <P>
          The decision also lives in the conversation that asked it. In the agent&apos;s
          transcript the card sits inside the turn where it was posted, collapsed, with its
          status and your answer in the header:
        </P>

        <Screenshot
          src="/blog/the-questions-your-agents-save-for-you/card-in-thread.png"
          alt="The ads agent's conversation: the agent writes that it has exhausted the useful work while the channel has no traffic, so the cadence itself is now the open question. Below, a decision card marked ANSWERED, Check every 3 days while dark, with the question, the start of the context and an Expand control, and both options with the first ticked"
          caption="The same card in the agent's conversation, where it was asked."
        />

        <P>
          Your answer reaches the agent as your next message, <em>Check every 3 days while
          dark</em>, with a link back to the ask. The agent was parked on exactly that, so it
          starts its next turn from the answer:
        </P>

        <Screenshot
          src="/blog/the-questions-your-agents-save-for-you/answer-and-resume.png"
          alt="The answer arriving in the conversation as a message from Ashot Petrosian on Sep 13: Check every 3 days while dark, with a DECISION chip quoting the question and a link to the ask. Below, the agent: Cadence widened and verified. Now the part that actually matters, making sure it gets restored, since trigger prompts are stateless and only the ledger carries learned state between runs. Then: Done. The check now runs every three days, verified against the trigger list"
          caption="The answer arrives as a message. The agent widens the schedule, checks it, and records when to undo it."
        />

        <P>
          It did what option 1 promised. The trigger&apos;s history shows the schedule moving
          from every day to every three days seventeen seconds after the answer was recorded.
          Then it took care of the part that is easy to lose: option 1 included
          a promise to go back to daily the day the campaign served again, and a scheduled
          agent does not remember a promise between runs. So it wrote the condition into the
          task its runs report to, where the next run would read it: the first check that sees
          the campaign serving again puts the schedule back to daily.
        </P>
        <P>
          That is the loop. The agent asks once, with everything you need. You answer when you
          are ready, alongside every other question waiting on you. The agent carries on from
          your answer without you having to say more.
        </P>

        <H2>From a script</H2>
        <P>
          Agents post decisions with a command, and the card is what that command produces.
          You never need to type it, but if you script your own agents, this is how one asks:
        </P>

        <Terminal label="how an agent asks" wrap>
          <Cmd>cast decide &quot;Should the daily check keep running every day?&quot; -o &quot;Check every 3 days :: what happens if chosen&quot; -o &quot;Keep it daily :: what happens instead&quot; --context -</Cmd>
        </Terminal>

        <blockquote
          className="my-8 border-l-2 pl-5 text-xl leading-relaxed font-mono"
          style={{ borderColor: SOL.yellow, color: SOL.base03 }}
        >
          Codecast records every coding agent session you run, on any machine, and gives you
          one place to see them, steer them and answer them.
        </blockquote>

        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link href="/signup">
            <Button size="lg" className="text-white text-base px-8 h-12 font-medium" style={{ backgroundColor: SOL.base03 }}>
              Start free
            </Button>
          </Link>
          <Link href="/blog/the-task-your-agent-reports-to">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              The task your agent reports to
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All five screenshots are the codecast web app on 2026-10-15, of two real decisions
          about codecast&apos;s own work, both asked and answered in September. Each is cropped
          to the content column: the sidebar, the top bar and the right rail are outside every
          crop. On the ads decision, the context&apos;s last paragraph and the agent&apos;s
          status line under the card are cropped out because they carry the campaign&apos;s
          dollar figures. On the second decision, the third option is cropped because it names
          another project. The open queue is described from the app, not pictured, because it
          held only other projects&apos; questions that day. No decision was posted, answered
          or edited for this post.
        </p>
      </article>
    </main>
  );
}
