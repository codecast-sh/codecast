// The stages `cast flow run` names when a run starts (flows.md FL4): the path the web's picker and run card show beside
// the flow (PR → CI + Review → Merge → Deploy → Live for the library change flow), by the same planner over the same
// graph (shared contracts/flowStagePlan.ts), never every station a segment expands into.
import { stagePathWords } from "@codecast/shared/contracts/flowStagePlan";
import { sourceSaysOwnResults } from "@codecast/shared/contracts/ownResults";
import { graphOf } from "./flowBase.js";
import type { FoundFlow } from "./flowFind.js";

/** The flow's stages by name, in path order; null when its graph does not parse. */
export function flowStagePath(found: FoundFlow): string | null {
  const graph = graphOf(found);
  return graph ? stagePathWords({ nodes: [...graph.nodes.values()], edges: graph.edges }, { personal: sourceSaysOwnResults(found.source) }) : null;
}
