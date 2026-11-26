// Whether a flow is a personal Ship (pl-1111): its round routes on its fan-out branches' own results
// (`check.json.outcome`, `review.json.verdict`) and its stations report what they found in a result JSON
// (stationResult.ts). The flow says so itself, `graph [own_results=true]` in its source (personal.cast), carried as
// `own_results` on the snapshot the web reads (cli shippedFlows.ts flowSnapshot) and on a pushed row's flow
// (pushedFlow); a stored workflows row carries its source. Never guessed from the graph's shape: a team's land flow
// routes on its branches' JSON too. Every personal-only rule on the journey, the diagram, a station's panel and the run
// report keys off this one predicate. Pure: the phone reads it through them.

import { sourceSaysOwnResults } from "@codecast/shared/contracts/ownResults";

type Graph = { own_results?: boolean; source?: string | null };

/** Whether the flow is a personal Ship: it says so (`own_results`), on itself or in its source. */
export function roundsOnOwnResults(graph: Graph | null | undefined): boolean {
  return !!graph && (graph.own_results === true || sourceSaysOwnResults(graph.source));
}
