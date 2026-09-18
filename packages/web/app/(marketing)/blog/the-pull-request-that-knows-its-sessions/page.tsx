"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, BlogFooter, Terminal, Cmd, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Genuine `cast pr` output captured on 2026-09-17 against the public repository
// codecast-sh/codecast. Check URLs are dropped from `show` for width; one
// bot comment is omitted. Every omission is marked with an editorial "…".

const PR_LS = `  #46  open  Artifact draft store: published pages can autosave vi-  aivery/artifact-drafts -> main        10 green 2 red  1h
  #47  open  fix(cli): a Mac remote absorbs the pushed Claude logi-  remote-mac-credential-absorb -> main  9 green 3 red   jx7905c  1h
…  three more rows: two webhook test PRs and a proof PR  …
`;

const PR_SHOW = `codecast-sh/codecast#47 fix(cli): a Mac remote absorbs the pushed Claude login into its keychain and never rotates it open

  url        https://github.com/codecast-sh/codecast/pull/47
  page       https://codecast.sh/pr/codecast-sh/codecast/47
  branch     remote-mac-credential-absorb -> main
  sha        e7a03055c5cc
  author     samvit
  merge      unstable, 33 behind
  updated    1h ago

shepherd
  session    jx7905c StagePane label crash fix
  enabled    no

checks (failure)
  x GitGuardian Security Checks failure
  * classify changed paths (pull_request) success
  - lint (pull_request) skipped
  …  seven more checks: build, the contract check and an advisory macOS check pass; four jobs skipped  …
  x test-cli (pull_request) failure
  x verify (pull_request) failure

unresolved comments (3)
  samvit  ## 🎙️ Codecast Conversation
  …  one bot comment  …
  samvit  Rebased onto origin/main (e7a03055c). Note for reviewers: \`daemon.machine-prompt

linked
  jx7905c StagePane label crash fix
  jx7cep7 Verify Codecast E2E
  jx71rq4 Keyboard shortcuts help coverage
  jx7fmc6 Verify codecast cross-machine
  jx724wf Mobile viewport scaling fix
  jx71196 React error #520 debug
  jx73db1 Task status picker
`;

const PR_EVENTS = `    8h pr_behind PR #47 is behind main
    1d pr_check samvit CI failed: verify (pull_request)
    1d pr_check samvit CI failed: verify (pull_request)
    1d pr_check samvit CI failed: test-cli (pull_request)
    1d pr_ready PR #47 merges cleanly again
    1d pr_check samvit CI failed: GitGuardian Security Checks
    1d pr_synchronize samvit PR #47 updated to e7a0305
    1d pr_check samvit CI failed: test-cli (pull_request)
    1d pr_behind PR #47 is behind main
    1d pr_check samvit CI failed: GitGuardian Security Checks
    1d pr_opened samvit Opened PR #47: fix(cli): a Mac remote absorbs the pushed Claude login into its keychain and never rotates it
`;

export default function PullRequestKnowsItsSessionsPost() {
  const post = getPost("the-pull-request-that-knows-its-sessions");
  useRouteMeta("/blog/the-pull-request-that-knows-its-sessions");

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
            The pull request that knows its sessions
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            When agents write most of the code, a pull request is the end of a conversation you
            were not in. Codecast keeps the two attached: every PR carries its checks, its
            reviews, and the sessions that made it, and a review can wake the agent that owns
            it.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "September 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 6} min read</span>
          </div>
        </header>

        <H2>The diff is the least interesting part</H2>
        <P>
          A pull request used to be a person&apos;s work, summarized by that person. You read
          the description, you knew who to ask, and the reasoning lived in their head a desk
          away. When an agent wrote the change, the description is the agent&apos;s, the
          reasoning is in a transcript, and the person whose name is on the PR may have steered
          it in ten messages and read none of the code. The question a reviewer actually has
          is not &ldquo;what changed&rdquo; but &ldquo;what was this agent trying to do, and did
          it check&rdquo;. GitHub cannot answer that. The session can.
        </P>
        <P>
          So codecast treats a pull request the way it treats a session or a task: as an
          object with an address, a state, and links to the conversations around it. Here is
          the team&apos;s open list on our own repository this morning:
        </P>

        <Terminal label="cast pr ls">
          <Cmd>cast pr ls --repo codecast-sh/codecast</Cmd>
          {PR_LS}
        </Terminal>

        <P>
          Two teammates, two branches, check counts, and on the second row a session id: the
          conversation that pull request belongs to. That column is the whole idea.
        </P>

        <H2>Everything known about one</H2>
        <P>
          <Code>cast pr show</Code> is the page a reviewer wants before opening the diff. State
          and merge status, the author, which session shepherds it, every check with its
          verdict, the open comments, and the sessions linked to the change. This one, from a
          teammate, is shepherded by a session about a crash and linked to six more:
        </P>

        <Terminal label="cast pr show" wrap>
          <Cmd>cast pr show codecast-sh/codecast#47</Cmd>
          {PR_SHOW}
        </Terminal>

        <P>
          Seven linked sessions, judging by their titles: a crash fix, two verification passes
          across machines, a React error debug, and three unrelated to the change that read or
          touched it. Each is one <Code>cast read</Code> away, and in the web app they sit beside
          the PR as cards. The first unresolved comment is titled <em>Codecast Conversation</em>:
          a link from the pull request back to the session that made it. The paper trail runs
          both ways.
        </P>
        <P>
          The same object in the web app, on the Checks tab, with the shepherd session in its
          own panel to the right:
        </P>

        <Screenshot
          src="/blog/the-pull-request-that-knows-its-sessions/pr-checks.png"
          alt="The codecast pull request page for codecast-sh/codecast#47: author and branch, check counts, review state, merge state, diff size, tabs for Conversation, Files, Commits and Checks, twelve checks listed with three failures, and a Sessions panel showing the shepherd session card"
          caption="codecast.sh/pr/codecast-sh/codecast/47, Checks tab. Three failed, four passed, five skipped, and the session that owns it on the right."
        />

        <H2>A timeline, not a notification pile</H2>
        <P>
          GitHub tells you a check failed by email, one at a time, out of order. Codecast keeps
          the pull request&apos;s history as a timeline you can read top down, and{" "}
          <Code>cast pr watch</Code> streams the same events live, one line per change, silent
          until something moves:
        </P>

        <Terminal label="cast pr events" wrap>
          <Cmd>cast pr events codecast-sh/codecast#47</Cmd>
          {PR_EVENTS}
        </Terminal>

        <P>
          Read it bottom up and you can see the day: opened, a security check and a test job
          fail, the branch falls behind main, the author pushes a fix, the PR merges cleanly
          again, the same two checks fail again, a third joins them, and by morning it is behind
          main once more. That is a pull request waiting for its owner. Which brings us to the
          part that is new.
        </P>

        <H2>A review that wakes the author</H2>
        <P>
          When a session owns a pull request, codecast calls it the shepherd. Turn it on with{" "}
          <Code>cast pr shepherd on</Code>, or let the shipping flow do it when it opens the
          PR. From then on the session is woken when the pull request moves: a check goes red,
          the branch falls behind, and above all, someone reviews it.
        </P>

        <Terminal label="review from the shell">
          <Cmd>cast pr comment 47 --hold --file src/x.ts --line 42 &quot;what should change here&quot;</Cmd>
          <Cmd>cast pr review 47 --request-changes -b &quot;one fix, then good to go&quot;</Cmd>
        </Terminal>

        <P>
          A review from the shell is a batch: hold notes on lines, then send them as one
          verdict. It lands on GitHub under the reviewer&apos;s own account, so the verdict is
          theirs. And if the pull request has a shepherd, the whole review, verdict and every
          note, arrives in that session as a message the moment GitHub accepts it. The agent
          that wrote the change reads the review, makes each fix, pushes to the same branch,
          replies on the threads it addressed, and resolves them. The reviewer sees resolutions,
          not silence.
        </P>
        <P>
          The shepherd on our example is off, which is why it sat behind main all night with
          three red checks and nobody woke up. Toggle it on, and the next failed check becomes
          a turn in the session that knows the code.
        </P>

        <H2>Why this is a team feature</H2>
        <P>
          Every previous post on this blog was about one person&apos;s agents. This one is
          about the seam between people. A pull request is where a teammate first meets work
          they did not watch happen, and the question they bring is always the same: what was
          the agent trying to do? Linking the PR to its sessions answers it without a meeting.
          Letting a review wake the agent answers the follow-up, &ldquo;who fixes it&rdquo;,
          without a person relaying comments into a terminal. The record that made a session
          searchable last month is the same record that makes its pull request reviewable now.
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
          <a href="https://github.com/codecast-sh/codecast" target="_blank" rel="noopener noreferrer">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              View on GitHub
            </Button>
          </a>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          The three terminal captures are genuine <Code>cast pr</Code> output from 2026-09-17
          against the public repository codecast-sh/codecast, whose pull requests and author
          handles are public on GitHub. The <Code>ls</Code> excerpt keeps two of five rows; the{" "}
          <Code>show</Code> excerpt drops the per-check URLs, collapses seven checks to one line,
          and omits one automated bot comment. Each omission is marked <Code>…</Code>. The
          review commands are illustrative, with placeholder file and text, and were not run
          against this pull request. The screenshot is the pull request page in the codecast web app, cropped to
          the content column from the author row down; the author&apos;s avatar is blurred.
        </p>
      </article>

      <BlogFooter />
    </main>
  );
}
