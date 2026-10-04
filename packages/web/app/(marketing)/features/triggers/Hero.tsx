"use client";

import Link from "next/link";
import { SOL } from "../../blog/blogChrome";
import { NightShift } from "./NightShift";
import { ACCENT, Nb } from "./ui";

/** The opening: what a trigger is, the first command, and one night of them working. */
export function Hero() {
  return (
    <header className="relative overflow-hidden" style={{ backgroundColor: SOL.base3 }}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(circle at 1px 1px, color-mix(in srgb, ${SOL.base1} 45%, transparent) 1px, transparent 0)`,
          backgroundSize: "22px 22px",
          maskImage: "linear-gradient(to bottom, black, transparent 70%)",
          WebkitMaskImage: "linear-gradient(to bottom, black, transparent 70%)",
        }}
      />
      <div className="relative max-w-6xl mx-auto px-5 sm:px-6 pt-14 sm:pt-20 pb-16 sm:pb-20">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-end">
          <div>
            <h1 className="tg-rise font-mono font-bold text-[34px] sm:text-[46px] lg:text-[54px] leading-[1.06] tracking-[-0.035em] [text-wrap:balance]" style={{ color: SOL.base03 }}>
              The work keeps going after you close the laptop
            </h1>
            <p className="tg-rise mt-6 max-w-2xl text-[17px] sm:text-[19px] leading-8" style={{ color: SOL.base00, animationDelay: "0.12s" }}>
              A trigger is a prompt with a clock or an event attached. When it fires, codecast runs a real agent session:
              back in the conversation that asked for it, or in a fresh one. Most runs finish quietly. The ones that need a
              person land in your inbox.
            </p>
          </div>
          <div className="tg-rise space-y-3" style={{ animationDelay: "0.24s" }}>
            <div className="rounded-xl px-4 py-3 font-mono text-[13px]" style={{ backgroundColor: SOL.base03, color: SOL.base1 }}>
              <pre className="whitespace-pre-wrap break-words">
                <span style={{ color: SOL.green }}>$</span> <Nb text={'cast trigger add "Check if CI is green on main" --in 30m'} />{"\n"}
                <span style={{ color: SOL.green }}>+</span> Trigger <span style={{ color: SOL.cyan }}>tr-41</span> in 30m: <span className="font-semibold" style={{ color: SOL.base2 }}>Check if CI is green on main</span>
              </pre>
            </div>
            <div className="flex flex-wrap gap-2 text-[14px]">
              <a href="#install" className="rounded-lg px-4 py-2 font-medium transition-transform hover:-translate-y-0.5" style={{ backgroundColor: ACCENT, color: SOL.base3 }}>
                Install codecast
              </a>
              <Link href="/documentation/triggers" className="rounded-lg px-4 py-2 font-medium transition-colors" style={{ border: `1px solid ${SOL.base1}`, color: SOL.base02 }}>
                Read the guide
              </Link>
            </div>
          </div>
        </div>
        <div className="tg-rise mt-12" style={{ animationDelay: "0.35s" }}>
          <NightShift />
        </div>
      </div>
    </header>
  );
}
