"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Terminal, Cmd, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Five genuine screenshots of the codecast web app on 2026-10-18, from two of
// codecast's own sessions: jx7afyf ("Agent fleet CPU scheduling", Oct 5; the
// canvas is message 47 and the reply message 48) and jx743jq ("Character
// subject rendering", Oct 1; the canvas is message 18, the reply message 30).
// Each is cropped to the conversation column: the sidebar, top bar, session
// header and right rail are outside every crop, as is the sticky header that
// repeats the user's last message. Nothing was composited or retouched. The
// fullscreen view and the phone app are described, not pictured.

export default function ChartInTheReplyPost() {
  const post = getPost("the-chart-in-the-reply");
  useRouteMeta("/blog/the-chart-in-the-reply");

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
            The chart in the reply
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Some findings are a shape: sixteen numbers where four stand out, five versions of
            one line of UI. In Codecast an agent can put that shape in its reply as a chart, a
            table or a mockup, drawn right in the conversation, so you see it before you read
            the paragraph explaining it.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>Sixteen cores in one picture</H2>
        <P>
          On October 5th the machine we build Codecast on was overloaded again, and we asked
          an agent to investigate and talk through the root cause with us. The session&apos;s
          first pass, run by Codex, put it down to too much independently launched work with
          no machine-wide budget. A session the Thursday before had blamed a low battery.
          Claude, which took over in the same session, measured the load on each core
          separately, and its reply led with this:
        </P>

        <Screenshot
          src="/blog/the-chart-in-the-reply/per-core-canvas.png"
          alt="An agent's reply in codecast. Bold text: The root cause is a priority clamp, not too much work. Below it, a canvas titled Per-core load at 21:59, load average 124, with the caption The 4 efficiency cores are pegged while the 12 performance cores are 55-75% idle, and a bar chart of percent busy per core: four blue efficiency cores at 100 and twelve green performance cores between about 24 and 46"
          caption="The reply as it appears in the conversation. The canvas has a title, and three controls on its header: source, copy, fullscreen."
        />

        <P>
          You do not need the paragraph to get it. Four blue bars at 100 percent, twelve green
          bars well under half. The agent&apos;s reading: every agent on the machine was running
          at a throttled priority that macOS keeps on the four efficiency cores, so all the work queued there while
          the twelve performance cores sat mostly idle. The text under the chart carried the
          rest of the evidence: 680 processes at the clamped priority shared 2.6 cores, and
          the same busy loop got 0.44 seconds of CPU from an agent shell against 9.43 seconds
          as an unthrottled job, about twenty times more. The cause was one missing setting
          in the launch file of Codecast&apos;s background process.
        </P>
        <P>
          The chart has one flaw, and we left it in. The agent wrote the core numbers as text,
          so the axis sorts them as text: 0, 1, 10, 11 and on to 15, then 2, 3. That is why two
          of the blue bars sit in the middle. The small warning sign in the corner is the chart
          library noticing the same thing: the values look like numbers but arrived as strings.
        </P>

        <H2>What the reply was for</H2>
        <P>
          The agent ended that reply with three choices about rollout and asked how to handle
          the restart. The answer came back in one line:
        </P>

        <Screenshot
          src="/blog/the-chart-in-the-reply/the-answer.png"
          alt="The end of the agent's reply: I saved this to memory so the next overload investigation starts with a per-core measurement. I haven't changed any code. How do you want to handle the restart? Below, a message from Ashot Petrosian on Oct 5: yes, build and validate e2e - unclamp, measure, then build a very liberal budget to start. Then Claude replies with a four step plan starting with adding ProcessType: Interactive to the daemon plist"
          caption="The next message: approve the fix, measure, then build a budget. The agent's plan follows."
        />

        <P>
          The fix shipped: the background process now launches at interactive priority, and
          existing installs rewrite their launch file automatically. Once it was live, the
          agent measured again and reported all sixteen cores busy instead of four. It also
          found that the fix removed only one of two causes, and the second became more work
          in the same session. The chart did its job either way. It turned a disputed diagnosis into something you
          could check at a glance, and the decision came right after it.
        </P>

        <H2>Five versions of one line</H2>
        <P>
          A canvas is just as useful when the question is how something should look. On
          October 1st we told an agent that the way Codecast prints a session&apos;s character
          name and title, as in <em>Whisker : Team huddle observation</em>, was subtly off.
          The usual move would be to change the component and check it in a browser, but the
          machine was at a load average of 275 and the agent&apos;s browser connection kept
          stalling. So it wrote: &quot;Instead I&apos;ll lay the variants out side by side in a
          canvas.&quot;
        </P>

        <Screenshot
          src="/blog/the-chart-in-the-reply/separator-variants.png"
          alt="A canvas titled Name : title separator variants with five rows, A to E, each showing Whisker and Team huddle observation with a different separator, and a note under each: A, the current spaced colon that reads like key : value; B, the colon hugging the name; C, no separator with a regular weight title; D, a middle dot, noting the app already uses it for metadata runs; E, B plus a regular weight title"
          caption="A mockup drawn in the reply, with the agent's note under each option."
        />

        <P>
          The rows are drawn with the app&apos;s own font and colors, so they look the way the
          real line would. The agent applied B, the smallest fix, and recommended E if that
          still felt flat. It also pointed out a cost of D: the app already uses a middle dot
          between pieces of metadata. We picked D anyway:
        </P>

        <Screenshot
          src="/blog/the-chart-in-the-reply/middle-dot.png"
          alt="The agent's message: The canvas above has other directions in case the hug alone isn't enough, recommending E and describing C, then Tell me which way to push it. Below, a message from Ashot Petrosian on Oct 1: middle dot. Then Claude: The separator is now a middle dot (Whisker · Team huddle observation), with the change in components/identity/SessionIdentityLine.tsx and three test assertions updated; all 11 identity tests pass"
          caption="Two words of feedback, because the options were already on screen with names."
        />

        <P>
          Two words were enough because every option had a letter and a picture. The agent
          made the swap, updated the three test assertions that checked the old colon, and
          the middle dot is what the app shows today.
        </P>

        <H2>How a canvas behaves</H2>
        <P>
          A canvas sits in the conversation like any other part of the reply, with its title
          on a header strip and three controls. <em>Show source</em> flips it to the HTML the
          agent wrote, <em>Copy HTML</em> copies that, and <em>Fullscreen</em> opens it on its
          own over the app; <Code>Esc</Code> closes it. A tall canvas folds behind a fade
          with a control to show the rest.
        </P>

        <Screenshot
          src="/blog/the-chart-in-the-reply/canvas-source.png"
          alt="The same per-core canvas with Show source toggled: a div with data-canvas-title, a paragraph styled with var(--sol-text-muted), and a div with class cast-chart and a data-spec attribute holding JSON marks of type barY with data entries such as c 0, v 100, k efficiency"
          caption="The source view of the per-core chart. The chart is a short description of the data; Codecast draws it."
        />

        <P>
          The source shows how little the agent writes for a chart: a title, a caption, and a
          description of the bars as data. Codecast draws the chart itself, so it uses the
          app&apos;s font, follows light and dark mode, and can show each value on hover. The same goes for
          tabs, sortable tables and tooltips. You can also see the cause of the odd axis order
          here: <Code>&quot;c&quot;:&quot;0&quot;</Code> is a string.
        </P>
        <P>
          Canvases are safe to show to anyone who can read the session. No script the agent
          writes ever runs: Codecast strips scripts and event handlers before drawing. A
          canvas also cannot load anything from outside. An image has to be embedded in the
          canvas or stored in Codecast, so viewing one never tells a third party you looked. The desktop app
          draws canvases the same way as the web app, and the phone app draws them too; an
          older phone build that predates the feature shows the source as a code block
          instead.
        </P>
        <P>
          Agents do not need prompting to use this. The instructions Codecast installs for
          your agents tell them to reach for a canvas when structure or size carries the
          meaning (comparisons, flows, timelines, metrics) and to keep ordinary prose in
          markdown. The same applies to the questions agents put in your decision queue,
          where a canvas can lay the options side by side.
        </P>

        <H2>From a script</H2>
        <P>
          A canvas is a fenced block in the agent&apos;s markdown, so any agent that writes
          markdown can draw one, and so can you:
        </P>

        <Terminal label="a canvas in a reply">
          <Cmd>```cast-canvas</Cmd>
          <Cmd>&lt;div data-canvas-title=&quot;Shown in the header&quot;&gt; … &lt;/div&gt;</Cmd>
          <Cmd>```</Cmd>
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
          <Link href="/blog/the-questions-your-agents-save-for-you">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              The questions your agents save for you
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All five screenshots are the codecast web app on 2026-10-18, of two of codecast&apos;s
          own sessions from October 1 and October 5. Each is cropped to the conversation
          column: the sidebar, the top bar, the session header and the right rail are outside
          every crop, as is the strip that keeps the last user message pinned at the top while
          you scroll. The fourth screenshot starts at the canvas, below the agent&apos;s one-line
          lead-in quoted above it. Nothing was composited or retouched, and the chart&apos;s
          axis order and warning sign are as the agent drew them. The fullscreen view and the
          phone app are described, not pictured. No message was sent and no session was
          changed for this post.
        </p>
      </article>
    </main>
  );
}
