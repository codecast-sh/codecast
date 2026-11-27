// What every surface that draws a priority (the list, a reference's card, the
// priority page) reads beside its rows: the inbox's live verdict for each
// linked session, and the store's lookups for a milestone's branches, pull
// requests and deploys (lib/priorityList builds the models from them).
import { useMemo } from "react";
import type { PriorityHistory, PriorityRow, PrioritySessionState } from "@codecast/shared/contracts/priorities";
import { buildModels, stateOfMark, type MilestoneModel, type PriorityModel } from "../lib/priorityList";
import type { TeamDeployRow } from "../lib/deploys/targets";
import { useInboxStore } from "../store/inboxStore";
import { inboxMarkOf, type MarkInbox } from "../store/inboxMark";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { useCoarseNow } from "./useCoarseNow";
import type { DeployInfo } from "../lib/priorityList";

/**
 * Whose inbox a milestone's marks follow: web's sidebar, or the phone's inbox
 * (store/inboxMark inboxMarkOf).
 */
export type LiveInbox = MarkInbox;

/** One session's state as `inbox` draws it (usePriorityLiveStates), or undefined when that inbox does not draw it. */
export function liveStateOf(s: Parameters<typeof inboxMarkOf>[0], id: string, now: number, inbox: LiveInbox = "sidebar"): PrioritySessionState | undefined {
  const mark = inboxMarkOf(s, id, { inbox, now });
  return mark ? stateOfMark(mark) : undefined;
}

/**
 * The mark each linked session's inbox draws for it, by conversation id, as
 * the milestone vocabulary reads it (lib/priorityList buildModels states the
 * whole rule). One subscription to a signature of just those rows' states,
 * so a heartbeat elsewhere wakes nothing.
 */
export function usePriorityLiveStates(ids: readonly string[], now: number, inbox: LiveInbox = "sidebar"): (conversationId: string) => PrioritySessionState | undefined {
  const key = ids.join(",");
  const sig = useInboxStore((s) => {
    const out: string[] = [];
    for (const id of key.split(",")) {
      const state = id ? liveStateOf(s as any, id, Math.max(now, Date.now()), inbox) : undefined;
      if (state) out.push(`${id}:${state}`);
    }
    return out.join(",");
  });
  return useMemo(() => {
    const states = new Map(sig.split(",").filter(Boolean).map((p) => p.split(":") as [string, PrioritySessionState]));
    return (id: string) => states.get(id);
  }, [sig]);
}

/** Every linked session's conversation id across `rows`, sorted, once each. */
export function linkedSessionIds(rows: ReadonlyArray<{ links?: Array<{ sessions: Array<{ conversation_id: string }> }> }>): string[] {
  return [...new Set(rows.flatMap((r) => (r.links ?? []).flatMap((l) => l.sessions.map((s) => s.conversation_id))))].sort();
}

const prIndexes = new WeakMap<object, Map<string, string>>();
/** A pull request's state by "owner/repo#N", from the rows the store holds. */
function prStateIn(coll: Record<string, any> | undefined, ref: string): string | undefined {
  if (!coll) return undefined;
  let idx = prIndexes.get(coll);
  if (!idx) {
    idx = new Map();
    for (const pr of Object.values(coll)) idx.set(`${String(pr.repository).toLowerCase()}#${pr.number}`, pr.state ?? "open");
    prIndexes.set(coll, idx);
  }
  return idx.get(ref.toLowerCase());
}

/** The newest deploy per target that shipped one of a milestone's tasks or carried one of its sessions' commits. */
function deploysFor(m: MilestoneModel, deploys: readonly TeamDeployRow[]): DeployInfo[] {
  const tasks = new Set(m.tasks);
  const sessions = new Set(m.sessions.map((s) => s.conversation_id));
  const out: DeployInfo[] = [];
  const hits = deploys
    .filter((d) => (d.tasks ?? []).some((t) => t.short_id && tasks.has(t.short_id)) || d.sessions.some((x) => sessions.has(x.conversation_id)))
    .map((d) => ({ id: d._id, short_id: d.short_id, target: d.target, status: d.status, at: d.live_at ?? d.finished_at ?? d.created_at }))
    .sort((a, b) => b.at - a.at);
  for (const d of hits) if (!out.some((x) => x.target === d.target)) out.push(d);
  return out;
}

/** What a milestone's links need from the store around the row: branches by session, a PR's state, deploys. */
export type LinkLookups = {
  branchOf: (conversationId: string) => string | null;
  prState: (ref: string) => string | undefined;
  deploysOf: (m: MilestoneModel) => DeployInfo[];
};

const DEFAULT_BRANCHES = new Set(["main", "master", "HEAD", "develop"]);

/** A milestone's branches: its sessions' worktree or git branch, never a default one. */
export const branchesOf = (m: MilestoneModel, lookups: LinkLookups) =>
  [...new Set(m.sessions.map((s) => lookups.branchOf(s.conversation_id)).filter((b): b is string => !!b && !DEFAULT_BRANCHES.has(b)))];

const NO_DAYS: string[] = [];

/** One priority's model (lib/priorityList buildModels), with `inbox`'s live verdict laid over its sessions. */
export function usePriorityModel(row: PriorityRow, history?: PriorityHistory, days: string[] = NO_DAYS, inbox: LiveInbox = "sidebar"): PriorityModel {
  const now = useCoarseNow(30_000);
  const ids = useMemo(() => linkedSessionIds([row]), [row]);
  const live = usePriorityLiveStates(ids, now, inbox);
  return useMemo(() => buildModels([row], history, live, days)[0], [row, history, live, days]);
}

/** Every pull request (`owner/repo#N`) the milestones of `rows` name, sorted, once each. */
export function linkedPrRefs(rows: ReadonlyArray<{ steps: ReadonlyArray<{ refs: ReadonlyArray<{ kind: string; id: string }> }> }>): string[] {
  return [...new Set(rows.flatMap((r) => r.steps.flatMap((st) => st.refs.filter((x) => x.kind === "pr").map((x) => x.id))))].sort();
}

/**
 * The lookups for the linked sessions (`sessionIds`) and pull requests
 * (`prRefs`) a surface draws. One subscription to a signature of just their
 * branches and states, so a branch or a PR's state changing repaints its
 * chip, and nothing else in those collections wakes it.
 */
export function usePriorityLookups(sessionIds: readonly string[], prRefs: readonly string[]): LinkLookups {
  const deploys = useWorkspaceCollection<TeamDeployRow>("teamDeploys", (d) => `${d.status}:${d.live_at ?? ""}:${d.sessions.length}:${d.tasks?.length ?? 0}`);
  const ids = sessionIds.join(",");
  const prs = prRefs.join(",");
  const sig = useInboxStore((s) => {
    const sessions = s.sessions as Record<string, any>;
    const branches = ids ? ids.split(",").map((id) => sessions[id]?.worktree_branch || sessions[id]?.git_branch || "").join(",") : "";
    const states = prs ? prs.split(",").map((ref) => prStateIn(s.pullRequests as Record<string, any>, ref) ?? "").join(",") : "";
    return `${branches}|${states}`;
  });
  return useMemo<LinkLookups>(() => ({
    branchOf: (id) => {
      const row = (useInboxStore.getState().sessions as Record<string, any>)[id];
      return row?.worktree_branch || row?.git_branch || null;
    },
    prState: (ref) => prStateIn(useInboxStore.getState().pullRequests as Record<string, any>, ref),
    deploysOf: (m) => deploysFor(m, deploys),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is what the getState() reads above wake on
  }), [deploys, sig]);
}
