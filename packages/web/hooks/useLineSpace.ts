"use client";
// The workspace /line reads (lib/line/lineSpaces.ts, line-journeys.md LJ5):
// the workspaces holding problems, which one is read, and the pick. The page
// wraps itself in WorkspaceScopeProvider with `key`, so every reader under it
// reads that workspace whatever the app's active one is.
import { useCallback, useMemo, useState } from "react";
import { useInboxStore } from "../store/inboxStore";
import { decisionTask } from "../lib/line/fixDecision";
import { lineSpaces, pickLineSpace, readLastLineSpace, rememberLineSpace, type LineSpace } from "../lib/line/lineSpaces";
import { resolveLineProject, type LineSelection } from "../lib/line/lineWorkspaceUrl";
import { activeWorkspaceKeyOf, type WorkspaceKey } from "../lib/workspaceScope";

type Row = { _id?: string; short_id?: string; cause?: unknown; status?: string; workspace?: string | null; title?: string };
type State = ReturnType<typeof useInboxStore.getState>;

// The scan reads every cached task (every workspace the sync log follows), so it runs once per tasks ref and teams
// ref, and the subscriber compares a string.
const spacesCache = new WeakMap<object, { teams: unknown; viewer: string | null; sig: string }>();
function spacesSig(s: State): string {
  const tasks = s.tasks as unknown as Record<string, Row>;
  const teams = (s as { teams?: unknown }).teams;
  const viewer = s.currentUser?._id ? String(s.currentUser._id) : null;
  const hit = spacesCache.get(tasks);
  if (hit && hit.teams === teams && hit.viewer === viewer) return hit.sig;
  const own: Row[] = [];
  for (const id in tasks) if (tasks[id] && String(tasks[id]._id) === id) own.push(tasks[id]);
  const list = Array.isArray(teams) ? teams : Object.values((teams ?? {}) as Record<string, { _id?: string; name?: string }>);
  const sig = JSON.stringify(lineSpaces(own, list as Array<{ _id?: string; name?: string }>, viewer));
  spacesCache.set(tasks, { teams, viewer, sig });
  return sig;
}

const refCache = new WeakMap<object, Map<string, string | null>>();

/** The workspace a linked thing lives in: the problem, need or decision the address names, or the project it filters to. */
function linkedWorkspace(s: State, sel: Pick<LineSelection, "need" | "case" | "decision" | "project">): string | null {
  const tasks = s.tasks as unknown as Record<string, Row>;
  const taskWs = (ref: string | null | undefined): string | null => {
    if (!ref) return null;
    const direct = tasks[ref];
    if (direct?.workspace) return direct.workspace;
    let refs = refCache.get(tasks);
    if (!refs) { refs = new Map(); refCache.set(tasks, refs); }
    if (!refs.has(ref)) {
      let ws: string | null = null;
      for (const id in tasks) { const t = tasks[id]; if (t?.short_id === ref && t.workspace) { ws = t.workspace; break; } }
      refs.set(ref, ws);
    }
    return refs.get(ref) ?? null;
  };
  const decisionWs = (ref: string | null | undefined) => {
    if (!ref) return null;
    const task = decisionTask(s.sessionDecisions as never, (s as { lineCards?: never }).lineCards, ref);
    return task ? taskWs(task) : null;
  };
  const need = sel.need;
  const fromNeed = need ? (need.startsWith("sd-") ? decisionWs(need) : taskWs(need)) : null;
  if (fromNeed) return fromNeed;
  const fromCase = taskWs(sel.case);
  if (fromCase) return fromCase;
  const fromDecision = decisionWs(sel.decision);
  if (fromDecision) return fromDecision;
  if (sel.project) {
    const projects = Object.values((s.projects ?? {}) as Record<string, Row & { _id: string }>);
    const id = resolveLineProject(sel.project, projects);
    return id ? projects.find((p) => p._id === id)?.workspace ?? null : null;
  }
  return null;
}

export type LineSpaceState = {
  /** The workspace /line reads; null when no workspace has a problem (the app's active one holds). */
  key: WorkspaceKey | null;
  /** Every workspace with problems, busiest first. */
  spaces: LineSpace[];
  /** Read another workspace, remembered on this device. */
  pick: (key: WorkspaceKey) => void;
};

export function useLineSpace(sel: LineSelection): LineSpaceState {
  const sig = useInboxStore(spacesSig);
  const spaces = useMemo(() => JSON.parse(sig) as LineSpace[], [sig]);
  const linked = useInboxStore((s) => linkedWorkspace(s, sel));
  const active = useInboxStore(activeWorkspaceKeyOf);
  const [remembered, setRemembered] = useState(readLastLineSpace);
  const key = pickLineSpace(spaces, [linked], remembered) ?? active;
  const pick = useCallback((k: WorkspaceKey) => { rememberLineSpace(k); setRemembered(k); }, []);
  return useMemo(() => ({ key, spaces, pick }), [key, spaces, pick]);
}
