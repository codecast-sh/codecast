// Whether a session has edited something its finished run did not take: what decides that the Ship panel offers
// Ship again on a run that landed its change (components/line/widgets/RunThroughFlow.tsx).
import type { FlowEdgeIn, FlowNodeIn } from "@codecast/shared/contracts/flowPool";
import { toolRowKind } from "../modernRow";
import { recordedIds } from "./runRecord";

type Run = Omit<Parameters<typeof recordedIds>[1], "node_statuses"> & { node_statuses?: ReadonlyArray<{ node_id: string; started_at?: number; completed_at?: number }> | null };
type Message = { timestamp: number; tool_calls?: ReadonlyArray<{ name?: string } | null> | null };

/** The session's own fix rounds on a run, each [start, end]: what it edited there went out with the run. */
export function fixRounds(flow: { nodes: ReadonlyArray<FlowNodeIn>; edges: ReadonlyArray<FlowEdgeIn> }, run: Run): Array<readonly [number, number]> {
  // A step by its id as the journey reads it: a run of an older version of the flow may have named it otherwise.
  const idOf = recordedIds(flow, run);
  return (run.node_statuses ?? [])
    .filter((n) => flow.nodes.some((x) => x.id === idOf(n.node_id) && x.backend === "subject"))
    .map((n) => [n.started_at ?? 0, n.completed_at ?? Infinity] as const);
}

/** Whether the session edited a file after `since` outside the `except` windows: an edit or write call among its messages. */
export function editedSince(messages: ReadonlyArray<Message>, since: number, except: ReadonlyArray<readonly [number, number]>): boolean {
  for (let i = messages.length - 1; i >= 0 && messages[i].timestamp > since; i--) {
    const t = messages[i].timestamp;
    if (except.some(([from, to]) => t >= from && t <= to)) continue;
    if (messages[i].tool_calls?.some((c) => { const kind = toolRowKind(String(c?.name ?? "")); return kind === "edit" || kind === "write"; })) return true;
  }
  return false;
}
