"use client";

import { useState, type ReactNode } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, C, Section } from "./ui";

const ok = (msg: string, id = "tr-43") => (
  <span><span style={{ color: SOL.green }}>ok</span> {msg}: <span style={{ color: SOL.cyan }}>{id}</span>{"\n"}</span>
);
const mute = (s: ReactNode) => <span style={{ color: SOL.base01 }}>{s}</span>;

/** Each verb, its one-line purpose, and what it prints. Output follows the CLI's own format strings. */
const VERBS: { verb: string; cmd: string; what: string; out: ReactNode }[] = [
  {
    verb: "ls", cmd: "cast trigger ls", what: "Active triggers with their next run and last result. --all adds finished ones, --json the full rows.",
    out: (
      <span>
        {"  "}<span style={{ color: SOL.cyan }}>tr-41</span>  <span style={{ color: SOL.yellow }}>scheduled </span>  Check if CI is green on main  {mute("in 12m")}  {mute("inline")}{"\n"}
        {"  "}<span style={{ color: SOL.cyan }}>tr-43</span>  <span style={{ color: SOL.green }}>running   </span>  Review open PRs and summarize findings  {mute("every 8h")}  {mute("claude/default")}{"\n"}
        {"           "}{mute("last: Two PRs went green overnight. Summary filed.")}{"\n"}
        {"  "}<span style={{ color: SOL.cyan }}>tr-44</span>  <span style={{ color: SOL.yellow }}>scheduled </span>  Rebuild the docs index if main moved  {mute("every 1h")}  {mute("claude/sonnet")}{"\n"}
        {"  "}<span style={{ color: SOL.cyan }}>tr-45</span>  <span style={{ color: SOL.base01 }}>paused    </span>  Respond to new PR review comments  {mute("on pr_comment in acme/web#482")}  {mute("inline")}{"\n"}
        {mute("\n4 trigger(s)")}{"\n"}
      </span>
    ),
  },
  {
    verb: "update", cmd: "cast trigger update tr-43 --every 8h", what: "Edit in place: --prompt, --title, --in, --every, --on, --model, --safe and more. The run history stays attached.",
    out: <span><span style={{ color: SOL.green }}>ok</span> Updated <span style={{ color: SOL.cyan }}>tr-43</span>: interval_ms (see `cast trigger history tr-43`){"\n"}</span>,
  },
  {
    verb: "history", cmd: "cast trigger history tr-43", what: "Every version, newest first: who changed which field, from what to what, and from where.",
    out: (
      <span>
        <span style={{ color: SOL.cyan }}>tr-43</span> <span className="font-bold" style={{ color: SOL.base2 }}>Review open PRs and summarize findings</span> {mute("v3, 2 edit(s)")}{"\n\n"}
        <span style={{ color: SOL.yellow }}>v2 -&gt; v3</span>  {mute("10/3/2026, 9:12:04 AM")}  Dana {mute("via cli")}{"\n"}
        {"  "}interval_ms: 4h {mute("->")} 8h{"\n\n"}
        <span style={{ color: SOL.yellow }}>v1 -&gt; v2</span>  {mute("10/1/2026, 6:40:11 PM")}  Dana {mute("via web")}{"\n"}
        {"  "}prompt: &quot;Review open PRs and summarize findings&quot; {mute("->")} &quot;Review open PRs. Flag any with a failing check...&quot;{"\n"}
        {"  "}model: {mute("(none)")} {mute("->")} sonnet{"\n"}
      </span>
    ),
  },
  {
    verb: "log", cmd: "cast trigger log tr-43", what: "The last run's conversation, when it ran, and its summary. For a gated trigger, the last skip too.",
    out: (
      <span>
        Last run conversation: <span style={{ color: SOL.cyan }}>jx7f2qa9c81kd0v6n3t5wq2e7x8c1r4m</span> {mute("(Review open PRs and summarize findings)")}{"\n"}
        {mute("Ran 41m ago")}{"\n"}
        Two PRs went green overnight. #507 still waits on a reviewer. Summary filed.{"\n"}
        Use: cast read jx7f2qa9c81kd0v6n3t5wq2e7x8c1r4m{"\n"}
      </span>
    ),
  },
  { verb: "run", cmd: "cast trigger run tr-43", what: "Fire it now, outside its schedule. A precheck does not apply to a manual run.", out: ok("Queued for immediate run") },
  { verb: "pause", cmd: "cast trigger pause tr-43", what: "Stop firing without losing anything. cast trigger resume picks it back up.", out: ok("Paused") },
  { verb: "cancel", cmd: "cast trigger cancel tr-43", what: "Done with it. The history and every past run stay readable.", out: ok("Cancelled") },
];

export function History() {
  const [i, setI] = useState(2);
  const v = VERBS[i];
  return (
    <Section
      id="history"
      tint
      title="Edits are versions, not overwrites"
      lede={<>A trigger that runs for weeks gets tuned. <C>cast trigger update</C> writes a new version and keeps the old one, so you can always see what the prompt said when a given run fired. Every trigger also has a page in the web app, and the same verbs work there.</>}
    >
      <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
        <div role="tablist" aria-label="Trigger commands" className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
          {VERBS.map((x, k) => (
            <button
              key={x.verb}
              role="tab"
              aria-selected={k === i}
              type="button"
              onClick={() => setI(k)}
              className="shrink-0 rounded-lg px-3 py-2 text-left font-mono text-[13px] transition-colors"
              style={k === i ? { backgroundColor: SOL.base03, color: SOL.base3 } : { backgroundColor: SOL.base3, color: SOL.base01, border: `1px solid ${SOL.base2}` }}
            >
              <span style={{ color: k === i ? SOL.orange : SOL.base1 }}>cast trigger</span> {x.verb}
            </button>
          ))}
        </div>
        <div className="min-w-0">
          <div className="rounded-2xl overflow-hidden shadow-xl" style={{ backgroundColor: SOL.base03, border: "1px solid #094959" }}>
            <div className="flex items-center gap-2 px-4 py-2.5" style={{ backgroundColor: SOL.base02, borderBottom: "1px solid #094959" }}>
              {[SOL.red, SOL.yellow, SOL.green].map((col) => <span key={col} className="h-3 w-3 rounded-full" style={{ backgroundColor: col }} />)}
              <span className="ml-2 font-mono text-[12px]" style={{ color: SOL.base01 }}>~/src/acme</span>
            </div>
            <div className="overflow-x-auto">
              <pre key={v.verb} className="tg-fade min-h-[200px] p-4 font-mono text-[12px] leading-relaxed" style={{ color: SOL.base0 }}>
                <span style={{ color: SOL.green }}>$</span> <span style={{ color: SOL.base1 }}>{v.cmd}</span>{"\n"}
                {v.out}
              </pre>
            </div>
          </div>
          <Body className="mt-4">{v.what}</Body>
        </div>
      </div>
    </Section>
  );
}
