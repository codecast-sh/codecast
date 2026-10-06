// Codecast's own parts of the surface wall: the Multiplayer sim. The host
// hands them to the wall through its `wall` slot (host.tsx), so the wall and
// What moved name no sim file and can move to @platform/evals with the rest
// of the surface group, while the sim views stay here.

import type { MovedEvent, OverviewResponse, SimFailureMoved, SimSessionSummary } from "@codecast/shared/contracts/evalsApi";
import { evalsHref } from "./evalsPaths";
import { plural, shortSha } from "./format";
import { useEvalsHost } from "./host";
import { EvalsLink, VerdictGlyph } from "./parts";
import { simOutcome } from "./simModel";

/** A sim failure's What moved line: it opens the sim run that broke, and an X marks it. */
export function simMoved(e: MovedEvent) {
  const f = e as SimFailureMoved;
  return {
    href: f.run ? evalsHref.simRun(f.session, f.run) : evalsHref.sim(),
    text: `Multiplayer sim: ${f.scenario} broke ${f.invariant || "an invariant"}`,
    mark: (
      <svg width={12} height={12} viewBox="-7 -7 14 14" aria-hidden className="ev-fail">
        <path d="M-4,-4 L4,4 M4,-4 L-4,4" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
      </svg>
    ),
  };
}

/** The wall foot's block for the latest Multiplayer sim session. */
export function SimFoot({ overview, now }: { overview: OverviewResponse; now: number }) {
  return (
    <div className="ev-wall-foot-block">
      <h2 className="ev-title">
        <svg width={12} height={12} viewBox="-7 -7 14 14" aria-hidden className="ev-quiet">
          <path d="M-6,-3 H6 M-6,3 H6" stroke="currentColor" strokeWidth={1.3} />
          <circle cx={-2} cy={-3} r={1.6} fill="currentColor" />
          <circle cx={3} cy={3} r={1.6} fill="currentColor" />
        </svg>
        Latest Multiplayer sim session
        <EvalsLink href={evalsHref.sim()} className="ev-wall-more">
          catalog
        </EvalsLink>
      </h2>
      <SimLine sim={overview.sim} now={now} />
    </div>
  );
}

function SimLine({ sim, now }: { sim: SimSessionSummary | null; now: number }) {
  const { format } = useEvalsHost();
  if (!sim) return <div className="ev-wall-foot-empty">No Multiplayer sim session on this machine yet.</div>;
  const outcome = simOutcome(sim);
  return (
    <EvalsLink href={evalsHref.sim()} className="ev-wall-simline" data-ev-sim-line={sim.id}>
      <VerdictGlyph state={outcome.state} title={outcome.words} />
      <span className="ev-wall-simline-text" title={`${plural(sim.runs, "run")} across ${plural(sim.scenarios, "scenario")}`}>
        {sim.unsessioned ? "An unsessioned run" : plural(sim.scenarios, "scenario")}
        {", "}
        <span className={outcome.bad ? "ev-fail" : undefined}>{outcome.words}</span>
      </span>
      <span className="ev-grow" />
      <span className="ev-quiet ev-tabular">{format.relativeTime(Date.parse(sim.startedAt), now).replace(" ago", "")}</span>
      {sim.gitHead && <span className="ev-chip">{shortSha(sim.gitHead)}{sim.dirty ? ", dirty" : ""}</span>}
    </EvalsLink>
  );
}
