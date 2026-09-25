"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Terminal, Cmd, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// Genuine `cast sharing` output from the author's machine on 2026-09-24. The
// overview is trimmed to one team and three folders; the session list to its
// first rows. Every omission is marked with an editorial "…". Nothing is
// reconstructed, and no command in this post changed a setting.

const SHARING_OVERVIEW = `Sync
  Every folder on this machine uploads, new ones included.

Teams what each team sees of the sessions you share with it
  …  four other teams  …
  Codecast   Full          the whole conversation; 8 teammates

Folders 130 known, 91 deleted folders that never synced hidden (--all lists every one)
  ~/src/codecast                            Codecast, all sessions   11,315 synced, 7 shared one by one, 2 kept private, 1,565 on this machine, Dec 9, 2025 to today, codecast-sh/codecast
  ~                                         private                  24,423 synced (with 44 folders inside), 263 shared one by one, 7 kept private, 46 on this machine, May 1, 2024 to today
  ~/src/platform                            private                  15 synced, 1 kept private, 9 on this machine, Aug 26 to Sep 18
  …  36 more folders, most of them private  …

Change with cast sharing sync, unsync, share, private, lock, team or session. cast sharing --help explains each.
`;

const SHARING_SESSIONS = `~/src/codecast  11,305 sessions on codecast, Codecast, all sessions
  2026-09-24  shared                Org review conversation prompt                                jx71bgvnytnt52bm5d0j8atn8h8f01jk
  2026-09-24  shared                Desktop link routing                                          jx7e4etshj20w91rvj307g4jch8f0c75
  2026-09-24  shared                Cast browser bookmark animation                               jx74tvj4habe5zywrcth13dm2h8f0qm0
  2026-09-24  kept private          Codecast sharing setup                                        jx72nc0jmfj592gb6bx3324z718f0fft
  2026-09-24  shared                Session profiles missing                                      jx7fw61vhjypttfkwhdnwqnvq58f1xz8
  2026-09-24  shared                Cast sharing CLI review                                       jx70yehcnr27y82pz25ngza6vs8f1fcv
  …  11,299 more rows  …
`;

const SHARING_DRY_RUN = `dry run  Codecast would see ~/src/platform: 15 sessions, Aug 26 to Sep 18. 1 session you hid by hand stay hidden.
Codecast: 8 teammates, level Full, so they see the whole conversation of what you share.
`;

const SHARING_LEVELS = `Each team also has a level for you: what teammates see of anything shared.
  hidden   Your sessions never appear to this team.
  activity Teammates see that you are working and where, with no titles or content.
  summary  Teammates see what each session was about, not the conversation itself.
  full     Teammates can open and read every session you share with this team.
`;

export default function WhatYourTeamSeesPost() {
  const post = getPost("what-your-team-sees");
  useRouteMeta("/blog/what-your-team-sees");

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
            What your team sees
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            Sharing your Claude Code sessions with a team is a great idea right up to the
            session where you pasted a customer&apos;s data. Codecast answers with two dials, a
            dry run, and one command that shows the whole picture.
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "September 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 6} min read</span>
          </div>
        </header>

        <H2>The question everyone asks on day one</H2>
        <P>
          A team that adopts codecast gets the thing it came for in an hour: everyone&apos;s
          agent sessions, in one inbox, searchable, steerable from a phone. Then somebody asks
          the question that decides whether the tool stays installed. <em>Which of my sessions
          can they read?</em> The honest answer has to be per folder, per team, and per
          session, because a laptop runs agents on the work repository, on a side project, and
          on a scratch folder full of pasted secrets, and those three should not share a rule.
        </P>
        <P>
          This week we shipped that answer as one command. <Code>cast sharing</Code> prints
          everything that uploads from this machine and what each team can see of it. Here it
          is on the machine that writes this blog, trimmed to one team and three folders:
        </P>

        <Terminal label="cast sharing" wrap>
          <Cmd>cast sharing</Cmd>
          {SHARING_OVERVIEW}
        </Terminal>

        <P>
          Two settings decide everything, and the overview shows both. <em>Sync</em> is
          whether a folder&apos;s sessions upload at all; on this machine every folder does,
          and they land private. <em>Sharing</em> is who can open what uploaded. In this
          excerpt one folder is shared with a team, the codecast repository itself: every session in it, from
          December, across every checkout and worktree, because a rule covers a repository and
          not a path. The rest is private, which is the default for a new folder and the state
          you get without doing anything.
        </P>

        <H2>Two dials, not one</H2>
        <P>
          The folder rule says which sessions a team may see. A second dial, set per team, says
          how much of them. Four levels, from the command&apos;s own help:
        </P>

        <Terminal label="cast sharing --help" wrap>
          {SHARING_LEVELS}
        </Terminal>

        <P>
          The middle two are the ones a new team wants and most tools do not have.{" "}
          <em>Activity</em> is the office you can see across: your teammates know you are
          working and in which repository, and nothing else. <em>Summary</em> is the standup
          without the meeting: what each session was about, one line, and the transcript stays
          yours. A team can start at summary on its first day and move to full when it trusts
          the record, and raising the level applies to new sessions only unless you say
          otherwise.
        </P>
        <P>
          Here are both dials in the web app, on the Sync &amp; Privacy settings page: the
          team&apos;s level on the group header, and the repository&apos;s rule on the row
          beneath it, with the count and date span of what that rule exposes:
        </P>

        <Screenshot
          src="/blog/what-your-team-sees/team-level.png"
          alt="The Codecast team group on the Sync and Privacy settings page: 8 teammates, 1 shared, teammates see the whole conversation and can open 11,305 sessions from Dec 9, 2025 to today with 2 sessions hidden by hand, a Full level dropdown, and beneath it the codecast repository row with its own Codecast team dropdown, a sync toggle, and links to view as the team and review"
          caption="One team, one repository. The header carries the team's level; the row carries the folder's rule and what it exposes."
        />

        <H2>See before you share</H2>
        <P>
          The count on that row is the part that matters. A share is a decision about
          thousands of transcripts you did not reread, so the command tells you what a share
          would expose before it does anything. This is a dry run against a private folder on
          this machine, and it changed nothing:
        </P>

        <Terminal label="cast sharing share --dry-run" wrap>
          <Cmd>cast sharing share ~/src/platform --team Codecast --dry-run</Cmd>
          {SHARING_DRY_RUN}
        </Terminal>

        <P>
          Fifteen sessions, a date range, one session that stays hidden because it was hidden
          by hand, and a reminder of the level the team is at. A share can also start from a
          date (<Code>--from today</Code>), so the past stays private while the future is
          shared, and it can name sessions to keep out. The dry run is the same either way.
        </P>

        <H2>Down to the session</H2>
        <P>
          Rules are about folders, and the exceptions are about sessions. Inside a shared
          repository, any single session can be kept private, whatever the folder&apos;s rule
          says. The listing for a folder shows the verdict per session:
        </P>

        <Terminal label="cast sharing sessions" wrap>
          <Cmd>cast sharing sessions ~/src/codecast</Cmd>
          {SHARING_SESSIONS}
        </Terminal>

        <P>
          Look at the fourth row. A session titled <em>Codecast sharing setup</em> is kept
          private, in a repository whose rule shares everything else. That is the shape
          of the thing: a wide rule, and exact exceptions, both visible in the same list.
        </P>
        <P>
          There is one more option for folders that must never be shared, whatever anyone
          does later: <Code>cast sharing lock</Code>. A locked folder cannot be shared by any
          rule, from any checkout of the repository, until you lift the lock yourself. It is
          the setting for client work.
        </P>

        <H2>Or let an agent decide with you</H2>
        <P>
          The settings page opens with an offer. An agent will read your folder names and
          session titles, recommend what should sync and what each team should see, and ask
          before it changes anything. The conversation it has with you stays private, which is
          the only acceptable property for a conversation about what to keep private.
        </P>

        <Screenshot
          src="/blog/what-your-team-sees/page-top.png"
          alt="The top of the Sync and Privacy settings page: a card offering to decide with an agent that reads folders and session titles and asks before changing anything, a Sync all folders toggle turned on, and the Sharing section explaining that everything is private until a repository is shared with a team and that a share covers all checkouts and worktrees"
          caption="The Sync & Privacy page: the setup agent, the sync toggle, and the sharing rule in one sentence."
        />

        <P>
          Every change, from the command or the page, prints the command that reverts it. So
          the first team day goes like this: install, everything uploads private, share the
          work repository with the team at the level the team is ready for, keep the odd
          session out by name, and lock the folder that should never travel. Then your
          teammates see your sessions, and only the ones you meant.
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
          <Link href="/documentation/team-sessions">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              Team sessions guide
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          All four terminal captures are genuine <Code>cast sharing</Code> output from the
          author&apos;s machine on 2026-09-24, and no command shown changed a setting. The
          overview is trimmed to one of five teams and three of thirty-nine listed folders;
          the session list keeps six of its rows; each omission is marked <Code>…</Code>. The
          levels block is the command&apos;s own help text. Both screenshots are the Sync
          &amp; Privacy settings page in the codecast web app, cropped to one team&apos;s group
          and to the page header; the other teams&apos; groups and the private folder rows are
          outside the crops.
        </p>
      </article>
    </main>
  );
}
