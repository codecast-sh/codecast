// The project each inbox session works in, read off the store with the one
// rule every reader shares (docs/architecture/session-projects.md SP1): a
// session's own pick, else its bound task's (the task's own, else its plan's)
// or bound plan's project, else its
// parent's. Nothing is stored per session here; the map is derived from the
// sessions, tasks and plans already in the store and memoized on a digest of
// the session fields the rule reads and the tasks' and plans' refs.
//
// Projects filter the inbox on the same chip axis as folders, under their own
// key (`pj:<id>`), so a project chip and a folder chip are separate chips that
// share every gesture: include, exclude, shift-add, history.

import { sessionProjectId, type SessionProjectRow } from "@codecast/shared/contracts/sessionProject";
import { deviceDisplayName, type DeviceNameSource } from "@codecast/shared/contracts";
import { makeCollectionSig } from "./wakeSig";

export const WORK_PROJECT_CHIP_PREFIX = "pj:";
export const workProjectChipKey = (projectId: string): string => `${WORK_PROJECT_CHIP_PREFIX}${projectId}`;
export function workProjectIdOfChipKey(key: string | null | undefined): string | null {
  return key?.startsWith(WORK_PROJECT_CHIP_PREFIX) ? key.slice(WORK_PROJECT_CHIP_PREFIX.length) : null;
}

// Machines share the axis too (`mc:<device_id>`, the session's owner_device_id):
// "only what runs on this laptop" or "everything but the laptop" is the same
// include/exclude gesture as a folder.
export const MACHINE_CHIP_PREFIX = "mc:";
export const machineChipKey = (deviceId: string): string => `${MACHINE_CHIP_PREFIX}${deviceId}`;
export function machineIdOfChipKey(key: string | null | undefined): string | null {
  return key?.startsWith(MACHINE_CHIP_PREFIX) ? key.slice(MACHINE_CHIP_PREFIX.length) : null;
}

// And the viewer's priorities (`pr:<n>`): a session answers to `pr:3` when it
// serves one of their three highest-ranked priorities in the active workspace.
export const PRIORITY_CHIP_PREFIX = "pr:";
export const PRIORITY_TOP_NS = [3, 5, 10] as const;
export const priorityChipKey = (topN: number): string => `${PRIORITY_CHIP_PREFIX}${topN}`;
export function priorityTopNOfChipKey(key: string | null | undefined): number | null {
  if (!key?.startsWith(PRIORITY_CHIP_PREFIX)) return null;
  const n = Number(key.slice(PRIORITY_CHIP_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}
/** Whether a key's menu row and chip show a count. A Top N row shows none:
 *  what its filter keeps differs by view (a grouped card stays for a nested
 *  worker that matches, a flat list drops it), so no one number is true. */
export function axisKeyShowsCount(key: string): boolean {
  return priorityTopNOfChipKey(key) == null;
}

/** The `pr:` keys a session with this rank answers to (none without a rank). */
export function priorityChipKeysOf(rank: number | null | undefined): string[] {
  return rank == null ? [] : PRIORITY_TOP_NS.filter((n) => rank <= n).map(priorityChipKey);
}

/** A chip-axis key as people read it: a project's title, a machine's name
 *  (from the viewer's roster), "Top 3" for a priority key, else the folder
 *  name it already is. */
export function projectAxisLabel(
  key: string,
  projects: Parameters<typeof projectChipLabel>[1],
  machineOf: (deviceId: string) => DeviceNameSource | undefined,
): string {
  const topN = priorityTopNOfChipKey(key);
  if (topN != null) return `Top ${topN}`;
  const deviceId = machineIdOfChipKey(key);
  return deviceId ? deviceDisplayName(machineOf(deviceId)) : projectChipLabel(key, projects);
}

/** What a chip-axis key names, for copy ("Hide this machine"). */
export function projectAxisNoun(key: string): "project" | "machine" | "priority" | "folder" {
  return workProjectIdOfChipKey(key) ? "project" : machineIdOfChipKey(key) ? "machine" : priorityTopNOfChipKey(key) != null ? "priority" : "folder";
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
  tasks?: Record<string, { project_id?: string | null; plan_id?: string | null }>;
  plans?: Record<string, { project_id?: string | null }>;
};

// The fields of a session the rule reads. A heartbeat hands back a new
// `sessions` ref without touching any of them, so the map is keyed on this
// digest (each unchanged row's hash is cached by its ref) and a beat rebuilds
// nothing: every card's selector reads the same map.
const projectFieldsSig = makeCollectionSig<SessionLike>((s) =>
  `${s.project_id ?? ""}|${s.active_task?._id ?? ""}|${s.active_plan?._id ?? ""}|${s.parent_conversation_id ?? ""}|${s.spawned_by_conversation_id ?? ""}`);

// One adapter per session row object: a rebuild walks every row (and every
// child walks its parents), and allocating each time was most of its cost.
const rowsBySession = new WeakMap<SessionLike, SessionProjectRow>();
const row = (s: SessionLike): SessionProjectRow => {
  let r = rowsBySession.get(s);
  if (!r) rowsBySession.set(s, (r = adapt(s)));
  return r;
};
const adapt = (s: SessionLike): SessionProjectRow => ({
  _id: s._id,
  project_id: s.project_id,
  active_task_id: s.active_task?._id,
  active_plan_id: s.active_plan?._id,
  parent_conversation_id: s.parent_conversation_id,
  spawned_by_conversation_id: s.spawned_by_conversation_id,
});

const lookupOf = (state: WorkProjectSource) => ({
  session: (id: string) => {
    const s = state.sessions[id];
    return s ? row(s) : undefined;
  },
  taskProject: (id: string) => state.tasks?.[id]?.project_id ?? null,
  taskPlan: (id: string) => state.tasks?.[id]?.plan_id ?? null,
  planProject: (id: string) => state.plans?.[id]?.project_id ?? null,
});

// Tasks and plans by the fields the rule reads, so a status or title write on
// a task (the common one) rebuilds nothing.
const taskProjectSig = makeCollectionSig<{ project_id?: string | null; plan_id?: string | null }>((t) => `${t.project_id ?? ""}|${t.plan_id ?? ""}`);
const planProjectSig = makeCollectionSig<{ project_id?: string | null }>((p) => p.project_id ?? "");
const EMPTY_ROWS = {};

let memo: { sig: string; byId: Map<string, string | null> } | null = null;

/** The project of every session in the store, by conversation id (null: none). */
export function workProjectsBySession(state: WorkProjectSource): ReadonlyMap<string, string | null> {
  const sig = `${projectFieldsSig(state.sessions)}\x1f${taskProjectSig(state.tasks ?? EMPTY_ROWS)}\x1f${planProjectSig(state.plans ?? EMPTY_ROWS)}`;
  if (memo && memo.sig === sig) return memo.byId;
  const lookup = lookupOf(state);
  const byId = new Map<string, string | null>();
  const resolved = new Map<string, string | null>();
  for (const s of Object.values(state.sessions)) byId.set(s._id, sessionProjectId(row(s), lookup, resolved));
  memo = { sig, byId };
  return byId;
}

/** A session's project, for one row (the map above when it holds the row). */
export function workProjectOf(state: WorkProjectSource, sessionId: string): string | null {
  return workProjectsBySession(state).get(sessionId) ?? null;
}

/** The project of a row that may not be in `state.sessions` (its parents are read from there). */
export function workProjectOfRow(state: WorkProjectSource, s: SessionLike): string | null {
  const by = workProjectsBySession(state);
  return by.has(s._id) ? by.get(s._id) ?? null : sessionProjectId(row(s), lookupOf(state));
}

/** What a project-axis chip shows: a project's title for a `pj:` key, the
 *  folder name otherwise. */
export function projectChipLabel(key: string, projects?: Record<string, { title?: string; short_id?: string } | undefined>): string {
  const id = workProjectIdOfChipKey(key);
  if (!id) return key;
  const project = projects?.[id];
  return project?.title || project?.short_id || "Project";
}
