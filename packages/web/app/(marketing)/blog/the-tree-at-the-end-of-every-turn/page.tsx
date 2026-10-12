"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Terminal, Cmd, SOL, H2, P, Code } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Genuine output from the codecast checkout on 2026-10-07: `cast diff --turns`
// and `--turn` on a real session in this repository, and `git log` on the
// snapshot chain the daemon keeps. The turn list is trimmed; every omission is
// marked with an editorial "…". No command here changed anything.

const TURNS = `64 turn snapshots  (the working tree at each turn's end; shell and hand edits included)

  1  15e2558bca  19 hours ago   700 files  .codecast/check.toml, bun.lock, docs/SELF-HOSTING.md, +697
  #1 I want to build a systematized, deterministic, iterable graph like proc…
  2  ed5a07e711  19 hours ago   1 file     packages/convex/convex/_generated/api.d.ts
  turn with no ask on record
  checkout shared with 4 other sessions; the changes may be theirs
  3  231a21b8eb  18 hours ago   5 files    packages/playground/convex/_generated/api.d.ts, packages/web/components/SubagentFleetChip.tsx, packages/web/components/__tests__/publishedPageEmbed.test.tsx, +2
  sweep, no new turn
…  58 more rows  …
 62  69aabfe9d3  12 hours ago   3 files    packages/web/components/line/map/LineMap.tsx, packages/web/components/line/map/LineMapView.tsx, packages/web/components/line/map/lineMap.css
  sweep, no new turn
  checkout shared with 36 other sessions; the changes may be theirs
 63  1c29ec70ee  12 hours ago   6 files    packages/web/components/line/map/LineMap.tsx, packages/web/components/line/trace/LineTracePage.tsx, packages/web/components/line/trace/TraceStory.tsx, +3
  sweep, no new turn
  checkout shared with 37 other sessions; the changes may be theirs
 64  af34c25782  11 hours ago   11 files   packages/convex/convex/agentTasks.cadence.test.ts, packages/convex/convex/assistant/tools/workspace.test.ts, packages/convex/convex/assistant/turns.test.ts, +8
  sweep, no new turn
  checkout shared with 42 other sessions; the changes may be theirs

cast diff <session> --turn N   shows what turn N changed; --turn last for the newest
`;

const TURN_STAT = `turn 62  69aabfe9d3
47505f457b → 69aabfe9d3, 3 files, taken 12 hours ago; checkout shared with 36 other sessions

 packages/web/components/line/map/LineMap.tsx     |  67 ++++++++-
 packages/web/components/line/map/LineMapView.tsx | 165 +++++++++++++++++++----
 packages/web/components/line/map/lineMap.css     |  28 +++-
 3 files changed, 225 insertions(+), 35 deletions(-)
`;

const TURN_PATCH = `diff --git a/packages/web/components/line/map/LineMap.tsx b/packages/web/components/line/map/LineMap.tsx
@@ -103,7 +103,8 @@
       const cut = new Set<string>();
-      for (const b of layout.boxes.values()) if (Math.min(b.x + b.w, x1) - Math.max(b.x, x0) < b.w / 2) cut.add(b.id);
+      // Less than half in view either way: a loop's label over the stage, tied to a node out of sight below, hides with it.
+      for (const b of layout.boxes.values()) if (Math.min(b.x + b.w, x1) - Math.max(b.x, x0) < b.w / 2 || Math.min(b.y + b.h, y1) - Math.max(b.y, y0) < b.h / 2) cut.add(b.id);
…  the rest of the patch  …
`;

const GIT_CHAIN = `af34c2578  12 hours ago  parents: 033e34473 d85f2d78e
d85f2d78e  12 hours ago  parents: 033e34473 1c29ec70e
1c29ec70e  12 hours ago  parents: 033e34473 69aabfe9d
69aabfe9d  12 hours ago  parents: 033e34473 47505f457
`;

const GIT_TRAILERS = `codecast wip snapshot

codecast-branch: main
codecast-depth: 179
codecast-taken-at: 2026-10-07T03:59:50.786Z
`;

export default function TreeAtTheEndOfEveryTurnPost() {
  const post = getPost("the-tree-at-the-end-of-every-turn");
  useRouteMeta("/blog/the-tree-at-the-end-of-every-turn");

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
            The tree at the end of every turn
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            A transcript shows the edits an agent made with its editing tools. It never sees
            what a shell command, a formatter or a person changed. Codecast now records the
            whole working tree at the end of every turn, as git commits you can diff and
            rewind to.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 6} min read</span>
          </div>
        </header>

        <H2>The edits the transcript cannot see</H2>
        <P>
          Ask an agent what it changed and it will tell you what it changed with its editing
          tools, because that is what its transcript holds. The transcript does not hold the
          sed command it ran, the formatter the test suite invoked, the fixture a test
          rewrote, or the line you fixed yourself in your editor while it worked. Those edits
          reach the diff only when somebody commits, and by then the question of which turn
          introduced the thing that broke is unanswerable from the record.
        </P>
        <P>
          The working tree is the only ground truth. So codecast now records the tree
          itself, at the end of every turn, as a git commit of the checkout. The idea is taken
          whole from Zed&apos;s Delta, which records every edit from every source; codecast
          gets the same history from git, for a fraction of the cost, and the objects never
          leave your own repository.
        </P>

        <H2>Sixty-four snapshots of one session</H2>
        <P>
          Here is a session from this repository, yesterday, that set out to produce a design
          document and touched a lot of files on the way. Its turn history, trimmed to the first three
          rows and the last three:
        </P>

        <Terminal label="cast diff --turns" wrap>
          <Cmd>cast diff jx7e4fy --turns</Cmd>
          {TURNS}
        </Terminal>

        <P>
          Each row is one snapshot: a short hash, when it was taken, how many files changed
          since the previous one, and the first few of them. Under a row sits the ask that
          opened the turn, when there was one; <em>turn with no ask on record</em> marks a
          turn whose opening ask is not on record, and <em>sweep, no new turn</em> marks a snapshot
          the daemon took on its five minute pass while nothing was finishing. The line that
          matters most is the third one: <em>checkout shared with 36 other sessions; the
          changes may be theirs</em>. A snapshot describes a checkout, not a session, and
          this machine runs dozens of agents in one working tree. The listing says so rather
          than pretending each row belongs to the session you asked about.
        </P>

        <H2>Any turn, as a diff</H2>
        <P>
          A row is a question you can ask. What did turn 62 change? The answer is a diff
          between that snapshot and the one before it, as a file list or as a patch:
        </P>

        <Terminal label="cast diff --turn --stat">
          <Cmd>cast diff jx7e4fy --turn 62 --stat</Cmd>
          {TURN_STAT}
        </Terminal>

        <Terminal label="cast diff --turn" wrap>
          <Cmd>cast diff jx7e4fy --turn 62</Cmd>
          {TURN_PATCH}
        </Terminal>

        <P>
          That is an ordinary unified diff, so everything you already do with diffs applies.
          And because every turn has one, finding the turn that broke something is a walk,
          not an archaeology: <Code>--turn last</Code> for the newest, then back one at a
          time until the breakage disappears.
        </P>

        <H2>It is git underneath</H2>
        <P>
          A snapshot is a dangling git commit of the working tree, made against a private
          index the daemon keeps beside the repository&apos;s own, so your real index, HEAD
          and branch are never touched and a file git ignores never enters one. The commits
          chain. Here are the newest four on this checkout, with their parents:
        </P>

        <Terminal label="git log">
          <Cmd>git log --format=&apos;%h  %ar  parents: %p&apos; -4 $(cut -d&apos; &apos; -f1 .git/codecast/wip.head)</Cmd>
          {GIT_CHAIN}
        </Terminal>

        <P>
          Read the parents column. The first parent of every snapshot is the same commit,
          the HEAD the tree is based on, so any tool that expects a snapshot&apos;s parent to
          be its base keeps working. The second parent is the previous snapshot, which is
          what turns a pile of commits into a history: push the tip and the whole chain
          travels with it. The commit message carries the facts a reader needs:
        </P>

        <Terminal label="git log -1 --format=%B">
          {GIT_TRAILERS}
        </Terminal>

        <P>
          Depth 179 on this checkout. The chain restarts every four hundred so that an
          abandoned tail becomes unreachable and git&apos;s own garbage collection reclaims
          it.
        </P>

        <H2>What it costs</H2>
        <P>
          The reason this was not done before is that a snapshot of a large tree looked
          expensive, and the measurement showed why: the cost was never the tree, it was
          rebuilding the index from scratch and rehashing every tracked file. On this
          repository, with 7,798 tracked files, that took under two seconds on a quiet
          machine and three minutes under heavy load. A persistent index seeded from the
          real one turns a pass into a stat walk: a fifth of a second at rest, twenty-four
          seconds under the same load. Nothing runs on the hook path itself; the agent&apos;s
          turn ends, the daemon is told, and the snapshot runs from a timer. Turns that end
          within a second and a half of each other share one pass. If a pass ever takes more
          than five seconds, turn snapshots pause on that checkout for ten minutes and the
          five minute sweep carries on. Under load a snapshot can lag its turn by seconds, so
          a rewind is accurate to the turn, not to the keystroke, and each row records how
          long its pass took.
        </P>

        <H2>Rewind</H2>
        <P>
          A history you can read is good. A history you can stand in is better. The
          workspace command from the last post takes a session and a message line (the
          numbering <Code>cast read</Code> uses, not a turn number) and gives you a fresh
          checkout with the files exactly as they stood at that turn, on a new
          branch at that snapshot&apos;s base commit, with the turn&apos;s edits left
          uncommitted:
        </P>

        <Terminal label="cast ws acquire --rewind">
          <Cmd>cast ws acquire before-the-map-change --rewind jx7e4fy@61</Cmd>
        </Terminal>

        <P>
          Pair it with <Code>cast fork --at 61</Code> and you have the conversation and the
          files as they were, side by side with the present, and an agent that can carry on
          from there. That is the whole point of recording the tree: not a log to admire, but
          a place you can go back to.
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
          <Link href="/blog/one-repository-twenty-checkouts">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              Workspaces, the previous post
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          The five terminal captures are genuine output from the codecast checkout on
          2026-10-07: <Code>cast diff --turns</Code> and <Code>--turn</Code> on a real session
          in this repository, and <Code>git log</Code> on the snapshot chain the daemon keeps.
          The turn list keeps six of sixty-four rows, the patch keeps its first hunk, and the
          git log drops nothing; each omission is marked <Code>…</Code>. The rewind command is
          shown as a command only and was not run: the previous post measured an acquire on
          this machine at twenty minutes. The timings in the cost section are from the
          feature&apos;s own design document, measured on 2026-10-06 on this repository. No
          screenshot: the feature lives in the terminal and in git.
        </p>
      </article>
    </main>
  );
}
