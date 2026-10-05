"use client";

import { type CSSProperties } from "react";
import { SOL } from "../../blog/blogChrome";
import { MEMORY_CSS, VIOLET } from "./kit";
import { HeroStrata } from "./HeroStrata";
import { SearchLayer } from "./Search";
import { AskLayer, ContextLayer } from "./Ask";
import { BlameLayer, ImpactLayer } from "./Blame";
import { DecisionsLayer, TeachLayer } from "./Teach";
import { Scenarios, Limits, Reference, Closing } from "./Closing";
import { useStillMode, CopyCommand } from "../kit";

/**
 * /features/memory. The page reads as a core sample: the code on top, and the
 * sessions that wrote it lying underneath in layers, newest first. The hero
 * drills one line down to the message where its value was decided; every
 * section after it is one more way to dig.
 */
export default function MemoryPage() {
  const still = useStillMode();
  return (
    <main className="mm-root" data-static={still ? "" : undefined} style={{ backgroundColor: SOL.base3, color: SOL.base02 }}>
      <style>{MEMORY_CSS}</style>
      <Hero />
      <SearchLayer />
      <AskLayer />
      <ContextLayer />
      <BlameLayer />
      <ImpactLayer />
      <DecisionsLayer />
      <TeachLayer />
      <Scenarios />
      <Limits />
      <Reference />
      <Closing />
    </main>
  );
}

const DIG = [
  { cmd: "cast blame", what: "a line to its session" },
  { cmd: "cast read --ask", what: "a session to its answer" },
  { cmd: "cast search", what: "a file, commit or PR to its sessions" },
];

function Hero() {
  return (
    <section className="mm-strata relative overflow-hidden">
      <div className="max-w-6xl mx-auto px-5 sm:px-6 pt-14 pb-16 sm:pt-20 sm:pb-24 grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-14 items-center">
        <div className="min-w-0">
          <a href="/features" className="mm-anim mm-rise inline-flex items-center gap-2 font-mono text-[13px] mb-7 rounded-full pl-1 pr-3 py-1" style={{ color: SOL.base01, backgroundColor: `color-mix(in srgb, ${VIOLET} 8%, ${SOL.base3})`, border: `1px solid color-mix(in srgb, ${VIOLET} 22%, transparent)` }}>
            <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold" style={{ backgroundColor: VIOLET, color: SOL.base3 }}>features</span>
            Team memory
          </a>
          <h1 className="mm-anim mm-rise font-mono font-bold tracking-tight leading-[1.08] text-[34px] sm:text-[46px] lg:text-[50px] mb-6" style={{ color: SOL.base03, "--d": ".05s" } as CSSProperties}>
            Every line of code sits on the conversation that{" "}
            <span className="relative whitespace-nowrap">
              <span className="relative z-10">wrote it.</span>
              <span aria-hidden className="absolute left-0 right-0 bottom-[.08em] h-[.32em] -z-0" style={{ backgroundColor: `color-mix(in srgb, ${VIOLET} 28%, transparent)` }} />
            </span>
          </h1>
          <p className="mm-anim mm-rise text-[17px] sm:text-[19px] leading-[1.6] mb-8 max-w-xl" style={{ color: SOL.base01, "--d": ".12s" } as CSSProperties}>
            Codecast keeps every session your team runs, from any agent on any machine. Search it by the file, commit or pull request it touched. Ask one session a question and get an answer that cites its messages. Blame a line and the author column names the session that wrote it.
          </p>
          <ol className="mm-anim mm-rise space-y-2 mb-9" style={{ "--d": ".2s" } as CSSProperties}>
            {DIG.map((d, i) => (
              <li key={d.cmd} className="flex flex-wrap items-baseline gap-x-3 font-mono text-[13.5px]">
                <span className="tabular-nums text-[11px] w-5 shrink-0" style={{ color: SOL.base1 }}>{String(i + 1).padStart(2, "0")}</span>
                <span className="font-semibold whitespace-nowrap" style={{ color: VIOLET }}>{d.cmd}</span>
                <span style={{ color: SOL.base01 }}>{d.what}</span>
              </li>
            ))}
          </ol>
          <div className="mm-anim mm-rise flex flex-wrap items-center gap-3" style={{ "--d": ".28s" } as CSSProperties}>
            <CopyCommand cmd="cast blame src/webhooks/retry.ts:5" />
            <a href="#install" className="font-mono text-[13px] px-4 py-2 rounded-lg font-semibold" style={{ backgroundColor: VIOLET, color: SOL.base3 }}>Install codecast</a>
          </div>
        </div>
        <div className="min-w-0">
          <HeroStrata />
          <p className="mt-4 font-mono text-[11.5px] leading-5" style={{ color: SOL.base1 }}>
            Line 5 of a retry policy, traced through the sessions that touched the file to the one that set it, opened on the message where the number was decided and the later one that changed it.
          </p>
        </div>
      </div>
    </section>
  );
}
