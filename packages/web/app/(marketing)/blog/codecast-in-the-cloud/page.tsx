"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, SOL, H2, P, Code, Figure, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";
import { ArrivalFigure, CloudsTable, FigureStyles, GitFigure, MapFigure, MigrateFigure, SleepFigure, SyncFigure, TravelFigure } from "./figures";

// Screenshots are single elements of the real app (Settings → Devices,
// Settings → Migration, the conversation header's machine menu), captured
// with scripts/app-element-shot.ts from the codecast team's own workspace on
// 2026-10-09. Nothing else from that workspace is in frame.

const IMG = "/blog/codecast-in-the-cloud";

const MOVE_NOTICE = `[codecast] This session just moved to a different machine. It now runs on
Linux - ip-172-31-40-243 in /home/ubuntu/work/codecast (previously
macOS - MacBook-Pro-182). Processes, ports, and any files outside the working
tree from the previous machine are not here.`;

const LIMITS: [string, string][] = [
  ["Waking a sleeping machine needs your laptop online.", "Work sent to an asleep machine wakes it through the laptop that manages it. If that laptop is closed, the work waits."],
  ["Only Linux machines sleep on their own.", "A cloud Mac stays up, and AWS bills its dedicated host for at least 24 hours either way."],
  ["Only Claude Code sessions move.", "Any agent can start on a cloud machine, but moving a running session between machines works for Claude Code, and never straight from one cloud machine to another."],
  ["Most tool sign-ins travel when they exist.", "Claude, Codex, Gemini and a few others travel only while their sign-in is valid. Sign-ins for tools like GitHub, AWS and npm travel whenever your laptop has them. Your Anthropic API key and your Google logins never do."],
  ["Adding a machine runs one command on your laptop.", "The Add a cloud machine dialog builds it for you, because your AWS credentials and SSH key live on your laptop, not in a browser."],
  ["A cloud Mac only applies part of a repository's setup.", "System packages and services are set up on Linux machines; on a Mac, setup commands and iOS simulators apply."],
];

export default function CodecastInTheCloudPost() {
  const post = getPost("codecast-in-the-cloud");
  useRouteMeta("/blog/codecast-in-the-cloud");

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: SOL.base3 }}>
      <BlogNav />
      <FigureStyles />

      <article className="max-w-2xl mx-auto px-6 pt-16 pb-24">
        <Link href="/blog" className="inline-flex items-center gap-1 text-sm font-medium mb-8" style={{ color: SOL.yellow }}>
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
          </svg>
          Blog
        </Link>

        <header className="mb-10">
          <h1 className="text-4xl md:text-5xl font-bold leading-[1.12] tracking-tight font-mono" style={{ color: SOL.base03 }}>
            Codecast in the cloud
          </h1>
          <p className="mt-5 text-xl leading-relaxed" style={{ color: SOL.base00 }}>
            {post?.dek}
          </p>
          <div className="mt-6 flex items-center gap-3 font-mono text-sm" style={{ color: SOL.base1 }}>
            <span>{post?.author ?? "the codecast team"}</span>
            <span aria-hidden>&middot;</span>
            <time dateTime={post?.date}>{post?.dateLabel ?? "October 2026"}</time>
            <span aria-hidden>&middot;</span>
            <span>{post?.readingMinutes ?? 14} min read</span>
          </div>
        </header>

        <P>
          Most cloud agent products give you a fresh clone of <Code>main</Code> in somebody
          else&apos;s sandbox. Your uncommitted change is not there, your <Code>.env.local</Code>{" "}
          is not there, your agent instructions and your logins are not there, and the agent
          spends its first ten minutes rebuilding a world you already had. Codecast went the
          other way. A cloud machine is a computer in your own AWS account that codecast sets
          up to look like your laptop, and a session you send there starts from the folder you
          are working in.
        </P>
        <P>
          This post walks through all of it, in the order you meet it in the app: adding a
          machine, starting a session there, what the machine is given, how it pushes code,
          keeping the agent&apos;s edits on your laptop as they happen, moving running sessions
          between machines, watching a cloud session&apos;s browser and screen, cloud Macs with
          iOS simulators, sleep and wake, and the other companies&apos; clouds codecast also
          shows in your inbox. The limits are at the end, stated plainly.
        </P>

        <Figure wide caption="Everything that moves between your laptop and a cloud machine. Paper is the laptop, night is the cloud machine.">
          <MapFigure />
        </Figure>

        <P>
          One idea runs through the whole design: <strong>your laptop is the source of
          truth, and the cloud machine is a second pair of hands.</strong> Files and sign-ins go
          from the laptop to the machine directly. When the machine needs something only the
          laptop has, such as a site&apos;s login, it asks, and the laptop does the work.
          Codecast&apos;s servers carry instructions and short-lived tokens, never your source.
        </P>

        <H2>Add a machine</H2>
        <P>
          Open <strong>Settings → Devices</strong>. It lists every machine connected to
          codecast and whether it is online; under <strong>Machines</strong>, <strong>Add a
          cloud machine</strong> sets up a Linux or Mac machine in your own AWS account. Pick
          Linux for general development (it sleeps when idle) or Mac for Xcode and iOS work,
          connect an instance you already run or create a new one, and fill in the AWS details.
        </P>

        <Screenshot
          src={`${IMG}/add-cloud-machine.webp`}
          alt="The Add a cloud machine dialog: Linux or Mac, connect existing or create new, the instance details, and a Copy setup command button."
          caption="Add a cloud machine. AWS bills you directly; codecast never runs machines on its own account."
        />

        <P>
          The dialog builds one setup command, which you copy and run once in a terminal on
          your laptop, from your project. That step stays on the laptop on purpose: it is
          where your AWS credentials and SSH key live. Setup installs what a session needs,
          copies your agent configuration over, and waits for the machine to come online.
        </P>
        <P>
          From then on the machine has its own panel in Settings → Devices. It shows whether
          the machine is <strong>Awake</strong>, <strong>Waking</strong>, <strong>Going to
          sleep</strong> or <strong>Asleep</strong>, its size and region, what it costs per
          hour awake and per month for its disk, and when it next sleeps. The buttons wake it,
          put it to sleep, apply the repository&apos;s setup again, or <strong>Save
          image</strong>, which snapshots a ready machine so the next one starts ready. Rows
          for your setup, sign-ins and tools say what is in step, and which sign-ins were held
          back and why, before an agent finds out the hard way.
        </P>

        <H2>Start a session from your screen, not from main</H2>
        <P>
          Once a cloud machine exists, the composer grows a <strong>run in the cloud</strong>{" "}
          switch. Turn it on and the new session runs on the machine in a worktree of its own.
          Two more choices sit beside it. <strong>start from</strong> is <strong>my
          checkout</strong> (your exact working state) or <strong>origin/main</strong> (a clean
          start). <strong>isolated worktree</strong>, on by default, can be turned off to run in
          the machine&apos;s main checkout, for a job like a data migration that must run where
          everything else is; that is refused if the checkout has changes or another session
          is using it. An asleep machine wakes when the session starts, and the header reads{" "}
          <em>preparing cloud host</em> while its checkout is made.
        </P>
        <Screenshot
          src={`${IMG}/composer-cloud.webp`}
          alt="The new-session composer's switches: isolated worktree on, run in the cloud on, start from my checkout or origin/main."
          caption="The composer with run in the cloud on, starting from your checkout."
        />

        <P>
          &ldquo;My checkout&rdquo; is the part that took the longest to get right. Your laptop
          takes one snapshot of your folder, ignored files included, without moving anything in
          your checkout. The machine restores it so your uncommitted edits show up as
          uncommitted again, and checks that its folder matches yours before the agent starts.
          Any agent works there: Claude Code, Codex, Cursor, Gemini, opencode, pi or Grok.
        </P>

        <Screenshot
          wide
          src="/blog/field-manual/cloud-spawn.webp"
          alt="Two commit graphs. Laptop: an unpushed commit and modified files captured into a snapshot. Cloud machine: the same commit with the files uncommitted again."
          caption="The snapshot carries your exact working state, and the machine restores it as uncommitted work."
        />

        <P>
          Not everything should travel. Dependency folders are rebuilt on the machine, because
          a <Code>node_modules</Code> built on a Mac is wrong on Linux anyway, and big untracked
          media and binaries stay home. Each file left behind is listed under the reason it
          stayed, so you can see the decision rather than discover it.
        </P>

        <Figure wide caption="What a cloud start carries. Tracked files always travel, whatever their size; .env files travel too, since both machines are yours.">
          <TravelFigure />
        </Figure>

        <P>
          Agents can start cloud sessions too. One that fans out five tasks gets five worktrees
          from a single snapshot, so all five start from the same instant of your work (for an
          agent, that is <Code>cast spawn --cloud</Code>).
        </P>

        <H2>The machine is set up like your laptop</H2>
        <P>
          An agent is only as good as its context, and most of the context lives outside the
          repository: your agent settings, your <Code>CLAUDE.md</Code>, the skills and hooks you
          wrote, the shell setup your hooks assume, the sign-ins for the tools your agents call.
          You never set a cloud machine up by hand. Before a session starts, and whenever the
          machine wakes for one, your laptop brings it into step:
        </P>

        <Figure wide caption="The machine's checklist before a session starts. Every step except the disk check and the configuration copy may fail without blocking work, and says so in the machine's panel.">
          <ArrivalFigure />
        </Figure>

        <P>
          <strong>Your agent setup</strong> travels: agent settings, instruction files, skills,
          hooks, your shell setup and your agents&apos; memory, with laptop paths rewritten to
          the machine&apos;s. Memory comes back the other way too, so what a cloud session learns
          is not stranded there. Credentials, transcripts, caches, SSH keys and browser profiles
          never travel.
        </P>
        <P>
          <strong>Sign-ins</strong> go one way, from your laptop to the machine. The Claude
          sign-in is the delicate one: refreshing it on the machine would log you out at home,
          so the machine is never allowed to refresh it, and your laptop sends a fresh one when
          its own renews. Your Anthropic API key deliberately stays home, because its presence
          would move every Claude on the machine off your subscription and onto metered API
          billing. <strong>Tools</strong> arrive at your laptop&apos;s versions, installed for
          your user without admin rights.
        </P>
        <P>
          When a repository needs more on the machine, a database or a system package, ask an
          agent to add it to the repository&apos;s codecast setup. Every machine applies it before
          the next session starts, and skips it when it is already in step.
        </P>

        <H2>Pushing code without leaving a key on the machine</H2>
        <P>
          A machine that runs agents unattended should not hold a long-lived GitHub token. With
          the codecast GitHub app installed for a repository, the machine asks for a token each
          time it pushes, and codecast hands back one scoped to that one repository, after
          checking that you are allowed to push. It expires within the hour and is never written
          to disk.
        </P>

        <Figure wide caption="One push from a cloud machine. The token lives about as long as the push does.">
          <GitFigure />
        </Figure>

        <P>
          Where the app cannot help, Settings → Devices marks the repository <strong>needs
          access</strong> and shows the machine&apos;s own public key with a <strong>Copy</strong>{" "}
          button. Add it on GitHub as a deploy key with write access, and pushing starts working
          within minutes.
        </P>

        <H2>The agent&apos;s edits, on your laptop, as they happen</H2>
        <P>
          A cloud session is only half useful if its work is stuck there. Click the machine name
          in a cloud session&apos;s header and choose <strong>Sync with</strong> your laptop. The
          session&apos;s folder is then kept in step with a copy on your laptop, both ways, a few
          seconds behind. Open it in your editor, run the tests locally, or fix a line yourself
          and let the agent see it. A chip in the header shows the state: <em>syncing</em>,{" "}
          <em>in step</em> with the time of the last sync, or <em>sync paused</em> while the
          session is idle, so the machine can still sleep. Its menu opens the copy in Cursor or
          VS Code.
        </P>
        <P>
          When only one side changed, its changes land on the other. When both changed, the
          files that merge cleanly land, and a file changed on both sides is held as it is on
          each side while everything else keeps flowing. Only files that actually changed are
          written, so your editor and your dev server do not see a storm of rewrites.
        </P>

        <Figure wide caption="Thirty seconds of a synced session. Ticks run every 3 s while the agent works, and pause when it goes quiet.">
          <SyncFigure />
        </Figure>

        <P>
          A held file never gets conflict markers written into it: the chip lists it with{" "}
          <strong>Keep the laptop&apos;s</strong> and <strong>Keep the cloud&apos;s</strong>.{" "}
          <strong>Cloud to laptop only</strong> turns the copy into a mirror you read rather
          than edit, and if you edit it anyway, the sync stops and asks whether to send your
          edits or take the cloud&apos;s.
        </P>

        <Screenshot
          wide
          src="/blog/field-manual/cloud-mirror.webp"
          alt="The machine menu for a synced cloud session: synced both ways, one file held because it changed on both sides, and a list of what stayed on the cloud machine."
          caption="A conflict holds one file, not the sync. Heavy and machine-specific files stay on their own side, listed with the reason."
        />

        <H2>Move running sessions before you close the lid</H2>
        <P>
          The most common reason to want a cloud machine is the moment you need your laptop
          back: a flight, a meeting, a laptop pinned at full load. Click the machine name in a
          conversation&apos;s header for <strong>Run on device · which machine</strong>, and pick
          where the session should run. An asleep cloud machine is marked{" "}
          <em>asleep, wakes on move</em>.
        </P>

        <Screenshot
          src={`${IMG}/machine-menu.webp`}
          alt="The machine menu in a conversation's header: the session is running here on the MacBook Pro and can move to Cloud Linux or the Mac-mini."
          caption="The session runs here on the laptop; it can move to either cloud machine."
        />

        <P>
          For many sessions at once, select them in the inbox and choose <strong>Move
          to…</strong>, or open <strong>Settings → Migration</strong>. Migration lists your
          sessions with filters, and you pick a destination: each card says whether the machine
          is online and how many sessions already run there.
        </P>

        <Screenshot
          src={`${IMG}/migration-dest.webp`}
          alt="Settings, Migration, Destination: cards for Cloud Linux and Mac-mini (cloud hosts, online) and a MacBook Pro (laptop, offline), each with its session count."
          caption="Settings → Migration: pick where the selected sessions go."
        />

        <P>
          Then you decide how to treat a session that is in the middle of a turn. It finishes
          the turn first, up to the wait you choose, or is interrupted at once. Anything you send
          it meanwhile is held and delivered on the other side. A session waiting on a
          permission prompt moves at once and asks again on the new machine.
        </P>

        <Screenshot
          src={`${IMG}/migration-turns.webp`}
          alt="How to handle running turns: Sessions mid-turn set to Wait up to 10 minutes, and Transfers at once set to 2."
          caption="Mid-turn sessions get to finish. Messages sent meanwhile wait and arrive after the move."
        />

        <P>
          Each session walks through the same steps, shown live under <strong>Migrations</strong>{" "}
          on the same page: new turns are held, the turn finishes, the agent stops, its work
          and conversation transfer, and it resumes on the other side. Coming home, the cloud
          machine&apos;s work lands in your checkout as uncommitted changes. If it does not apply
          cleanly, that session fails with the reason, nothing in your folder changes, and the
          session keeps running where it was.
        </P>

        <Figure wide caption="A batch of five, schematic. A failed session restarts where it was; nothing is left half moved.">
          <MigrateFigure />
        </Figure>

        <P>
          The conversation marks the move with a rule reading <em>now running on …</em>, and the
          agent is told, so it does not go looking for a dev server it left behind:
        </P>

        <Figure caption="What the agent reads after a move.">
          <pre className="p-4 font-mono text-[12px] leading-relaxed whitespace-pre-wrap" style={{ color: SOL.base01 }}>{MOVE_NOTICE}</pre>
        </Figure>

        <P>
          <strong>Run here</strong>, on any laptop, brings a cloud session home without
          interrupting a turn in progress. And when your laptop is under sustained pressure
          (memory, CPU, or load for a minute or more), the <strong>Resources</strong> page offers
          to offload sessions to a cloud machine, spreads them for you, and waits for you to
          confirm. On the iPhone app, tap the machine in a session&apos;s header to move it.
        </P>

        <Screenshot
          wide
          src="/blog/field-manual/film-remote.webp"
          alt="A Codex session running on a cloud machine, with its browser tab, in the same inbox as the laptop's sessions."
          caption="A cloud session sits in the same inbox as everything on your laptop, browser tab and all."
        />

        <H2>Watch the cloud machine work</H2>
        <P>
          A cloud machine has its own Chrome, so agents there verify UI and read behind sign-ins
          without touching yours. <strong>watch live</strong> on a browser step shows the
          agent&apos;s tab beside the conversation. <strong>Take the wheel</strong> gives you the
          mouse and keyboard, for example to sign in where the agent cannot, and{" "}
          <strong>Hand back</strong> returns it. When an agent needs a site you are already
          signed in to, your laptop copies that one site&apos;s login across. Google logins are
          never copied.
        </P>
        <P>
          For anything outside the tab, a popup, a file picker or a native dialog, the screen
          button opens the machine&apos;s whole display in a <strong>Host screen</strong> pane.
          The <strong>tmux</strong> pill in the header opens the agent&apos;s terminal; typing
          works there, a moment behind. Agents on the machine can also drive native Linux apps
          the same way they do on a Mac.
        </P>
        <P>
          One capability is command-line only today: mounting a folder from your laptop on the
          cloud machine at the same path, with no copy (<Code>cast hosts reach ~/notes</Code>). The
          laptop serves just that folder from a locked-down sandbox, and the folder is there only
          while your laptop is.
        </P>

        <H2>Cloud Macs and iOS simulators</H2>
        <P>
          A cloud Mac is for work that needs Xcode. Add iOS simulators to the repository&apos;s
          codecast setup (or ask an agent to), and the Mac gets a copy of your laptop&apos;s
          Xcode, the iOS runtime and the tools agents use to drive a simulator. From then on an
          agent on the Mac installs its build in a simulator, taps through it and puts
          screenshots in the conversation, exactly as it would on your laptop. The first Xcode
          copy is slow, close to an hour for us; it happens once.
        </P>

        <H2>It sleeps when nothing is happening</H2>
        <P>
          A machine that runs all night for nothing is the fastest way to stop trusting the
          feature, so a Linux machine watches for real work and stops itself without it. Real
          work means an agent mid-turn, a background job, someone watching its screen, or a
          process using CPU. An agent idling at a prompt is not work. After twenty idle minutes
          the machine powers off, and a stopped machine costs only its disk. Its panel in
          Settings → Devices says when it will sleep.
        </P>

        <Figure wide caption="Schematic, except the wake: on September 5 a queued trigger reached a stopped machine's session 60 seconds later.">
          <SleepFigure />
        </Figure>

        <P>
          Waking is automatic. Work for an asleep machine, a message, a moved session or a
          scheduled trigger, wakes it through your laptop, and the work starts once it is up.
          You can also press <strong>Wake</strong> in its panel. A Mac is different: its AWS
          host bills while allocated, awake or asleep, so it does not sleep on its own.
        </P>

        <H2>When something breaks</H2>
        <P>
          Machines fail in boring ways, and most of the work here went into making the failures
          boring too. If an agent&apos;s process dies in the middle of work, on a cloud machine
          or a laptop, codecast restarts the session with a note explaining what happened, at
          most three times in six hours, and never one you stopped yourself. A move that stops
          reporting for thirty minutes is failed, and the session stays where it was. The
          machine&apos;s panel shows which sign-ins and tools are missing before an agent trips
          over them.
        </P>

        <H2>The other clouds</H2>
        <P>
          Your cloud machine is not the only cloud your agents run in. Codecast also shows, and
          mostly drives, the cloud agents other companies run, in the same inbox and the same
          search as everything else. Add a Cursor key and your Cursor Cloud agents appear as
          sessions; the composer&apos;s <strong>run in Cursor Cloud</strong> starts one, and your
          messages become its follow-ups. Turn on Codex Cloud tasks and <strong>run in
          OpenAI&apos;s cloud</strong> starts one with up to four attempts, then <strong>Create
          draft PR</strong> or <strong>Apply locally</strong>. Claude Code sessions you started on
          the web show up with their full transcripts, and you can reply from codecast.
        </P>

        <Figure wide caption="Four kinds of cloud session, one inbox. Only your own machine starts from your uncommitted work.">
          <CloudsTable />
        </Figure>

        <P>
          The difference is the starting point. A vendor&apos;s cloud starts from what is on
          GitHub. Your machine starts from what is on your screen, which is why we built it.
        </P>

        <H2>What it needs, and where it stops</H2>
        <ul className="mb-6 space-y-4">
          {LIMITS.map(([q, a]) => (
            <li key={q} className="text-[16px] leading-7" style={{ color: SOL.base01 }}>
              <strong style={{ color: SOL.base02 }}>{q}</strong> {a}
            </li>
          ))}
        </ul>

        <blockquote
          className="my-8 border-l-2 pl-5 text-xl leading-relaxed font-mono"
          style={{ borderColor: SOL.yellow, color: SOL.base03 }}
        >
          Codecast is where your team sees, steers, and remembers every coding agent session, on
          any agent and any machine, including the ones you rent.
        </blockquote>

        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <Link href="/signup">
            <Button size="lg" className="text-white text-base px-8 h-12 font-medium" style={{ backgroundColor: SOL.base03 }}>
              Start free
            </Button>
          </Link>
          <Link href="/features/cloud">
            <Button size="lg" variant="outline" className="bg-transparent text-base px-8 h-12 font-medium" style={{ borderColor: SOL.base1, color: SOL.base01 }}>
              The cloud machines page
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          The screenshots of Add a cloud machine, the machine menu and Settings → Migration are
          single elements of the real app, captured from the codecast team&apos;s own workspace
          on 2026-10-09 with nothing else in frame; two unrelated offline machines are hidden
          from the menu and the destination list. The 60 second wake was measured on 2026-09-05.
          The figures are drawn from the code&apos;s own constants (tick rates, timeouts, idle
          minutes); the migration batch and the sync timeline are schematic. Three illustrations
          come from the field manual&apos;s cloud chapter. If you script codecast, every action
          here also has a <Code>cast</Code> command; <Code>cast --help</Code> lists them.
        </p>
      </article>
    </main>
  );
}
