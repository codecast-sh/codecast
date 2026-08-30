"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, BlogFooter, Terminal, Cmd, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Genuine `cast publish` output captured on 2026-08-30 by the trigger run that
// wrote this post. The `ls` excerpt keeps only pages published from codecast
// repository sessions; one email address and one private owner link are
// redacted. Every omission is marked with an editorial "…".

const PUBLISH_OUTPUT = `* Capture manifest — blog week of Aug 30  v1 -> published
  https://codecast.sh/a/Vfr3NlQccwno
  …  owner manage link trimmed  …
`;

const VERSIONS_OUTPUT = `The Dormant State — a triage universe redesign (rthBILDTf3Xx)
  v3   14d   18.6KB ← current
  v2   14d   15.4KB
  v1   14d   12.7KB
  restore: cast publish rollback rthBILDTf3Xx <n>
  compare: https://codecast.sh/a/rthBILDTf3Xx?diff=<a>..<b>
`;

const COMMENTS_OUTPUT = `Threads verification page (n8ILKCmdYo8h) — 2 open
  zs7d63hr…  Ashot Petrosian <…> · v1 · 9d
    Owner reply from the Threads page — verifying the round trip.
  zs765xqd…  Anonymous Verifier · v1 · 9d
    Looks good — verifying the Pages kind end to end.
  resolve: cast publish comments n8ILKCmdYo8h --resolve <id>  |  --resolve-all
`;

const LS_OUTPUT = `SLUG          TITLE                             VER  KIND      VIEWS  CMTS  SESSION  AGE
n8ILKCmdYo8h  Threads verification page         v1   html      1      2     jx71a1g  9d
ne30lMY7qSod  Codecast Simplification Audit —…  v2   markdown  3      -     jx7751c  10d
rthBILDTf3Xx  The Dormant State — a triage un…  v3   html      23     -     jx7101e  14d
rMi72Tn06o9K  Published pages now embed in co…  v1   html      3      -     jx70esf  14d
e8IEUMTleMFp  Codecast Transactional Emails     v3   bundle    3      -     jx7ab4v  15d
F6uYi9blk4be  Permission prompts in the queue   v1   html      7      -     jx7236h  15d
cdhDbPMpTWQJ  Codecast · Four Directions        v1   html      3      -     jx7a9fd  16d

…  the rest of the roster, from other projects, trimmed
`;

export default function AUrlForEverythingPost() {
  const post = getPost("a-url-for-everything-your-agent-makes");
  useRouteMeta("/blog/a-url-for-everything-your-agent-makes");

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
            A URL for everything your agent makes
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Reports, dashboards, design proposals — agents produce them daily, and chat
            transcripts bury them. <Code>cast publish</Code> turns a file into a live page with
            versions, comments, and a link you can actually send.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "August 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>The deliverable that lives in a chat log</H2>
        <P>
          Ask an agent for an analysis and you get a wall of markdown in a transcript. Ask for
          a dashboard and you get a code block you are supposed to imagine rendered. The work
          is real — the agent read the data, weighed the options, laid out the page — but the
          artifact is trapped in a conversation, unstyled, unlinkable, and three scrolls up by
          tomorrow. You cannot send a transcript excerpt to a teammate and call it a
          deliverable.
        </P>
        <P>
          The fix is the oldest one on the web: give the thing a URL.
        </P>

        <H2>One command, one URL</H2>
        <P>
          <Code>cast publish report.html</Code> puts the file at a stable address. Markdown
          becomes a clean reading page; HTML ships as written; a directory with an{" "}
          <Code>index.html</Code> becomes a bundle with its assets intact. Here is this
          run&apos;s own use of it — the post you are reading published its{" "}
          <a href="https://codecast.sh/a/Vfr3NlQccwno" style={{ color: SOL.yellow }}>
            capture manifest
          </a>{" "}
          as a page, so the output below is real output about a real page:
        </P>

        <Terminal label="cast publish" wrap>
          <Cmd>cast publish capture-manifest.md --title &quot;Capture manifest — blog week of Aug 30&quot;</Cmd>
          {PUBLISH_OUTPUT}
        </Terminal>

        <P>
          Two links come back. The public one is the page. The other is an owner link — stats,
          access controls, rollback — which is why it is trimmed here: the command prints it,
          and the printout warns you to keep it private.
        </P>

        <H2>Republish, don&apos;t re-send</H2>
        <P>
          The detail that changes behavior: publishing the same file again updates the{" "}
          <em>same URL</em> and keeps every prior version viewable, diffable, and restorable.
          The link you sent yesterday shows today&apos;s revision, and nobody is ever reading
          the stale copy from an old message. Here is a real page&apos;s history — a design
          proposal an agent published from a codecast session two weeks ago and revised twice:
        </P>

        <Terminal label="cast publish versions" wrap>
          <Cmd>cast publish versions rthBILDTf3Xx</Cmd>
          {VERSIONS_OUTPUT}
        </Terminal>

        <P>
          And here is that page live, with its version menu open. Note the header: the title,
          the current version with one-click diffs against the older two, and a link back to
          the session that made it — a published page remembers where it came from:
        </P>

        <Screenshot
          src="/blog/a-url-for-everything-your-agent-makes/published-page.png"
          alt="A published codecast page titled 'The Dormant state: triage by who acts next' with the version dropdown open showing v3 current and diff links for v2 and v1, plus a link back to the originating session"
          caption="codecast.sh/a/rthBILDTf3Xx — an agent's design proposal, at version 3, version menu open."
        />

        <P>
          That page is a working document: an agent&apos;s proposal for redesigning
          codecast&apos;s own inbox triage, argued in prose and tables, revised as the idea
          sharpened. It reads like something a person shipped, because presentation was part of
          the agent&apos;s job, not a formatting accident of chat.
        </P>

        <H2>Readers talk back</H2>
        <P>
          A published page carries its own discussion. Viewers leave comments on the page;
          the publishing side reads them from the terminal, revises, republishes to the same
          URL, and resolves. This is the review loop for documents, running where the document
          lives instead of in a side channel:
        </P>

        <Terminal label="cast publish comments" wrap>
          <Cmd>cast publish comments n8ILKCmdYo8h</Cmd>
          {COMMENTS_OUTPUT}
        </Terminal>

        <P>
          Access is a flag, not a meeting: <Code>--password</Code> gates the page,{" "}
          <Code>--email-gate</Code> asks viewers who they are, <Code>--expires 7d</Code> gives
          a link a lifespan. Links are unlisted by default — viewable by whoever holds them,
          findable by nobody else.
        </P>

        <H2>A shelf, not a feed</H2>
        <P>
          After a few weeks the roster reads like a shelf of things agents shipped: design
          proposals, audits, verification pages, an email template bundle. Every row is a live
          page with its history attached, and a session id saying which conversation made it:
        </P>

        <Terminal label="cast publish ls">
          <Cmd>cast publish ls</Cmd>
          {LS_OUTPUT}
        </Terminal>

        <P>
          The pattern underneath is the same one this blog keeps arriving at: an agent&apos;s
          work should land where people can see it, steer it, and find it later. Sessions get
          an inbox, investigations get search, recurring jobs get a dashboard — and
          deliverables get URLs.
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
          All four terminal captures and the screenshot are genuine, taken on 2026-08-30 by
          the scheduled run that wrote this post. The <Code>cast publish ls</Code> excerpt
          keeps only pages published from codecast repository sessions; the comments capture
          redacts one email address; the publish output trims the private owner link. Each
          omission is marked <Code>…</Code>. The full accounting is on the{" "}
          <a href="https://codecast.sh/a/Vfr3NlQccwno" style={{ color: SOL.yellow }}>
            capture manifest
          </a>{" "}
          — itself published with the command this post is about.
        </p>
      </article>

      <BlogFooter />
    </main>
  );
}
