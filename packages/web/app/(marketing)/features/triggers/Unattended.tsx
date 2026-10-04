"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, C, Section } from "./ui";

/**
 * A run that meets a usage limit, on a 02:00 to 03:40 scale (100 minutes, so a
 * minute is a percent): it parks at 02:25, the window resets at 03:10, and the
 * same session resumes at 03:14. The hero's tr-46 lane shows the same night.
 */
const PARK_TICKS: [number, string][] = [[0, "02:00 fires"], [25, "02:25 limit"], [74, "03:14 resumes"], [100, "03:40 done"]];

function ParkStrip() {
  const seg = (from: number, to: number, label: string, parked = false) => (
    <div
      className="absolute inset-y-0 flex items-center justify-center rounded-md font-mono text-[10.5px] sm:text-[11px] whitespace-nowrap overflow-hidden"
      style={{
        left: `${from}%`, width: `${to - from}%`,
        color: SOL.base3,
        backgroundColor: parked ? undefined : SOL.violet,
        backgroundImage: parked ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${SOL.violet} 40%, transparent) 0 5px, transparent 5px 10px)` : undefined,
        border: parked ? `1px solid color-mix(in srgb, ${SOL.violet} 55%, transparent)` : undefined,
      }}
    >
      {parked ? <span className="rounded px-1.5 py-0.5" style={{ backgroundColor: SOL.base03, color: SOL.base2 }}>{label}</span> : label}
    </div>
  );
  return (
    <div className="rounded-2xl p-5" style={{ backgroundColor: SOL.base03 }}>
      <div className="relative h-4 font-mono text-[10.5px] sm:text-[11px]" style={{ color: SOL.base0 }}>
        {PARK_TICKS.map(([at, label]) => (
          <span key={label} className="absolute top-0 whitespace-nowrap" style={{ left: `${at}%`, transform: at === 0 ? "none" : at === 100 ? "translateX(-100%)" : "translateX(-50%)" }}>{label}</span>
        ))}
      </div>
      <div className="relative mt-2 h-9">
        {seg(0, 24.5, "working")}
        {seg(25.5, 73.5, "parked", true)}
        {seg(74.5, 100, "same session")}
        <span className="absolute -bottom-1.5 h-[calc(100%+12px)] w-px" style={{ left: "70%", backgroundColor: SOL.yellow }} aria-hidden />
      </div>
      <div className="relative mt-2 h-4 font-mono text-[10.5px] sm:text-[11px]" style={{ color: SOL.yellow }}>
        <span className="absolute whitespace-nowrap" style={{ left: "70%", transform: "translateX(-100%)", paddingRight: 6 }}>window resets 03:10</span>
      </div>
      <p className="mt-3 text-[12.5px] leading-5" style={{ color: SOL.base0 }}>
        No retry spent, no context lost. If the machine has a saved account with room and switching is on, the run can move there instead of waiting.
      </p>
    </div>
  );
}

const GUARDS: { flag: ReactNode; title: string; body: ReactNode; aside?: ReactNode }[] = [
  {
    flag: "usage limits", title: "A limit is a pause",
    body: <>A run that hits a usage limit parks and resumes its own session when the window resets. It keeps its context and spends none of its retries.</>,
    aside: <ParkStrip />,
  },
  {
    flag: "--safe", title: "Read-only runs",
    body: <>A spawned run gets its write tools removed and state-changing commands blocked. Right for watchers that should look and report, never touch. A run that injects into an existing session inherits that session&apos;s rules instead.</>,
  },
  {
    flag: "--max-runtime", title: "A hard stop",
    body: <>Every run has a kill cap, 10 minutes by default. Set it past any wait or retry window the prompt asks for.</>,
  },
  {
    flag: "retries", title: "Failure is visible",
    body: <>A failed run is retried after a short backoff, three attempts in all, then the trigger is marked failed. A failed run stays in the inbox while its retry runs, one click from the transcript that shows what went wrong.</>,
  },
  {
    flag: "cadence", title: "No drift, no pile-up",
    body: <>A repeating trigger re-arms on its slot, counted from when it was due, not when the run finished. A run that outlasts its interval skips the slots it missed instead of firing them all at once.</>,
  },
  {
    flag: "lease", title: "Each firing runs once",
    body: <>The daemon claims a due firing with a lease before it starts, so a second machine or a second daemon never runs the same firing twice.</>,
  },
  {
    flag: "kill / restore", title: "Cleanup is symmetric",
    body: <>Killing a session cancels the triggers bound to it. Restoring the session re-arms them. Nothing keeps firing into a thread you closed.</>,
  },
];

export function Unattended() {
  return (
    <Section
      id="unattended"
      title="Built to be left alone"
      lede="Nobody is watching when most triggers fire. These are the rules that make that safe."
    >
      <div className="grid gap-x-10 gap-y-0 md:grid-cols-2">
        {GUARDS.map((g, i) => (
          <div key={g.title} className={`py-6 ${g.aside ? "md:col-span-2 md:grid md:grid-cols-2 md:gap-x-10 md:items-center" : ""}`} style={{ borderTop: `1px solid ${SOL.base2}` }}>
            <div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[13px] font-semibold rounded px-1.5 py-0.5" style={{ color: SOL.orange, backgroundColor: `color-mix(in srgb, ${SOL.orange} 10%, transparent)` }}>{g.flag}</span>
              <h3 className="text-[17px] font-semibold" style={{ color: SOL.base03 }}>{g.title}</h3>
              <span className="ml-auto font-mono text-[11px]" style={{ color: SOL.base1 }}>{String(i + 1).padStart(2, "0")}</span>
            </div>
            <Body className="mt-2">{g.body}</Body>
            </div>
            {g.aside && <div className="mt-4 md:mt-0">{g.aside}</div>}
          </div>
        ))}
      </div>
      <Body className="mt-6 max-w-3xl">
        Runs are executed by the codecast daemon, on the machine where you armed the trigger and in that checkout. If that machine is asleep when a trigger comes due, the trigger waits and runs when it wakes. Usage limits and account switching are covered in <a href="/documentation/usage-limits" className="underline" style={{ color: SOL.blue }}>the usage limits guide</a>; the <C>cast usage</C> command shows your windows.
      </Body>
    </Section>
  );
}
