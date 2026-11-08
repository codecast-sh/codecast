"use client";

import Link from "next/link";
import { useState } from "react";
import { InstallTabs } from "@/components/install-tabs";
import { useMountEffect } from "@/hooks/useMountEffect";
import { SOL } from "../../blog/blogChrome";
import { FEATURE_DEEP_DIVES, featureHref } from "../catalog";
import { Hero, HeroReprise } from "./Hero";
import { SignalsSection, WaysInSection } from "./Signals";
import { ChangeRunSection } from "./ChangeRun";
import { ShipSection, TraceSection } from "./ShipTrace";
import { AutonomySection, RateSection } from "./Autonomy";
import { LibrarySection } from "./Library";
import { CopyCommand, Label } from "./kit";
import { HAIR, INK, LINE, PAPER, StillContext, TEXT, useStillMode } from "./base";
import "./flows.css";

/*
 * /features/flows: the software factory, end to end. A sticky pipeline rail
 * names the station each section explains and lights as you scroll; every
 * figure is a working model of the app's Flows page drawn from its real rules
 * (the Change flow's steps and ways out, the line's queue and slots, the
 * regret-free window). Facts trace to packages/cli/src/workflow/templates,
 * shared/contracts/{flowMap,regretRates}.ts and convex/{signals,deploys,
 * orgLineMerge}.ts.
 */

const STATIONS = [
  { id: "signals", name: "Signals" },
  { id: "ways-in", name: "Triage and build" },
  { id: "checks", name: "Checks" },
  { id: "ship", name: "Ship and watch" },
  { id: "back", name: "Back to signals" },
  { id: "autonomy", name: "Autonomy" },
];

/** The pipeline as the page's own navigation: the station in view is lit, the ones behind it are done. */
function Rail() {
  const [active, setActive] = useState(-1);
  useMountEffect(() => {
    const els = STATIONS.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => !!e);
    if (typeof IntersectionObserver === "undefined" || els.length === 0) return;
    // Any section crossing the band is only the cue; the station is read from
    // positions, so a jump that skips sections (an anchor, back to the top)
    // still lands on the right one: the last section whose top has passed
    // a third of the way down the screen, or none while the hero is there.
    const io = new IntersectionObserver(() => {
      const line = window.innerHeight * 0.33;
      let idx = -1;
      els.forEach((el, i) => { if (el.getBoundingClientRect().top <= line) idx = i; });
      setActive(idx);
    }, { rootMargin: "-33% 0px -66% 0px" });
    // The hero and the merge section are not stations but still move the line.
    const others = [document.querySelector(".flx-root")?.firstElementChild, document.getElementById("merge")];
    [...els, ...others].forEach((el) => el && io.observe(el));
    return () => io.disconnect();
  });
  return (
    <nav aria-label="The pipeline" className="flx-rail" data-active={active}>
      <ol className="max-w-7xl mx-auto px-3 sm:px-8">
        {STATIONS.map((s, i) => (
          <li key={s.id} data-state={i < active ? "done" : i === active ? "here" : "ahead"}>
            <a href={`#${s.id}`}>
              <span className="flx-rail-dot" aria-hidden>{i + 1}</span>
              <span className="flx-rail-name">{s.name}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

const RELATED: { slug: string; why: string }[] = [
  { slug: "decisions", why: "Decide, and every other step that waits on a person, lands in the same queue as the rest of your decisions." },
  { slug: "pull-requests", why: "A run of Change can start from a pull request, and the PR page shows which session wrote each line." },
  { slug: "triggers", why: "The session that shipped a change can arm a follow-up that checks on it once the deploy is live." },
  { slug: "memory", why: "Every landed change links back to the session that wrote it, which is how a fix finds who caused it." },
];

export default function FlowsPage() {
  const still = useStillMode();
  return (
    <StillContext.Provider value={still}>
      <main className="flx-root" data-static={still ? "" : undefined} style={{ backgroundColor: SOL.base3 }}>
        <Hero />
        {/* The rail sticks only while the pipeline's own sections scroll past. */}
        <div>
          <Rail />
          <SignalsSection />
          <WaysInSection />
          <ChangeRunSection />
          <ShipSection />
          <TraceSection />
          <RateSection />
          <AutonomySection />
        </div>
        <LibrarySection />

        <section style={{ backgroundColor: SOL.base3 }}>
          <div className="max-w-7xl mx-auto px-5 sm:px-8 pt-16 pb-20">
            <div className="max-w-3xl mb-14">
              <Label>From a session or a script</Label>
              <p className="mt-2 mb-3 text-[14px] leading-[1.6]" style={{ color: TEXT }}>Agents send their own finished work through a flow, and read a flow&apos;s steps before they do.</p>
              <div className="flex flex-col gap-2">
                <CopyCommand cmd="cast flow run change" />
                <CopyCommand cmd="cast flow show change" />
              </div>
            </div>
            <h2 className="font-mono font-bold text-[24px] sm:text-[28px] tracking-[-0.03em] mb-8" style={{ color: INK }}>Related features</h2>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {RELATED.map(({ slug, why }) => {
                const f = FEATURE_DEEP_DIVES.find((x) => x.slug === slug);
                if (!f) return null;
                return (
                  <Link key={slug} href={featureHref(slug)} className="group rounded-xl border p-5 transition-colors hover:bg-[rgba(238,232,213,.5)]" style={{ borderColor: HAIR, backgroundColor: PAPER }}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: f.color }} />
                      <span className="font-mono font-bold text-[15px] group-hover:underline underline-offset-4" style={{ color: SOL.base02 }}>{f.name}</span>
                    </div>
                    <p className="text-[14px] leading-6" style={{ color: TEXT }}>{why}</p>
                  </Link>
                );
              })}
            </div>
          </div>
        </section>

        <div id="install" className="scroll-mt-20">
          <HeroReprise title={<>Run your first change through a flow</>}>
            <p className="text-[16px] leading-7 max-w-lg" style={{ color: SOL.base1 }}>
              Install codecast and open <b style={{ color: SOL.base2 }}>Flows</b> in your workspace. The <b style={{ color: SOL.base2 }}>Library</b> holds
              the standard flows. Send the next change you finish through <b style={{ color: LINE }}>Change</b>, and the Loop
              fills in as your team&apos;s work moves through it.
            </p>
            <div className="mt-8 rounded-xl p-5 sm:p-6 max-w-xl" style={{ backgroundColor: SOL.base3 }}>
              <InstallTabs location="feature-flows" />
            </div>
          </HeroReprise>
        </div>
      </main>
    </StillContext.Provider>
  );
}
