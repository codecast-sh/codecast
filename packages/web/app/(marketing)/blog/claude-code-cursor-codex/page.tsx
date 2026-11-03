"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Screenshot, SOL, H2, P, Code, CardShot, Prompt } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Seven genuine screenshots of the codecast web app on a local build of this
// checkout, in Chrome on 2026-10-30. The sessions in them were run for this post
// in a throwaway repository (/tmp/slugs): one Cursor CLI session and one Claude
// Code session, each started by hand in a terminal, one after the other. The
// Claude Code session was then switched to Codex from the app, and the two
// follow-ups pictured were sent from the app's composer. Every image is cropped
// to one part of the screen; the rest of the account (other sessions, people,
// projects) is outside every crop. Nothing was composited or retouched.

const DIR = "/blog/claude-code-cursor-codex";

export default function AgentsTogetherPost() {
  const post = getPost("claude-code-cursor-codex");
  useRouteMeta("/blog/claude-code-cursor-codex");

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
            Claude Code, Cursor and Codex on the same project
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Plenty of people run more than one coding agent on a project: Cursor for one piece,
            Claude Code for another, Codex for a second look. Each keeps its own sessions in its
            own place. Codecast puts them in one list, shows what each one said and did, and can
            move a conversation from Claude Code to Codex so the second agent picks up with the
            whole history.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>One project, two agents</H2>
        <P>
          For this post we made a small repository with one script in it, <Code>slugify.py</Code>,
          which turns titles like <em>Hello, World</em> into URL slugs like{" "}
          <em>hello-world</em>. Then we did what a lot of people do: gave one job to Cursor and the
          next to Claude Code. First, in a terminal, Cursor&apos;s command line agent got this:
        </P>
        <Prompt>
          Write unit tests for slugify() in slugify.py in a new file test_slugify.py using
          unittest. Cover punctuation, repeated separators, leading and trailing spaces, and
          accented letters. Run them and report what passes.
        </Prompt>
        <P>When it was done, Claude Code got the next job in another terminal:</P>
        <Prompt>
          Add a --max-length N option to slugify.py that cuts each slug to at most N characters
          without ending on a hyphen or splitting a word when possible. Standard library only.
          Add tests for it to the existing test_slugify.py and update the README.
        </Prompt>
        <P>
          Neither was started from Codecast. Both showed up in the list on their own, because the
          Codecast app on the laptop picks up sessions from Claude Code, Codex, Cursor and other
          agents as they run. Each card carries the agent&apos;s mark, so you can tell them apart
          at a glance, and clicking the project&apos;s chip at the top of the list narrows it to
          that repository. We renamed both sessions in the app to keep the titles short:
        </P>

        <CardShot
          src={`${DIR}/inbox-two-agents.png`}
          width={280}
          alt="Two session cards in the slugs project: slugify: --max-length with the Claude mark, marked COMPLETE, and slugify: unit tests with the Cursor mark"
          caption="Claude Code on top, Cursor below, both in the slugs project."
        />

        <H2>What each one did</H2>
        <P>
          Opening a session shows its conversation as it happened, whichever agent ran it. Here is
          Cursor&apos;s, below the prompt. Its tool calls are folded into small rows (
          <em>read 1 file</em>, <em>wrote 1 file</em>) that open to show what it ran, and its
          report comes through as written, table included:
        </P>

        <Screenshot
          src={`${DIR}/cursor-transcript.png`}
          alt="The Cursor session in codecast: its plan to write test_slugify.py and run it with uv, folded rows for reading a file and writing a file, a table of four tests that all passed, and a note that accented letters are dropped, so café becomes caf"
          caption="Cursor's turn. The last line is the one we came back to."
        />

        <P>
          That last line matters later: the script throws accented letters away, so{" "}
          <em>café</em> becomes <em>caf</em>.
        </P>
        <P>
          Next to a Claude Code session is the code it changed. The panel lists each file with
          the lines added and removed, and has tabs for the whole session, the branch and a
          commit. Claude edited the README and added 32 lines of tests to the file Cursor had
          written:
        </P>

        <CardShot
          src={`${DIR}/claude-diff.png`}
          width={420}
          alt="The diff panel on the Session tab: README.md with 9 lines added describing --max-length N and an example, and test_slugify.py with 32 lines added"
          caption="Claude's changes, file by file. The panel is cut off on the right and below."
        />

        <P>
          For the Cursor session that panel stayed empty on our run. Its transcript names the
          file it wrote, and the tests themselves were in the repository, but the line by line
          diff is something we saw for Claude Code, not for Cursor.
        </P>

        <H2>Handing the conversation to Codex</H2>
        <P>
          To fix the accents, we wanted a different model on it, with everything that had
          happened so far. In a session&apos;s header, next to the agent&apos;s mark, is the
          model it is running. Clicking it opens the session&apos;s controls, and{" "}
          <em>Switch agent</em> lists the agents to move to:
        </P>

        <CardShot
          src={`${DIR}/switch-agent.png`}
          width={336}
          alt="The Switch agent list: Claude marked current; Codex, OpenCode, pi and Grok available; Cursor and Muse Spark greyed out with can't rebuild history"
          caption="Claude is current. Cursor is greyed out here; Codex is not."
        />

        <P>
          Cursor and Muse Spark are greyed out because they can&apos;t take over a conversation
          another agent started. The other agents can, so we picked Codex. Codecast stopped the
          Claude Code process that was still open in the terminal, and a divider landed in the
          conversation:
        </P>

        <Screenshot
          src={`${DIR}/switch-divider.png`}
          alt="A thin divider across the conversation reading now using Codex, was Claude, just now"
          caption="Same conversation, same title and link. A new agent answers from here."
        />

        <P>We typed the next request in the app&apos;s message box:</P>
        <Prompt>
          The accented letters test from earlier shows café becomes caf. Turn accented letters
          into plain ones instead, so café becomes cafe. Standard library only, and update that
          test.
        </Prompt>

        <Screenshot
          src={`${DIR}/codex-reply.png`}
          alt="Codex's reply: it normalizes accents with the standard library's unicodedata, café to cafe, naïve résumé to naive-resume, São Paulo to sao-paulo, updated the test, and all 10 tests pass"
          caption="Codex's first turn in the conversation Claude Code started."
        />

        <P>
          Codex made the change with Python&apos;s <Code>unicodedata</Code>, updated
          Cursor&apos;s test, and ran all ten tests, which pass. To check that it had the
          conversation and not only the files, we asked it something only the history could
          answer:
        </P>
        <Prompt>
          Before you answer from the files: what was my first request in this session, and which
          test file did you add to then?
        </Prompt>

        <Screenshot
          src={`${DIR}/codex-history.png`}
          alt="Codex answers: your first request was to add --max-length N to slugify.py, avoiding trailing hyphens and splitting words when possible, using only the standard library, with tests and a README update. I added tests to the existing test_slugify.py"
          caption="Answered from the conversation, without running a command."
        />

        <P>
          It answered without opening a file. The request it describes was sent to Claude Code,
          and the work it calls its own was Claude&apos;s, because Codecast rewrote the whole
          conversation in Codex&apos;s format before starting it. Our field manual chapter on{" "}
          <Link href="/blog/field-manual/switching-agents" className="underline" style={{ color: SOL.blue }}>
            switching agents
          </Link>{" "}
          explains how that works, what carries over and what doesn&apos;t, and the other ways to
          move work between agents, including the ones that work for Cursor.
        </P>

        <H2>What you need</H2>
        <P>
          An account and the Codecast app on each computer you code on; your empty inbox shows
          the one-line install command. Keep starting Claude Code, Cursor and Codex the way you
          already do, and their sessions arrive in the same list. You do not need a team for
          any of this.
        </P>

        <blockquote
          className="my-8 border-l-2 pl-5 text-xl leading-relaxed font-mono"
          style={{ borderColor: SOL.yellow, color: SOL.base03 }}
        >
          Codecast records every coding agent session you run, on any machine, and gives you
          one place to see them, steer them and answer them, on your own or with your team.
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
          All seven screenshots are the Codecast web app on a local build in Chrome on
          2026-10-30. The sessions were run for this post in a throwaway repository, Cursor
          first and then Claude Code, each started by hand in a terminal; the follow-ups were
          sent from the app. The account&apos;s other sessions, people and projects are outside
          every crop. Prompts are quoted in the text rather than pictured, the Cursor transcript
          starts below its prompt, and the diff is cut off at the edges shown. Nothing was
          composited or retouched.
        </p>
      </article>
    </main>
  );
}
