// A repository's own flows (`.codecast/flows/*.cast`, flows.md FL2), as its checkouts report them: what `cast flow
// run <slug>` runs in that repository ahead of a shipped or published flow of the same slug. The web has no DOT parser,
// so a checkout sends each graph parsed, its segments and `extends` expanded, in the shape the shipped snapshot carries
// (cli workflow/shippedFlows.ts). A report is keyed by its checkout's root: a repository's worktrees sit on different
// branches with different flows, and `cast flow run` reads the one it runs in. `repository` (repositoryKeyOfRemote of
// its origin) names the checkout a session in an unreported worktree falls back to.
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
  /** Set on a shipped flow the checkout reports with its start decided there (cli workflow/startFacts.ts): the shipped
   *  slug it was cut from, and the facts that cut it. Only this marks a reported flow as the library's own. */
  decided_from?: string;
  facts?: Record<string, string>;
};

export type RepoFlowsReport = { root: string; repository: string; hash: string; flows: RepoFlow[] };
