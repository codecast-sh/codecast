"use client";

import { useState } from "react";
import { SOL } from "../../blog/blogChrome";
import { Body, Section } from "./ui";

type Outcome = "clean" | "attention";

/** Where a finished run goes: folded into the trigger's history, or held in the inbox. */
function Fork({ outcome }: { outcome: Outcome }) {
  const clean = outcome === "clean";
  const on = (mine: boolean) => (mine ? 1 : 0.28);
  return (
    <svg viewBox="0 0 420 210" className="w-full h-auto" role="img" aria-label={clean ? "A clean run folds into the trigger's history" : "A run flagged for attention stays in the inbox"}>
      <defs>
        <marker id="tg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" fill={SOL.base01} />
        </marker>
      </defs>
      <rect x="10" y="80" width="120" height="50" rx="10" fill={SOL.base03} />
      <text x="70" y="101" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill={SOL.base1}>run of tr-47</text>
      <text x="70" y="118" textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill={SOL.base2}>complete</text>

      <path d="M130 105 C 180 105, 190 45, 250 45" fill="none" stroke={SOL.cyan} strokeWidth="2" opacity={on(clean)} className={clean ? "tg-flow" : undefined} markerEnd="url(#tg-arrow)" />
      <path d="M130 105 C 180 105, 190 165, 250 165" fill="none" stroke={SOL.red} strokeWidth="2" opacity={on(!clean)} className={!clean ? "tg-flow" : undefined} markerEnd="url(#tg-arrow)" />

      <g opacity={on(clean)}>
        <rect x="252" y="18" width="158" height="54" rx="10" fill="#fffbf0" stroke={SOL.base2} />
        <text x="266" y="40" fontFamily="ui-monospace, monospace" fontSize="11" fill={SOL.base02}>trigger history</text>
        <text x="266" y="58" fontFamily="ui-monospace, monospace" fontSize="10" fill={SOL.base1}>read when you look</text>
      </g>
      <g opacity={on(!clean)}>
        <rect x="252" y="138" width="158" height="54" rx="10" fill="#fffbf0" stroke={SOL.red} />
        <circle cx="270" cy="156" r="4" fill={SOL.red} />
        <text x="281" y="160" fontFamily="ui-monospace, monospace" fontSize="11" fill={SOL.base02}>your inbox</text>
        <text x="266" y="178" fontFamily="ui-monospace, monospace" fontSize="10" fill={SOL.base1}>stays until you act</text>
      </g>
    </svg>
  );
}

/** The summary a finished run files, as it reads under the trigger or in the inbox. */
function Summary({ outcome }: { outcome: Outcome }) {
  const clean = outcome === "clean";
  const color = clean ? SOL.green : SOL.red;
  return (
    <div className="rounded-xl px-4 py-3" style={{ backgroundColor: SOL.base3, border: `1px solid ${clean ? SOL.base2 : `color-mix(in srgb, ${SOL.red} 40%, transparent)`}` }}>
      <div className="flex items-center gap-2 font-mono text-[11.5px]" style={{ color }}>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        {clean ? "run of tr-47 · done" : "run of tr-47 · flagged for attention"}
      </div>
      <p className="mt-1.5 text-[14.5px] leading-6" style={{ color: SOL.base02 }}>
        {clean
          ? "Spike was a bot hitting /search. Rate limit held, no user impact."
          : "New TypeError in checkout since last night's migration. Fix drafted, needs your call on the backfill."}
      </p>
    </div>
  );
}

export function Report() {
  const [outcome, setOutcome] = useState<Outcome>("attention");
  return (
    <Section
      id="report"
      tint
      title="Every run says who acts next"
      lede={<>A run ends by filing a summary of what it found. The summary is what you read later, so it states the outcome. The run also says whether you have to read it at all.</>}
    >
      <div className="grid gap-10 lg:grid-cols-2 lg:items-center">
        <div className="space-y-4">
          <div className="inline-flex rounded-lg p-0.5 font-mono text-[12.5px]" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base1}` }}>
            {(["clean", "attention"] as const).map((k) => (
              <button key={k} type="button" onClick={() => setOutcome(k)} className="rounded-md px-3 py-1.5 transition-colors" style={outcome === k ? { backgroundColor: SOL.base03, color: SOL.base3 } : { color: SOL.base01 }}>
                {k === "clean" ? "a clean run" : "needs attention"}
              </button>
            ))}
          </div>
          <Summary outcome={outcome} />
          <Body>
            {outcome === "clean"
              ? <>Nobody needs to act. The run folds into the trigger&apos;s run history, where every firing links to the conversation it produced. A quiet trigger reads as quiet, not as broken.</>
              : <>The run declares itself blocked and stays in the inbox until you have read it. If its session was stashed or killed, it is pulled back into the queue. A trigger whose runs start fresh also wakes the session that set it.</>}
          </Body>
        </div>
        <div className="rounded-2xl p-4 sm:p-6" style={{ backgroundColor: SOL.base3, border: `1px solid ${SOL.base2}` }}>
          <Fork outcome={outcome} />
        </div>
      </div>

      <div className="mt-14 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div>
          <h3 className="font-mono text-[18px] font-bold" style={{ color: SOL.base03 }}>Agents arm their own follow-ups</h3>
          <Body className="mt-2">
            Installing codecast adds a short section to your agent instructions (CLAUDE.md, AGENTS.md). It teaches agents when a trigger earns its place: an agent that pushes a fix sets its own &quot;check CI in 30m&quot;, and one that opens a PR watches for review comments. It also teaches restraint. A trigger needs a concrete reason, not a reflex.
          </Body>
        </div>
        <div>
          <h3 className="font-mono text-[18px] font-bold" style={{ color: SOL.base03 }}>Every run knows its contract</h3>
          <Body className="mt-2">
            A fired run receives your prompt, its trigger ID, and how to file its summary. A run that ends without reporting is caught too: the session that set it is told, with a link to the run&apos;s transcript.
          </Body>
        </div>
      </div>
    </Section>
  );
}
