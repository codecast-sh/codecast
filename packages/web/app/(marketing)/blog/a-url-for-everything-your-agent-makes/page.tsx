"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// The published page screenshot was taken on 2026-08-30 by the trigger run
// that wrote this post; the Pages screenshot on 2026-10-09, cropped to one
// card from a codecast session.

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
            transcripts bury them. Codecast turns a file into a live page with versions,
            comments, and a link you can actually send.
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

        <H2>One file, one URL</H2>
        <P>
          In codecast, an agent that makes a deliverable publishes it and puts the link in its
          reply. In the conversation the link opens into the live page itself, with buttons to
          copy the link, expand it, or open it beside your work or in a new tab. Markdown
          becomes a clean reading page; HTML ships as written; a folder with an{" "}
          <Code>index.html</Code> becomes a bundle with its assets intact. The post you are
          reading did it too: the run that wrote it published its{" "}
          <a href="https://codecast.sh/a/Vfr3NlQccwno" style={{ color: SOL.yellow }}>
            capture manifest
          </a>{" "}
          as a page, and linked it from the footer.
        </P>
        <P>
          The page is unlisted: anyone holding the link can read it, and nobody else can find
          it. The agent does this with one command, <Code>cast publish report.html</Code>,
          which you can also run yourself on any file.
        </P>

        <H2>Republish, don&apos;t re-send</H2>
        <P>
          The detail that changes behavior: publishing the same file again updates the{" "}
          <em>same URL</em> and keeps every prior version viewable, diffable, and restorable.
          The link you sent yesterday shows today&apos;s revision, and nobody is ever reading
          the stale copy from an old message. Here is a real page, a design proposal an agent
          published from a codecast session two weeks ago and revised twice, with its version
          menu open. Note the header: the title, the current version with a diff against each
          older one (and, for the owner, a restore link), and a link back to the session that
          made it. A published page remembers where it came from:
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
          A published page carries its own discussion. Readers pin a note on the page or
          select a passage and comment on it; the owner, or the agent that published it, reads
          the comments, revises, republishes to the same URL, and resolves them. When a newer
          version lands while someone is reading, the page tells them and offers to reload.
          This is the review loop for documents, running where the document lives instead of
          in a side channel.
        </P>
        <P>
          Access is a setting, not a meeting. The page&apos;s menu has{" "}
          <em>Manage sharing…</em>, where the owner sets a <em>Password</em>, an{" "}
          <em>Email gate</em> that asks viewers who they are, or an <em>Expires</em> date
          that gives a link a lifespan, and turns comments or the session link on or off.
        </P>

        <H2>A shelf, not a feed</H2>
        <P>
          After a few weeks the <em>Pages</em> screen reads like a shelf of things agents
          shipped: design proposals, audits, verification pages, an email template bundle. Ours
          holds 515. Every card is a live page with its history attached: the title, the
          version, the kind, how many people opened it, who published it, and the session that
          made it, one click away. A card&apos;s menu opens, copies, forwards or manages the
          page, and a badge says when a page is behind a password or an email gate, or has
          expired:
        </P>

        <Screenshot
          src="/blog/a-url-for-everything-your-agent-makes/pages-gallery.png"
          alt="The Pages screen in the codecast web app, 515 pages, showing one card: a thumbnail of a page titled Chat that waits its turn, the title Ten ways chat could reach you without a…, version 5, bundle, 3h ago, 9 views, the author, and a link to the session Chat toast UX prototypes"
          caption="One card from the Pages screen: an agent's design prototypes at version 5, linked to the session that made them."
        />

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
          The published page screenshot is genuine, taken on 2026-08-30 by the scheduled
          run that wrote this post; the capture manifest below accounts for it. The Pages
          screenshot was taken on 2026-10-09 and cropped to a single card from a codecast
          session. The{" "}
          <a href="https://codecast.sh/a/Vfr3NlQccwno" style={{ color: SOL.yellow }}>
            capture manifest
          </a>{" "}
          is itself a published page.
        </p>
      </article>
    </main>
  );
}
