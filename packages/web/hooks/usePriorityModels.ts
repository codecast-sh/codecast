// What every surface that draws a priority (the list, a reference's card, the
// priority page) reads beside its rows: the inbox's live verdict for each
// linked session, and the store's lookups for a milestone's branches, pull
// requests and deploys (lib/priorityList builds the models from them).
import { useMemo } from "react";
import type { PriorityHistory, PriorityRow } from "@codecast/shared/contracts/priorities";
import { buildModels, type MilestoneModel, type PriorityModel } from "../lib/priorityList";
import type { TeamDeployRow } from "../lib/deploys/targets";
import { hostedStopsSig } from "../lib/hostedNotice";
import {
  pendingSendWakeSig, placementDecisionsSig, resolveShowOld, sessionsWakeSig, teamInboxIdsOf, useInboxStore, useTrackedStore,
} from "../store/inboxStore";
import { inboxMarkOf, type DrawnMark, type MarkInbox } from "../store/inboxMark";
import { rowSigExcluding } from "../store/wakeSig";
import { useWorkspacesCollection } from "./useWorkspaceCollection";
import { INBOX_CLOCK_MS, useCoarseNow } from "./useCoarseNow";
import type { DeployInfo } from "../lib/priorityList";

/**
 * Whose inbox a milestone's marks follow: web's sidebar, or the phone's inbox
 * (store/inboxMark inboxMarkOf).
 */
export type LiveInbox = MarkInbox;

/**
 * Where `inbox` holds its rows in place: the sidebar's focused id
 * (hooks/useSidebarFocusId, read on web and handed in), else the store's
 * currentSessionId, the phone's.
 */
type Focus = string | null | undefined;
const focusOf = (s: { currentSessionId?: string | null }, focusedId: Focus) => (focusedId === undefined ? s.currentSessionId ?? null : focusedId);

/** What `inbox` draws for one session (usePriorityLiveStates), or undefined when that inbox does not draw it. */
export function liveMarkOf(s: Parameters<typeof inboxMarkOf>[0] & { currentSessionId?: string | null }, id: string, now: number, inbox: LiveInbox = "sidebar", focusedId?: Focus): DrawnMark | undefined {
  return inboxMarkOf(s, id, { inbox, now, focusedId: focusOf(s, focusedId) }) ?? undefined;
}

/** A row's liveness stamps: a heartbeat moves them and nothing a card draws. */
const LIVENESS_FIELDS: ReadonlySet<string> = new Set(["updated_at", "last_heartbeat", "last_metrics_at", "last_active_at", "last_message_at", "daemon_alive_until"]);
const linkedRowsSig = (sessions: Record<string, any>, ids: readonly string[]) => ids.map((id) => (sessions[id] ? rowSigExcluding(sessions[id], LIVENESS_FIELDS) : "")).join("|");

/**
 * What each linked session's inbox draws for it, by conversation id
 * (lib/priorityList buildModels reads it and states the whole rule). The
 * inbox is placed again only when what placement reads moves: the inbox's
 * own wake signatures (structural session change, pending sends, decisions,
 * the view keys), a linked row's own facts, the focus and a coarse clock for
 * its time-driven flips. A heartbeat that changes none of them places nothing
 * and wakes nothing.
 */
export function usePriorityLiveStates(ids: readonly string[], now: number, inbox: LiveInbox = "sidebar", focusedId?: Focus): (conversationId: string) => DrawnMark | undefined {
  const s = useTrackedStore([
    (st) => sessionsWakeSig(st.sessions),
    (st) => st.sessionsWithQueuedMessages,
    (st) => st.blockedReviveRequestedAt,
    (st) => pendingSendWakeSig(st.pendingMessages),
    (st) => st.pendingSessionCreates,
    (st) => st.currentUser?._id,
    (st) => st.clientState.ui?.inbox_scope,
    (st) => resolveShowOld(st.clientState.ui),
    (st) => teamInboxIdsOf(st),
    (st) => placementDecisionsSig(st.sessionDecisions),
    (st) => st.questionResolutions,
    (st) => st.newSessionHolds,
    (st) => st.killedShelf?.ids,
    (st) => st.livenessHeldAt,
    (st) => hostedStopsSig(st.sessions, st.messages),
    (st) => st.currentSessionId,
    // Each linked row's own facts its card reads (an ask, an error, a stop), its liveness stamps left out.
    (st) => linkedRowsSig(st.sessions as Record<string, any>, ids),
  ]);
  const coarseNow = useCoarseNow(INBOX_CLOCK_MS);
  const key = ids.join(",");
  const rowsSig = linkedRowsSig(s.sessions as Record<string, any>, ids);
  const focus = focusOf(s, focusedId);
  return useMemo(() => {
    const at = Math.max(now, coarseNow);
    const marks = new Map<string, DrawnMark>();
    for (const id of key ? key.split(",") : []) {
      const m = liveMarkOf(s as any, id, at, inbox, focus);
      if (m) marks.set(id, m);
    }
    return (id: string) => marks.get(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the wake signatures stand in for the churny refs placement reads
  }, [key, rowsSig, inbox, focus, now, coarseNow, sessionsWakeSig(s.sessions), s.sessionsWithQueuedMessages, s.blockedReviveRequestedAt, pendingSendWakeSig(s.pendingMessages), s.pendingSessionCreates, s.currentUser?._id, s.clientState.ui?.inbox_scope, resolveShowOld(s.clientState.ui), teamInboxIdsOf(s), placementDecisionsSig(s.sessionDecisions), s.questionResolutions, s.newSessionHolds, s.killedShelf?.ids, s.livenessHeldAt, hostedStopsSig(s.sessions, s.messages)]);
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

/**
 * The newest deploy per target that shipped one of a milestone's tasks or
 * carried one of its sessions' commits. A milestone's deploys come only from
 * its priority's own workspace (`workspace`): where the store holds none of
 * that workspace's deploys there are none, never another workspace's.
 */
function deploysFor(m: MilestoneModel, workspace: string, deploys: readonly TeamDeployRow[]): DeployInfo[] {
  const tasks = new Set(m.tasks);
  const sessions = new Set(m.sessions.map((s) => s.conversation_id));
  const out: DeployInfo[] = [];
  const hits = deploys
    .filter((d) => d.workspace === workspace)
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
  /** `workspace`: the milestone's priority's own (PriorityRow.workspace). */
  deploysOf: (m: MilestoneModel, workspace: string) => DeployInfo[];
};

const DEFAULT_BRANCHES = new Set(["main", "master", "HEAD", "develop"]);

/** A milestone's branches: its sessions' worktree or git branch, never a default one. */
export const branchesOf = (m: MilestoneModel, lookups: LinkLookups) =>
  [...new Set(m.sessions.map((s) => lookups.branchOf(s.conversation_id)).filter((b): b is string => !!b && !DEFAULT_BRANCHES.has(b)))];

const NO_DAYS: string[] = [];

/** One priority's model (lib/priorityList buildModels), with `inbox`'s live verdict laid over its sessions. */
export function usePriorityModel(row: PriorityRow, history?: PriorityHistory, days: string[] = NO_DAYS, inbox: LiveInbox = "sidebar", focusedId?: string | null): PriorityModel {
  const now = useCoarseNow(30_000);
  const ids = useMemo(() => linkedSessionIds([row]), [row]);
  const live = usePriorityLiveStates(ids, now, inbox, focusedId);
  return useMemo(() => buildModels([row], history, live, days)[0], [row, history, live, days]);
}

/** Every pull request (`owner/repo#N`) the milestones of `rows` name, sorted, once each. */
export function linkedPrRefs(rows: ReadonlyArray<{ steps: ReadonlyArray<{ refs: ReadonlyArray<{ kind: string; id: string }> }> }>): string[] {
  return [...new Set(rows.flatMap((r) => r.steps.flatMap((st) => st.refs.filter((x) => x.kind === "pr").map((x) => x.id))))].sort();
}

/**
 * The lookups for the linked sessions (`sessionIds`), pull requests
 * (`prRefs`) and the workspaces (`workspaces`: the drawn priorities' own) a
 * surface draws. One subscription to a signature of just their branches and
 * states, so a branch or a PR's state changing repaints its chip, and nothing
 * else in those collections wakes it.
 */
export function usePriorityLookups(sessionIds: readonly string[], prRefs: readonly string[], workspaces: readonly string[]): LinkLookups {
  const deploys = useWorkspacesCollection<TeamDeployRow>("teamDeploys", (d) => `${d.status}:${d.live_at ?? ""}:${d.sessions.length}:${d.tasks?.length ?? 0}`, workspaces);
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
    deploysOf: (m, workspace) => deploysFor(m, workspace, deploys),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature is what the getState() reads above wake on
  }), [deploys, sig]);
}
