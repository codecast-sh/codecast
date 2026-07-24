"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { BlogNav, BlogFooter, Terminal, Cmd, SOL } from "../blogChrome";
import { usePageMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Genuine `cast blame` output captured from this repository on 2026-07-20.
// BLAME_LINES is verbatim (all 9 rows). BLAME_LOG and BLAME_PORCELAIN are
// excerpts: every omission is marked with an editorial "…". In BLAME_PORCELAIN
// the git author/committer block (name, email, timestamps) and git's trailing
// fields are trimmed; all six codecast-* keys are shown in full. Nothing here
// is reconstructed.

const BLAME_LINES = `1cc1592e3 (jx75w7g Ashot Cross-device session sync          2026-06-14 19:59:09 -0400 1) import { mutation, query, internalAction, internalMutation } from "./functions";
a15290d7d (Ashot Petrosian                                  2025-12-24 13:16:30 -0800 2) import { v } from "convex/values";
a15290d7d (Ashot Petrosian                                  2025-12-24 13:16:30 -0800 3) import { internal } from "./_generated/api";
e5657b8e6 (Ashot Petrosian                                  2025-12-24 16:08:21 -0800 4) import { getAuthUserId } from "@convex-dev/auth/server";
726e57342 (jx708f9 Ashot Topical Commits and Conflict Res.. 2026-02-07 23:32:38 -0800 5) import { verifyApiToken } from "./apiTokens";
69add29d7 (jx72v1e Ashot Deploy forced CLI release          2026-04-07 13:47:42 -0500 6) import { isConversationTeamVisible } from "./privacy";
beda6c5e2 (jx710sn Ashot Worktree consolidation             2026-07-08 20:01:09 +0300 7) import { isAgentSpawnedConversation } from "./ccAccountsShared";
c1707b627 (jx76xy4 Ashot Codecast ownership model refactor  2026-07-14 14:42:08 +0400 8) import { listSessionOwnerIds } from "./sessionOwners";
9ed63bb00 (Ashot Petrosian                                  2026-07-13 15:36:26 +0400 9) import {
`;

const BLAME_LOG = `Sessions that shaped ~/src/codecast/packages/convex/convex/notifications.ts  (382/843 lines attributed)

  jx7bn26  Ashot   773469c14  Daemon flush cadence fix                     3 lines  2026-07-20
  jx74vrz  Ashot   a28115d2b  Notification aggregation per conversat..    29 lines  2025-12-24→2026-07-20
  jx76xy4  Ashot   c1707b627  Codecast ownership model refactor           70 lines  2026-07-14
  jx70at5  Ashot   9ed63bb00  Idle session notifications                  46 lines  2025-12-25→2026-07-13
  jx73xhc  Ashot   9ed63bb00  Team session notifications gate fix          7 lines  2025-12-25→2026-07-13
  jx707cd  Ashot   9ed63bb00  Notification settings granular control       3 lines  2025-12-25→2026-07-13
  jx78db2  Ashot   9ed63bb00  Notification system audit & implementa..     3 lines  2025-12-25→2026-07-13
  jx779qm  Ashot   9ed63bb00  Fork: Agent Queue UI Implementation          3 lines  2026-02-17→2026-07-13
  …  17 more sessions
`;

const BLAME_PORCELAIN = `c1707b627059816451a7c1967ffce25b9e55d871 8 8 1
…  author + committer block (name, email, timestamps) trimmed  …
summary feat(sessions): owners as an independent set — multi-owner handoff with notification
codecast-session jx76xy4
codecast-conversation jx76xy4kp0dngmd2vzbn3sjvqd8ahvsr
codecast-title Codecast ownership model refactor
codecast-author Ashot Petrosian
codecast-url https://codecast.sh/conversation/jx76xy4kp0dngmd2vzbn3sjvqd8ahvsr
codecast-message k171az4qwtbck5fnc3rmbvpy1s8agha1
…  git trailers (previous, filename, content) trimmed  …
`;

function H2({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-2xl font-bold font-mono tracking-tight mt-12 mb-4" style={{ color: SOL.base03 }}>
      {children}
    </h2>
  );
}

function P({ children }: { children: ReactNode }) {
  return <p className="text-[17px] leading-8 mb-5" style={{ color: SOL.base01 }}>{children}</p>;
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[14px] px-1.5 py-0.5 rounded" style={{ backgroundColor: SOL.base2, color: SOL.base02 }}>
      {children}
    </code>
  );
}

export default function GitBlameForAiAgentsPost() {
  const post = getPost("git-blame-for-ai-agents");
  usePageMeta(
    "git blame for AI agents — Codecast",
    "When an agent writes the line, the author column goes blank. cast blame fills it back in with the conversation that wrote it.",
  );

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
            git blame for AI agents
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            When an agent writes the line, the author column goes blank. <Code>cast blame</Code> fills it back in — with the conversation that wrote it.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "July 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 6} min read</span>
          </div>
        </header>

        <H2>The author column is going blank</H2>
        <P>
          Open a file your team shipped last month and run <Code>git blame</Code>. Every line
          carries an author, a date, a commit message. Now ask the author why line 8 imports
          what it imports. More and more often, there is nobody to ask. An agent wrote it, in a
          terminal session that closed hours ago, and everything it knew while writing — the
          files it read, the approach it rejected, the reason it landed here — closed with the
          process.
        </P>
        <P>
          Agents already write a large share of the code that ships. In a controlled study of a
          large enterprise rollout, engineers given command-line agents merged 24% more pull
          requests per day, rising to 50% for the ones who used them five or more days a week
          (Microsoft, 2026).
          The commit still lands under a human name, because a human ran <Code>git commit</Code>.
          But <Code>git blame</Code> answers what changed and when. The why — the part you
          actually need during review — lived in the conversation, and the conversation is gone.
        </P>

        <H2>The gap this leaves</H2>
        <P>
          This would be a footnote if reviewing agent code were easy. It is not; it is the
          bottleneck. Simon Willison, who moved to running agents in parallel through 2025, puts
          it plainly: the binding constraint is review capacity, not how fast the agents produce
          code.
        </P>
        <P>
          And developers do not extend the benefit of the doubt. In Stack Overflow&apos;s 2025
          developer survey, 46% said they distrust the accuracy of AI output, and 66% named
          &ldquo;almost right&rdquo; code as their single biggest frustration. DORA&apos;s 2025
          report found roughly 30% still place little or no trust in AI-generated code.
          &ldquo;Almost right&rdquo; is the worst kind of line to inherit: it passes a glance and
          fails under load, and the one who could explain it is a stateless process that already
          exited. So you re-derive the intent by hand — slower than if you had written the line
          yourself.
        </P>

        <H2>What cast blame does</H2>
        <P>
          <Code>git blame</Code> answers who wrote this. For agent-written code the useful answer
          is not a person; it is the conversation. <Code>cast blame</Code> is <Code>git blame</Code> with
          that column swapped: the author of each line is the codecast session that produced it.
          Nothing about your workflow changes — you still run agents in a terminal, still commit
          under your own name. The daemon watches the sessions as they happen and keeps the
          mapping from line to conversation, so the attribution is there when you go looking for
          it.
        </P>

        <Terminal label="cast blame">
          <Cmd>cast blame -L 1,9 packages/convex/convex/notifications.ts</Cmd>
          {BLAME_LINES}
        </Terminal>

        <P>
          Read the author column. The leading token — <Code>jx76xy4</Code>, <Code>jx710sn</Code>,{" "}
          <Code>jx75w7g</Code> — is a codecast session, and the text beside it is that
          session&apos;s title: <em>Codecast ownership model refactor</em>, <em>Worktree
          consolidation</em>, <em>Cross-device session sync</em>. Lines marked only{" "}
          <em>Ashot Petrosian</em> predate the record or came from an ordinary hand edit;{" "}
          <Code>cast blame</Code> does not invent an author it does not have. In this file, 382 of
          843 lines trace back to a specific session.
        </P>
        <P>
          Step back from lines to sessions and you get the shape of the file&apos;s history:
        </P>

        <Terminal label="cast blame --log">
          <Cmd>cast blame --log packages/convex/convex/notifications.ts</Cmd>
          {BLAME_LOG}
        </Terminal>

        <P>
          Each row is a conversation that shaped this file, newest first, with how many of its
          lines survive and the span of dates it touched. It is the map of where the file came
          from, rebuilt from agent work that would otherwise have evaporated at the end of each
          session.
        </P>

        <H2>From a line to the conversation</H2>
        <P>
          The point is not the label. The point is that the label is a link.{" "}
          <Code>cast blame</Code> is a drop-in replacement for <Code>git blame</Code> — the default
          and porcelain formats match byte for byte, so anything that already shells out to{" "}
          <Code>git blame</Code> can call <Code>cast blame</Code> instead. Alongside git&apos;s own
          fields, porcelain adds six <Code>codecast-*</Code> keys — session, conversation, title,
          author, url, and message:
        </P>

        <Terminal label="cast blame --porcelain">
          <Cmd>cast blame packages/convex/convex/notifications.ts:8 --porcelain</Cmd>
          {BLAME_PORCELAIN}
        </Terminal>

        <P>
          Take line 8. Blame says it came from <Code>jx76xy4</Code>, <em>Codecast ownership model
          refactor</em>. Open that session and you see why <Code>listSessionOwnerIds</Code> is
          imported here at all: the refactor made ownership an independent set, so notifications
          had to resolve a list of owners instead of a single author. That reason is one click
          from the line — not guessed from a commit summary, but the actual conversation, prompt
          and dead ends included.
        </P>
        <P>
          That <Code>codecast-url</Code> is the conversation link, and{" "}
          <Code>codecast-message</Code> pins the exact turn; <Code>cast blame src/file.ts:8 --open</Code>{" "}
          just opens it for you. In
          your editor it is closer still: the VS Code and Cursor extension shows the session that
          wrote the current line at the end of the line, the way GitLens shows the commit, and
          lets you open the conversation behind it. For vim,{" "}
          <Code>cast blame --install-fugitive</Code> points fugitive at a shim so <Code>:Gblame</Code>{" "}
          renders sessions in the author column.
        </P>

        <H2>Blame is one query over the record</H2>
        <P>
          Line attribution is one view of a larger thing: every agent conversation your team has
          run, kept and searchable instead of discarded when the terminal closes.{" "}
          <Code>cast search &quot;auth&quot;</Code> greps it like ripgrep;{" "}
          <Code>cast ask &quot;how did we implement auth?&quot;</Code> answers from it. It spans
          agents and machines — Claude Code, Codex, Cursor, Gemini — not one vendor&apos;s cloud
          runs, because the daemon watches the local sessions you already run, wherever you run
          them.
        </P>
        <P>
          This is where it stops being a personal convenience. The person who ran{" "}
          <Code>git commit</Code> may have skimmed the diff and approved it; six weeks later the
          teammate who has to change that code is a different person again. With the record, the
          author to ask is attached to the line for both of them. The reasoning outlives the
          session, the reviewer, and the terminal that produced it.
        </P>
        <P>
          That is the whole idea, and it is why the author column does not have to stay blank.
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
          Sources:{" "}
          <a href="https://survey.stackoverflow.co/2025/ai/" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: SOL.yellow }}>Stack Overflow 2025 Developer Survey</a>;{" "}
          <a href="https://dora.dev/dora-report-2025/" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: SOL.yellow }}>DORA 2025 State of AI-assisted Software Development</a>;{" "}
          <a href="https://arxiv.org/abs/2607.01418" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: SOL.yellow }}>a controlled study of a large enterprise command-line agent rollout (Microsoft, 2026)</a>; Simon Willison on parallel agents. Terminal output is genuine{" "}
          <Code>cast blame</Code> from this repository, captured 2026-07-20 — the line blame is
          verbatim; the <Code>--log</Code> and <Code>--porcelain</Code> views are excerpts with
          every omission marked <Code>…</Code> (the porcelain author/committer block and git
          trailers are trimmed).
        </p>
      </article>

      <BlogFooter />
    </main>
  );
}
