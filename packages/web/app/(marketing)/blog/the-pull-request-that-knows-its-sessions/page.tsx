"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Screenshots are the codecast web app against the public repository
// codecast-sh/codecast: #47 on 2026-09-17, the Pull requests tab and #52 on
// 2026-10-09. The #47 event history is from `cast pr events` the same day.

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
          object with an address, a state, and links to the conversations around it. Every
          repository in codecast has a <em>Pull requests</em> tab, filtered by{" "}
          <em>Open</em>, <em>Merged</em>, <em>Closed</em>, <em>Mine</em> and{" "}
          <em>Shepherded</em>. Here it is on our own repository today:
        </P>

        <Screenshot
          wide
          src="/blog/the-pull-request-that-knows-its-sessions/pr-list.png"
          alt="The Pull requests tab of codecast-sh/codecast in the codecast web app, with filters Open, Merged, Closed, Mine and Shepherded, listing one open pull request, #52 Fix stash, kill and restore failing on large session groups, with checks failing and a shepherded tag"
          caption="The repository's Pull requests tab. The shepherded tag means a session owns this one."
        />

        <P>
          One open pull request, its checks failing, and a tag that says{" "}
          <em>shepherded</em>: a session owns it. That tag is the whole idea.
        </P>

        <H2>Everything known about one</H2>
        <P>
          Open one and you get the page a reviewer wants before opening the diff. Across the
          top: <em>Checks</em>, <em>Review</em>, <em>Merge</em>, <em>Open comments</em> and{" "}
          <em>Diff</em>, each with its verdict. Below that, tabs for <em>Conversation</em>,{" "}
          <em>Files</em>, <em>Commits</em> and <em>Checks</em>, and beside them the sessions
          that made the change. Here is a teammate&apos;s pull request from September, #47, on
          the Checks tab, with its shepherd session on the right:
        </P>

        <Screenshot
          src="/blog/the-pull-request-that-knows-its-sessions/pr-checks.png"
          alt="The codecast pull request page for codecast-sh/codecast#47: author and branch, check counts, review state, merge state, diff size, tabs for Conversation, Files, Commits and Checks, twelve checks listed with three failures, and a Sessions panel showing the shepherd session card"
          caption="codecast.sh/pr/codecast-sh/codecast/47, Checks tab. Three failed, four passed, five skipped, and the session that owns it on the right."
        />

        <P>
          That pull request was linked to seven sessions. Judging by their titles: a crash
          fix, two verification passes across machines, a React error debug, and three that
          read or touched the change without being about it. Each opens with a click. The
          first comment on the GitHub side is titled <em>Codecast Conversation</em>: a link
          from the pull request back to the session that made it. The paper trail runs both
          ways. (A terminal gets the same summary from <Code>cast pr show</Code>.)
        </P>

        <H2>A timeline, not a notification pile</H2>
        <P>
          GitHub tells you a check failed by email, one at a time, out of order. Codecast keeps
          the pull request&apos;s history as a timeline on its <em>Conversation</em> tab, with
          a marker for what changed since you last looked, and a comment box whose comments
          are mirrored to GitHub. The shepherd session sees the same events as rows in its own
          transcript. The day #47 had looked like this, read top down:
        </P>

        <ol className="mb-6 ml-6 list-decimal space-y-1 text-[17px] leading-8" style={{ color: SOL.base01 }}>
          <li>Opened.</li>
          <li>A security check and a test job fail; the branch falls behind main.</li>
          <li>The author pushes a fix, and the pull request merges cleanly again.</li>
          <li>The same two checks fail again, and a third joins them.</li>
          <li>By morning it is behind main once more.</li>
        </ol>

        <P>
          That is a pull request waiting for its owner. Which brings us to the part that is
          new.
        </P>

        <H2>A review that wakes the author</H2>
        <P>
          When a session owns a pull request, codecast calls it the shepherd. On a pull
          request with none, the header offers <em>Assign a shepherd session</em> and lists the
          sessions that worked on it; the shipping flow assigns one itself when it opens the
          pull request. Once set, the header names the shepherd and carries a switch,{" "}
          <em>Wakes on changes</em> or <em>Paused</em>:
        </P>

        <Screenshot
          wide
          src="/blog/the-pull-request-that-knows-its-sessions/pr-shepherd.png"
          alt="The header of pull request #52 in the codecast web app: the title, Open, the author, a Shepherd control naming the session that shipped it with the note branch is behind its base and the switch Wakes on changes, the Review and Merge buttons, and the summary row of checks, review, merge, open comments and diff"
          caption="#52's header: the shepherd session, what it is waiting on, and Wakes on changes switched on."
        />

        <P>
          From then on the session is woken when the pull request moves: a check goes red, the
          branch falls behind, and above all, someone reviews it. Reviewing happens on the same
          page. On the <em>Files</em> tab, click a line and choose <em>Start a review</em>;
          later notes go in with <em>Add to review</em>. The <em>Review</em> button opens{" "}
          <em>Finish your review</em>, where the notes go out as one verdict:{" "}
          <em>Comment</em>, <em>Approve</em> or <em>Request changes</em>. It lands on GitHub
          under the reviewer&apos;s own account, so the verdict is theirs. Or choose{" "}
          <em>Send to session</em>, and the notes go only to the shepherd, as one message,
          with nothing posted to GitHub.
        </P>
        <P>
          Either way, if the pull request has a shepherd, the whole review, verdict and every
          note, arrives in that session the moment it is sent. The agent that wrote the change
          reads the review, makes each fix, pushes to the same branch, replies on the threads
          it addressed, and resolves them. The reviewer sees resolutions, not silence. Agents
          that review each other use the same batch from a terminal, with{" "}
          <Code>cast pr comment --hold</Code> and <Code>cast pr review</Code>.
        </P>
        <P>
          The shepherd on #47 was off, which is why it sat behind main all night with three
          red checks and nobody woke up. Toggle it on, and the next failed check becomes
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
          All three screenshots are the pull request pages in the codecast web app for the
          public repository codecast-sh/codecast, whose pull requests and author handles are
          public on GitHub: #47&apos;s Checks tab on 2026-09-17, cropped to the content column
          with the author&apos;s avatar blurred, and the Pull requests tab and #52&apos;s header
          on 2026-10-09. The linked sessions and the event history of #47 were read with{" "}
          <Code>cast pr show</Code> and <Code>cast pr events</Code> on 2026-09-17; the timeline
          above summarizes those events in order.
        </p>
      </article>
    </main>
  );
}
