"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Terminal, Cmd, SOL, H2, P, Code } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Genuine `cast ws` output from the codecast checkout on 2026-10-04. The
// workspace list is trimmed to its first rows; the acquire and destroy of a
// demo workspace were run for this post and left nothing behind. Every
// omission is marked with an editorial "…".

const WS_LS = `NAME                      STATE       BRANCH                            PATH
deprecate-reconcilers     ready       codecast/deprecate-reconcilers    /Users/ashot/src/codecast/.codecast/worktrees/deprecate-reconcilers
browser-watch-pane        ready       codecast/browser-watch-pane       /Users/ashot/src/codecast/.codecast/worktrees/browser-watch-pane
deploy-repo-objects       destroying  codecast/deploy-repo-objects      /Users/ashot/src/codecast/.codecast/worktrees/deploy-repo-objects
linear-token-deploy       ready       codecast/linear-token-deploy      /Users/ashot/src/codecast/.codecast/worktrees/linear-token-deploy
safe-query                ready       codecast/safe-query               /Users/ashot/src/codecast/.codecast/worktrees/safe-query
browser-resident-driver   ready       codecast/browser-resident-driver  /Users/ashot/src/codecast/.codecast/worktrees/browser-resident-driver
ct-49675                  ready       codecast/ct-49675                 /Users/ashot/src/codecast/.codecast/worktrees/ct-49675
grok-fork                 broken      codecast/grok-fork                /Users/ashot/src/codecast/.codecast/worktrees/grok-fork
…  11 more rows, all ready  …
`;

const WS_STATUS = `safe-query
  state:   ready
  path:    /Users/ashot/src/codecast/.codecast/worktrees/safe-query
  branch:  codecast/safe-query
  ports:   web=3201
  updated: 2026-08-11T22:34:58.491Z
  contract: ok
    ✓ worktree-exists
    ✓ git-branch
    ✓ deps-installed
    ✓ env-vars
    ✓ port:web
    ✓ port-free:web
`;

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

const WS_ACQUIRE = `created: blog-demo
  path:    /Users/ashot/src/codecast/.codecast/worktrees/blog-demo
  branch:  codecast/blog-demo
  state:   ready
  ports:   web=3401
  port pool of 10 indices exhausted; extended the range to indices 10-19 and took index 10 (web=3401)
`;

const WS_DESTROY = `destroyed: blog-demo
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
            port of its own, in one command.
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
          first ten minutes on plumbing. So codecast made the plumbing one command.
        </P>

        <H2>Twenty of them</H2>
        <P>
          Here is the codecast repository&apos;s own list this morning. Every row is a
          checkout an agent asked for by name, most of them for a feature branch, two for a
          task by its id:
        </P>

        <Terminal label="cast ws ls">
          <Cmd>cast ws ls</Cmd>
          {WS_LS}
        </Terminal>

        <P>
          Nineteen tracked: seventeen ready, one being torn down, one broken. The broken one
          is the interesting row. A workspace carries a contract, and codecast checks it rather
          than assuming it. Ask about one and you get the state and every clause of the
          contract, verified:
        </P>

        <Terminal label="cast ws status">
          <Cmd>cast ws status safe-query</Cmd>
          {WS_STATUS}
        </Terminal>

        <P>
          The worktree exists, the branch is right, dependencies are installed, the secret
          files are present, the port is assigned and nothing else is listening on it. When a
          clause fails, the row reads <em>broken</em> in the list, and <Code>cast ws heal</Code>{" "}
          reruns the setup to make it true again.
        </P>

        <H2>What a workspace promises</H2>
        <P>
          The contract comes from one file in the repository, which <Code>cast ws init</Code>{" "}
          generates by looking at the project and which the team then edits and commits. Ours
          is short:
        </P>

        <Terminal label=".codecast/workspace.toml">
          <Cmd>cat .codecast/workspace.toml</Cmd>
          {WS_TOML}
        </Terminal>

        <P>
          Three things: which ignored files to copy from the main checkout, what to run after
          the copy, and which ports to hand out. Each workspace gets an index, and its web
          port is the base plus twenty times that index, probed free before it is handed
          out. The workspace above is index zero, so its status says <Code>web=3201</Code>.
          Two agents can each run a dev server without reading each other&apos;s pages.
        </P>

        <H2>Acquire, work, destroy</H2>
        <P>
          For this post we asked for a workspace that did not exist, watched it come up, and
          took it down again. This is the whole lifecycle, as it ran:
        </P>

        <Terminal label="cast ws acquire" wrap>
          <Cmd>cast ws acquire blog-demo</Cmd>
          {WS_ACQUIRE}
        </Terminal>

        <P>
          A worktree on a new branch, the secret files copied and the install run behind
          that one word <em>ready</em>, and a port. The last line is the honest part: the
          pool of ten port indices was already spent on the workspaces above, so the
          allocator extended it and this one became index ten, port 3401. The command prints
          the path because a program cannot change your shell&apos;s directory; the next line
          is always <Code>cd &quot;$(cast ws path blog-demo)&quot;</Code>. An agent that
          already has a workspace by that name attaches to it instead of making a second one,
          so a session that restarts lands back where it was.
        </P>

        <Terminal label="cast ws destroy" wrap>
          <Cmd>cast ws destroy blog-demo</Cmd>
          {WS_DESTROY}
        </Terminal>

        <P>
          Teardown runs any teardown hooks, removes the worktree, and drops the state, so the
          port goes back to the pool and the name is free. The list above is as long as it is
          because agents are better at acquiring than destroying; the one marked{" "}
          <em>destroying</em> is a teardown in progress.
        </P>

        <H2>Where this fits</H2>
        <P>
          A workspace is a checkout, not a sandbox. The agent in it still runs on your
          machine, with your logins and your tools, and its session lands in your inbox like
          any other, with the checkout named in the session header so you can tell at a
          glance which branch a conversation is editing. Two agents in two workspaces cannot
          overwrite each other&apos;s files, and they still share everything else codecast
          gives a team: the inbox, search across both sessions, and messages between them
          when the work does need a word.
        </P>
        <P>
          The rule we have settled on is simple. Work that can live on a branch gets a
          workspace. Work that must land in the main checkout, because the human is in it
          too, stays shared and the agents talk. Both are one command away, and the list
          tells you which is which.
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
          All five terminal captures are genuine <Code>cast ws</Code> output from the codecast
          checkout on 2026-10-04. The list keeps eight of nineteen rows and marks the rest;
          the status, the config file, the acquire and the destroy are shown in full. The
          demo workspace was created and removed for this post and nothing else on the
          machine changed; on a machine carrying 183 registered worktrees and a full load of
          agents, the acquire took about twenty minutes and the destroy about ten, nearly all
          of it waiting on git. There is no screenshot: the feature lives in the terminal, and
          the sessions that use these workspaces belong to other work.
        </p>
      </article>
    </main>
  );
}
