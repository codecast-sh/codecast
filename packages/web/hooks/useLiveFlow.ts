// A team's live flow and the flows its sessions used (flows doc of Oct 23).
// Feeders hand convex liveFlows.forTeam and flowLibrary.sessionFlows to the
// store; readers paint from it. Both queries are named by reference, so a
// deployment without them answers an error the feeder keeps to itself, and
// the surfaces they feed stay empty.
import { useMemo } from "react";
import { makeFunctionReference } from "convex/server";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const FOR_TEAM = makeFunctionReference<"query">("liveFlows:forTeam");
const SESSION_FLOWS = makeFunctionReference<"query">("flowLibrary:sessionFlows");

/** A live flow as convex liveFlows.forTeam returns it: its queue is task ids in start order, each with why it waits. */
export type LiveFlow = {
  _id: string;
  workspace: string;
  team_id: string;
  flow: { id: string; slug: string; label: string };
  /** The sources it takes problems from; null for every source. */
  sources: string[] | null;
  on: boolean;
  caps: { hands_per_day: number | null };
  hands_today: number;
  load: { working: number; cap: number };
  /** Why nothing starts now, when nothing does. */
  waiting: string | null;
  watcher: { role_id: string; handle: string } | null;
  changed_by: string | null;
  changed_at: number | null;
  queue: Array<{ task_id: string; waiting: string | null }>;
  running: string[];
  /** A hold stops every start until it is cleared or `until` passes; `by` is the session that set it. */
  hold: { why: string; until: number | null; by: string | null; at: number } | null;
};

/** A flow a team session ran or defined, as convex flowLibrary.sessionFlows returns it: the graph once, and the runs,
 *  sessions and people that used it. */
export type SessionFlow = {
  _id: string;
  workspace: string;
  graph_hash: string;
  /** A Claude Code Workflow script the daemon traced, or a graph file run with cast. */
  from: "script" | "graph";
  name: string;
  label: string | null;
  kind: "line" | "segment" | null;
  /** The library flow it extends, by slug. */
  base: string | null;
  nodes: Array<{ id: string; label: string; type: string; shape?: string }>;
  edges: Array<{ from: string; to: string; label?: string; condition?: string }>;
  /** Its runs, newest first (capped). */
  runs: string[];
  run_count: number;
  /** More runs than run_count counted. */
  more: boolean;
  last_at: number;
  /** The sessions that ran it, and who ran it. */
  sessions: string[];
  by: string[];
  saved: { slug: string; version: number } | null;
};

const teamOf = (space: string | null | undefined) => (space?.startsWith("team:") ? space.slice(5) : null);

const liveSig = (r: LiveFlow) => `${r.on}|${r.flow.id}|${r.flow.label}|${r.load.working}/${r.load.cap}|${r.hands_today}|${r.caps.hands_per_day}|${r.waiting ?? ""}|${(r.sources ?? []).join(" ")}|${r.queue.map((q) => `${q.task_id}:${q.waiting ?? ""}`).join(",")}|${r.running.join(",")}|${r.watcher?.handle ?? ""}|${r.hold ? `${r.hold.why}@${r.hold.until ?? ""}` : ""}`;
const sessionSig = (r: SessionFlow) => `${r.label ?? r.name}|${r.run_count}|${r.more}|${r.last_at}|${r.saved?.slug ?? ""}@${r.saved?.version ?? ""}|${r.sessions.join(",")}|${r.by.join(",")}|${r.base ?? ""}`;

/** Feeder and reader: the team workspace's live flow (the first, while a team runs one), or null. */
export function useLiveFlow(space: string | null | undefined): LiveFlow | null {
  const team = teamOf(space);
  useSyncCollection("liveFlows", FOR_TEAM, team ? { team_id: team } : "skip");
  const rows = useWorkspaceCollection<LiveFlow>("liveFlows", liveSig, space ?? null);
  return rows[0] ?? null;
}

/** Feeder and reader: the flows the team's sessions used, newest first, and whether the query has answered (a
 *  deployment without it never does, and the shelf stays away). */
export function useSessionFlows(space: string | null | undefined): { flows: SessionFlow[]; answered: boolean } {
  const team = teamOf(space);
  const { ready } = useSyncCollection("sessionFlows", SESSION_FLOWS, team ? { team_id: team } : "skip");
  const rows = useWorkspaceCollection<SessionFlow>("sessionFlows", sessionSig, space ?? null);
  const flows = useMemo(() => rows.slice().sort((a, b) => b.last_at - a.last_at), [rows]);
  return { flows, answered: ready || rows.length > 0 };
}
