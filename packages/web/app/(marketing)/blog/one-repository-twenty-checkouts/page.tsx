"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Terminal, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// The workspace config is the codecast repository's own file. The Worktrees
// screenshot is the repository's Worktrees tab in the codecast web app on
// 2026-10-09; the counts in the prose are from `cast ws` on 2026-10-04.

const WS_TOML = `[setup]
copy = [
  ".env",
  ".env.local",
  "packages/convex/.env.local",
  "packages/web/.env.local",
  "packages/cli/.env.local",
]
install = ["bun install"]

[ports.web]
base = 3201
range = 20
`;

export default function OneRepositoryTwentyCheckoutsPost() {
  const post = getPost("one-repository-twenty-checkouts");
  useRouteMeta("/blog/one-repository-twenty-checkouts");

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
            One repository, twenty checkouts
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Running several agents at once is easy until two of them edit the same file.
            Codecast gives each one its own worktree, with the env files, dependencies and a
            port of its own, from one switch when you start the session.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 5} min read</span>
          </div>
        </header>

        <H2>The shared checkout problem</H2>
        <P>
          Three weeks ago on this blog, a Codex agent and a Claude Code agent coordinated a
          repair by messaging each other, because both were editing one working tree and one
          of them had to stay out of the other&apos;s files. That was the right thing to do in
          a shared checkout, and it is also a cost: two agents spending turns negotiating who
          may touch which file. The cheaper answer, when the work allows it, is to not share
          the checkout at all.
        </P>
        <P>
          Git has had worktrees for years: extra checkouts of the same repository, each on its
          own branch, sharing one object store. What stops people using them for agents is
          everything around the checkout. The ignored files that hold secrets are not copied.
          Dependencies are not installed. The dev server wants port 3200, which the main
          checkout already holds. By the time an agent has fixed all that, it has spent its
          first ten minutes on plumbing. So codecast made the plumbing part of starting a
          session.
        </P>

        <H2>One switch</H2>
        <P>
          When you start a session from codecast, the new session screen has a switch
          labelled <em>isolated worktree</em>. Leave it off and the agent works in the
          checkout you picked, alongside everyone else. Turn it on and the agent gets a
          checkout of its own: a worktree on a new branch, the secret files copied in, the
          install run, and a port nobody else holds. The session&apos;s card in the inbox
          carries the worktree&apos;s name (hover it for <em>Worktree &lt;name&gt;
          (&lt;branch&gt;)</em>), and the session header shows the same pill, so you can tell
          at a glance which branch a conversation is editing.
        </P>

        <H2>Every checkout in one list</H2>
        <P>
          Each repository in codecast has a <em>Worktrees</em> tab: every checkout of it on
          every machine, grouped into the main checkout, codecast&apos;s worktrees, worktrees
          other agents made, and the rest. Each row says what branch it is on, how far it is
          from main, which port it was given, and which sessions are working in it:
        </P>

        <Screenshot
          wide
          src="/blog/one-repository-twenty-checkouts/worktrees-tab.png"
          alt="The Worktrees tab of the codecast repository in the codecast web app: the main checkout on main with uncommitted changes and the sessions working in it, a codecast worktree named line-ct-57659 on its own branch, four commits ahead and three behind main, with a Compare link, its web port 3201 and six sessions, and two release worktrees tagged locked and no cast ws record"
          caption="The codecast repository's Worktrees tab. Each row names its branch, its port and the sessions working in it."
        />

        <P>
          On the morning this post was drafted that list held nineteen codecast worktrees:
          seventeen ready, one being torn down, one broken. By the time we took the screenshot
          most had been finished and removed, which is what they are for. The broken one was
          the interesting row. A workspace carries a contract, and codecast checks it rather
          than assuming it: the worktree exists, the branch is right, dependencies are
          installed, the secret files are present, the port is assigned and nothing else is
          listening on it. When a clause fails, the row says <em>setup is broken</em>, and
          rerunning the setup makes it true again.
        </P>

        <H2>What a workspace promises</H2>
        <P>
          The contract comes from one file in the repository, which codecast generates by
          looking at the project and which the team then edits and commits. Ours is short:
        </P>

        <Terminal label=".codecast/workspace.toml">{WS_TOML}</Terminal>

        <P>
          Three things: which ignored files to copy from the main checkout, what to run after
          the copy, and which ports to hand out. Each workspace gets an index, and its web
          port is the base plus twenty times that index, probed free before it is handed
          out. The worktree in the screenshot is index zero, so its row says{" "}
          <em>web :3201</em>.
          Two agents can each run a dev server without reading each other&apos;s pages.
        </P>

        <H2>Made, used, removed</H2>
        <P>
          For this post we asked for a worktree that did not exist, watched it come up, and
          took it down again. It came up on a new branch with the secret files copied and the
          install run, and with a port. That last part was the honest surprise: the pool of
          ten port indices was already spent on the worktrees in the list, so codecast
          extended it and gave this one index ten, port 3401. A session that restarts lands
          back in the worktree it had, rather than getting a second one. Teardown runs any
          teardown hooks, removes the worktree, and drops its state, so the port goes back to
          the pool and the name is free.
        </P>
        <P>
          Agents can do all of this themselves from a terminal, which is how most of those
          nineteen were made: <Code>cast ws acquire &lt;name&gt;</Code> to get one,{" "}
          <Code>cast ws destroy &lt;name&gt;</Code> to give it back, <Code>cast ws ls</Code>{" "}
          for the same list the tab shows. Agents turn out to be better at acquiring than
          destroying, which is why the list ran long.
        </P>

        <H2>Where this fits</H2>
        <P>
          A workspace is a checkout, not a sandbox. The agent in it still runs on your
          machine, with your logins and your tools, and its session lands in your inbox like
          any other, with its worktree named on the card and in the header. Two agents in two workspaces cannot
          overwrite each other&apos;s files, and they still share everything else codecast
          gives a team: the inbox, search across both sessions, and messages between them
          when the work does need a word.
        </P>
        <P>
          The rule we have settled on is simple. Work that can live on a branch gets a
          workspace. Work that must land in the main checkout, because the human is in it
          too, stays shared and the agents talk. Both are one switch away, and the Worktrees
          tab tells you which is which.
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
          <Link href="/blog/agents-that-talk-to-each-other">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              When agents share a checkout
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          The counts of nineteen worktrees, the broken row and the port allocation are from{" "}
          <Code>cast ws</Code> on the codecast checkout on 2026-10-04; the demo worktree was
          created and removed for this post and nothing else on the machine changed. On a
          machine carrying 183 registered worktrees and a full load of agents, creating it
          took about twenty minutes and removing it about ten, nearly all of it waiting on git.
          The config file is the repository&apos;s own. The screenshot is the repository&apos;s
          Worktrees tab in the codecast web app on 2026-10-09, cropped to the content column.
        </p>
      </article>
    </main>
  );
}
