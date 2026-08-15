"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, BlogFooter, Terminal, Cmd, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Genuine CLI output captured from the author's account on 2026-08-15, all of it
// from sessions in the codecast repository. Excerpts are trimmed; every omission
// is marked with an editorial "…". Nothing is reconstructed.

const SEARCH_OUTPUT = `Found 30 matches in 10 conversations


── CodeCast SEO backlink campaign ──────────────────────────
jx7c9d2 | yesterday | 465 msgs | ~/src/codecast
edits: packages/web/src/compat/tabRouting.ts, packages/web/package.json, packages/web/scripts/indexnow.mjs +5

  1: [assistant] ... it. Your SEO is bad for one dominant, fixable reason: **your own server serves Googlebot a blank page**. Everything else is secondary.

## The root cause

\`packages/web/server/bot-meta.ts\` is a link-unfurl middleware built so Slack and Twitter cards look nice. But \`Googlebot\`, \`bingbot\`, and \`Apple...

  2: [assistant] ...ss="seo-grid">
    <div class="seo-card"><h4>Before</h4>
      <div class="bad">Googlebot got <b>&lt;body&gt;&lt;/body&gt;</b> on every page</div>
      <div class="bad">robots.txt and sitemap.xml returned the SPA shell</div>
      <div class="bad">9 of 14 marketing pages had title "codecast"</div>
...

  3: [assistant] ...e in prod.** The prerender commit (\`eaa0e6285\`) is on origin/main and deployed: Googlebot now receives 86KB of real HTML from codecast.sh with an \`h1\` and the new title, \`sitemap.xml\` serves as genuine XML, and robots.txt is up. Google's index just hasn't recrawled yet ...

…  9 more conversations
`;

const SUMMARY_OUTPUT = `<SUMMARY session="jx7c9d2">
# CodeCast SEO backlink campaign

## Goal
why is my seo so bad - we don't even rank for codecast

## Approach
- Let me confirm what Google has actually indexed and glance at the marketing page metadata handling before I summarize.
- Your SEO is bad for one dominant, fixable reason: **your own server serves Googlebot a blank page**.
- Setting up a task and grounding in the server code first.

## Outcome
The Gamma playbook is implemented — every one of the 23 items is now either shipped, spec'd as a task, routed to your kit, or consciously skipped.

## Files Changed
- ~/.../lib/seoRoutes.ts (+5 -4)
- ~/.../src/prerender-entry.tsx (+5 -4)
- ~/.../public/robots.txt (+8 -0)
- ~/.../(marketing)/pageMeta.ts (+4 -3)
- ~/.../scripts/prerender.mjs (+4 -3)
…  4 more files
</SUMMARY>
`;

const READ_OUTPUT = `── CodeCast SEO backlink campaign ──────────────────────────
   jx7c9d2 | Yesterday | 465 msgs | ~/src/codecast

  26: [assistant]
       Found it. Your SEO is bad for one dominant, fixable reason: **your own server serves Googlebot a blank page**. Everything else is secondary.

       ## The root cause

       \`packages/web/server/bot-meta.ts\` is a link-unfurl middleware built so Slack and Twitter cards look nice. But \`Googlebot\`, \`bingbot\`, and \`Applebot\` are in its \`BOT_UA_PATTERNS\` list. When Google crawls any page, the middleware returns \`ogHtml()\` — a head full of meta tags and a literal empty \`<body></body>\`. I verified this live:

       \`\`\`
       curl -A "Googlebot..." https://codecast.sh/  →  <body></body>
       \`\`\`

       So Google's view of codecast.sh is: title "codecast", a one-line description, zero body text, zero links. …

       The unfurl middleware and SEO have opposite needs that got conflated. Slack and Discord only read \`<head>\` tags, so an empty body is fine for them. Google reads the body and follows links. One \`isBot()\` list treating both audiences the same means the feature that makes share cards pretty is the same feature that blinds Google. The fix is to split the list, not delete the middleware.

       …  secondary problems and the four-step fix trimmed  …
`;

const CONTEXT_OUTPUT = `<CONTEXT query="add a new marketing page with SEO">
Found 10 relevant sessions

## Most Relevant
[jx7a9s8] 4:04 PM - "Codecast monorepo setup"
  Preview: ... checks run in both directions (\`routes.manifest.test.ts:266\`, \`:317\`, \`:375\`). Adding a manifest...

[jx7c9d2] Yesterday - "CodeCast SEO backlink campaign"
  Preview: ...dy to go live on the next push to main. \`\`\`cast-canvas <div data-canvas-title="SEO fix — what cr...

[jx76rg1] Jul 22 - "Codecast market positioning launch"
  Preview: ...f"> ct-39374 blog work is done and verified. Files (all under packages/web/app/(marketing)/blog/,...

…  7 more sessions

Use: cast read jx7a9s8 <range>  # read session messages
     cast summary jx7a9s8        # get session summary
</CONTEXT>
`;

export default function YourAgentsForgetPost() {
  const post = getPost("your-agents-forget-your-team-does-not");
  useRouteMeta("/blog/your-agents-forget-your-team-does-not");

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
            Your agents forget. Your team doesn&apos;t have to.
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Every agent session is a problem being solved out loud, and then the terminal closes.
            Codecast keeps the record searchable — so the next agent, or the next person, starts
            from the answer.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "August 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>The most expensive thing an agent produces is thrown away</H2>
        <P>
          Watch an agent work on a hard bug and most of what it produces is not code. It is the
          investigation: the three hypotheses it ruled out, the file it read that turned out to
          be the culprit, the one-line experiment that proved it, the sentence where it finally
          says <em>found it</em>. Then the fix lands, the session ends, and all of that goes
          with it. The diff survives. The reasoning does not.
        </P>
        <P>
          On a team this compounds. Someone else hits the same wall next month — or the same
          person does, in a fresh session with no memory of the last one — and an agent starts
          the whole investigation over from zero. The answer already existed. It just lived in a
          terminal that closed.
        </P>

        <H2>One real question</H2>
        <P>
          Here is a session from this repository, one week ago. The prompt was one line:{" "}
          <em>why is my seo so bad — we don&apos;t even rank for codecast</em>. Twenty-six
          messages later the agent had the root cause. Codecast recorded the session as it
          happened, so today it is one query away. From the terminal:
        </P>

        <Terminal label="cast search" wrap>
          <Cmd>cast search &quot;Googlebot blank page&quot;</Cmd>
          {SEARCH_OUTPUT}
        </Terminal>

        <P>
          The first hit is the diagnosis itself, with the sentence that mattered right there in
          the excerpt. Search runs across every session on the team — yours and your teammates&apos;
          — and matches message content, not just titles, so a phrase the agent said in passing
          is enough to find the session that said it.
        </P>
        <P>
          The same query in the web app, with the filters that scope it: everyone or only you,
          everything or only your prompts, a time window, and sort by recency or relevance:
        </P>

        <Screenshot
          src="/blog/your-agents-forget-your-team-does-not/search.png"
          alt="The codecast web app search page showing the query 'SEO Googlebot', filter controls, and a result card for the session 'CodeCast SEO backlink campaign' with five matching messages including the root-cause diagnosis"
          caption="Search in the web app: one card per session, one row per matching message, the original prompt at the bottom."
        />

        <P>
          Read that card bottom to top and it is the whole arc: the question, the diagnosis two
          minutes later, the deploy confirmation two days after that, and the loose end (<em>has
          the fix actually deployed to prod?</em>) that came up in review. That is what a session
          record looks like when it is kept.
        </P>

        <H2>From a hit to the whole story</H2>
        <P>
          A search result is a pointer. Three commands turn it into understanding, each one a
          step deeper. <Code>cast summary</Code> gives you the shape of the session — goal,
          approach, outcome, files touched — the way you would ask a colleague &ldquo;what
          happened there?&rdquo;:
        </P>

        <Terminal label="cast summary" wrap>
          <Cmd>cast summary jx7c9d2</Cmd>
          {SUMMARY_OUTPUT}
        </Terminal>

        <P>
          <Code>cast read</Code> opens the transcript at any message. This is message 26 — the
          moment the agent found it — including the mechanism, which is the part a diff can
          never tell you:
        </P>

        <Terminal label="cast read" wrap>
          <Cmd>cast read jx7c9d2 26</Cmd>
          {READ_OUTPUT}
        </Terminal>

        <P>
          Notice what you now know that <Code>git log</Code> would never have told you: the bug
          was not in the SEO code at all. It was in a link-unfurl feature built for Slack, doing
          exactly what it was designed to do, for an audience it was never meant to serve. If
          you had inherited that repository and touched <Code>bot-meta.ts</Code> without this
          context, you would have had a fair chance of putting Google back on the wrong list.
          And <Code>cast diff jx7c9d2</Code> lists the nine files the session actually changed,
          with <Code>--patch</Code> for the full diff — for the moment you need to see the code
          after all.
        </P>

        <H2>Agents remember through it too</H2>
        <P>
          The interesting part is who else can run these commands. Every codecast agent session
          gets the same CLI. An agent about to start a task can ask what came before it —
          which is exactly what <Code>cast context</Code> is for. We ran this while drafting
          this post:
        </P>

        <Terminal label="cast context" wrap>
          <Cmd>cast context &quot;add a new marketing page with SEO&quot;</Cmd>
          {CONTEXT_OUTPUT}
        </Terminal>

        <P>
          Ten sessions, ranked, with the two commands to go deeper printed at the bottom because
          the reader is expected to be an agent. It found the SEO session, the launch session
          that built the first blog pages, and the monorepo setup session that explains the route
          manifest checks a new page has to pass — three things a new agent would otherwise
          have had to rediscover by reading code, or worse, by getting it wrong once. Memory
          stops being something you have to remember to write down. Every session is already
          the note.
        </P>

        <H2>Whose memory</H2>
        <P>
          Search is scoped the way your team is. Sessions in a shared project are searchable by
          the whole team; sessions in a private project are searchable only by their owner. The{" "}
          <em>Everyone / Only mine</em> switch in the screenshot is that boundary made visible.
          Content matches cover the last thirty days in full; older sessions match by title and
          summary, so a session from March still surfaces by what it was about. Nothing is
          searchable that you did not choose to share.
        </P>
        <P>
          A few weeks of running agents this way changes a habit. You stop asking a teammate
          &ldquo;did anyone ever look at this?&rdquo; and start asking the record — and the record
          answers with the session, the reasoning, and the exact message where someone, or
          something, found it.
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
          <a href="https://github.com/codecast-sh" target="_blank" rel="noopener noreferrer">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              View on GitHub
            </Button>
          </a>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All four terminal captures are genuine <Code>cast</Code> output from the author&apos;s
          account on 2026-08-15, and the session they point at (<Code>jx7c9d2</Code>) is a real
          session from the codecast repository, one week earlier. Excerpts are trimmed to the
          codecast repository; every omission is marked <Code>…</Code>. The screenshot is the
          web app&apos;s search page cropped to its content area, joined from two captures of
          the same results — the query header, and the result card for that session; one card
          between them, for the session that wrote this post, is left out.
        </p>
      </article>

      <BlogFooter />
    </main>
  );
}
