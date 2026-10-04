"use client";

import { useState } from "react";
import { SOL } from "../../blog/blogChrome";
import { ACCENT, ShapeGlyph, type Shape } from "./parts";

/**
 * "Which one do I want?" The rule codecast teaches its agents is ownership:
 * who reads the result. Each situation maps to one command and the three
 * facts that decide it: what history the new session starts with, where it
 * shows up, and who hears back.
 */
type Choice = { situation: string; shape: Shape; cmd: string; history: string; lands: string; reports: string; anchor: string };

const CHOICES: Choice[] = [
  {
    situation: "Hand off a piece and get the result back",
    shape: "worker",
    anchor: "workers",
    cmd: 'cast spawn --subagent -- "<task>"',
    history: "None. The brief you write is all it knows, so make it self-contained.",
    lands: "Nested under your session. It stays out of the inbox and out of top-level lists.",
    reports: "You. Your session is woken when the worker finishes, blocks, stops or waits on a permission.",
  },
  {
    situation: "Try two approaches to the same problem",
    shape: "fork",
    anchor: "fork",
    cmd: 'cast fork "<approach A>" "<approach B>"',
    history: "Everything up to the fork point. By default the fork request itself stays out.",
    lands: "This thread takes the first direction. Each other direction is a live session in the inbox.",
    reports: "No one. A branch receives its direction as its human's next message and is steered on its own.",
  },
  {
    situation: "Keep going on another agent or model",
    shape: "switch",
    anchor: "switch",
    cmd: "cast switch --agent codex",
    history: "The same conversation. The id does not change.",
    lands: 'The same thread, with a "now using Codex" divider where the agent changed.',
    reports: "You, exactly as before.",
  },
  {
    situation: "Stop here and continue fresh",
    shape: "handoff",
    anchor: "handoff",
    cmd: "cast handoff --to codex",
    history: "A brief the server writes: goal, decisions, what is verified, open questions, next steps.",
    lands: "A new inbox card in the same directory, linked to this one and bound to its task or plan.",
    reports: "The new session carries on. This one is pinned done and ends its turn.",
  },
  {
    situation: "Get one answer inside a script",
    shape: "exec",
    anchor: "exec",
    cmd: 'git diff | cast exec --agent codex "review this"',
    history: "Only the prompt and whatever you pipe in.",
    lands: "stdout. The exit code is the agent's. No inbox card.",
    reports: "Whatever reads the output.",
  },
  {
    situation: "Open a separate thread a person will steer",
    shape: "spawn",
    anchor: "workers",
    cmd: 'cast spawn "<task>"',
    history: "None.",
    lands: "Its own card in the inbox, even when an agent runs the command.",
    reports: "The person who steers it. Agents use this mode only when the human asks for it.",
  },
];

export function Chooser() {
  const [pick, setPick] = useState(0);
  const c = CHOICES[pick];
  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="flex flex-col gap-1.5" role="tablist" aria-label="Situations">
        {CHOICES.map((ch, i) => {
          const on = i === pick;
          return (
            <button
              key={ch.situation}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setPick(i)}
              onMouseEnter={() => setPick(i)}
              className="agx-choice flex items-center gap-3 rounded-lg px-3 py-2.5 text-left"
              style={{
                backgroundColor: on ? SOL.base03 : "transparent",
                border: `1px solid ${on ? SOL.base03 : SOL.base2}`,
                color: on ? SOL.base3 : SOL.base01,
              }}
            >
              <span className="shrink-0 rounded-md" style={{ backgroundColor: on ? "rgba(253,246,227,0.08)" : SOL.base2 }}>
                <ShapeGlyph shape={ch.shape} size={30} color={on ? "#b5c600" : ACCENT} />
              </span>
              <span className="text-[14.5px] font-medium leading-snug">{ch.situation}</span>
            </button>
          );
        })}
      </div>
      <div key={pick} className="agx-swap rounded-xl p-5 sm:p-6" style={{ backgroundColor: "#fffdf6", border: `1px solid ${SOL.base2}` }} role="tabpanel">
        <div className="flex items-start gap-4">
          <div className="shrink-0 rounded-lg p-1" style={{ backgroundColor: SOL.base2 }}>
            <ShapeGlyph shape={c.shape} size={56} />
          </div>
          <div className="min-w-0">
            <div className="text-[13px]" style={{ color: SOL.base1 }}>{c.situation}</div>
            <code className="mt-1 block overflow-x-auto whitespace-nowrap font-mono text-[15px] sm:text-[16px] font-semibold" style={{ color: SOL.base03 }}>{c.cmd}</code>
          </div>
        </div>
        <dl className="mt-6 grid grid-cols-1 gap-4">
          {([["Starts with", c.history], ["Shows up", c.lands], ["Hears back", c.reports]] as const).map(([k, v]) => (
            <div key={k} className="grid grid-cols-1 gap-1 sm:grid-cols-[110px_1fr] sm:gap-4">
              <dt className="font-mono text-[12px] font-semibold pt-0.5" style={{ color: ACCENT }}>{k}</dt>
              <dd className="text-[14.5px] leading-[1.6]" style={{ color: SOL.base01 }}>{v}</dd>
            </div>
          ))}
        </dl>
        <a href={`#${c.anchor}`} className="mt-6 inline-flex items-center gap-1.5 font-mono text-[12.5px] font-semibold underline decoration-1 underline-offset-4" style={{ color: ACCENT }}>
          How it works <span aria-hidden>↓</span>
        </a>
      </div>
    </div>
  );
}
