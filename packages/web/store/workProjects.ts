// The project each inbox session works in, read off the store with the one
// rule every reader shares (docs/architecture/session-projects.md SP1): a
// session's own pick, else its bound task's or plan's project, else its
// parent's. Nothing is stored per session here; the map is derived from the
// sessions, tasks and plans already in the store and memoized on a digest of
// the session fields the rule reads and the tasks' and plans' refs.
//
// Projects filter the inbox on the same chip axis as folders, under their own
// key (`pj:<id>`), so a project chip and a folder chip are separate chips that
// share every gesture: include, exclude, shift-add, history.

import { sessionProjectId, type SessionProjectRow } from "@codecast/shared/contracts/sessionProject";
import { makeCollectionSig } from "./wakeSig";

export const WORK_PROJECT_CHIP_PREFIX = "pj:";
export const workProjectChipKey = (projectId: string): string => `${WORK_PROJECT_CHIP_PREFIX}${projectId}`;
export function workProjectIdOfChipKey(key: string | null | undefined): string | null {
  return key?.startsWith(WORK_PROJECT_CHIP_PREFIX) ? key.slice(WORK_PROJECT_CHIP_PREFIX.length) : null;
}

type SessionLike = {
  _id: string;
  project_id?: string | null;
  active_task?: { _id: string } | null;
  active_plan?: { _id: string } | null;
  parent_conversation_id?: string | null;
  spawned_by_conversation_id?: string | null;
};

export type WorkProjectSource = {
  sessions: Record<string, SessionLike>;
  tasks?: Record<string, { project_id?: string | null }>;
  plans?: Record<string, { project_id?: string | null }>;
};

// The fields of a session the rule reads. A heartbeat hands back a new
// `sessions` ref without touching any of them, so the map is keyed on this
// digest (each unchanged row's hash is cached by its ref) and a beat rebuilds
// nothing: every card's selector reads the same map.
const projectFieldsSig = makeCollectionSig<SessionLike>((s) =>
  `${s.project_id ?? ""}|${s.active_task?._id ?? ""}|${s.active_plan?._id ?? ""}|${s.parent_conversation_id ?? ""}|${s.spawned_by_conversation_id ?? ""}`);

let memo: { sig: string; tasks: unknown; plans: unknown; byId: Map<string, string | null> } | null = null;

/** The project of every session in the store, by conversation id (null: none). */
export function workProjectsBySession(state: WorkProjectSource): ReadonlyMap<string, string | null> {
  const sig = projectFieldsSig(state.sessions);
  if (memo && memo.sig === sig && memo.tasks === state.tasks && memo.plans === state.plans) return memo.byId;
  const row = (s: SessionLike): SessionProjectRow => ({
    _id: s._id,
    project_id: s.project_id,
    active_task_id: s.active_task?._id,
    active_plan_id: s.active_plan?._id,
    parent_conversation_id: s.parent_conversation_id,
    spawned_by_conversation_id: s.spawned_by_conversation_id,
  });
  const lookup = {
    session: (id: string) => {
      const s = state.sessions[id];
      return s ? row(s) : undefined;
    },
    taskProject: (id: string) => state.tasks?.[id]?.project_id ?? null,
    planProject: (id: string) => state.plans?.[id]?.project_id ?? null,
  };
  const byId = new Map<string, string | null>();
  for (const s of Object.values(state.sessions)) byId.set(s._id, sessionProjectId(row(s), lookup));
  memo = { sig, tasks: state.tasks, plans: state.plans, byId };
  return byId;
}

/** A session's project, for one row (the map above when it holds the row). */
export function workProjectOf(state: WorkProjectSource, sessionId: string): string | null {
  return workProjectsBySession(state).get(sessionId) ?? null;
}

/** What a project-axis chip shows: a project's title for a `pj:` key, the
 *  folder name otherwise. */
export function projectChipLabel(key: string, projects?: Record<string, { title?: string; short_id?: string } | undefined>): string {
  const id = workProjectIdOfChipKey(key);
  if (!id) return key;
  const project = projects?.[id];
  return project?.title || project?.short_id || "Project";
}
