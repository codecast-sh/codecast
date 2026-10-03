// "What moved" (docs/architecture/evals-ui.md section 4.1): the last events
// across every surface, one clickable line each. A prompt epoch began, the
// footing changed, freezes flipped, a bisect finished, or the Multiplayer sim
// caught a failure. Props only; the wall hands in GET /overview's `moved`.

import type { MovedEvent } from "@codecast/shared/contracts/evalsApi";
import { formatFullTimestamp, formatRelativeTime } from "../../lib/conversationFormat";
import { evalsHref } from "./evalsPaths";
import { EvalsLink, shortModel, shortRuler } from "./parts";

const MAX_EVENTS = 12;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const OUTCOME_WORDS: Record<string, string> = {
  culprit: "named a culprit commit",
  range: "narrowed to a range",
  drift: "found drift, not source",
  attribution: "answered from the records",
  unreplayable: "found uncommitted edits it cannot replay",
};

/** Where an event's line goes, and what it says. */
export function movedLine(e: MovedEvent): { href: string; text: string } {
  const s = e.surface ?? "";
  switch (e.kind) {
    case "epoch":
      return { href: evalsHref.surface(s, { batch: e.batch }), text: `${s} began prompt epoch e${e.epoch}, ${plural(e.changedFreezes, "freeze")} rendered anew` };
    case "footing":
      return e.change === "model"
        ? { href: evalsHref.surface(s, { batch: e.batch }), text: `${s} moved model, ${shortModel(e.from)} to ${shortModel(e.to)}` }
        : { href: evalsHref.surface(s, { batch: e.batch }), text: `${s} judge ruler moved, ${shortRuler(e.from)} to ${shortRuler(e.to)}` };
    case "flips": {
      const parts = [e.broke ? `${plural(e.broke, "freeze")} broke` : null, e.fixed ? `${e.fixed} fixed` : null].filter(Boolean);
      return { href: evalsHref.surface(s, { batch: e.batch }), text: `${s}: ${parts.join(", ") || "freezes flipped"}` };
    }
    case "bisect":
      return { href: evalsHref.bisect(e.id), text: `Bisect on ${s} ${e.outcome ? OUTCOME_WORDS[e.outcome] ?? "finished" : "stopped without an answer"}` };
    case "sim-failure":
      return { href: e.run ? evalsHref.simRun(e.session, e.run) : evalsHref.sim(), text: `Multiplayer sim: ${e.scenario} broke ${e.invariant || "an invariant"}` };
  }
}

/** The event's mark, drawn in the fixed colour meanings: magenta broke, cyan fixed, violet the judge. */
function MovedMark({ e }: { e: MovedEvent }) {
  const box = { width: 12, height: 12, viewBox: "-7 -7 14 14", "aria-hidden": true } as const;
  switch (e.kind) {
    case "epoch":
      return (
        <svg {...box} className="ev-quiet">
          <path d="M-5,4 H5 M0,-5 V4" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
        </svg>
      );
    case "footing":
      return e.change === "model" ? (
        <svg {...box} className="ev-quiet">
          <path d="M0,-4.6 L4.6,0 L0,4.6 L-4.6,0 Z" fill="none" stroke="currentColor" strokeWidth={1.3} />
        </svg>
      ) : (
        <svg {...box} className="ev-ruler">
          <path d="M-3.6,4.6 L3.6,-4.6" stroke="currentColor" strokeWidth={1.6} strokeDasharray="2 1.2" />
        </svg>
      );
    case "flips":
      return e.broke ? (
        <svg {...box} className="ev-fail">
          <circle r={4.6} fill="none" stroke="currentColor" strokeWidth={1.6} />
        </svg>
      ) : (
        <svg {...box} className="ev-pass">
          <circle r={5} fill="currentColor" />
        </svg>
      );
    case "bisect":
      return (
        <svg {...box} className={e.outcome === "culprit" ? "ev-fail" : "ev-quiet"}>
          <path d="M-2.5,-5 H-5 V5 H-2.5 M2.5,-5 H5 V5 H2.5" fill="none" stroke="currentColor" strokeWidth={1.4} />
          <circle r={1.5} fill="currentColor" />
        </svg>
      );
    case "sim-failure":
      return (
        <svg {...box} className="ev-fail">
          <path d="M-4,-4 L4,4 M4,-4 L-4,4" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
        </svg>
      );
  }
}

export function WhatMoved({ events, now }: { events: MovedEvent[]; now: number }) {
  const list = [...events].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_EVENTS);
  return (
    <aside className="ev-moved" aria-label="What moved" data-ev-moved>
      <h2 className="ev-title">
        <svg width={12} height={12} viewBox="-7 -7 14 14" aria-hidden className="ev-quiet">
          <path d="M-6,3 L-2,-1 L1,2 L6,-4" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
        What moved
      </h2>
      {list.length ? (
        <ol className="ev-moved-list">
          {list.map((e, i) => {
            const { href, text } = movedLine(e);
            const at = Date.parse(e.at);
            return (
              <li key={`${e.kind}:${e.at}:${i}`} className="ev-settle" style={{ ["--ev-delay" as string]: `${120 + i * 30}ms` }}>
                <EvalsLink href={href} className="ev-moved-line" data-ev-moved-kind={e.kind}>
                  <span className="ev-moved-mark">
                    <MovedMark e={e} />
                  </span>
                  <span className="ev-moved-text">{text}</span>
                  <time className="ev-moved-at" dateTime={e.at} title={formatFullTimestamp(at)}>
                    {formatRelativeTime(at, now).replace(" ago", "")}
                  </time>
                </EvalsLink>
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="ev-moved-empty">Nothing has moved in the window: no new epoch, footing change, flip, finished bisect or Multiplayer sim failure.</p>
      )}
    </aside>
  );
}
