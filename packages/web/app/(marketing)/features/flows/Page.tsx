"use client";

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { InstallTabs } from "@/components/install-tabs";
import { SOL } from "../../blog/blogChrome";
import { FEATURE_DEEP_DIVES, featureHref } from "../catalog";
import { C, CopyCommand, ForScripts, Shot, useStillMode } from "../kit";
import "./flows.css";

// Every screenshot is the codecast web app on 2026-11-06, unretouched except
// for blurred names. The Loop, the Signals column and the Autonomy card are a
// customer team's Flows page, with its source names blurred; the Change flow
// is the standard flow from the pool; the deploy is codecast's own `cli`
// target, with one session title that names the customer blurred. Crops only.

const PERSON = SOL.blue;
const LINE = SOL.cyan;
const at = (d: number) => ({ ["--d" as string]: `${d}s` }) as CSSProperties;

/** The five stages, each a link to its section; the last returns to the first. */
const STAGES = [
  { id: "signals", n: 1, name: "Signals" },
  { id: "ways-in", n: 2, name: "Two ways in" },
  { id: "checks", n: 3, name: "Checks" },
  { id: "ship", n: 4, name: "Ship and watch" },
  { id: "back", n: 5, name: "Back to signals" },
];

function Strip() {
  return (
    <nav aria-label="The loop" className="flx-strip flx-rise" style={at(0.3)}>
      <ol>
        {STAGES.map((s) => (
          <li key={s.id}>
            <a href={`#${s.id}`}>
              <span className="flx-n">{s.n}</span>
              {s.name}
            </a>
          </li>
        ))}
      </ol>
      <div className="flx-return" aria-hidden><span>production becomes the next signal</span></div>
    </nav>
  );
}

function Section({ id, n, title, lede, children, tone = "plain" }: { id: string; n?: number; title: string; lede: ReactNode; children?: ReactNode; tone?: "plain" | "paper" }) {
  return (
    <section id={id} className="scroll-mt-20" style={{ backgroundColor: tone === "paper" ? "#fffaf0" : SOL.base3 }}>
      <div className="max-w-6xl mx-auto px-5 sm:px-8 py-16 sm:py-20">
        <div className="max-w-3xl">
          {n ? <div className="font-mono text-[13px] font-semibold" style={{ color: SOL.base1 }}>{n} / 5</div> : null}
          <h2 className="mt-2 font-mono font-bold text-[26px] sm:text-[34px] leading-[1.15] tracking-[-0.03em]" style={{ color: SOL.base03 }}>{title}</h2>
          <div className="flx-prose mt-5 text-[16px] sm:text-[17px] leading-[1.7]" style={{ color: SOL.base01 }}>{lede}</div>
        </div>
        {children ? <div className="mt-10">{children}</div> : null}
      </div>
    </section>
  );
}

/** A wide screenshot that a phone scrolls sideways at a readable size instead of shrinking it to nothing. */
function WideShot({ caption, ...shot }: Parameters<typeof Shot>[0]) {
  return (
    <div>
      <div className="flx-wide"><Shot {...shot} /></div>
      {caption ? <p className="mt-3 text-[13px] leading-6" style={{ color: SOL.base00 }}>{caption}</p> : null}
    </div>
  );
}

/** A count as the app draws it: a person's wait in blue, the line's work in cyan. */
function Mark({ tone, children }: { tone: "person" | "line"; children: ReactNode }) {
  const c = tone === "person" ? PERSON : LINE;
  return <span className="flx-mark" style={{ color: c, backgroundColor: `color-mix(in srgb, ${c} 11%, transparent)` }}>{children}</span>;
}

const RELATED: { slug: string; why: string }[] = [
  { slug: "decisions", why: "A step where a person decides lands in the same queue as every other call that waits on you." },
  { slug: "pull-requests", why: "A change on its way to Land can be a pull request whose session answers its own review." },
  { slug: "triggers", why: "The session that shipped a change can arm a follow-up that checks on it once the deploy is live." },
  { slug: "memory", why: "Every change on the loop links back to the session that wrote it, and the reasoning stays searchable." },
];

export default function FlowsPage() {
  const still = useStillMode();
  return (
    <main className="flx-root" data-static={still ? "" : undefined} style={{ backgroundColor: SOL.base3 }}>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20 pb-14">
          <div className="flx-rise inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[12px]" style={{ ...at(0), borderColor: "rgba(42,161,152,0.35)", color: SOL.cyan, backgroundColor: "rgba(42,161,152,0.07)" }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: SOL.cyan }} />
            Flows in codecast
          </div>
          <h1 className="flx-rise mt-5 max-w-4xl font-mono text-[34px] leading-[1.08] sm:text-[50px] lg:text-[58px] font-bold tracking-[-0.03em]" style={{ ...at(0.08), color: SOL.base03 }}>
            Every change takes the same path to production
          </h1>
          <p className="flx-rise mt-6 max-w-2xl text-[17px] sm:text-[19px] leading-[1.6]" style={{ ...at(0.16), color: SOL.base01 }}>
            Whether you wrote the change in your own session or an agent picked it up from an error report, it passes
            the same checks, lands and deploys the same way, and is watched in production afterwards. When something breaks,
            the fix is traced back to the change that caused it, and that record decides how much an agent may merge without you.
          </p>
          <Strip />
        </div>
        <div className="max-w-7xl mx-auto px-3 sm:px-8 pb-16 sm:pb-24 flx-rise" style={at(0.4)}>
          <WideShot
            eager
            src="/features/flows/loop.webp"
            width={2114}
            height={1053}
            alt="The Flows page's Loop view. Across the top, five rules: Sources to watch (25 feeding, 9 silent, 1 not filed), Goals and owners (17 owners, 20 projects), Skills (10 prompts), Review and gates (2 checks, 1 person gate) and Autonomy (8 of 17 roles merge without a person, with regret-free rates). Under them five stages: Signals with 2,276 signals today across six sources (their names blurred); a person's session shipping through a flow and the line triaging and building; the same checks Check, Review and Decide; Land, Deploy and Watch; and a bar along the foot, Back to signals, with 2 regressed and 2 reopened by a finding"
            caption={<>The <b>Loop</b> on the <b>Flows</b> page of a team running the line, as it stood on November 6. Blue counts wait on a person; each opens where you answer it. Source names are blurred.</>}
          />
        </div>
      </section>

      <Section
        id="signals"
        n={1}
        tone="paper"
        title="Signals come in from what you chose to watch"
        lede={
          <>
            <p>
              A signal is anything that says something may be wrong or wanted: an error from production, a failed job, a
              conversation a reviewer flagged, a check that runs against live data. You pick the sources under <b>Sources to watch</b>,
              and the <b>Signals</b> column counts what each one sent today. A source that has gone quiet turns red, so a broken
              feed does not pass for a calm day.
            </p>
            <p>
              Signals are filed into problems. <b>Triage</b> shows how many problems are open and how many are queued for the
              line, and the line takes from that queue when it has a free slot.
            </p>
          </>
        }
      >
        <Shot
          src="/features/flows/signals.webp"
          width={1382}
          height={650}
          className="max-w-xl"
          alt="The Signals column of the Loop: 2,276 signals today across six sources, with the source names blurred and counts of 2023, 112, 58, 27, 18 and 12"
          caption={<>Today&apos;s signals by source on the same team&apos;s Loop. The team&apos;s own source names are blurred.</>}
        />
      </Section>

      <Section
        id="ways-in"
        n={2}
        title="Two ways in: your session, or the line"
        lede={
          <>
            <p>
              Most changes still start with a person. You work in a session, and when the change is ready you send it through
              a flow: <b>Change</b> is the standard one. The other way in is the line: agents working for a role take problems
              from triage, build the fix and send it through the flow that role owns.
            </p>
            <p>
              The Loop draws both lanes side by side with what is in each right now: <Mark tone="line">9 running</Mark> on
              the line, and <Mark tone="person">10 on a person</Mark> where a run has stopped at a step that needs someone.
              That blue count opens <b>For you</b>, where each waiting step is a card you can answer.
            </p>
          </>
        }
      />

      <Section
        id="checks"
        n={3}
        tone="paper"
        title="The same checks for every change, and you decide where it matters"
        lede={
          <>
            <p>
              Both lanes meet at the same checks. In the Change flow that is <b>Check</b>, which runs your project&apos;s own
              check command on the change; <b>Review</b>, where an agent reads the diff; and <b>Decide</b>, where a person says
              ship, revise or drop. A change written by hand gets no lighter treatment than one an agent wrote overnight.
            </p>
            <p>
              Every flow drawing marks the steps where a person decides in blue. Each step&apos;s ways out are drawn under it:
              a failed check or a requested change goes back to the session that wrote it, and a rejection ends the run.
            </p>
          </>
        }
      >
        <WideShot
          src="/features/flows/flow.webp"
          width={1565}
          height={287}
          alt="The Change flow drawn in codecast: Session, then Check, Review, Decide, Land (2 steps), Deploy and Live. Decide is blue with a person icon. Under the steps, their ways out: Checks failed, Changes asked and Revise loop back to the session; Rejected, Dropped, Not shipped and Deploy failed end the run; Land also shows Already landed and Conflict"
          caption={<>The <b>Change</b> flow. <b>Decide</b> is the step a person answers; the purple ways out return the change to the session that wrote it.</>}
        />
      </Section>

      <Section
        id="ship"
        n={4}
        title="Ship and watch"
        lede={
          <>
            <p>
              A change that passes lands on main, then goes out with the next deploy of each place it touches. The <b>Deploys</b> page
              shows every target with what is live, what is waiting on main and why, and a history where each deploy lists the
              changes it carried, grouped by the session or task that made them. Fix commits sit in that list with the session that
              wrote them, one click away.
            </p>
            <p>
              When the line fixes a problem, its run waits for the deploy that carries the fix to go live, then stays open
              in <b>Watch</b> until the problem has stayed quiet for a while. A fix is done when production agrees, not when it
              merges.
            </p>
          </>
        }
      >
        <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-10 items-start">
          <Shot
            src="/features/flows/deploy.webp"
            width={948}
            height={1542}
            alt="The Deploys page for codecast's cli target: live at cc5ffb7, version 1.1.213, with a Deploy 2 commits button and CI passed. Waiting on main: one commit from Line placement agent check, fix(line): place no run on a machine that cannot start, and a version bump. History: dp-371 live now, and dp-352 open, sent from 688578e to 0497294 for version 1.1.212, with its task ct-85426 and its changes grouped by session: Ship main checkout, one session with its title blurred, Deploy carry backfill, CI failure fixes and GitHub PR review and merge, several of them fix commits"
            caption={<>Codecast&apos;s own <C>cli</C> target. <b>dp-352</b> carried fixes from five sessions, each group named for the session that wrote it.</>}
          />
          <div className="flx-prose text-[16px] leading-[1.7]" style={{ color: SOL.base01 }}>
            <h3 className="font-mono font-bold text-[18px]" style={{ color: SOL.base02 }}>What the Loop counts here</h3>
            <p>
              <b>Land</b> counts changes waiting to merge. <b>Deploy</b> counts what is going out now, what went live today and
              what failed. <b>Watch</b> counts changes inside their window. A failed deploy is red on the Loop and opens the
              target with its log.
            </p>
            <h3 className="mt-8 font-mono font-bold text-[18px]" style={{ color: SOL.base02 }}>A target per place</h3>
            <p>
              Each deploy target says what it ships (web, backend, a mobile build, a CLI) and when: on every push to main, or
              on a press. A press is one button with the commits it will carry listed above it.
            </p>
          </div>
        </div>
      </Section>

      <Section
        id="back"
        n={5}
        tone="paper"
        title="Production comes back as the next signal"
        lede={
          <>
            <p>
              Every night codecast reads what landed on main. For each fix, it finds the earlier commit whose lines the fix had to
              change, and records the fix against that change. The Loop&apos;s foot counts what came back this way: changes that
              <b> regressed</b>, and problems <b>reopened by a finding</b> after their fix shipped.
            </p>
            <p>
              A regression is a signal like any other. It goes through triage and takes the same path, and the record of which
              change caused it stays attached to both.
            </p>
          </>
        }
      />

      <Section
        id="autonomy"
        title="Autonomy is earned by a measured rate"
        lede={
          <>
            <p>
              A change is <b>regret-free</b> if no fix traced back to it inside its window. The window is measured from your own
              history: long enough to cover three quarters of the time your fixes have taken to arrive, and at most 30 days. Once a
              change&apos;s window closes it is <b>settled</b>, and the rate is the share of settled changes that stayed regret-free.
            </p>
            <p>
              The <b>Autonomy</b> rule on the Loop shows that rate three ways: changes the line made, changes a person sent through
              a flow, and changes that went through no flow at all. Each rate carries its sample, so a rate with nothing settled says
              so instead of showing a number it has not earned. Each check shows how often a change it passed came back.
            </p>
            <p>
              In a role&apos;s settings, its merge step decides on a <b>Count</b> (a daily limit) or on its <b>Rate</b>. On Rate, the
              role merges without a person only while its own line changes hold the bar you set, over at least the number of
              settled changes you require. Short of either, it does not merge and says which one it missed. Only a person can switch a role to
              Rate, and every change of that setting is logged.
            </p>
          </>
        }
      >
        <div className="grid sm:grid-cols-[minmax(0,340px)_minmax(0,1fr)] gap-8 items-center">
          <Shot
            className="max-w-[340px]"
            src="/features/flows/autonomy.webp"
            width={680}
            height={520}
            alt="The Autonomy rule on the Loop: 8 of 17 roles merge without a person. Regret-free, 6-day window: Line 10, none settled; Person 8, none settled; No flow 91% of 2,785"
          />
          <div className="flx-prose text-[15.5px] leading-[1.7]" style={{ color: SOL.base01 }}>
            <p>
              The same team on November 6. Its line has merged 10 changes and none has settled yet, so the line has no rate
              yet, and no role can merge on it. Of the 2,785 settled changes that went through no flow at all,
              91% stayed regret-free.
            </p>
            <p><b>8 of 17</b> counts the roles that own a flow and how many of them have merging switched on.</p>
          </div>
        </div>
        <div className="mt-12 max-w-3xl">
          <ForScripts note={<>Agents send their own finished work through a flow from the session, and read a flow&apos;s steps before they do.</>}>
            <div className="flex flex-col gap-2">
              <CopyCommand cmd="cast flow run change" />
              <CopyCommand cmd="cast flow show change" />
            </div>
          </ForScripts>
        </div>
      </Section>

      <section style={{ backgroundColor: SOL.base3 }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 pb-20">
          <h2 className="font-mono font-bold text-[24px] sm:text-[28px] tracking-[-0.03em] mb-8" style={{ color: SOL.base03 }}>Related features</h2>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {RELATED.map(({ slug, why }) => {
              const f = FEATURE_DEEP_DIVES.find((x) => x.slug === slug);
              if (!f) return null;
              return (
                <Link key={slug} href={featureHref(slug)} className="group rounded-xl border p-5 transition-colors hover:bg-[rgba(238,232,213,.5)]" style={{ borderColor: "rgba(88,110,117,.2)" }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: f.color }} />
                    <span className="font-mono font-bold text-[15px] group-hover:underline underline-offset-4" style={{ color: SOL.base02 }}>{f.name}</span>
                  </div>
                  <p className="text-[14px] leading-6" style={{ color: SOL.base01 }}>{why}</p>
                </Link>
              );
            })}
          </div>
        </div>
      </section>

      <section id="install" className="scroll-mt-20" style={{ backgroundColor: SOL.base03 }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 py-20 sm:py-24 grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-10 items-center">
          <div>
            <h2 className="font-mono font-bold text-[28px] sm:text-[36px] leading-[1.12] tracking-[-0.03em]" style={{ color: SOL.base3 }}>
              Get started with flows
            </h2>
            <p className="mt-5 text-[16px] leading-7 max-w-lg" style={{ color: SOL.base1 }}>
              Install codecast and open <b style={{ color: SOL.base2 }}>Flows</b> in your workspace. The <b style={{ color: SOL.base2 }}>Library</b> holds
              the standard flows; the next change you finish in a session can go through <b style={{ color: SOL.base2 }}>Change</b>, and the Loop
              fills in as your team&apos;s work moves through it.
            </p>
          </div>
          <div className="rounded-xl p-5 sm:p-6" style={{ backgroundColor: SOL.base3 }}>
            <InstallTabs location="feature-flows" />
          </div>
        </div>
      </section>
    </main>
  );
}
