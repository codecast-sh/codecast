"use client";

import Link from "next/link";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { featureHref, featureDeepDives } from "../catalog";
import { CLOUD_CSS } from "./motion";
import { BLUE, C, Caption, Note, Section, delay } from "./kit";
import { HeroDiptych } from "./Hero";
import { SpawnSection } from "./Spawn";
import { ManifestSection } from "./Manifest";
import { MirrorSection } from "./Mirror";
import { MigrateSection } from "./Migrate";
import { BrowserSection, HostSetupSection, SleepSection } from "./Host";
import { Shot, useStillMode } from "../kit";

const REFERENCE: { group: string; rows: [string, string][] }[] = [
  {
    group: "Start work on the host",
    rows: [
      ['cast spawn --cloud "<task>" …', "One worktree per task, from this checkout"],
      ["  --from origin-main", "Start clean instead"],
      ["  --shared", "The host's main checkout, one task"],
      ['cast fork --cloud "<dir>" …', "Branches on the host, yours stays here"],
    ],
  },
  {
    group: "Mirror and move",
    rows: [
      ["cast remote sync <session>", "Keep its folder in step with a laptop copy"],
      ["cast sync status | pull | push | diff", "From the host: what differs, fetch, send"],
      ["cast remote move | back <session>", "One live session there, or home"],
      ["cast migrate start --to <device> …", "Many sessions as one batch"],
      ["  --dry-run  --wait <min>", "Plan only; how long a turn may finish"],
      ["cast migrate ls | show | cancel | retry", "Batches, row by row"],
    ],
  },
  {
    group: "The hosts",
    rows: [
      ["cast remote hosts", "Configured hosts and this device's id"],
      ["cast hosts ls", "State, sessions, worktrees, git access, cost"],
      ["cast hosts create linux | mac", "Launch an EC2 instance and set it up"],
      ["cast hosts add <instance-id> --provision", "Register one you already run"],
      ["cast hosts wake | sleep [id]", "Boot it, or stop it costing money"],
      ["cast hosts setup | image [id]", "Apply [host]; save a ready host"],
      ["cast hosts tools [id]", "Check and install the CLIs and runtimes the host needs"],
      ["cast hosts sync --dry-run", "What the config mirror would send"],
      ["cast hosts vnc [id]", "The whole screen, in codecast"],
    ],
  },
  {
    group: "On the host",
    rows: [
      ["cast browser sync <site>", "Borrow one site's login from your laptop"],
      ["cast hosts keepalive <minutes>", "Stay awake for a quiet job"],
      ["cast ws acquire <name>", "The worktree a cloud task runs in; the host runs it for you"],
    ],
  },
];

const LIMITS: { q: string; a: React.ReactNode }[] = [
  { q: "Where can a host run?", a: <>On AWS: Ubuntu 24.04 or macOS EC2 instances, new or ones you already run. Settings, Devices, Add a cloud machine builds the setup command (<C>cast hosts create</C> or <C>cast hosts add</C>), and running it needs AWS credentials and an SSH key on the laptop.</> },
  { q: "What does it cost?", a: <>Whatever AWS charges you; the host is yours. Linux hosts stop themselves when idle and then cost only their disk. A Mac sits on a dedicated host with a 24 hour minimum, billed while stopped.</> },
  { q: "Which sessions can migrate?", a: <>Claude Code sessions with a transcript. Other agents, subagents (they move with their parent), ended or killed sessions are skipped with the reason. Moving straight from one cloud host to another is not supported.</> },
  { q: "Does my laptop need to be on?", a: <>For starting and moving work, yes: preparation and transfers run from a laptop daemon over SSH, and the machine holding a session&apos;s files must be online to move it. A running session keeps going with the lid closed. Waking a host for a trigger with every laptop closed needs the backend operator to allowlist it.</> },
  { q: "Can the host open pull requests?", a: <>It pushes with a one-hour GitHub App token scoped to one repo and contents write, so fetch and push work. Calls that need more, like opening a PR, answer 403 unless you log in with <C>gh auth login</C> on the host or grant the device key.</> },
  { q: "What if a mid-turn session never finishes?", a: <>After the wait you chose under Sessions mid-turn in Migration (<C>--wait</C> from the CLI, 10 minutes by default), the turn is interrupted and the row says so. A session stopped at a permission prompt moves at once, and the prompt asks again on the destination. A runner that dies leaves a fence the server lifts after 30 minutes.</> },
];

const RELATED = ["agents", "browser", "triggers", "computer"];

/** The new-session composer with a cloud host picked: the switches and the machine pill. */
function ComposerShot() {
  return (
    <div className="cl-anim cl-rise min-w-0 hidden sm:block" style={delay(0.3)}>
      <Shot dark eager src="/features/cloud/composer-cloud.webp" alt="The new-session composer: isolated worktree and run in the cloud switched on, start from my checkout, and the machine pill reading Cloud Linux" width={1252} height={252} />
      <p className="mt-3 font-mono text-[12px] leading-5" style={{ color: SOL.base1 }}>Starting a session: switch on run in the cloud, pick what it starts from, and the machine pill names the host it will run on.</p>
    </div>
  );
}

/** Settings, Devices: a host's card, and the dialog that adds one. */
function HostsSection() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_1fr] gap-8 items-start">
      <div className="min-w-0">
        <Shot dark src="/features/cloud/devices-host.webp" alt="A cloud host's card in Settings, Devices: Awake, t3.medium in us-west-2 at $0.042 an hour, rows for Your setup, Logins, Tools and Host setup, and the Sleep, Apply setup now and Save image buttons" width={1412} height={756} />
        <Caption dark>A Linux host, awake. Yellow rows say what is off and how to fix it: here, logins held back because their tokens expired on the laptop, and tools a hook needs that cannot run on Linux.</Caption>
        <div className="mt-8 space-y-5">
          <Note dark>
            <b style={{ color: SOL.base2 }}>Wake and Sleep</b> boot the host or stop it costing compute. <b style={{ color: SOL.base2 }}>Apply setup now</b> installs the packages and services your repo declares, and <b style={{ color: SOL.base2 }}>Save image</b> snapshots the machine so the next one starts ready. Your laptop carries each one out, so it needs to be online.
          </Note>
          <Note dark>
            A host also shows up wherever you pick a machine: the machine pill in a new session, the machine menu in a session&apos;s header, and Migration in the same settings group.
          </Note>
        </div>
      </div>
      <div className="min-w-0">
        <Shot dark src="/features/cloud/add-cloud-machine.webp" alt="The Add a cloud machine dialog: Linux or Mac, Connect existing or Create new, the instance, region and SSH key fields, and the setup command it builds with a Copy setup command button" width={1168} height={1330} />
        <Caption dark>Add a cloud machine, at the foot of the Machines list.</Caption>
        <Note dark className="mt-5">
          Choose Linux or Mac, then connect an EC2 instance you already run or create a new one. The dialog builds the setup command and <b style={{ color: SOL.base2 }}>Copy setup command</b> puts it on your clipboard. You run it once in a terminal on your laptop, because setup uses your AWS sign-in and SSH key; that one step has no button today.
        </Note>
      </div>
    </div>
  );
}

function Hero() {
  return (
    <section className="cl-paper">
      <div className="max-w-6xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20 pb-6 lg:pb-10 grid lg:grid-cols-[1.45fr_1fr] gap-x-14 gap-y-10 items-end">
        <div className="lg:col-span-2">
          <h1 className="cl-anim cl-rise font-mono font-bold text-[34px] sm:text-[48px] lg:text-[54px] leading-[1.04] tracking-[-0.045em] [text-wrap:balance] max-w-5xl" style={{ color: SOL.base03 }}>
            Start it on your laptop. Let it run on your own cloud box.
          </h1>
        </div>
        <div>
          <p className="cl-anim cl-rise text-[18px] sm:text-[19px] leading-8 max-w-2xl" style={delay(0.1, { color: SOL.base01 })}>
            Switch on run in the cloud when you start a session, and it runs on your own host from the checkout you are in, uncommitted work included. It arrives with your agent config, logins and CLIs. Its edits mirror back to your laptop as they happen, and whole batches of sessions move between the two without losing a message.
          </p>
          <div className="cl-anim cl-rise mt-8 flex flex-wrap items-center gap-3" style={delay(0.2)}>
            <a href="#hosts" className="font-mono text-[14px] px-4 py-2.5 rounded-lg" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
              Add a host
            </a>
            <Link href="/documentation/remote-and-cloud-sessions" className="font-mono text-[14px] px-2 py-2.5 underline underline-offset-4" style={{ color: BLUE }}>Read the guide</Link>
          </div>
        </div>
        <ComposerShot />
      </div>
      <HeroDiptych />
    </section>
  );
}

export default function CloudPage() {
  const still = useStillMode();
  const related = featureDeepDives(RELATED);

  return (
    <main className="cl-root" data-static={still ? "" : undefined} style={{ backgroundColor: SOL.base3 }}>
      <style>{CLOUD_CSS}</style>
      <Hero />

      <Section
        id="hosts"
        tone="night"
        route="host"
        title="Your hosts sit in Settings, under Devices"
        lede={<>Each cloud host has a card in the Machines list there: whether it is awake, what it costs, and whether it carries your setup, logins and tools, with the buttons that fix what is off.</>}
      >
        <HostsSection />
      </Section>

      <Section
        id="spawn"
        route="out"
        title="It starts from what is on your screen, not from main"
        lede={<>Your branch, your unpushed commits and your uncommitted, untracked and gitignored files all travel. Dependency and build folders are rebuilt on the host. The laptop takes the snapshot with a temporary index, so nothing in your checkout moves.</>}
      >
        <SpawnSection />
      </Section>

      <Section
        id="manifest"
        tone="night"
        route="out"
        title="The host is set up like your laptop, minus the secrets it should not hold"
        lede={<>Before a session starts, the host gets your agent config, shell, logins and CLIs. Each kind of thing travels its own way and stops at a line you can read.</>}
      >
        <ManifestSection />
      </Section>

      <Section
        id="mirror"
        route="back"
        title="Read, run and test the agent's edits on your laptop"
        lede={<>A synced cloud session keeps a copy of its folder on your laptop, both ways, a few seconds behind. Open it in your editor, run the tests locally, or fix a line yourself and let the agent see it.</>}
      >
        <MirrorSection />
      </Section>

      <Section
        id="migrate"
        tone="sand"
        route="both"
        title="Move twenty sessions before you close the lid"
        lede={<>Settings, Migration moves sessions between laptop and host as one batch: pick a destination, tick the sessions, press Move. A session in the middle of a turn finishes it first, and messages sent while it moves are held and delivered on the other side.</>}
      >
        <MigrateSection />
      </Section>

      <Section
        id="host-setup"
        route="host"
        title="Whatever else the repo needs, declared once"
        lede={<>A database, a service, a seed script: the <C>[host]</C> table in <C>.codecast/workspace.toml</C> holds it, and every host applies it before any worktree exists.</>}
      >
        <HostSetupSection />
      </Section>

      <Section
        id="browser"
        tone="night"
        route="back"
        title="A browser on a machine with no screen of yours"
        lede={<>Agents on the host verify UI and read behind sign-ins in the host&apos;s own Chrome, borrowing logins from your laptop one site at a time.</>}
      >
        <BrowserSection />
      </Section>

      <Section
        id="sleep"
        route="host"
        title="It sleeps when nothing is happening"
        lede={<>A host costs money while it runs, so it looks for real work before it stops and wakes when work is queued for it.</>}
      >
        <SleepSection />
      </Section>

      <Section id="reference" tone="sand" route="both" title="For scripts and agents" lede={<>Everything above also has a command, which is what agents run and what you script. Registering a host is only a command today, built for you by Add a cloud machine. <C>cast &lt;command&gt; --help</C> has the full flags.</>}>
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: "#e3dcc6", backgroundColor: SOL.base3 }}>
          {REFERENCE.map((g, gi) => (
            <div key={g.group}>
              <div className={`px-5 py-2.5 font-mono text-[12px] font-semibold ${gi ? "border-t" : ""}`} style={{ color: BLUE, borderColor: "#e3dcc6", backgroundColor: "#f6efda" }}>{g.group}</div>
              <ul>
                {g.rows.map(([cmd, what]) => (
                  <li key={cmd} className="cl-row px-5 py-2.5 grid sm:grid-cols-[minmax(0,1.15fr)_1fr] gap-x-6 gap-y-0.5 border-t" style={{ borderColor: "#f1ead6" }}>
                    <code className="font-mono text-[12.5px] overflow-x-auto" style={{ color: cmd.startsWith("  ") ? SOL.base01 : SOL.base02 }}>{cmd}</code>
                    <span className="text-[13.5px]" style={{ color: SOL.base01 }}>{what}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section id="limits" route="host" title="What it needs, and where it stops" lede={<>The honest version, so nothing surprises you on the first run.</>}>
        <div className="grid md:grid-cols-2 gap-x-10 gap-y-8">
          {LIMITS.map((l) => (
            <div key={l.q}>
              <h3 className="font-mono font-semibold text-[16px]" style={{ color: SOL.base03 }}>{l.q}</h3>
              <p className="mt-2 text-[15px] leading-7" style={{ color: SOL.base01 }}>{l.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <section style={{ backgroundColor: SOL.base2 }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16">
          <div className="font-mono text-[13px] mb-5" style={{ color: SOL.base01 }}>Works with</div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {related.map((f) => (
              <Link key={f.slug} href={featureHref(f.slug)} className="cl-lift block rounded-xl border p-5" style={{ borderColor: "#e3dcc6", backgroundColor: SOL.base3 }}>
                <div className="font-mono font-semibold text-[14.5px]" style={{ color: f.color }}>{f.name}</div>
                <p className="mt-2 text-[13.5px] leading-6" style={{ color: SOL.base01 }}>{f.dek}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section id="install" className="cl-night scroll-mt-20">
        <div className="max-w-3xl mx-auto px-5 sm:px-8 py-20 sm:py-24">
          <h2 className="font-mono font-bold text-[28px] sm:text-[38px] leading-[1.12] tracking-[-0.03em]" style={{ color: SOL.base2 }}>
            Install on the laptop. Add a host when you want one.
          </h2>
          <p className="mt-4 text-[17px] leading-8" style={{ color: SOL.base1 }}>
            Codecast runs on your laptop first. When you are ready for a host, open Settings, Devices, Add a cloud machine: it builds the one command that sets the host up, and you run it on your laptop.
          </p>
          <div className="mt-8 font-mono text-[12px] mb-2" style={{ color: SOL.base01 }}>1 · on your laptop</div>
          <InstallTabs location="feature-cloud" />
          <div className="mt-8 font-mono text-[12px] mb-2" style={{ color: SOL.base01 }}>2 · when you want a host, the command Add a cloud machine builds looks like this</div>
          <pre className="rounded-xl border px-4 py-3 font-mono text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ borderColor: "#0b4a5a", backgroundColor: "#01232c", color: SOL.base2 }}>
            <span style={{ color: SOL.green }}>$</span> cast hosts add i-0123456789abcdef0 --provision {"\\"}{"\n"}{"    "}--region us-west-2 --key ~/.ssh/dev.pem
          </pre>
        </div>
      </section>
    </main>
  );
}
