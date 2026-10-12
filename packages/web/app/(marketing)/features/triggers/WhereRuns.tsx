"use client";

import { useState } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, Section } from "./ui";
import { Whole } from "../kit";

function Bubble({ who, children, faded = false }: { who: "you" | "agent"; children: React.ReactNode; faded?: boolean }) {
  const you = who === "you";
  return (
    <div className={`flex ${you ? "justify-end" : ""}`} style={{ opacity: faded ? 0.45 : 1 }}>
      <div
        className="max-w-[85%] rounded-xl px-3 py-2 text-[12.5px] leading-5"
        style={you ? { backgroundColor: SOL.base2, color: SOL.base02 } : { backgroundColor: "#fffbf0", color: SOL.base01, border: `1px solid ${SOL.base2}` }}
      >
        {children}
      </div>
    </div>
  );
}

function FiredRule({ id, at, color }: { id: string; at: string; color: string }) {
  return (
    <div className="flex items-center gap-2 py-1 font-mono text-[10.5px]" style={{ color }}>
      <span className="h-px flex-1" style={{ backgroundColor: `color-mix(in srgb, ${color} 40%, transparent)` }} />
      <span>{id} fired {at}</span>
      <span className="h-px flex-1" style={{ backgroundColor: `color-mix(in srgb, ${color} 40%, transparent)` }} />
    </div>
  );
}

/** Inline: the run is the next turn of the conversation that armed it. */
function InlineMock() {
  return (
    <div className="rounded-2xl p-4 space-y-2" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
      <div className="mb-1 flex items-center justify-between font-mono text-[11px]" style={{ color: SOL.base1 }}>
        <span>Fix flaky checkout test</span><span>jx7c6zk</span>
      </div>
      <Bubble who="you" faded>ship the fix, then make sure CI is actually green</Bubble>
      <Bubble who="agent" faded>Pushed <span className="font-mono">a41f9e2</span>. I set a follow-up for 30 minutes from now to check CI on main.</Bubble>
      <FiredRule id="tr-41" at="18:40" color={SOL.blue} />
      <Bubble who="agent">
        CI is green on main. The checkout suite passed 3 times in a row on the new runner, so the flake is gone.
        <span className="mt-1 block font-mono text-[10.5px]" style={{ color: SOL.base1 }}>arrived as a new turn, with the whole thread behind it</span>
      </Bubble>
    </div>
  );
}

/** Spawn: each run is a fresh worker nested under the session that armed it. */
function SpawnMock() {
  const runs = [
    { n: 1, at: "20:00", text: "Reviewed 3 open PRs. Summary filed.", state: "done" },
    { n: 2, at: "00:00", text: "No new PRs since the last run.", state: "done" },
    { n: 3, at: "04:00", text: "No change since the last run.", state: "done" },
    { n: 4, at: "08:00", text: "#511 fails its migration check. Needs a decision.", state: "attention" },
  ];
  return (
    <div className="rounded-2xl p-4" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
      <div className="mb-3 flex items-center justify-between font-mono text-[11px]" style={{ color: SOL.base1 }}>
        <span>Release prep</span><span>jx7dhfh</span>
      </div>
      <div className="rounded-lg px-3 py-2 font-mono text-[11.5px]" style={{ backgroundColor: SOL.base2, color: SOL.base02 }}>
        <span style={{ color: SOL.cyan }}>tr-43</span> every 4h · Review open PRs and summarize findings
      </div>
      <ol className="mt-2 ml-3 border-l pl-4 space-y-2" style={{ borderColor: SOL.base2 }}>
        {runs.map((r) => (
          <li key={r.n} className="relative">
            <span
              className="absolute -left-[21px] top-2 h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: r.state === "attention" ? SOL.red : SOL.cyan, boxShadow: `0 0 0 3px ${SOL.base3}` }}
            />
            <div className="rounded-lg px-3 py-1.5 text-[12px] leading-5" style={{ backgroundColor: "#fffbf0", border: `1px solid ${r.state === "attention" ? `color-mix(in srgb, ${SOL.red} 40%, transparent)` : SOL.base2}`, color: SOL.base01 }}>
              <span className="font-mono text-[10.5px]" style={{ color: SOL.base1 }}>run {r.n} · {r.at} · fresh session</span>
              <span className="block">{r.text}</span>
              {r.state === "attention" && <span className="mt-0.5 block font-mono text-[10.5px]" style={{ color: SOL.red }}>needs attention: wakes jx7dhfh</span>}
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 font-mono text-[10.5px]" style={{ color: SOL.base1 }}>each run gets the prompt plus the previous run&apos;s summary</p>
    </div>
  );
}

type Row = { label: string; inline: string; spawn: string; spawnFlag?: string };
const ROWS: Row[] = [
  { label: "Fires once", inline: "The run is the next turn in the thread. The result is right there.", spawn: "A clean result posts back as a message without waking the thread.", spawnFlag: "The agent can ask to be woken to act on the report too." },
  { label: "Repeats", inline: "Every firing reloads the whole history and grows the thread. Use this only for a few firings.", spawn: "A clean run posts nothing. Its summary is read under the trigger.", spawnFlag: "Or every run's result can post into the thread, without a wake." },
  { label: "Fails, dies, or asks", inline: "The thread is where it happened, so you see it there.", spawn: "The arming session is woken: a failed run, a run that died without reporting, or one that flagged itself for attention." },
];

export function WhereRuns() {
  const [col, setCol] = useState<"inline" | "spawn">("spawn");
  return (
    <Section
      id="where"
      tint
      title="Run it here, or in a fresh session"
      lede={<>A trigger an agent sets inside a conversation runs back in that conversation by default, or the agent can give each run a fresh session instead. One made from the Triggers page starts a fresh session each time. The choice turns on two questions: does the run need what this conversation knows, and how often will it fire.</>}
    >
      <div className="grid gap-8 lg:grid-cols-2">
        <div>
          <h3 className="font-mono text-[18px] font-bold" style={{ color: SOL.base03 }}>Here <span className="font-normal text-[14px]" style={{ color: SOL.base1 }}>the default</span></h3>
          <Body className="mt-2 mb-4">For follow-through on this conversation&apos;s own work, firing once or a few times. The run arrives as a new turn with the full history, and its answer lands where the question was asked.</Body>
          <InlineMock />
        </div>
        <div>
          <h3 className="font-mono text-[18px] font-bold" style={{ color: SOL.base03 }}>A fresh session <span className="font-normal text-[14px]" style={{ color: SOL.base1 }}>for standing duties</span></h3>
          <Body className="mt-2 mb-4">For anything that repeats: a monitor, a digest, a sweep. A fresh run carries only its prompt and the last run&apos;s summary, so write the prompt as a full brief. Runs an agent set nest under its session, never as inbox cards.</Body>
          <SpawnMock />
        </div>
      </div>

      <div className="mt-12">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-mono text-[18px] font-bold" style={{ color: SOL.base03 }}>What reaches you</h3>
          <div className="inline-flex rounded-lg p-0.5 font-mono text-[12px] md:hidden" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base1}` }}>
            {(["inline", "spawn"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setCol(k)} className="rounded-md px-3 py-1" style={col === k ? { backgroundColor: SOL.base03, color: SOL.base3 } : { color: SOL.base01 }}>
                {k === "inline" ? "here" : "fresh session"}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-4 overflow-hidden rounded-2xl" style={{ border: `1px solid ${SOL.base1}` }}>
          <div className="hidden md:grid grid-cols-[170px_1fr_1fr] font-mono text-[12px]" style={{ backgroundColor: SOL.base03, color: SOL.base1 }}>
            <span className="px-4 py-2" />
            <span className="px-4 py-2" style={{ color: SOL.blue }}>here</span>
            <span className="px-4 py-2" style={{ color: SOL.cyan }}>fresh session</span>
          </div>
          {ROWS.map((r, i) => (
            <div key={r.label} className="grid md:grid-cols-[170px_1fr_1fr] text-[14px] leading-6" style={{ backgroundColor: i % 2 ? SOL.base3 : "#fffbf0", borderTop: i ? `1px solid ${SOL.base2}` : undefined }}>
              <span className="px-4 pt-3 md:py-3 font-semibold" style={{ color: SOL.base02 }}>{r.label}</span>
              <span className={`px-4 py-3 ${col === "inline" ? "" : "hidden"} md:block`} style={{ color: SOL.base01 }}><Whole text={r.inline} /></span>
              <span className={`px-4 py-3 ${col === "spawn" ? "" : "hidden"} md:block`} style={{ color: SOL.base01 }}>
                <Whole text={r.spawn} />
                {r.spawnFlag && <span className="mt-1 block text-[13px]" style={{ color: SOL.base00 }}>{r.spawnFlag}</span>}
              </span>
            </div>
          ))}
        </div>
        <Body className="mt-4 max-w-3xl">
          A fresh run can be Claude or Codex (the form&apos;s <b>Agent</b> row), a pinned model, or a saved agent definition. A run that lands in an existing conversation keeps that conversation&apos;s model.
        </Body>
      </div>
    </Section>
  );
}
