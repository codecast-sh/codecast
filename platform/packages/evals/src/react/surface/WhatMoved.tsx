// "What moved" (docs/architecture/evals-ui.md section 4.1): the last events
// across every surface, one clickable line each. A prompt epoch began, the
// footing changed, freezes flipped, a bisect finished, or something of the
// host's own kind happened (codecast: the Multiplayer sim caught a failure),
// drawn by the host's wall slot. Props only; the wall hands in GET /overview's
// `moved`.

import type { ReactNode } from "react";
import { movedLine, orList } from "../../client";
import type { MovedEvent } from "../../contract";
import { useCaseNoun, useEvalsHost, useEvalsPaths } from "../hooks";
import { EvalsLink } from "../shell/parts";

const MAX_EVENTS = 12;

/** The event's mark, drawn in the fixed colour meanings: magenta broke, cyan fixed, violet the judge. A host's own kind brings its mark. */
function MovedMark({ e, own }: { e: MovedEvent; own: ReactNode }) {
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
    default:
      return own;
  }
}

/** An event's kind: a shared one, or the host's own (codecast: sim-failure). */
const kindOf = (e: { at: string }): string => (e as { kind?: string }).kind ?? "moved";

/** `M` is the host's own kinds (OverviewResponse's second parameter), drawn through its wall slot. */
export function WhatMoved<M extends { at: string } = never>({ events, now }: { events: ReadonlyArray<MovedEvent | M>; now: number }) {
  const noun = useCaseNoun();
  const { format, wall } = useEvalsHost();
  const { href: hrefs } = useEvalsPaths();
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
            const line = movedLine(hrefs, e, wall?.moved, noun);
            const { href, text } = line;
            const at = Date.parse(e.at);
            return (
              <li key={`${kindOf(e)}:${e.at}:${i}`} className="ev-settle" style={{ ["--ev-delay" as string]: `${120 + i * 30}ms` }}>
                <EvalsLink href={href} className="ev-moved-line" data-ev-moved-kind={kindOf(e)}>
                  <span className="ev-moved-mark">
                    <MovedMark e={e as MovedEvent} own={"mark" in line ? line.mark : null} />
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
        <p className="ev-moved-empty">{`Nothing has moved in the window: no ${orList(["new epoch", "footing change", "flip", "finished bisect", ...(wall?.movedKinds ?? [])])}.`}</p>
      )}
    </aside>
  );
}
