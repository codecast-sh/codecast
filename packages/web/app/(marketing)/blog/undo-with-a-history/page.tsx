"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Figure, SOL, H2, P, Code } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Five genuine screenshots of the codecast web app (codecast.sh) in Chrome on
// 2026-10-21. The three changes in them were made for this post, from the
// command palette, on the session that wrote it (jx7d5m0, then titled "CMO
// content pipeline run"), and all three were taken back in the same window;
// the store read back unpinned, the original title and not a favorite
// afterwards. Each image is cropped to the undo card or to one toast. The
// sessions list behind them belongs to another workspace and is outside every
// crop. Nothing was composited or retouched.

const DIR = "/blog/undo-with-a-history";

/** A small capture shown at its own size (the PNGs are 2x), centred in the frame. */
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

export default function UndoWithAHistoryPost() {
  const post = getPost("undo-with-a-history");
  useRouteMeta("/blog/undo-with-a-history");

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
            Undo, with a history you can see
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Running several agents means a lot of small moves: pin this one, file that one as
            done, rename a third, stash a fourth. In Codecast every one of them can be taken
            back with ⌘Z, and ⌘⌥Z opens the list of what you did in this window, with a button
            to go back to any point in it.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>Three changes</H2>
        <P>
          The session that wrote this post made three changes to itself before writing a
          word, in a Codecast window in Chrome, all from the command palette (⌘K). It pinned
          itself, renamed itself from <em>CMO content pipeline run</em> to <em>Blog post on
          undo</em>, and added itself to favorites. Each change happened at once, and the
          pin left a small toast in the corner:
        </P>

        <CardShot
          src={`${DIR}/pinned-toast.png`}
          width={108}
          alt="A small toast reading Pinned, with an Undo button"
          caption="The toast after the pin. Its Undo takes back this change, not the latest one."
        />

        <P>
          That toast is the quickest way back, and it is tied to the change it announces:
          if you have made other changes since, its Undo still takes back only the pin and
          leaves the rest. For anything further back there is the history. ⌘⌥Z (Ctrl+Alt+Z
          on Windows and Linux) opens it in the same corner:
        </P>

        <CardShot
          src={`${DIR}/timeline-three.png`}
          width={380}
          alt="A card titled Undo history, subtitled This window, Command Z reaches the last 5 minutes. A line marked NOW sits above three rows, newest first: Favorited Blog post on undo, now; Renamed CMO content pipeline run to ..., now; Pinned CMO content pipeline run, 1m. The top row is selected and shows a Back to here button. Below the rows: Start, before these changes. A footer lists the keys: arrows to move, Enter to go, right arrow to fold, O to open, Command Z and Command Shift Z to step"
          caption="Undo history after the three changes. Newest at the top, the NOW line above them."
        />

        <P>
          Each row names the change and the thing it changed, in words you would use
          yourself. The line marked <em>NOW</em> is where you are; everything below it is
          done, and the dim <em>Start</em> row at the bottom is the state before any of it.
          The card takes the keyboard while it is open: the arrows move between rows, the
          right arrow unfolds one to show what it changed, <Code>O</Code> opens the session
          or task the row is about, and <Code>Esc</Code> closes it.
        </P>

        <H2>Back to here</H2>
        <P>
          Moving the selection down to the rename and unfolding it shows the change in full.
          The button on the row now reads <em>Back 2</em>, because going back to just before
          the rename takes two steps, the favorite and then the rename:
        </P>

        <CardShot
          src={`${DIR}/timeline-fold.png`}
          width={380}
          alt="The same card with the Renamed row selected and unfolded, showing Renamed CMO content pipeline run to Blog p..., and a Back 2 button on the row"
          caption="The rename unfolded. The button counts the steps it will take."
        />

        <P>
          Enter pressed the button. The title went back to <em>CMO content pipeline run</em>{" "}
          and the session left favorites, and the card kept both rows:
        </P>

        <CardShot
          src={`${DIR}/timeline-back2.png`}
          width={380}
          alt="The card after going back two steps. The Favorited and Renamed rows are now above the NOW line, dimmed, each marked undone just now with a redo icon. The NOW line sits above the Pinned row, which is selected with a Back to here button"
          caption="After Back 2: the two undone changes sit above the NOW line, ready to redo."
        />

        <P>
          Undone rows move above the line and stay there, marked <em>undone just now</em>.
          Selecting one offers <em>Forward to here</em>, and ⌘⇧Z steps forward one at a
          time, so going back too far costs nothing. Making a new change after an undo sets
          the undone rows aside, the way an editor drops its redo stack, and the card says
          so in one struck line under the change that replaced them.
        </P>

        <H2>One key</H2>
        <P>
          Most of the time you never open the card. With it closed, one ⌘Z took back the
          last change left, the pin:
        </P>

        <CardShot
          src={`${DIR}/undid-toast.png`}
          width={358}
          alt="A toast reading Undid: Pinned CMO content pipeline ..., with a History button"
          caption="One ⌘Z. The History button opens the card."
        />

        <P>
          The toast says what was undone, and its <em>History</em> button appears when
          there is more history than that one step. Holding ⌘ for a moment after a ⌘Z also
          opens the card as a peek that follows each further Z, so you can watch the steps go
          by and let go when you reach the right one. Holding ⌘Z down undoes once, not once
          per key repeat, so a long press never empties the history.
        </P>
        <P>
          After that one key the session was back exactly as it started: unpinned, its old
          title, not a favorite. Every undo is a real change, sent to the server like the
          original, so the session reads the same in your other windows, on the desktop app
          and on your phone.
        </P>

        <H2>What it takes back, and what it leaves</H2>
        <P>
          Undo covers the moves you make on your work. On sessions that means pin, favorite,
          rename, label, snooze, defer, filing as done, stash and kill; undoing a kill brings
          the card back, but the agent stays stopped until you restart it. On tasks, plans
          and docs it covers edits to their fields, and archiving a doc. It also covers
          pausing a trigger, resolving a comment and changing who can see a session.
        </P>
        <P>
          It leaves alone what cannot honestly be unsaid: a message you sent, something you
          created, something you deleted, your settings, and switching a session&apos;s agent
          or model. Text boxes keep their own undo, so ⌘Z in a composer with words in it
          edits the words.
        </P>
        <P>
          Two rules keep it from doing damage. First, it never writes over a later change.
          If a teammate or an agent has changed the same field since, that row is skipped,
          and the toast says how much it could take back (&quot;2 of 3; 1 changed
          since&quot;). Second, an undo that would let more people see a session never
          happens from a bare ⌘Z; you take it back from the toast or the card, where you can
          see what it is.
        </P>

        <H2>Where it works</H2>
        <P>
          The history belongs to the window you made the changes in, and it lives in that
          window&apos;s memory: a reload starts it fresh, and a second window has its own.
          ⌘Z reaches the last five minutes, which is what the card&apos;s subtitle says. Older
          rows stay in the card, and you can still take most of them back by choosing them there,
          because you can see exactly what you are undoing. It works the same in the
          desktop app, where the Edit menu&apos;s Undo and Redo reach it whenever the cursor
          is outside a text box. The phone app does not have it yet.
        </P>
        <P>
          To find the card without the shortcut, search the command palette for{" "}
          <em>Undo history</em>.
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
          <Link href="/blog/the-chart-in-the-reply">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              The chart in the reply
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All five screenshots are the Codecast web app at codecast.sh in Chrome on
          2026-10-21, shown at their own size. The three changes were made for this post, on
          the session that wrote it, and all three were taken back in the same window, so
          nothing changed for good. Each image is cropped to the undo card or to a single
          toast; the sessions list behind them, which belongs to another workspace, is
          outside every crop. Nothing was composited or retouched. The held peek, the desktop
          app and the conflict message are described, not pictured.
        </p>
      </article>
    </main>
  );
}
