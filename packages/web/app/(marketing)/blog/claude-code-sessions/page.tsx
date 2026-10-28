"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Figure, Screenshot, SOL, H2, P, Code } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Six genuine screenshots of the codecast web app on a local build of this
// checkout, in Chrome on 2026-10-27. The two sessions in them were run for this
// post in a throwaway repository (/tmp/wordcount): one Claude Code session and
// one Codex session, each started by hand in a terminal. The Claude Code
// session was renamed in the app, its process was ended, and the follow-up
// pictured was sent from the app's composer, which resumed it. Every image is
// cropped to one part of the screen; the rest of the account (other sessions,
// people, projects) is outside every crop. Nothing was composited or retouched.

const DIR = "/blog/claude-code-sessions";

/** A small capture shown at its own size (the PNGs are 2.56x), centred in the frame. */
function CardShot({ src, alt, width, caption }: { src: string; alt: string; width: number; caption: string }) {
  return (
    <Figure caption={caption}>
      <div className="flex justify-center px-4 py-6" style={{ backgroundColor: SOL.base2 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} loading="lazy" className="block max-w-full h-auto" style={{ width }} />
      </div>
    </Figure>
  );
}

export default function ClaudeCodeSessionsPost() {
  const post = getPost("claude-code-sessions");
  useRouteMeta("/blog/claude-code-sessions");

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
            Finding, naming and reopening your Claude Code sessions
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Claude Code keeps every session as a file on the machine that ran it, named by a
            random id. Codecast collects those sessions, and the ones from Codex, Cursor and
            Gemini, from every computer you use into one list. You can search what was said in
            them, give them names, read the whole transcript with the code it changed, and send
            the next message to any of them.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 6} min read</span>
          </div>
        </header>

        <H2>Two sessions</H2>
        <P>
          To show this on something you can read, we ran two small sessions for this post in
          a throwaway repository with one script in it, <Code>wc.py</Code>, which counts the
          words in a file. In one terminal, Claude Code got this:
        </P>
        <blockquote className="my-6 border-l-2 pl-5 font-mono text-[15px] leading-relaxed" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
          Add a --top N option to wc.py that prints the N most common words with their counts
          after the total. Standard library only, and update the README.
        </blockquote>
        <P>
          In another, Codex was asked to write unit tests for the same script. Neither was
          started from Codecast. Both were plain terminal sessions, and both showed up in the
          inbox while they ran, because the Codecast background app on the laptop picks up
          every session as it happens. Clicking the <em>wordcount</em> project chip at the top
          of the list narrows it to that repository:
        </P>

        <CardShot
          src={`${DIR}/inbox-two-agents.png`}
          width={340}
          alt="Two session cards under DONE (2): a Codex session titled Write test_wc.py with ..., summarized as Added four words() unittest cases; and a Claude Code session titled Word count: --top N flag, whose last message reads When FILE is -, read from standard input. Both are in the wordcount project"
          caption="The inbox, filtered to one project. Codex on top, Claude Code below."
        />

        <P>
          Each card shows which agent ran it, its title, its last message and its project. The
          same list holds sessions from every computer where you have installed Codecast, so a
          session you ran on a desktop last week sits next to the one you started on a laptop
          this morning.
        </P>

        <H2>Naming a session</H2>
        <P>
          A session starts out titled with the start of its first message. That is often good
          enough, and often it is not: <em>Add a --top N option to wc.py that prints the N
          mo...</em> is long and says nothing you would search for later. To rename one, open
          it and press <Code>Ctrl+Shift+E</Code>:
        </P>

        <CardShot
          src={`${DIR}/rename.png`}
          width={540}
          alt="The rename box: the old title in grey on top, the new name Word count: --top N flag typed below it, and one row reading Rename to Word count: --top N flag"
          caption="The old title on top, the new one below. Enter saves it."
        />

        <P>
          The new name is saved to your account, so it is the name in the inbox, in search,
          on your phone and in every other window, as the card above shows.
        </P>

        <H2>Finding an old one</H2>
        <P>
          The search box at the top of the app shows matching sessions as you type. For more
          control, the search page takes the same query with filters: <em>Only mine</em>{" "}
          (leave out teammates&apos; sessions, if you have a team), <em>My prompts</em> (match
          only what you typed, not what the agent wrote), a time range, and a choice between
          most recent and most relevant first. Here, looking for the session where we asked
          about standard input:
        </P>

        <Screenshot
          src={`${DIR}/search.png`}
          alt="The search page with the query standard input, filters set to Only mine, My prompts and Past week. The first result is the session Word count: --top N flag in the wordcount project, 36 messages, with two of the prompts typed into it, the words standard and input highlighted"
          caption="Search matches the words inside the conversation, not just the title."
        />

        <P>
          Search reads the messages themselves from the last 30 days, and the title and
          summary of every session before that, which is one more reason to give the sessions
          you will want again a name.
        </P>

        <H2>The whole transcript, and the code it changed</H2>
        <P>
          Opening a session shows the conversation as it happened. The agent&apos;s tool calls
          are folded into small rows (<em>ran ls</em>, <em>wrote 2 files</em>,{" "}
          <em>1 edit, ran 2 commands</em>) that open to show the command and its output:
        </P>

        <Screenshot
          src={`${DIR}/transcript.png`}
          alt="Claude's reply in the session: its plan, folded rows for the commands it ran and the files it wrote, and its summary of the change, with sample output of python wc.py sample.txt --top 3 printing 10, the 3, dog 2, cat 1"
          caption="Claude's first turn: the plan, the folded tool calls, and what it reported."
        />

        <P>
          Next to the conversation is the code. The panel has a tab for the whole session, the
          branch, a commit, and the last turn, each as a diff of the files involved. This is
          the Turn tab after the follow-up below, two files, eight lines added and four removed:
        </P>

        <CardShot
          src={`${DIR}/diff.png`}
          width={540}
          alt="The diff panel on the Turn tab: 2 files, +8 -4. README.md has one line changed to add Use - as FILE to read standard input. wc.py adds import sys and a help text on the file argument"
          caption="What the last turn changed, file by file."
        />

        <H2>Picking it back up</H2>
        <P>
          By the time we came back to the Claude Code session, its terminal was closed and the
          process was gone. In Codecast the conversation still ends in a message box. We typed
          the next request there:
        </P>

        <Screenshot
          src={`${DIR}/followup.png`}
          alt="The follow-up When FILE is -, read from standard input instead, and Claude's reply under it: its plan, a folded row of 4 edits, its test run, and a summary saying wc.py now reads from standard input when FILE is -"
          caption="The follow-up, sent from the app to a session whose terminal was closed."
        />

        <P>
          Codecast started Claude Code again on the laptop with <Code>--resume</Code> and that
          session&apos;s id, so it carried on with its full history, and the answer was back
          in about twenty seconds. You do not need to find the id, the folder it ran in or the
          machine it was on. The diff panel and the inbox card updated with the new turn.
        </P>

        <H2>What you need</H2>
        <P>
          An account and the Codecast app on each computer you code on; your empty inbox shows
          the one-line install command. Sessions start arriving from then on, from Claude
          Code, Codex, Cursor and Gemini CLI. You do not need a team for any of this. If you
          have one, the same inbox can show their sessions too, and the <em>Only mine</em>{" "}
          filter takes them back out.
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
          <Link href="/blog/undo-with-a-history">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              Undo, with a history you can see
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All six screenshots are the Codecast web app on a local build in Chrome on
          2026-10-27. The two sessions were run for this post in a throwaway repository, each
          started by hand in a terminal. The account&apos;s other sessions, people and
          projects are outside every crop. The transcript image starts below the first prompt,
          which is quoted in the text instead, and the diff is cut off below the lines shown.
          Nothing was composited or retouched.
        </p>
      </article>
    </main>
  );
}
