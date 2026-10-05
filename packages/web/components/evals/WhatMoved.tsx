// "What moved" (docs/architecture/evals-ui.md section 4.1): the last events
// across every surface, one clickable line each. A prompt epoch began, the
// footing changed, freezes flipped, a bisect finished, or the Multiplayer sim
// caught a failure. Props only; the wall hands in GET /overview's `moved`.

import type { MovedEvent } from "@codecast/shared/contracts/evalsApi";
import { useEvalsHost } from "./host";
import { EvalsLink } from "./parts";
import { movedLine } from "./wallModel";

const MAX_EVENTS = 12;

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
  const { format } = useEvalsHost();
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
                  <time className="ev-moved-at" dateTime={e.at} title={format.fullTimestamp(at)}>
                    {format.relativeTime(at, now).replace(" ago", "")}
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
