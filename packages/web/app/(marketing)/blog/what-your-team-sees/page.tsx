"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, SOL, H2, P, Code, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";

// The figures quoted below (session counts, date spans, the kept-private
// session) come from the author's Sync & Privacy page and `cast sharing` on
// 2026-09-24. No setting was changed for this post.

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
            preview before every share, and one settings page that shows the whole picture.
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
          This week we shipped that answer as one page. Open <em>Settings</em>, then{" "}
          <em>Sync &amp; Privacy</em>, and you get everything that uploads from this machine
          and what each team can see of it:
        </P>

        <Screenshot
          src="/blog/what-your-team-sees/page-top.png"
          alt="The top of the Sync and Privacy settings page: a card offering to decide with an agent that reads folders and session titles and asks before changing anything, a Sync all folders toggle turned on, and the Sharing section explaining that everything is private until a repository is shared with a team and that a share covers all checkouts and worktrees"
          caption="The Sync & Privacy page: the setup agent, the sync toggle, and the sharing rule in one sentence."
        />

        <P>
          Two settings decide everything, and the page shows both. <em>Sync</em> is whether a
          folder&apos;s sessions upload at all; on this machine the <em>Sync all folders</em>{" "}
          switch is on, so every folder does, and they land private. <em>Sharing</em> is who
          can open what uploaded. On the machine that writes this blog, one folder is shared
          with a team, the codecast repository itself: every session in it, from December,
          across every checkout and worktree, because a rule covers a repository and not a
          path. The rest is private, which is the default for a new folder and the state you
          get without doing anything.
        </P>

        <H2>Two dials, not one</H2>
        <P>
          The folder rule says which sessions a team may see. A second dial, set per team, says
          how much of them. It is a dropdown on the team&apos;s header, with four levels:
        </P>

        <ul className="mb-6 space-y-2 text-[17px] leading-8" style={{ color: SOL.base01 }}>
          <li><strong>Full access.</strong> Teammates can read your full sessions.</li>
          <li><strong>Summary.</strong> Teammates see titles and short summaries: what you worked on and how it went, not the conversation itself.</li>
          <li><strong>Activity only.</strong> Teammates see workspace names and session counts. Like a status light.</li>
          <li><strong>Hidden.</strong> Teammates see none of your work. You still see what they share.</li>
        </ul>

        <P>
          The middle two are the ones a new team wants and most tools do not have.{" "}
          <em>Activity</em> is the office you can see across: your teammates know you are
          working and in which repository, and nothing else. <em>Summary</em> is the standup
          without the meeting: what each session was about, one line, and the transcript stays
          yours. A team can start at summary on its first day and move to full when it trusts
          the record. Raising the level asks which sessions it covers, <em>Only new
          sessions</em> or <em>All sessions, past and future</em>, so nobody widens the past by
          accident.
        </P>
        <P>
          Here are both dials together, further down the same page: the team&apos;s level on
          the group header, and the repository&apos;s rule on the row
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
          thousands of transcripts you did not reread, so the page tells you what a share
          would expose before it does anything. Click a folder&apos;s sharing control, pick a
          team, and before anything changes a band spells it out: which team, how many
          teammates, what level they will see, how many sessions, and the dates they span.
          Here it is for a private folder on this machine, picked and then cancelled:
          nineteen sessions from Aug 26 on, and one that stays hidden because it was hidden by
          hand.
        </P>

        <Screenshot
          src="/blog/what-your-team-sees/share-preview.png"
          alt="The share preview on the Sync and Privacy page: Codecast (4 teammates) will see the whole conversation for platform; 19 sessions, Aug 26 to today, 1 session hidden by hand stays hidden; the choices Everything, past sessions included, From today on, and Since a date; and below it a list headed Untick a session to keep it private"
          caption="The preview a share shows before you confirm it. Nothing changes until you press the share button."
        />

        <P>
          Under it are the choices that make a share fit: <em>Everything, past sessions
          included</em>, <em>From today on</em>, or <em>Since a date</em>, so the past can stay
          private while the future is shared. Below those is the folder&apos;s session list,
          where you untick any session to keep it private. Only then does the button, which
          names the team (<em>Share with Codecast</em>), do anything. The same preview prints
          in a terminal with <Code>cast sharing share &lt;folder&gt; --dry-run</Code>, for
          scripts and for agents.
        </P>

        <H2>Down to the session</H2>
        <P>
          Rules are about folders, and the exceptions are about sessions. Inside a shared
          repository, any single session can be held back, whatever the folder&apos;s rule
          says: the <em>Share</em> button in a session&apos;s header opens a popover where{" "}
          <em>What the team sees</em> goes from <em>Full</em> down to <em>Summary</em> or{" "}
          <em>Hidden</em> for that one session. On this machine a session titled{" "}
          <em>Codecast sharing setup</em> is kept private, in a repository whose rule shares
          the other eleven thousand. That is the shape of the thing: a wide rule, and exact
          exceptions.
        </P>
        <P>
          There is one more choice for folders that must never be shared, whatever anyone
          does later: <em>Never share</em>, next to <em>Only me</em> and the team names on the
          folder&apos;s sharing control. A folder set that way is listed as locked by you, and no rule from any checkout of the
          repository can share it until you unlock it yourself. It is the setting for client
          work.
        </P>

        <H2>Or let an agent decide with you</H2>
        <P>
          The settings page opens with an offer, the <em>Decide with an agent</em> card at the
          top of the screenshot above. An agent will read your folder names and
          session titles, recommend what should sync and what each team should see, and ask
          before it changes anything. The conversation it has with you stays private, which is
          the only acceptable property for a conversation about what to keep private.
        </P>

        <P>
          So the first team day goes like this: install, everything uploads private, share the
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
          The counts, dates and the kept-private session are from the author&apos;s machine
          on 2026-09-24, read from the Sync &amp; Privacy page and the matching{" "}
          <Code>cast sharing</Code> output; nothing shown changed a setting. All three
          screenshots are the Sync &amp; Privacy settings page in the codecast web app, cropped
          to the page header, to one team&apos;s group, and to the share preview; the other
          teams&apos; groups and the private folder rows are outside the crops. The preview
          was opened on a private folder and cancelled.
        </p>
      </article>
    </main>
  );
}
