"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { FEATURE_DEEP_DIVES, featureHref } from "../catalog";
import { CLOUD_CSS } from "./motion";
import { BLUE, C, Out, P$, Section, Term, delay } from "./kit";
import { HeroDiptych } from "./Hero";
import { SpawnSection } from "./Spawn";
import { ManifestSection } from "./Manifest";
import { MirrorSection } from "./Mirror";
import { MigrateSection } from "./Migrate";
import { BrowserSection, HostSetupSection, SleepSection } from "./Host";

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
      ["cast hosts sync --dry-run", "What the config mirror would send"],
      ["cast hosts vnc [id]", "The whole screen, in codecast"],
    ],
  },
  {
    group: "On the host",
    rows: [
      ["cast browser sync <site>", "Borrow one site's login from your laptop"],
      ["cast hosts keepalive <minutes>", "Stay awake for a quiet job"],
      ["cast ws acquire <name>", "The worktree each cloud task runs in"],
    ],
  },
];

const LIMITS: { q: string; a: React.ReactNode }[] = [
  { q: "Where can a host run?", a: <>On AWS. <C>cast hosts create</C> launches Ubuntu 24.04 or macOS EC2 instances, and <C>cast hosts add</C> registers one you already run. You need AWS credentials and an SSH key on the laptop; Settings, Machines, Add a cloud machine builds the command for you.</> },
  { q: "What does it cost?", a: <>Whatever AWS charges you; the host is yours. Linux hosts stop themselves when idle and then cost only their disk. A Mac sits on a dedicated host with a 24 hour minimum, billed while stopped.</> },
  { q: "Which sessions can migrate?", a: <>Claude Code sessions with a transcript. Other agents, subagents (they move with their parent), ended or killed sessions are skipped with the reason. Moving straight from one cloud host to another is not supported.</> },
  { q: "Does my laptop need to be on?", a: <>For starting and moving work, yes: preparation and transfers run from a laptop daemon over SSH, and the machine holding a session&apos;s files must be online to move it. A running session keeps going with the lid closed. Waking a host for a trigger with every laptop closed needs the backend operator to allowlist it.</> },
  { q: "Can the host open pull requests?", a: <>It pushes with a one-hour GitHub App token scoped to one repo and contents write, so fetch and push work. Calls that need more, like opening a PR, answer 403 unless you log in with <C>gh auth login</C> on the host or grant the device key.</> },
  { q: "What if a mid-turn session never finishes?", a: <>After <C>--wait</C> minutes (10 by default) the turn is interrupted and the row says so. A session stopped at a permission prompt moves at once, and the prompt asks again on the destination. A runner that dies leaves a fence the server lifts after 30 minutes.</> },
];

const RELATED = ["agents", "browser", "triggers", "computer"];

/** `cast remote hosts`: the machines this laptop can send work to. */
function HostsCard() {
  return (
    <div className="cl-anim cl-rise min-w-0 hidden sm:block" style={delay(0.3)}>
      <Term machine="laptop" label="your laptop">
        <P$>cast remote hosts</P$>
        <Out>this device: macOS - MacBook-Pro  <span style={{ color: SOL.base1 }}>(76e7d3d6)</span></Out>
        <Out>{"  "}<span style={{ color: SOL.base02 }}>i-0843c56a91e15ff</span>  ubuntu@203.0.113.24  aws <span style={{ color: SOL.green }}>running</span></Out>
        <Out>{"  "}<span style={{ color: SOL.base02 }}>i-021a2d254c07d3e</span>  ec2-user@203.0.113.80  aws <span style={{ color: SOL.base1 }}>stopped</span></Out>
      </Term>
      <p className="mt-3 font-mono text-[12px] leading-5" style={{ color: SOL.base1 }}>Linux or Mac, on your own AWS account. A stopped host wakes when work is sent to it.</p>
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
            <C>--cloud</C> sends a session to your host from the checkout you are in, uncommitted work included. It arrives with your agent config, logins and CLIs. Its edits mirror back to your laptop as they happen, and whole batches of sessions move between the two without losing a message.
          </p>
          <div className="cl-anim cl-rise mt-8 flex flex-wrap items-center gap-3" style={delay(0.2)}>
            <code className="font-mono text-[14px] px-4 py-2.5 rounded-lg" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>
              <span style={{ color: SOL.green }}>$</span> cast spawn --cloud &quot;port the v1 routes&quot;
            </code>
            <Link href="/documentation/remote-and-cloud-sessions" className="font-mono text-[14px] px-2 py-2.5 underline underline-offset-4" style={{ color: BLUE }}>Read the guide</Link>
          </div>
        </div>
        <HostsCard />
      </div>
      <HeroDiptych />
    </section>
  );
}

export default function CloudPage() {
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("static")) setStill(true);
  }, []);
  const related = RELATED.map((s) => FEATURE_DEEP_DIVES.find((f) => f.slug === s)).filter((f): f is NonNullable<typeof f> => !!f);

  return (
    <main className="cl-root" data-static={still ? "" : undefined} style={{ backgroundColor: SOL.base3 }}>
      <style>{CLOUD_CSS}</style>
      <Hero />

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
        lede={<><C>cast migrate</C> moves sessions between laptop and host as one batch. A session in the middle of a turn finishes it first, and messages sent while it moves are held and delivered on the other side.</>}
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

      <Section id="reference" tone="sand" route="both" title="Command reference" lede={<>Every command here is in the CLI today. <C>cast &lt;command&gt; --help</C> has the full flags.</>}>
        <div className="grid md:grid-cols-2 gap-6">
          {REFERENCE.map((g) => (
            <div key={g.group} className="rounded-xl border overflow-hidden" style={{ borderColor: "#e3dcc6", backgroundColor: SOL.base3 }}>
              <div className="px-5 py-3 font-mono text-[13px] font-semibold border-b" style={{ color: SOL.base02, borderColor: "#e3dcc6" }}>{g.group}</div>
              <ul>
                {g.rows.map(([cmd, what]) => (
                  <li key={cmd} className="cl-row px-5 py-2.5 grid sm:grid-cols-[1.25fr_1fr] gap-x-4 gap-y-0.5 border-b last:border-b-0" style={{ borderColor: "#f1ead6" }}>
                    <code className="font-mono text-[12.5px] whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ color: cmd.startsWith("  ") ? SOL.base01 : SOL.base02 }}>{cmd}</code>
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
            Codecast runs on your laptop first. When you are ready for a host, Settings, Machines, Add a cloud machine builds the one command that sets it up.
          </p>
          <div className="mt-8"><InstallTabs location="feature-cloud" /></div>
        </div>
      </section>
    </main>
  );
}
