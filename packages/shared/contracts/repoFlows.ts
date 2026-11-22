// A repository's own flows (`.codecast/flows/*.cast`, flows.md FL2), as its checkouts report them: what `cast flow
// run <slug>` runs in that repository ahead of a shipped or published flow of the same slug. The web has no DOT parser,
// so a checkout sends each graph parsed, its segments and `extends` expanded, in the shape the shipped snapshot carries
// (cli workflow/shippedFlows.ts). A report is keyed by the repository (repositoryKeyOfRemote of its origin), so every
// checkout of it shares one row per person and the newest report wins.
import type { FlowEdgeIn, FlowNodeIn } from "./flowPool";

export type RepoFlow = {
  slug: string;
  name: string;
  kind: "line" | "segment";
  label: string;
  description: string | null;
  takes: string[];
  nodes: FlowNodeIn[];
  edges: FlowEdgeIn[];
};

export type RepoFlowsReport = { repository: string; hash: string; flows: RepoFlow[] };
