"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, CardShot, CardShots, Prompt, SOL, H2, P, Code, Terminal } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Eight genuine screenshots of the Codecast iPhone app, run in the iOS simulator
// against this checkout on 2026-11-02 and signed in to a real account. The
// sessions in them were run for this post in a throwaway repository
// (/tmp/tidebook): a Claude Code session and a Codex session, each started by hand
// in a terminal on the laptop, and a second Claude Code session started from the
// phone. Every tap pictured was a real tap in the app, and the terminal excerpt is
// copied from the laptop's terminal. The inbox is narrowed to the demo project and
// cropped below the account's header; the new session sheet is cropped above its
// folder list. Nothing was composited or retouched.

const DIR = "/blog/claude-code-from-your-phone";
const PHONE = 300;
/** Two phones side by side fit the text column's figure at this width. */
const PHONE_PAIR = 272;

export default function ClaudeCodeFromYourPhonePost() {
  const post = getPost("claude-code-from-your-phone");
  useRouteMeta("/blog/claude-code-from-your-phone");

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
            Answering Claude Code from your phone
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            You start Claude Code in a terminal on your laptop, give it a job, and walk away. Ten
            minutes later it has a question, or it wants permission to write a file, and it waits.
            Codecast&apos;s iPhone app shows you that session, lets you answer the question or
            approve the edit, and sends your next message to the same terminal, as if you had typed
            it there.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "November 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>A job on the laptop</H2>
        <P>
          For this post we made a small repository, <Code>tidebook</Code>, with one script in it,{" "}
          <Code>tides.py</Code>, that prints the next high and low tide from a CSV of predictions.
          In a terminal on the laptop we started Claude Code the usual way, in its default mode,
          where it asks before it edits a file or runs a command. It got this:
        </P>
        <Prompt>
          Add a --days N option to tides.py that lists every high and low tide in the next N days,
          one per line. Before you write any code, ask me one question: should times print in local
          time or UTC?
        </Prompt>
        <P>
          Then we put the laptop down and picked up the phone. Everything below happened in the
          Codecast app on an iPhone, while Claude Code kept running in that terminal.
        </P>

        <H2>The session list</H2>
        <P>
          The app opens on the same inbox as the Codecast web and desktop apps. Sessions sit under
          who acts next: <em>Needs You</em> when the agent is waiting on you,{" "}
          <em>Working</em> while it runs. We had also started Codex in a second terminal on the
          same project, asking it to check the README, so the list had two. The menu at the top
          left narrows the list to one project:
        </P>

        <CardShot
          src={`${DIR}/inbox.png`}
          width={402}
          alt="The Codecast inbox on iPhone, narrowed to the tidebook project: tides.py --days option under Needs You, and Check whether README.md describes every option under Working"
          caption="Claude Code waiting on us, Codex still working."
        />

        <P>
          Neither session was started from Codecast. The Codecast app on the laptop picks up
          Claude Code and Codex sessions as they run and keeps the list current on every device
          you sign in on.
        </P>

        <H2>Answering its question</H2>
        <P>
          Claude read the script and the CSV, then asked its question with two choices. Opening the
          session on the phone shows the conversation as it happened: our prompt, Claude&apos;s
          note, a folded row for the commands it ran, and the question with its choices as buttons.
          The status under the message box reads <em>Needs You</em>.
        </P>

        <CardShot
          src={`${DIR}/question.png`}
          width={PHONE}
          alt="The Claude Code session on iPhone: our prompt, Claude's note that it will read tides.py first, a folded ran ls · head row, and a TIMEZONE question with Local time (Recommended) and UTC as buttons"
          caption="The question, with Claude's own reasoning for the recommended choice."
        />

        <P>
          We tapped <em>Local time (Recommended)</em>. The choice reached the terminal on the
          laptop within a few seconds, and Claude carried on and wrote the code.
        </P>

        <H2>Approving a file edit or a command</H2>
        <P>
          Because Claude Code was in its default mode, it stopped before overwriting{" "}
          <Code>tides.py</Code>, again before editing the README, and again before running the
          script to check its work. Each time, a card showed up in the conversation on the phone
          with the tool and what it wanted to do:
        </P>

        <CardShot
          src={`${DIR}/permission.png`}
          width={402}
          alt="A Permission Required card for Bash, showing the command wc -l predictions.csv && python3 tides.py predictions.csv, with Approve and Deny buttons"
          caption="The command it wants to run, with Approve and Deny."
        />

        <P>
          Tapping <em>Approve</em> answered the prompt in the terminal; Claude&apos;s output there
          marks each one <em>Allowed by PermissionRequest hook</em>. In the build we used, the card
          appears at the top of the conversation, above the first message, so if a session reads{" "}
          <em>Needs You</em> and you see no question at the bottom, scroll up.
        </P>

        <H2>Reading the result and sending the next message</H2>
        <P>
          When Claude finished, its reply came through on the phone as written, with the command it
          ran and its output in a code block. It also pointed out something we hadn&apos;t asked
          about: the sample CSV only covers two days, so its own run didn&apos;t prove the cutoff
          works. So we typed the next request into the message box at the bottom:
        </P>
        <Prompt>
          Add a unit test for the cutoff: a high tide three days out must not show up in a two day
          listing.
        </Prompt>

        <CardShots
          width={PHONE_PAIR}
          images={[
            {
              src: `${DIR}/reply.png`,
              alt: "Claude's reply on iPhone: a folded wrote 1 file · 1 edit · ran 1 command row, a summary of the --days option, a code block with python3 tides.py predictions.csv --days 2 and three tides, and notes on default output, argument handling, a shared filter and the README",
            },
            {
              src: `${DIR}/follow-up.png`,
              alt: "The same conversation after the follow-up: our message asking for a unit test for the cutoff, and Claude's answer that it will add a standard library unittest file, a folded wrote test_tides.py row and a ran python3 row",
            },
          ]}
          caption="Left: the reply. Right: our follow-up from the phone, and Claude at work on it."
        />

        <P>On the laptop, the message landed in the terminal as Claude Code&apos;s next turn:</P>

        <Terminal label="claude in /tmp/tidebook, on the laptop" wrap>
{`❯ Add a unit test for the cutoff: a high tide three days out must not show up in a two day listing.

⏺ No test setup exists in the repo, so I'll add a stdlib unittest file that calls tides_within with a fixed now. That way it doesn't depend on the CSV or the clock.

⏺ Write(test_tides.py)
  ⎿  Wrote 16 lines to test_tides.py
  …
  ⎿  Allowed by PermissionRequest hook

⏺ Running it, then breaking the cutoff on purpose to confirm the test catches it:
  Ran 1 shell command
  ⎿  Allowed by PermissionRequest hook

⏺ I added the test in test_tides.py, and it passes.`}
        </Terminal>

        <P>
          Both <em>Allowed</em> lines are taps on the phone. If you come back to the laptop, the
          terminal holds the whole session, and you can keep typing there; the phone is a second
          way into the same conversation.
        </P>

        <H2>Codex in the same list</H2>
        <P>
          The Codex session reads the same way. Its header carries the Codex mark and the model it
          runs, its commands fold into rows, and its report comes through in full:
        </P>

        <CardShot
          src={`${DIR}/codex.png`}
          width={PHONE}
          alt="The Codex session on iPhone, marked Codex and GPT-6 Astra: folded rows for ran cat · git status, ran rg and ran git status, then its finding that the README does not say N must be at least 1, omits -h and --help, and does not explain the CSV columns; both example commands ran and no files changed"
          caption="Codex's report on the README, read on the phone."
        />

        <P>
          We read this one on the phone and sent our follow-ups in this post to the Claude Code
          session.
        </P>

        <H2>Starting a session from the phone</H2>
        <P>
          The pencil at the top right of the inbox starts a new session without going near the
          laptop. You write the first message, pick the agent (Claude, Codex, Cursor, Grok and
          others), pick the folder and the machine to run it on. We typed the path to our demo
          repository into the folder search and picked the laptop:
        </P>

        <CardShot
          src={`${DIR}/new-session.png`}
          width={402}
          alt="The new session sheet: the message Give tides.py an option to print the day listing as JSON, and add a test for it, with Claude selected among Claude, Codex, Cursor and Grok"
          caption="The first message and the agent. The folder and machine are below the crop."
        />

        <CardShot
          src={`${DIR}/new-session-done.png`}
          width={PHONE}
          alt="The finished session on iPhone, titled Tides.py JSON day listing: what changed in tides.py, the rule that --json needs --days, two tests in test_tides.py, a README line, and a note that it built on the uncommitted --days work already in the tree"
          caption="Claude Code ran on the laptop; the whole session played out on the phone."
        />

        <P>
          The session ran on the laptop, in the demo folder, and noticed the uncommitted work the
          first session had left there. Sessions Codecast starts run in Claude Code&apos;s bypass
          permissions mode by default, so this one didn&apos;t stop to ask before editing or
          running anything.
        </P>

        <H2>What you need</H2>
        <P>
          A Codecast account, the Codecast app on the laptop (your empty inbox shows the one-line
          install command), and the Codecast app for iPhone from the{" "}
          <a href="https://apps.apple.com/app/id6757820850" className="underline" style={{ color: SOL.blue }}>
            App Store
          </a>
          , signed in to the same account. Android isn&apos;t out yet. Keep starting Claude Code and
          Codex the way you already do. The agent still runs on the laptop, so the laptop has to be
          awake and online for your answers to reach it. You don&apos;t need a team for any of
          this. If you were looking for Anthropic&apos;s own ways to reach Claude Code remotely,
          their documentation covers those; this post covers only what Codecast does.
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
          All eight screenshots are the Codecast iPhone app, running in the iOS simulator on a
          local build on 2026-11-02 and signed in to a real account. The sessions were run for this
          post in a throwaway repository: Claude Code and Codex were each started by hand in a
          terminal on the laptop, and the third session was started from the phone. Every answer,
          approval and message pictured was sent from the phone. The inbox is narrowed to the demo
          project and cropped below the account&apos;s header, and the new session sheet is cropped
          above its folder and machine. The terminal excerpt is copied from the laptop, with the
          test file&apos;s contents and the end of Claude&apos;s last reply left out. Nothing was
          composited or retouched.
        </p>
      </article>
    </main>
  );
}
