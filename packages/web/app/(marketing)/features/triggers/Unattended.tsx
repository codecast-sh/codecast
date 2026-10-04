"use client";

import type { ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, C, Section } from "./ui";

/** A run that meets a usage limit: it parks, the window resets, the same session continues. */
function ParkStrip() {
  const seg = (from: number, to: number, fill: string, label: string, color: string, striped = false) => (
    <div
      className="absolute inset-y-0 flex items-center justify-center rounded-md font-mono text-[10.5px] sm:text-[11px] whitespace-nowrap overflow-hidden"
      style={{
        left: `${from}%`, width: `${to - from}%`, color,
        backgroundColor: striped ? undefined : fill,
        backgroundImage: striped ? `repeating-linear-gradient(135deg, color-mix(in srgb, ${fill} 40%, transparent) 0 5px, transparent 5px 10px)` : undefined,
        border: striped ? `1px solid color-mix(in srgb, ${fill} 50%, transparent)` : undefined,
      }}
    >
      {label}
    </div>
  );
  return (
    <div className="rounded-2xl p-5" style={{ backgroundColor: SOL.base03 }}>
      <div className="flex justify-between font-mono text-[11px]" style={{ color: SOL.base01 }}>
        <span>02:00 fires</span><span>03:10 window resets</span><span>03:40</span>
      </div>
      <div className="relative mt-2 h-9">
        {seg(0, 34, SOL.violet, "working", SOL.base3)}
        {seg(35, 77, SOL.violet, "parked at the limit", SOL.base1, true)}
        {seg(78, 100, SOL.violet, "same session", SOL.base3)}
      </div>
      <p className="mt-3 text-[12.5px] leading-5" style={{ color: SOL.base0 }}>
        No retry spent. If the machine has a saved account with room and switching is on, it can move there instead of waiting.
      </p>
    </div>
  );
}

const GUARDS: { flag: ReactNode; title: string; body: ReactNode; aside?: ReactNode }[] = [
  {
    flag: "--safe", title: "Read-only runs",
    body: <>A spawned run gets its write tools removed and state-changing commands blocked. Right for watchers that should look and report, never touch. A run that injects into an existing session inherits that session&apos;s rules instead.</>,
  },
  {
    flag: "usage limits", title: "A limit is a pause",
    body: <>A run that hits a usage limit parks and resumes its own session when the window resets. It keeps its context and spends none of its retries.</>,
    aside: <ParkStrip />,
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
          <div key={g.title} className={`py-6 ${g.aside ? "md:row-span-2" : ""}`} style={{ borderTop: `1px solid ${SOL.base2}` }}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[13px] font-semibold rounded px-1.5 py-0.5" style={{ color: SOL.orange, backgroundColor: `color-mix(in srgb, ${SOL.orange} 10%, transparent)` }}>{g.flag}</span>
              <h3 className="text-[17px] font-semibold" style={{ color: SOL.base03 }}>{g.title}</h3>
              <span className="ml-auto font-mono text-[11px]" style={{ color: SOL.base1 }}>{String(i + 1).padStart(2, "0")}</span>
            </div>
            <Body className="mt-2">{g.body}</Body>
            {g.aside && <div className="mt-4">{g.aside}</div>}
          </div>
        ))}
      </div>
      <Body className="mt-6 max-w-3xl">
        Runs are executed by the codecast daemon, on the machine where you armed the trigger and in that checkout. The daemon claims each firing with a lease, so a firing runs once. If that machine is asleep when a trigger comes due, the trigger waits and runs when it wakes. Usage limits and account switching are covered in <a href="/documentation/usage-limits" className="underline" style={{ color: SOL.blue }}>the usage limits guide</a>; the <C>cast usage</C> command shows your windows.
      </Body>
    </Section>
  );
}
