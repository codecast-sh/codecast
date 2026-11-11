"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Screenshot, SOL, H2, P, Code } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Three genuine screenshots of the Codecast web app at codecast.sh, in Chrome on
// 2026-11-08, signed in to the founder's account. The sessions pictured were
// synced as they ran over the past months, not by the history import; search and
// the transcript look the same either way. The search is narrowed to the
// account's own sessions and every result in frame is from the codecast project.
// The search image is two crops of the same results page (its top, and further
// down the list). The transcript image starts at Claude's first reply, below a
// prompt whose attached screenshot showed other people's photos. Nothing was
// composited or retouched. The import numbers come from the test run in session
// jx71jtq (ct-57303) and were rechecked against packages/cli/src/daemon.ts,
// packages/convex/convex/conversations.ts and
// packages/shared/contracts/inboxProjection.ts.

const DIR = "/blog/claude-code-history-on-day-one";

export default function ClaudeCodeHistoryOnDayOnePost() {
  const post = getPost("claude-code-history-on-day-one");
  useRouteMeta("/blog/claude-code-history-on-day-one");

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
            Your old Claude Code sessions, on the day you install Codecast
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            By the time most people try Codecast, they have months of Claude Code sessions sitting
            in files on their laptop. When you sign in on a machine, Codecast now uploads all of
            them in the background. The ones from the past week go in your inbox. The rest are in
            search and open in full, from the first day.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "November 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 4} min read</span>
          </div>
        </header>

        <H2>What happens when you sign in</H2>
        <P>
          Claude Code writes every session to a file under <Code>~/.claude/projects</Code>, one
          folder per project. Until this month, a new Codecast install uploaded only the files
          touched in the last week, so an account started out holding a week of history and grew
          from there. Anything older stayed on the laptop.
        </P>
        <P>
          Now, after you install the Codecast app on a machine and sign in, it does two passes.
          The first uploads the last week, as before, so your inbox fills in first. The second goes through every Claude Code session file on the machine, however old,
          and uploads the ones Codecast doesn&apos;t have yet.
        </P>
        <P>
          The second pass is slow on purpose. It sends one file at a time and waits a quarter of a
          second between files, which caps it at about 14,000 sessions an hour, so it doesn&apos;t
          compete with the sessions you are running while it works. If you close the lid or restart halfway through, it carries
          on the next time the app starts and skips everything already uploaded. Folders you have
          excluded from syncing are skipped here too.
        </P>
        <P>
          This pass reads Claude Code&apos;s session files. Sessions from Codex, Cursor and the
          other agents Codecast supports are picked up as they run, the same as before. Version
          1.1.213 of the Codecast app, released November 5, is the first with the history pass;
          machines that were already signed in don&apos;t run it on upgrade, only when they sign in
          again.
        </P>

        <H2>Your inbox stays on this week</H2>
        <P>
          The inbox is where you see what your agents are doing now and which of them is waiting
          on you. Three hundred sessions from last spring don&apos;t belong there, so the server
          treats a session differently when it started more than seven days before it was
          uploaded. It keeps that session out of the inbox unless something happened in it during
          the last seven days. Everything else about it is the same as any other session.
        </P>
        <P>
          We checked this on a fresh account and a clean Mac user with 30 test sessions spread
          over 14 days. All 30 arrived; the history pass handled the 16 older ones in about 13
          seconds. The 14 sessions from the past week were the ones the inbox could show, and none
          of the 16 older ones appeared there.
        </P>

        <H2>Finding an older session</H2>
        <P>
          The older sessions are where you would look for them anyway. Search for a word and the
          results run back through your history. The note under the result count says how far
          the full text goes: messages from the last 30 days are searched word for word, and older
          sessions match on their title and summary.
        </P>

        <Screenshot
          src={`${DIR}/search-query.png`}
          alt="Codecast search for hibernate, narrowed to my sessions: 22 sessions, with the note Messages from the last 30 days. Older sessions match by title and summary."
          caption="A search for hibernate across one account's own sessions."
        />

        <P>
          Further down the same results are sessions from six and seven weeks earlier. One matched
          on its title, <em>Hibernated badge placement</em>; another on its summary, which shows
          under it with the word highlighted.
        </P>

        <Screenshot
          src={`${DIR}/search-older.png`}
          alt="Older search results, all in the codecast project: LiveKit state sync issues (Oct 2), Hibernated badge placement (Sep 23) with hibernate highlighted in the title, Session parking verification (Sep 22), and Idle clock hibernation fix verification (Sep 20) with its summary quoted"
          caption="Sessions from late September, found by title and by summary."
        />

        <P>
          Opening one shows the whole transcript as it happened, with the dates it happened on:
          the prompt, Claude&apos;s replies, folded rows for the files it read and the commands it
          ran, and the files it changed. From there you can send it a new message, and it picks
          up where it stopped.
        </P>

        <Screenshot
          src={`${DIR}/old-session.png`}
          alt="A Claude Code session from September 23 opened in Codecast: Claude's reply about where the hibernated badge renders, with folded rows for read 1 file, ran 5 commands, ran 6 commands and ran cat, python3"
          caption="The September 23 session, opened from search."
        />

        <H2>What you need</H2>
        <P>
          A Codecast account and the Codecast app on the machine where you run Claude Code. Your
          empty inbox shows the one-line install command; it opens the browser so you can sign in,
          and the history pass starts on its own after that. There is nothing to turn on. You
          don&apos;t need a team for any of this. The history is yours, in your own workspace,
          and works the same whether you use Codecast alone or with other people.
        </P>
        <P>
          For people who script their setup: signing in from a terminal with{" "}
          <Code>cast login</Code> starts the same pass, and the Codecast app&apos;s log shows{" "}
          <Code>History import: done</Code> when it finishes.
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
          <Link href="/blog/claude-code-sessions">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              Finding your Claude Code sessions
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All three screenshots are the Codecast web app at codecast.sh in Chrome on 2026-11-08,
          signed in to the founder&apos;s account. The sessions in them were synced as they ran
          over the past months rather than by the history pass; search and the transcript look the
          same either way. The search is narrowed to the account&apos;s own sessions, and every
          result in frame is from the Codecast project. The first two images are the top of one
          results page and a part further down it. The transcript starts at Claude&apos;s first
          reply, below a prompt whose attached screenshot showed other people&apos;s photos.
          Nothing was composited or retouched. The 30-session check ran on a separate test account
          on a Mac mini.
        </p>
      </article>
    </main>
  );
}
