"use client";

import Link from "next/link";
import { BlogNav, Screenshot, SOL, H2, P, Code, Figure, Terminal, Cmd, Prompt } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";
import { FigureStyles, LifeFigure, PipelineFigure, TwoScreensFigure } from "./figures";

// The board in the film and the screenshot is a real Codecast board
// (doc s97f181thpadv0jdetk5a8ew0s8jx8ky, personal workspace), built on
// 2026-11-24 by an agent session through `cast board apply`, `cast board page`
// and `cast board connect`, the commands a huddle agent runs, and captured
// one write at a time in Chrome with packages/web/scripts/app-element-shot.ts.
// The agent's cursor label is the session's short title, as it is in a real
// huddle. The call around the board in the film (faces, room chat, outro
// card) is drawn in HyperFrames and the conversation is scripted; the film's
// source is in the session that wrote this post (jx71r4a). The numbers from
// our own call are from cl-240 (Nov 24): its board doc
// s973n3v5c7jxkqwqax950v80ah8jt4xc and `cast call cl-240`. Mechanics were
// checked against convex/callStage.ts, convex/transcripts.ts
// (CONTEXT_MIN_GAP_MS), packages/shared/contracts/stagePins.ts
// (STAGE_PIN_LIMIT) and packages/shared/contracts/transcriptChunk.ts.

const DIR = "/blog/a-board-on-every-call";

export default function BoardOnEveryCallPost() {
  const post = getPost("a-board-on-every-call");
  useRouteMeta("/blog/a-board-on-every-call");

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
            A board on every call, kept by the agent in the room
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            {post?.dek}
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "November 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 9} min read</span>
          </div>
        </header>

        <Figure
          wide
          caption="A planning huddle about search speed, in 55 seconds. The board is a real Codecast board, captured one write at a time while an agent session built it with the same commands a huddle agent uses. The call around it is drawn and the conversation is scripted."
        >
          <video
            src={`${DIR}/call-board.mp4`}
            poster={`${DIR}/poster.jpg`}
            className="w-full h-auto block"
            autoPlay
            muted
            loop
            playsInline
            controls
            preload="metadata"
            aria-label="A Codecast huddle with Priya, Theo, Maya and an agent named Juniper. Juniper joins and puts the call's board on the stage. As the three talk about whether search is fast enough for Thursday's launch, notes appear on the board in frames: the launch, why search is slow, a chart of search latency the agent published, the options, what was decided, who does what, and two open questions. When the call ends, the board stays with the call."
          />
        </Figure>

        <H2>Why a call needs a board</H2>
        <P>
          Our team runs most of its planning on Codecast huddles: voice and video calls inside the
          app, transcribed by speaker as people talk. For a while now you could bring an agent
          session into one. It hears the transcript, answers when someone says its name, and
          checks things against the code and the team&apos;s record while the room keeps talking.
        </P>
        <P>
          It had two ways to give anything back. It could write a line in the call&apos;s chat, or
          publish a page and link it there. Both scroll away. Half an hour into a call, the chart
          someone asked for in minute six is forty messages up, and the room has no shared picture
          of where it got to: what the options were, which one won, who said they would do what.
          A whiteboard is the usual answer, and nobody wants to be the person drawing it instead of
          talking.
        </P>
        <P>
          So now the agent draws it. When an agent joins a huddle, the call gets a board, pinned on
          everyone&apos;s stage beside the faces. As the talk goes, the agent puts it there: the
          topics as frames, the points and numbers as notes inside them, how they connect, what was
          decided, who owns what, and what is still open. People edit the same board at the same
          time. When the call ends, the board stays with it.
        </P>

        <H2>The stage holds things, not only faces</H2>
        <P>
          A huddle&apos;s stage used to hold two kinds of tile: people and screen shares. It now
          holds a third, a pinned thing. The pin button in the call&apos;s header opens a short
          list: <strong>Call board</strong>, <strong>New board</strong>, <strong>New sheet</strong>,
          and a field that finds any doc by name or takes a pasted link or short id. So a board, a
          sheet, a dashboard, a doc, a published page, a task or a plan can all go up on the stage.
        </P>
        <P>
          A pin differs from a screen share in the way that matters. Each person sees the thing
          itself, live, at the size of their own screen, with everyone&apos;s cursors on it. Theo can
          zoom into the options while Priya reads the chart. Anyone can add a note, and it lands on
          every screen as they type it. Each pin gets a tab over the stage, so the room flips
          between the board and a pricing sheet the way it would flip between two shared screens.
        </P>

        <Figure caption="The same board on two people's screens in one huddle. A note Theo adds lands on Priya's screen at once with Theo's cursor; the agent's cursor adds the decision and a page; a second pin gets its own tab.">
          <TwoScreensFigure />
        </Figure>

        <P>
          A stage holds up to six pins; a seventh replaces the oldest. Pinning posts a line in the
          call&apos;s chat (&ldquo;Juniper put the call&apos;s board on the stage&rdquo;), so someone
          who folded the stage away still sees that something went up. Pins respect access: a doc
          that only its owner can open shows everyone else a lock and the name of the person to
          ask.
        </P>

        <H2>Where the board comes from</H2>
        <P>
          Nobody has to make it. The first agent to join a transcribed huddle makes the call&apos;s
          board, names it after the call and the day (&ldquo;Launch week board · Dec 1&rdquo;), and
          pins it. In a team huddle the board belongs to the team. In a private huddle it goes to
          the personal workspace of whoever brought the agent in, so a private call never leaks a
          board to people who were not in it.
        </P>
        <P>
          The room stays in charge of its stage. If someone takes the board down, it stays down:
          a second agent arriving, or the same agent asking for the board again, gets the same
          board back without putting it on the stage. Anyone in the call can bring it back with{" "}
          <strong>Call board</strong> in the pin list. There is one board per call however many
          agents join, and a huddle with transcription off has no call record yet, so it gets its
          board when transcription starts.
        </P>

        <Figure caption="The board's life. Made and pinned when the first agent arrives, edited by everyone during the talk, left down if the room takes it down, and kept after the call.">
          <LifeFigure />
        </Figure>

        <H2>How the agent hears the room</H2>
        <P>
          The agent keeping the board works from the transcript, which arrives with every line
          attributed to its speaker. What it gets depends on whether anyone named it. A line that
          says its name reaches it right away, as a question to answer. Everything else, the room
          talking among itself, reaches it in batches, at most one a minute, with a standing
          instruction: bring the board up to date with what was said, and bring what the code or
          the record settles.
        </P>
        <P>
          Each turn ends one of two ways. The agent can write a reply, which shows up in the
          call&apos;s chat (and is spoken aloud by a voice agent only when someone asked it
          something). Or it can end with <Code>[pass]</Code>, and the room sees nothing. A turn
          spent only on the board is a good turn: the agent updates the board, passes, and nobody
          is interrupted. That is most of its turns in a real call.
        </P>
        <P>
          Two smaller details keep this working over a long call. Every batch of transcript names
          the board&apos;s id, so an agent whose context was compacted halfway through still knows
          which board is the room&apos;s. And when the agent needs a few uninterrupted minutes (to
          read code and write a page, say), it can take a hold: the room&apos;s words wait and
          arrive together when it is done, while a line that names it still gets through at once.
        </P>

        <Figure wide caption="From the room to every screen. Speech becomes a transcript by speaker; a line that names the agent reaches it now, the rest at most once a minute; the agent writes to the board, publishes a page, files a task, says one line or passes; every stage shows the board change at once.">
          <PipelineFigure />
        </Figure>

        <H2>What the agent is told</H2>
        <P>
          The board is only as good as the agent&apos;s judgment about what goes on it, and that
          judgment comes from a paragraph in its briefing. This is it, as every huddle agent
          receives it:
        </P>
        <Prompt>
          The room has a board, pinned on everyone&apos;s call stage next to the faces, and you keep
          it. It is the room&apos;s shared picture of the conversation: as the talk goes, put its
          substance there: the topics as frames, the ideas, options, numbers and open questions as
          stickies inside them, how things connect, what was decided and who owns what next. Read it
          before you write, because people edit it with you: build on what is there, move and
          reword your own work as the talk changes rather than adding second copies, and leave what
          people wrote to them. Keep it readable at a glance from across the room: short phrases,
          grouped, nothing piled up. Every page you publish goes on the board too, beside the ideas
          it supports.
        </Prompt>
        <P>
          Three of those instructions do most of the work. <strong>Read it before you write</strong>{" "}
          matters because people edit the board during the call, and an agent writing from its own
          memory of the board would paste over them. <strong>Move and reword your own work</strong>{" "}
          keeps the board from growing a second copy of every idea each time the talk circles back.
          And <strong>leave what people wrote to them</strong> is the line that makes people
          willing to write on it at all.
        </P>
        <P>
          The rest of the briefing is about being useful in the room, and it shows up on the board
          too. The agent is told to go and look before it speaks: read the code, search past
          sessions and decisions, pull the real number, and say where it came from. In the film,
          when Theo says every save rebuilds the index, the agent reads the indexer and adds an
          orange note that starts with <em>Checked</em>. When the room needs more than a sentence (a
          chart, a comparison, a plan), the agent publishes a page and places it on the board next
          to the notes it supports, where it stays live: republishing the page updates it in place.
        </P>

        <Screenshot
          src={`${DIR}/board.png`}
          alt="The finished board in Codecast: six frames. Launch: Thursday, Dec 3, with two notes. Why search is slow, with three notes, the last an orange Checked note. A published page, Search p95 by workspace size, showing bars from 210 ms under 5k docs to 1.8 s over 50k. Options A, B and C in blue, with arrows from A and B to a green Decided note reading A before launch, B the week after, and from C to C is off the table. Who does what, with three owner notes. Still open, with two orange questions. The agent's cursor rests below the board."
          caption="The finished board from the film, as Codecast draws it. The chart is a page the agent published and placed beside the notes it supports."
          wide
        />

        <H2>The commands under it</H2>
        <P>
          The agent does all of this with the same <Code>cast board</Code> commands any Codecast
          session can run, outside calls too. It reads the board in a compact form it can reason
          over, writes a batch of elements in one call with its status shown on its cursor, places
          a published page, and connects notes with arrows that stay attached when someone moves
          them. Pinning anything else on the stage is one more command.
        </P>
        <Terminal label="the agent's side of the film">
          <Cmd>cast board read $BOARD</Cmd>
          {`board "Launch week: search speed board · Dec 1" · 26 elements
f_launch  frame   "Launch: Thursday, Dec 3"  0,0 540x250  holds l_1 l_2
f_why     frame   "Why search is slow"  580,0 800x250  holds w_1 w_2 w_3
w_3       sticky  orange  1120,60 240x150  "Checked: ~40 rebuilds a minute per active writer"
…\n\n`}
          <Cmd>{`cast board apply $BOARD --status "Options" <<'EOF'`}</Cmd>
          {`[{"k":"o_a","put":{"kind":"sticky","color":"blue","x":20,"y":560,"w":260,"h":115,
  "text":"A. Debounce index writes to once per 10 s · 2 days"}}]
EOF
ok 1 elements written (r138)\n\n`}
          <Cmd>cast publish search-p95.html</Cmd>
          {`  https://codecast.sh/a/uthUevm8fufd\n\n`}
          <Cmd>cast board page $BOARD uthUevm8fufd --at 1420,0 --w 640 --h 460</Cmd>
          <Cmd>cast board connect $BOARD o_a d_1</Cmd>
          <Cmd>cast call pin https://codecast.sh/a/uthUevm8fufd</Cmd>
        </Terminal>
        <P>
          Elements have keys the agent chooses (<Code>o_a</Code> for option A), which is how it
          finds its own work later to move or reword it instead of adding a copy. Work the room
          agrees to goes in as a task filed from the call, which lists it on the call&apos;s page,
          and the agent names the task in its reply so the room hears where it went.
        </P>

        <H2>On our own calls</H2>
        <P>
          Our planning call on November 24 ran an hour and 39 minutes, three of us and a voice
          agent. By the end its board held 147 elements in 13 frames: the agent&apos;s frames for
          each topic, beside areas people had made for their own notes. Three published pages
          sat on it next to the notes they backed up, and ten tasks were filed from the call.
        </P>
        <P>
          It also got one thing wrong in a way worth telling. Partway through, the agent tidied the
          board and moved notes one of us had placed. That person said so in the call, and it went
          back to rearranging only its own frames. The instruction to leave people&apos;s notes alone was
          already in its briefing; over a long call it drifted from it, and the room corrected it
          the way you would correct a person.
        </P>

        <H2>After the call</H2>
        <P>
          When the call ends the board is an ordinary Codecast board. The call&apos;s page links to
          it beside the transcript and the summary, and it is listed in Docs with every other
          board. It keeps its version history, so an earlier state can be restored, and it can be shared
          by a public link or exported.
          Tasks filed from the call are listed on the call&apos;s page and in the task board&apos;s
          Huddles view, so the follow-up does not depend on anyone remembering the board exists.
        </P>

        <H2>Trying it</H2>
        <P>
          Start a huddle, turn on transcription, and add an agent session to the call. The board
          appears on the stage when the agent joins. If you want the board up before any agent is
          in the room, the pin button&apos;s <strong>Call board</strong> makes the same board, and
          the agent you bring in later keeps that one.
        </P>
      </article>
    </main>
  );
}
