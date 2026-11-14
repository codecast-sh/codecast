"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Screenshot, SOL, H2, P, Code, Figure } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";
import { FigureStyles, LoopFigure } from "./figures";

// Genuine screenshots of the Codecast web app (a local build of this repo,
// signed in to the founder's account) in Chrome on 2026-11-14. The Ship popover
// is the header of the session that wrote this post (jx76dak), opened and
// closed without pressing Ship. The decision is sd-3029, the Decide card of
// change run th77f3df on task ct-93196 (removing the workspace trust gate),
// asked Nov 12 and answered Ship by the founder. Its reviewer was session
// jx77gys (11 minutes); the answer came 2 minutes after the card. Mechanics were checked against
// packages/cli/src/workflow/templates (change.cast, check.cast, review.cast,
// deploy.cast, change/*.md, line/review.md) and docs/architecture/flows.md.
// Nothing was composited or retouched; the decision is cropped to its
// question, the reviewer's note and its options.

const DIR = "/blog/one-question-per-change";

export default function OneQuestionPerChangePost() {
  const post = getPost("one-question-per-change");
  useRouteMeta("/blog/one-question-per-change");

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
            One question per change
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            {post?.dek}
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "November 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 7} min read</span>
          </div>
        </header>

        <H2>Checking is the slow part now</H2>
        <P>
          An agent can write a change in ten minutes. Deciding whether to ship it takes longer:
          someone has to run the tests, read the diff, try the thing, and work out whether the
          problems they found are real. When a reviewer leaves a comment, that is more work, not
          less. Someone reads it, the agent changes the code, the checks run again, and the change
          comes back to be read a second time. A review that returns ten comments, eight of them
          matters of taste, has handed you the job of sorting them.
        </P>
        <P>
          So we built the path a change takes in Codecast around one rule: everything that can be
          settled without you is settled before you see the change, by the agent that wrote it.
          What reaches you is one card with one question, ship this or not, and the evidence to
          answer it in a minute.
        </P>

        <H2>What happens when you press Ship</H2>
        <P>
          Every session you own has a <strong>Ship</strong> button in its header. It opens the flows your team can send the change through, with the team&apos;s default
          picked. Ours is <strong>Change</strong>.
        </P>

        <Screenshot
          src={`${DIR}/ship-popover.png`}
          alt="The Ship popover on a Codecast session titled Change flow article. Change is picked as the default, marked You approve, with the path Check, Review, Decide, Land, Deploy, Live. Quick is the other option, marked No approval. Below, the six steps are drawn with who does each: Check automatic, Review an agent, Decide you, Land automatic, Deploy you, and a bracket under Check to Land reading findings come back to this session."
          caption="The Ship popover on the session that wrote this post. Nothing was shipped from it."
        />

        <P>
          The drawing says who does each step. <strong>Check</strong> runs your project&apos;s own
          check command. <strong>Review</strong> is a second agent. <strong>Decide</strong> is you.{" "}
          <strong>Land</strong> rebases and lands the change. <strong>Deploy</strong> waits for
          the deploy that carries it, and the run ends at <strong>Live</strong>. The bracket
          underneath is the part that saves you the most time: whatever the first four steps find
          goes back to the session that made the change.
        </P>

        <Figure wide caption="The Change flow. Each dashed red line is a stop the session can fix; each one goes back to it as a message in its own thread, and the fixed change starts again at Check.">
          <LoopFigure />
        </Figure>

        <P>
          A failed check sends the session the check&apos;s output. The reviewer&apos;s findings,
          your note when you choose Revise, and a conflict with the main branch at Land go back the
          same way. The session fixes them in its own checkout and ends its turn. The run then
          takes a fresh snapshot of the change and walks it through Check again, and every stage
          after it, so what lands is exactly what the reviewer approved and you accepted, never
          whatever the session happened to have on disk a moment later. Each way back is allowed
          three times. A fourth failure ends the run and says why, so a change that keeps failing
          stops asking for attention.
        </P>

        <H2>Check</H2>
        <P>
          Check runs the command your repository names for it, in a separate worktree that holds
          only the change. Your checkout and the other sessions working in it are not touched.
          When the command fails, the session gets the failing steps and the end of the output.
          When the machine could not run the check at all (no test database, a missing tool), the
          run stops at <strong>Not checked here</strong> instead. That is a problem with the
          machine, not with the change, so it never goes to the session as something to fix.
        </P>

        <H2>Review, by an agent that did not write the change</H2>
        <P>
          The reviewer is a new session. It gets the branch, the task&apos;s title and its
          acceptance criteria, and none of the conversation that produced the change. That is on
          purpose: it judges what the diff does, not what its author meant to do. It checks each
          criterion against the diff, runs what it can, and reads the change against your
          repository&apos;s own instructions (its CLAUDE.md or AGENTS.md). It is not allowed to fix
          the code itself. It ends with one verdict: approve, changes, or reject.
        </P>
        <P>
          Asking for changes sends the findings to the session that wrote the change. That session
          fixes what is right and argues with what it thinks is wrong, in its reply. Then the
          change goes through Check and a fresh review. You don&apos;t see any of this unless you
          go looking. A rejection ends the run with the reviewer&apos;s reasons on the task.
        </P>

        <H2>What the reviewer has to write</H2>
        <P>
          When the reviewer approves, its note becomes your card, so the note has rules. Its first
          line is the question, in plain words about what the change does for the people it
          reaches. Then a few sentences for someone who knows the product but not the code: what
          the change does, what the review found, and what could still go wrong. Every claim has
          to be something the reviewer ran and saw, or read in full. When a claim rests on the
          implementer&apos;s word, the note says so. Whatever the reviewer could not check is
          written down too.
        </P>
        <P>
          This is the card from a real run on our own repository, two days ago. The change removed
          a confirmation step from workspace setup in Codecast.
        </P>

        <Screenshot
          src={`${DIR}/decide-question.png`}
          alt="Decision sd-3029 in Codecast, answered. The question: Ship the change that lets new workspaces set themselves up without first asking a person to approve the repo's setup scripts? Asked of Ashot Petrosian by a Change run in codecast. The note says what the change does, then What I checked: a real workspace creation from an agent shell on a fresh repo, typecheck clean, 183 tests passing, and that the removed card was never in a released CLI. Then the risk the person is accepting: a changed setup script now runs unread in the next workspace, including ones agents create unattended. Not checked: a run on a cloud host."
          caption="The Decide card from run th77f3df. The reviewer, an independent session, took 11 minutes."
        />

        <P>
          Read the third paragraph. The reviewer did not stop at saying the change works. It named
          the cost of shipping it: a teammate&apos;s push can now change a setup script, and the
          next workspace runs it without anyone reading it. That is the sentence a person needs to
          decide well, and it is exactly the kind of thing a list of review comments buries.
        </P>
        <P>
          Below that sit the findings for the implementer, each with a severity (blocker, high,
          medium, low or nit), a file and line, and what fails. A finding the reviewer does not
          hold against the change is marked as such, and it does not send the change back. One
          about security or lost data can never be put off for later: it is fixed in this round or
          the verdict is changes. On this card the reviewer raised a low and a nit and held
          neither against the change, so nothing went back and the card went straight to the
          founder.
        </P>

        <H2>The one question</H2>
        <P>
          Decide has three answers. <strong>Ship</strong> lands the change.{" "}
          <strong>Revise</strong> sends your note back to the session that made it, and the change
          comes round again through Check, Review and Decide. <strong>Drop</strong> leaves it
          unshipped. If your team has a lead agent for the area, its recommendation sits above the
          options. If you would rather ask than choose, type the question: it goes to the reviewer,
          who answers it in a new version of the card.
        </P>

        <Screenshot
          src={`${DIR}/decide-options.png`}
          alt="The bottom of the same decision: the Broker Outreach lead recommends Ship, with its reason. Three options: Ship, Land the change, marked a lead recommends; Revise, Your note goes back to the session that made it; Drop, Leave the change unshipped. The answer: Ship, answered by Ashot Petrosian."
          caption="The options on the same card, and the answer, given two minutes after it arrived."
        />

        <P>
          The card waits in your Decisions queue with every other agent&apos;s question, so you can
          answer a morning&apos;s worth of changes in one sitting, from the web, the desktop app or
          your phone.
        </P>

        <H2>Land and Deploy</H2>
        <P>
          Land rebases the approved snapshot onto your main branch and lands it with your
          project&apos;s ship command, or opens a pull request if that is how your repository
          ships. If main moved and the rebase conflicts, the conflict goes back to the session, and
          the resolved change goes through Check and Review again, since a resolved conflict is new
          code.
        </P>
        <P>
          Then the run waits for the deploy that carries the change on every target its files
          touch. It starts no deploy itself; your deploy policy does that, whether that is a
          button, CI on main or a push that deploys itself. While it waits it holds no machine and
          no session. When the deploy is live, the session hears which deploy took it there. If
          the deploy fails, the run stops at <strong>Deploy failed</strong> with the deploy&apos;s
          note, and the task stays open.
        </P>

        <H2>Quick, and flows of your own</H2>
        <P>
          <strong>Quick</strong> is the same flow without Decide: when the reviewer approves, the
          change lands. It suits small changes in areas where you trust the checks.
        </P>
        <P>
          Both are starting points. A flow is a file in your repository, under{" "}
          <Code>.codecast/flows/</Code>, reviewed and versioned like the rest of your code. You can
          give Check steps of your own (an eval for a prompt change, a browser check for a page),
          add stages, or build a flow from scratch out of the same parts. A team admin picks which
          flow the Ship button offers first. The <strong>Flows</strong> page lists your
          team&apos;s flows, draws each one, and shows every change that ran through it, with its
          live run.
        </P>

        <H2>What you need</H2>
        <P>
          The Codecast app on the computer where your agents run, with{" "}
          <strong>Workflows</strong> switched on in <strong>Agent features</strong>, and a check
          command for your repository, the same one you would run before pushing. You don&apos;t
          need a team: on your own, Decide simply asks you. The{" "}
          <Link href="/documentation/workflows" className="underline" style={{ color: SOL.blue }}>
            workflows guide
          </Link>{" "}
          covers runs, gates and how to write a flow of your own.
        </P>
        <P>
          For people who script: <Code>cast flow run change</Code> sends a session&apos;s own edits
          through the flow, <Code>cast flow ls</Code> lists the flows you can run, and{" "}
          <Code>cast flow show change</Code> prints each step and where it sends the work.
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
          The screenshots are the Codecast web app in Chrome on 2026-11-14, signed in to the
          founder&apos;s account, from a local build of the app. The Ship popover is the header of
          the session that wrote this post, opened and closed without shipping. The decision is
          sd-3029, from Change run th77f3df on our own repository, cropped to its question, the
          reviewer&apos;s note and its options; the findings and the list of checks the reviewer
          passed sit between those crops on the card. Times are from the run record. The diagram
          is drawn from the flow&apos;s definition. Nothing was composited or retouched.
        </p>
      </article>
    </main>
  );
}
