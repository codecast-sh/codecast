"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { BlogNav, Terminal, Cmd, SOL, H2, P, Code, Figure, Screenshot } from "../blogChrome";
import { useRouteMeta } from "../../pageMeta";
import { getPost } from "../posts";
import { ArrivalFigure, CloudsTable, FigureStyles, GitFigure, MapFigure, MigrateFigure, SleepFigure, SyncFigure, TravelFigure } from "./figures";

// Genuine CLI output from the codecast team's own machines on 2026-10-07. The
// two hosts' public IPs are replaced with documentation addresses
// (203.0.113.0/24); everything else is as printed, with omissions marked "…".

const REMOTE_HOSTS = `this device: macOS - MacBook-Pro-182  (76e7d3d6801fca2b)
  i-084309c56a91e15ff  ubuntu@203.0.113.24  aws running  [default]
  i-021a32d2d254c07d3  codecast@203.0.113.80  aws running  [default]
`;

const HOSTS_LS = `i-084309c56a91e15ff  aws · us-west-2
  state      awake  203.0.113.24
  device     Linux - ip-172-31-40-243 — online  28d80e225ed21f45
  sessions   51
    jx72k01  codecast                       line                               active
    jx79p8f  cloud-5646a5  origin/main@641432e UI polish audit                    active
    …
  worktrees
    codecast  cloud-4213bb  ready  main-4213bb@07a081b, uncommitted changes
    codecast  cloud-5646a5  ready  codecast/cloud-5646a5@eccc7c6, uncommitted changes
    codecast  cloud-54e335  ready  codecast/cloud-54e335@5831cb2, uncommitted changes  no session (orphan)
    codecast  shared-checkout  main@fb2fe9d, uncommitted changes  main checkout, free
    …
  git        device-key: push access to git@github.com:codecast-sh/codecast.git, checked 1d ago
  tools      7 ok, 0 installed, 4 missing, 0 unsupported, 3 MCP servers disabled (codex: node_repl, codex: paper, claude: ios-simulator)
  setup      in step: nothing declared beyond the tools step (applied 2026-10-06T05:33:54Z)
  cost       awake: about $0.0416/hour running, about $6.40/month disk

i-021a32d2d254c07d3  aws · us-east-2
  state      awake  203.0.113.80
  device     macOS - Mac-mini — online  0c621d6e4176bed7
  sessions   12
  …
  cost       Mac dedicated host billing continues while the instance is stopped; 24-hour minimum allocation.
`;

const SPAWN = `cast spawn --cloud "port the v1 routes to the new router"
cast spawn --cloud --from origin-main "audit the public API docs"
cast spawn --cloud --shared "run the data migration"
cast fork --cloud "try it with a queue" "try it with a cron"`;

const HOST_TOML = `# .codecast/workspace.toml (committed, read by every host)
[host]
packages = ["postgresql", "redis-server"]
services = ["postgresql", "redis-server"]
run = ["./scripts/seed-dev-db.sh"]

# this repository's own file says only:
[host]
simulators = ["iOS"]`;

const MIGRATE_LS = `mg-03p71vdf  → Linux - ip-172-31-40-243 (cloud)  done      1/1 done  41h ago
mg-k28o8e34  → macOS - MacBook-Pro-182  done      1/1 done  3d ago
mg-f7qy8sqs  → macOS - Mac-mini (cloud)  done      1/1 done  3d ago
mg-x0ocus1i  → macOS - MacBook-Pro-182  done      3/3 done  3d ago
mg-st7mdwnx  → macOS - MacBook-Pro-182  partial   5/8 done, 3 failed  3d ago
mg-lnu1wdnm  → macOS - Mac-mini (cloud)  done      2/2 done  3d ago
mg-2uvjb2z1  → Linux - ip-172-31-40-243 (cloud)  partial   1/2 done, 1 failed  3d ago
…
`;

const MOVE_NOTICE = `[codecast] This session just moved to a different machine. It now runs on
Linux - ip-172-31-40-243 in /home/ubuntu/work/codecast (previously
macOS - MacBook-Pro-182). Processes, ports, and any files outside the working
tree from the previous machine are not here.`;

const BORROW = `cast browser sync linear.app       # one site's login, from your laptop's Chrome
cast hosts vnc                     # the host's whole screen, inside codecast
cast hosts reach ~/notes           # a laptop folder, mounted on the host, no copy
cast computer get-app-state --app gedit   # native apps on the host, over AT-SPI`;

const LIMITS: [string, string][] = [
  ["Waking a sleeping host needs a laptop online.", "Queued work marks the host for waking, and the next laptop heartbeat starts it. A server-side waker exists, but it is enabled per host by the operator, not from the app."],
  ["Only Linux hosts stop themselves.", "A Mac host stays up, and AWS bills its dedicated host for at least 24 hours either way."],
  ["Only Claude Code sessions move.", "Any agent can be started on a host, but migrating a running session between machines works for Claude Code only, and never directly from one host to another."],
  ["Most tool logins travel when they exist.", "Claude, Codex, Gemini and a few others only travel while their tokens are live. Logins for gh, aws, npm and similar CLIs travel whenever the file is present. Your Anthropic API key and Google logins never do."],
  ["Opening a pull request from a host may need a gh login.", "The per-push token is for fetching and pushing. Most hosts already have a gh login copied from the laptop; if not, run gh auth login there."],
  ["[host] packages and services are Ubuntu-only.", "On a Mac host, only run commands and simulators apply."],
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
            <span>{post?.readingMinutes ?? 16} min read</span>
          </div>
        </header>

        <P>
          Most cloud agent products give you a fresh clone of <Code>main</Code> in somebody
          else&apos;s sandbox. Your uncommitted change is not there, your <Code>.env.local</Code>{" "}
          is not there, your agent instructions and your logins are not there, and the agent
          spends its first ten minutes rebuilding a world you already had. Codecast went the
          other way. A cloud host is a machine in your own AWS account that codecast sets up
          to look like your laptop, and a session sent there starts from the folder you are
          standing in.
        </P>
        <P>
          This post covers all of it: the host itself, what travels when a session starts,
          how the host is made to feel like home, how pushes are authorized, the live mirror
          of an agent&apos;s edits, moving running sessions between machines, the laptop
          capabilities a host can borrow, cloud Macs with iOS simulators, sleep and wake,
          what happens when something breaks, and the other companies&apos; clouds codecast
          also reads from. Every command here is in the CLI today, and the limits are at the
          end, stated plainly.
        </P>

        <Figure wide caption="Everything that moves between your laptop and your host. Paper is the laptop, night is the host.">
          <MapFigure />
        </Figure>

        <P>
          One idea runs through the whole design: <strong>the laptop is the source of
          truth, and the host is a pair of hands.</strong> Files and logins go from the
          laptop to the host over SSH. When the host needs something only the laptop has,
          such as a site&apos;s login or a file outside the repository, it asks through
          codecast, and the laptop does the work. Codecast&apos;s servers carry commands and
          short-lived tokens, never your source.
        </P>

        <H2>A host is an EC2 instance you own</H2>
        <P>
          A host is Ubuntu 24.04 on any instance type, or macOS on an AWS dedicated host. You
          pay AWS directly, at AWS prices. <Code>cast hosts create linux</Code> launches one
          with sensible defaults (a <Code>t3.medium</Code> with an encrypted 80 GiB disk in{" "}
          <Code>us-west-2</Code>), and <Code>cast hosts add &lt;instance-id&gt; --provision</Code>{" "}
          adopts one you already run. In the web app, Settings, Devices, Add a cloud machine
          asks a few questions and builds that command for you to paste on the laptop;
          nothing is provisioned from a browser, because the AWS credentials and the SSH key
          live on your machine.
        </P>
        <P>
          Provisioning installs what a session needs and nothing exotic: tmux, git, a
          virtual display with Chrome on it, bun, the codecast CLI, your agent CLIs at the
          same versions as your laptop, and a <Code>codecast-daemon</Code> service that runs
          unattended. From then on the host shows up next to your laptops. Here is the
          codecast team&apos;s own list this afternoon, one Linux host and one Mac:
        </P>

        <Terminal label="cast remote hosts">
          <Cmd>cast remote hosts</Cmd>
          {REMOTE_HOSTS}
        </Terminal>

        <P>
          <Code>cast hosts ls</Code> is the fuller picture: whether each host is awake, which
          sessions run there, every worktree on it, whether it can push, which tools are
          missing, and what it costs. Fifty-one sessions on a <Code>t3.medium</Code> for about
          four cents an hour is the number that made us stop running long jobs on laptops.
        </P>

        <Terminal label="cast hosts ls">
          <Cmd>cast hosts ls</Cmd>
          {HOSTS_LS}
        </Terminal>

        <P>
          Two rows are worth a second look. <em>orphan</em> marks a worktree whose session
          ended; a disk sweep on the host releases those once they are clean, with no stash
          and no unpushed commits, and keeps anything else with a logged reason. And the
          tools line names three MCP servers that were switched off on the host because
          they cannot run on Linux (one is a macOS app, one drives an iOS simulator), so an
          agent there gets a clear absence instead of a server that crashes on start.
        </P>

        <H2>A session starts from your screen, not from main</H2>
        <P>
          Starting work on the host is the flag you would expect. In the web composer it is
          a toggle labeled <strong>run in the cloud</strong>, with <strong>start from</strong>{" "}
          set to <strong>my checkout</strong> or <strong>origin/main</strong>. From a terminal
          or from another agent:
        </P>

        <Terminal label="starting work on the host" wrap>
          {SPAWN.split("\n").map((l) => <Cmd key={l}>{l}</Cmd>)}
        </Terminal>

        <P>
          What happens next is the part that took the longest to get right. The laptop
          takes one snapshot of your folder: a commit built through a temporary git index
          with every file in it, ignored ones included, so your own index and branch never
          move. That snapshot is pushed to the host, the host&apos;s own <Code>cast ws</Code>{" "}
          creates a worktree for each task with its own ports and its own dependency install,
          and the worktree is then reset so your uncommitted edits show up as uncommitted
          again. A tree hash comparison proves the host&apos;s folder matches yours before the
          agent starts. Any agent works: Claude Code, Codex, Cursor, Gemini, opencode, pi or
          Grok.
        </P>

        <Screenshot
          wide
          src="/blog/field-manual/cloud-spawn.webp"
          alt="Two commit graphs. Laptop: an unpushed commit and modified files captured by a temporary index into a snapshot commit. Host: the same commit with the files uncommitted again."
          caption="The snapshot carries your exact working state, and the host restores it as uncommitted work."
        />

        <P>
          Not everything should travel. Dependency folders are rebuilt on the host, because
          a <Code>node_modules</Code> built on a Mac is wrong on Linux anyway. Big untracked
          media and binaries stay home. Each file left behind is listed under the reason it
          stayed, so you can see the decision rather than discover it.
        </P>

        <Figure wide caption="What a cloud spawn carries. Tracked files always travel, whatever their size; .env files travel too, since both machines are yours.">
          <TravelFigure />
        </Figure>

        <P>
          A fan-out of five tasks takes one snapshot and makes five worktrees, so five agents
          start from the same instant of your work. <Code>--shared</Code> is the exception:
          one task, in the host&apos;s main checkout instead of a worktree, for jobs like a
          migration that must run where everything else is. It refuses a dirty checkout or
          one a live session holds, rather than trampling either. If any step fails, the
          session fails loudly. It falls back to <Code>origin/main</Code> only when your folder
          is not a git repository at all, and says so.
        </P>

        <H2>The host is set up like your laptop</H2>
        <P>
          An agent is only as good as its context, and most of the context lives outside the
          repository: <Code>~/.claude</Code>, your <Code>CLAUDE.md</Code>, the skills and hooks
          you wrote, the shell setup your hooks assume, the logins for the CLIs your agents
          call. Before any session starts, and again whenever the host wakes for one, the
          laptop brings the host into step, in this order:
        </P>

        <Figure wide caption="The host's checklist before a session starts. Every step except the disk check and the mirror is allowed to fail without blocking work.">
          <ArrivalFigure />
        </Figure>

        <P>
          The <strong>home mirror</strong> carries agent folders (<Code>.claude</Code>,{" "}
          <Code>.codex</Code>, <Code>.cursor</Code> and the rest), instruction files, your shell
          rc files and the files they source, small scripts from <Code>~/.local/bin</Code>, and
          your Claude project memory. Laptop paths are rewritten to host paths on the way. It
          is checked every minute and only sends when something changed. Memories an agent
          writes on the host are merged back into the laptop before the next push, so what a
          cloud session learns is not stranded there. Credentials, transcripts, caches,{" "}
          <Code>.ssh</Code>, keychains and browser profiles are on a denylist and never travel.
        </P>
        <P>
          <strong>Logins</strong> go one way, from the laptop to the host, and never back. The
          Claude credential is the delicate one: refreshing it would rotate the laptop&apos;s
          refresh token and log you out at home, so it is sent only while its access token is
          still live, and the host is never allowed to refresh it. It is sent again shortly
          after the laptop&apos;s token renews. Your <Code>ANTHROPIC_API_KEY</Code> deliberately
          stays home, because its presence would move every Claude on the host off your
          subscription and onto metered API billing.
        </P>
        <P>
          <strong>Tools</strong> are installed without sudo, into your user&apos;s home: agent
          CLIs at your laptop&apos;s versions, a recent Node, bun, gh, uv, and any helper
          command your hooks or skills name. What the repository itself needs goes in one
          committed file:
        </P>

        <Terminal label=".codecast/workspace.toml">
          {HOST_TOML}
        </Terminal>

        <P>
          The <Code>[host]</Code> table runs before any worktree exists, and it is skipped
          when the host is already in step, so a warm host pays one SSH round trip for it.
          A personal <Code>~/.codecast/host.toml</Code> merges in for the things that are
          yours rather than the repository&apos;s, like your shell. Every login shell on a host
          also sees <Code>CODECAST_CLOUD=1</Code>, so a hook can tell where it is running.
        </P>

        <H2>Pushing from a host without leaving a key on it</H2>
        <P>
          A machine that runs agents unattended should not hold a long-lived GitHub token.
          So git on the host asks for credentials every time it needs them, through{" "}
          <Code>cast git-credential</Code>, and codecast answers with a GitHub App
          installation token for that one repository. For a team installation it first
          checks that you are allowed to push. The token expires within the hour and is
          handed to git in memory, never written to disk.
        </P>

        <Figure wide caption="One push from the host. The token lives about as long as the push does.">
          <GitFigure />
        </Figure>

        <P>
          Two fallbacks exist for setups the App cannot cover. Each host has its own ed25519
          device key, which <Code>cast hosts key --grant</Code> adds to GitHub through your
          gh login. And <Code>cast hosts forward-agent</Code>, strictly opt-in, exposes your
          laptop&apos;s ssh-agent to the host over one held connection, for when the host must
          use exactly the keys you have.
        </P>

        <H2>The agent&apos;s edits, on your laptop, as they happen</H2>
        <P>
          A session on a host is only half useful if its work is stuck there. Pick{" "}
          <strong>Sync with MacBook-Pro</strong> in the session&apos;s machine menu, or run{" "}
          <Code>cast remote sync &lt;session&gt;</Code>, and codecast keeps a copy of the
          session&apos;s folder on your laptop, both ways, a few seconds behind. Open it in
          your editor, run the tests locally, or fix a line yourself and let the agent see it.
        </P>
        <P>
          Each tick snapshots both sides and compares them with the last tree they agreed
          on. If only one side changed, its changes land on the other. If both changed, git
          does a three-way merge in memory without touching either folder; the clean files
          land, and a file changed on both sides is held as it is on each side while
          everything else keeps flowing. Only files that actually changed are written, so
          your editor and your dev server do not see a storm of rewrites.
        </P>

        <Figure wide caption="Thirty seconds of a synced session. Ticks run every 3 s while the agent works, and pause when it goes quiet.">
          <SyncFigure />
        </Figure>

        <P>
          A held file never gets conflict markers written into it. You pick a side, from the
          menu (<strong>Keep the laptop&apos;s</strong>, <strong>Keep the cloud&apos;s</strong>)
          or with <Code>cast sync keep laptop|cloud</Code>. When the agent goes quiet, the
          sync pauses and only reads the laptop&apos;s copy every 15 seconds; a laptop edit
          is sent only if the host is already awake, so a forgotten sync never keeps a billed
          machine running. <Code>--watch-only</Code> makes it one way, from cloud to laptop,
          and if you then edit the copy anyway it stops and asks what you meant.
        </P>

        <Screenshot
          wide
          src="/blog/field-manual/cloud-mirror.webp"
          alt="The machine menu for a synced cloud session: synced both ways, one file held because it changed on both sides, and a list of what stayed on the host."
          caption="A conflict holds one file, not the sync. Heavy and machine-specific files stay on their own side."
        />

        <P>
          The verbs work from either machine: <Code>cast sync status</Code>, <Code>diff</Code>,{" "}
          <Code>pull</Code> and <Code>push</Code>, even without a running sync. From the host,{" "}
          <Code>cast sync pull ~/data/export.csv</Code> fetches a file from outside the
          repository, up to 2 GB, and <Code>--ref</Code> fetches a branch only the laptop has.
          One rule keeps the two mirrors from fighting: every file has exactly one carrier.
          Folder sync carries the working folder; the home mirror carries your agent config.
        </P>

        <H2>Moving twenty sessions before you close the lid</H2>
        <P>
          The most common reason to want a host is the moment you need your laptop back: a
          flight, a meeting, a machine pinned at full load. <Code>cast migrate</Code> moves
          running Claude Code sessions between a laptop and a host as one batch, in either
          direction, and the session continues on the other side with its transcript, its
          working tree and its place in your inbox.
        </P>

        <Terminal label="cast migrate" wrap>
          <Cmd>cast migrate start --to linux --label rollout --dry-run</Cmd>
          <Cmd>cast migrate start --to linux --label rollout</Cmd>
          <Cmd>cast migrate start --to macbook --from linux</Cmd>
        </Terminal>

        <P>
          Each row goes through the same steps. New turns are blocked first, so steady
          traffic cannot keep a session busy forever; anything you send it meanwhile is held
          and delivered on the other side. A session in the middle of a turn gets to finish
          it, up to <Code>--wait</Code> minutes (ten by default). One stopped at a permission
          prompt moves at once and asks again on the destination. Then the agent is stopped,
          the work is transferred, ownership flips in one transaction, and the session
          resumes.
        </P>

        <Figure wide caption="A batch of five, schematic. Failures restart the agent where it was; nothing is left half moved.">
          <MigrateFigure />
        </Figure>

        <P>
          Going out, the transfer reuses the spawn snapshot, plus the gitignored files and
          the transcript with its paths rewritten. Coming home, the host&apos;s work is applied
          to your checkout as uncommitted changes with a three-way merge. If it does not
          apply cleanly, the row fails with the reason and nothing in your folder changes.
          Here is our own history from the past few days, failures included:
        </P>

        <Terminal label="cast migrate ls">
          <Cmd>cast migrate ls</Cmd>
          {MIGRATE_LS}
        </Terminal>

        <P>
          The partial batches are the honest part. Their failed rows read{" "}
          <em>handoff refused: the host checkout is in use by session jx70vhm</em> and{" "}
          <em>CONFLICT: the host&apos;s changes do not apply to this folder as it is now;
          nothing was changed here</em>. In both cases the session kept running where it was.
          When a move succeeds, the agent is told, so it does not go looking for a dev server
          it left behind:
        </P>

        <Terminal label="what the agent reads after a move" wrap>
          {MOVE_NOTICE}
        </Terminal>

        <P>
          There are three other ways in. The machine chip in a session&apos;s header lists every
          machine you can use and moves the session with one click; a sleeping host reads{" "}
          <em>asleep, wakes on move</em>. <strong>Run here</strong> on a laptop brings a cloud
          session home without ever interrupting a running turn. And when your laptop is under
          sustained pressure (memory, CPU, or load at three times its core count for a minute
          or more), the Resources page offers to offload sessions and spread them for you,
          for you to review and confirm.
        </P>

        <Screenshot
          wide
          src="/blog/field-manual/film-remote.webp"
          alt="A Codex session running on a cloud host, with its browser tab, in the same inbox as the laptop's sessions."
          caption="A session on a host sits in the same inbox as everything on your laptop, browser tab and all."
        />

        <H2>Borrowing the laptop from the cloud</H2>
        <P>
          Some things only exist on your laptop, and some work needs a screen. The host has
          its own Chrome on a virtual display, so <Code>cast browser</Code> on a host drives
          that Chrome and never yours. When an agent there needs to be signed in somewhere,
          the laptop decrypts its own cookies for that one site and injects them into the
          host&apos;s browser over an SSH tunnel. Google is refused outright, requests are rate
          limited, and a request never wakes a host on its own.
        </P>

        <Terminal label="from the host, or about it" wrap>
          {BORROW.split("\n").map((l) => <Cmd key={l}>{l}</Cmd>)}
        </Terminal>

        <P>
          <Code>cast hosts vnc</Code> opens the host&apos;s whole screen inside codecast, with
          mouse and keyboard, for anything outside the agent&apos;s tab. The stream reaches your
          browser through the laptop, one SSH channel per connection, and closes ten minutes
          after the last viewer leaves. <Code>cast computer</Code>, which drives native apps
          through their accessibility tree, works on Linux hosts too, over AT-SPI on the
          virtual display.
        </P>
        <P>
          <Code>cast hosts reach ~/notes</Code> is the strangest of these and our favorite. It
          mounts a folder from your laptop on the host at the same path, with no copy. The
          laptop serves it through an <Code>sftp-server</Code> locked in a macOS sandbox that
          cannot touch the network, run programs, or read any file outside that folder, and
          the host mounts it over the SSH connection the laptop already holds. The host never
          connects to your laptop. Your home folder and anything holding keys are refused.
          When the laptop sleeps, the mount drops and leaves a note in its place.
        </P>
        <P>
          Underneath all of these is one small relay. The host writes a request to codecast,
          the laptop daemon picks it up and does the work over SSH, and the host reads the
          outcome. There is no inbound port on your laptop and no relay server holding your
          data. When both machines are on the same Tailscale network, the laptop dials the
          host&apos;s tailnet address instead of its public one.
        </P>

        <H2>Cloud Macs and iOS simulators</H2>
        <P>
          A Mac host is for work that needs Xcode. Add <Code>simulators = [&quot;iOS&quot;]</Code>{" "}
          to the <Code>[host]</Code> table and setup copies your laptop&apos;s Xcode to the host,
          downloads the iOS runtime without an Apple ID, and installs the tools{" "}
          <Code>cast sim</Code> drives. After that an agent on the Mac host runs{" "}
          <Code>cast sim acquire</Code>, installs its build, taps through it and screenshots
          it into the thread, exactly as it would on your laptop, from a pool of three
          simulators that are reaped when nobody holds them. The first Xcode copy is slow,
          close to an hour for us; it happens once.
        </P>

        <H2>It sleeps when nothing is happening</H2>
        <P>
          A host that runs all night for nothing is the fastest way to stop trusting the
          feature, so a Linux host watches for real work and stops itself without it. A
          timer checks every two minutes. Real work means an SSH session, someone watching
          the screen, an agent mid-turn, a headless <Code>claude -p</Code> or{" "}
          <Code>codex exec</Code>, a live process under an agent, or CPU moving in one. An
          agent idling at a prompt is not work. After twenty idle minutes (configurable, or
          zero to disable) the host powers off, and a stopped instance costs only its disk.
        </P>

        <Figure wide caption="Schematic, except the wake: on September 5 a queued trigger reached a stopped host's session 60 seconds later.">
          <SleepFigure />
        </Figure>

        <P>
          Waking is automatic in the common case. Work queued for a stopped host, a message
          or a trigger, marks it for waking, and the next heartbeat from a laptop that manages
          it starts the instance and waits for SSH. For a deliberately quiet job, such as a
          long download with no CPU, <Code>cast hosts keepalive 30</Code> on the host takes
          a lease that holds it awake for thirty minutes. The host&apos;s panel in Settings
          shows all of it: Awake, Waking, Going to sleep or Asleep, how long until it sleeps,
          and buttons to wake it, put it to sleep, re-apply setup, or save an image to start
          new hosts from.
        </P>

        <H2>When something breaks</H2>
        <P>
          Machines fail in boring ways, and most of the work here went into making the
          failures boring too. Every daemon, on a host or a laptop, runs a watchdog that looks
          for sessions whose agent process died mid-work. It restarts them with a note
          explaining what happened, at most three times in six hours per session, and never
          one you stopped yourself. Each host reports its readiness (mirror, logins, tools,
          setup) on its heartbeat, and the laptop collects a cost and state report every
          fifteen minutes, so the panel tells you which logins were held back and why before
          an agent finds out the hard way. A migration row that stops reporting for thirty
          minutes is failed by the server, and the session stays where it was.
        </P>

        <H2>The other clouds</H2>
        <P>
          Your host is not the only cloud your agents run in. Codecast also reads, and mostly
          drives, the cloud agents other companies run, so they land in the same inbox and the
          same search as everything else. Cursor Cloud agents appear as sessions once you add
          a Cursor key; you can launch one from the composer with <strong>run in Cursor
          Cloud</strong>, and your messages become its follow-ups. Codex Cloud tasks sync from
          your own <Code>codex login</Code> when you turn it on, with up to four attempts per
          task, a draft pull request, or the result applied to your checkout. Claude Code
          sessions you started on the web are mirrored with their full transcripts, and you can
          reply to them from codecast.
        </P>

        <Figure wide caption="Four kinds of cloud session, one inbox. Only your own host starts from your uncommitted work.">
          <CloudsTable />
        </Figure>

        <P>
          The difference is the starting point. A vendor&apos;s cloud starts from what is on
          GitHub. Your host starts from what is on your screen, which is why we built it.
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
              The cloud hosts page
            </Button>
          </Link>
        </div>

        <p className="mt-10 text-sm leading-relaxed" style={{ color: SOL.base1 }}>
          The terminal captures are genuine output from the codecast team&apos;s laptop and
          its two hosts on 2026-10-07, with the hosts&apos; public IP addresses replaced by
          documentation addresses and long lists trimmed where marked. The spawn, migrate and
          borrow blocks show commands, not their output. The 60 second wake was measured on
          2026-09-05 and is written up in the CLI&apos;s cloud workspaces doc. The figures are
          drawn from the code&apos;s own constants (tick rates, timeouts, idle minutes); the
          migration batch and the sync timeline are schematic. The three screenshots come from
          the field manual&apos;s cloud chapter.
        </p>
      </article>
    </main>
  );
}
