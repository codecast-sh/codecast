// Who says yes before a flow's change lands (pl-1075), read from the flow's graph: the chip on a Ship press, and
// whether that press confirms first. journey.ts draws where a run of the flow stands.
import { asksIfOf } from "./segmentInside";
import { journeyStages, LANDING_STEP } from "./journey";

type Graph = Parameters<typeof journeyStages>[0];

/** Whether a person approves the change before it lands: on every run, only on a side route (`when`: what makes a run
 *  ask, as the person's step says it with `asks_if`, else unknown), or never. */
export type Approval = { kind: "always" } | { kind: "if"; when: string | null } | { kind: "never" };

/**
 * Who says yes before the change lands, read from the graph. A person's stage on the passing path before the one that
 * lands it asks on every run. Otherwise a person's step (a segment's own included) that a run can reach before the
 * change lands, at the runner's landing step or else an exit that is no stop, asks only when a run turns off toward it
 * from a step that still lands without it: `when` is that step's `asks_if` (on it, else on each segment holding it, outermost last),
 * never a route's label, which names the route and is not written to finish a sentence. Anything else asks nobody.
 */
export function approvalOf(graph: Graph): Approval {
  const plan = journeyStages(graph);
  const land = plan.findIndex((s) => s.role === "land" || s.role === "deploy");
  // The landing stage counts too: a person on its passing route says yes before its landing step.
  const upTo = land < 0 ? plan.length : plan[land].role === "land" ? land + 1 : land;
  if (plan.slice(0, upTo).some((s) => s.who === "person")) return { kind: "always" };
  const landing = graph.nodes.filter((n) => LANDING_STEP.test(n.id)).map((n) => n.id);
  const lands = landing.length ? landing : graph.nodes.filter((n) => n.type === "exit" && !n.stop).map((n) => n.id);
  const start = graph.nodes.filter((n) => n.type === "start").map((n) => n.id);
  // Every node a walk from `from` reaches, along edges forward or backward, never through `without`.
  const reach = (from: string[], back: boolean, without?: string) => {
    const seen = new Set(from.filter((id) => id !== without));
    for (let frontier = [...seen]; frontier.length; ) {
      const next = graph.edges.filter((e) => frontier.includes(back ? e.to : e.from)).map((e) => (back ? e.from : e.to)).filter((id) => id !== without && !seen.has(id));
      for (const id of next) seen.add(id);
      frontier = [...new Set(next)];
    }
    return seen;
  };
  const fromStart = reach(start, false);
  const toLand = reach(lands, true);
  const asks = graph.nodes.filter((n) => n.type === "human" && fromStart.has(n.id) && toLand.has(n.id)).map((n) => n.id);
  for (const h of asks) {
    // The steps that still reach landing without this person, and the turn from one of them toward the person.
    const passing = reach(lands, true, h);
    const towards = reach([h], true);
    const turn = graph.edges.find((e) => passing.has(e.from) && fromStart.has(e.from) && !passing.has(e.to) && towards.has(e.to));
    if (turn) return { kind: "if", when: asksIfOf(graph, h) };
  }
  return { kind: "never" };
}

/**
 * Whether Ship confirms before it starts the run. One click starts it (pl-1075): a card the run may ask later arrives
 * as its own card. Only a flow that asks the person on every run confirms, since that question is its first stop; a
 * ship from a risky checkout (`from`, far behind or conflicting) or one starting several runs at once confirms too.
 */
export function shipConfirms(approval: Approval, opts: { from?: string | null; runs?: number } = {}): boolean {
  return approval.kind === "always" || !!opts.from || (opts.runs ?? 1) > 1;
}

/** An approval in a chip's words. */
export const approvalWords = (a: Approval): string => (a.kind === "always" ? "Asks you every time" : a.kind === "if" ? (a.when ? `Asks you if ${a.when}` : "Sometimes asks you") : "No approval");
