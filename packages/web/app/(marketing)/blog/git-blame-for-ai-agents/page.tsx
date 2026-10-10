"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";
import { KeyCap } from "@/components/KeyCap";

// The screenshot is the codecast web app's file page with Blame set to
// Sessions, captured from this repository on 2026-10-09.

export default function GitBlameForAiAgentsPost() {
  const post = getPost("git-blame-for-ai-agents");
  useRouteMeta("/blog/git-blame-for-ai-agents");

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
            When an agent writes the line, the author column goes blank. Codecast&apos;s blame fills it back in, with the conversation that wrote it.
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

        <H2>Blame by session</H2>
        <P>
          <Code>git blame</Code> answers who wrote this. For agent-written code the useful answer
          is not a person; it is the conversation. So codecast&apos;s blame swaps that column:
          the author of each line is the codecast session that produced it. Nothing about your
          workflow changes. You still run agents in a terminal and still commit under your own
          name. The daemon watches the sessions as they happen and keeps the mapping from line
          to conversation, so the attribution is there when you go looking for it.
        </P>
        <P>
          You find it where you read code. Open a repository in codecast, open any file from
          the <em>Code</em> tab (or from a pull request&apos;s <em>Files</em> tab, or a
          commit), and the file&apos;s toolbar has a <em>Blame</em> switch with three
          positions: <em>Off</em>, <em>Git</em> and <em>Sessions</em>. The <KeyCap size="xs">b</KeyCap>{" "}
          key cycles them. Here is a file from this repository, set to <em>Sessions</em>:
        </P>

        <Screenshot
          wide
          src="/blog/git-blame-for-ai-agents/blame-sessions.png"
          alt="The codecast file page for packages/convex/convex/notifications.ts with Blame set to Sessions: a strip reading 70% by 41 sessions with a chip per session and its line count, and a gutter naming the session behind each block of lines, such as Cross-device session sync, Production deployment and Codecast ownership model refactor, with plain author names where no session wrote the line"
          caption="notifications.ts with Blame on Sessions. The gutter names the conversation behind each block of lines."
        />

        <P>
          Read the gutter. Each block of lines carries a session&apos;s title and age:{" "}
          <em>Cross-device session sync</em>, <em>Production deployment</em>,{" "}
          <em>Codecast ownership model refactor</em>. Rows that show only{" "}
          <em>Ashot Petrosian</em> predate the record or came from an ordinary hand edit;
          blame does not invent an author it does not have. The strip above the code steps
          back from lines to sessions: <em>70% by 41 sessions</em>, then one chip per
          conversation with how many of its lines survive. Hover a chip and its lines light
          up; click it and the view jumps to the first of them and keeps them lit. That strip
          is the map of where the file came from, rebuilt from agent work that would
          otherwise have evaporated at the end of each session.
        </P>

        <H2>From a line to the conversation</H2>
        <P>
          The point is not the label. The point is that the label is a link. Take line 18,
          which imports <Code>listSessionOwnerIds</Code>. Blame says it came from{" "}
          <em>Codecast ownership model refactor</em>. Open that session and you see why the
          import is here at all: the refactor made ownership an independent set, so
          notifications had to resolve a list of owners instead of a single author. That
          reason is one click from the line. Not guessed from a commit summary, but the actual
          conversation, prompt and dead ends included.
        </P>
        <P>
          The same attribution reaches the places code is read outside the app. In VS Code and
          Cursor, the codecast extension shows the session that wrote the current line at the
          end of the line, the way GitLens shows the commit, and opens the conversation behind
          it. In a terminal, <Code>cast blame</Code> is a drop-in for <Code>git blame</Code>{" "}
          with the session in the author column; its porcelain output matches git&apos;s and
          adds <Code>codecast-*</Code> keys (session, title, url, and the exact message), so
          anything that already shells out to <Code>git blame</Code> can call it instead.
        </P>

        <H2>Blame is one query over the record</H2>
        <P>
          Line attribution is one view of a larger thing: every agent conversation your team has
          run, kept and searchable instead of discarded when the terminal closes. The{" "}
          <em>Search</em> page finds a phrase in any of them, and the repository&apos;s own{" "}
          <em>Search</em> and <em>Sessions</em> tabs scope it to one codebase. It spans
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
          <a href="https://arxiv.org/abs/2607.01418" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: SOL.yellow }}>a controlled study of a large enterprise command-line agent rollout (Microsoft, 2026)</a>; Simon Willison on parallel agents. The screenshot is the codecast web app&apos;s
          file page for <Code>packages/convex/convex/notifications.ts</Code> in this repository,
          captured 2026-10-09 with Blame set to Sessions and cropped to the content column.
        </p>
      </article>
    </main>
  );
}
