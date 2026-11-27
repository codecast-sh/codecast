// The folder a milestone's Start opens the composer in, so the session lands
// where its link to a team priority can hold (dispatch createSession keeps a
// session in the team its folder rule names, and never widens sharing): a
// folder the person maps to the priority's team with auto-share, the most
// recently used first; else one mapped to that team without auto-share (its
// session stays as private as the folder keeps it: sharing is the person's
// own pick, never a default this sets); else nothing, and the composer starts
// where it always does. Both apps.
import { matchDirectoryMapping } from "@codecast/shared/team/directoryRules";
import { lookup } from "./liveEntities";
import { pathOnMyMachines, type MachineCandidate } from "./machinePicker";
import { settingsDataKey } from "./settingsData";

/** A folder rule as getDirectoryTeamMappings answers it. */
export type FolderRule = { path_prefix: string; team_id?: string | null; auto_share: boolean; private?: boolean; repository?: string };

export type StartFolder = { path: string };

/**
 * `recentPaths`: the person's folders, most recently used first; the rules'
 * own folders follow them. `usable`: a folder this person can start in (on
 * one of their machines). A candidate counts by the rule that governs it, so
 * a private lock inside a team's folder keeps that subfolder out.
 */
export function startFolderFor(
  priorityWorkspace: string | undefined,
  rules: readonly FolderRule[] | null | undefined,
  recentPaths: readonly string[],
  usable: (path: string) => boolean = () => true,
): StartFolder | null {
  if (!priorityWorkspace?.startsWith("team:") || !rules?.length) return null;
  const team = priorityWorkspace.slice("team:".length);
  const candidates = [...new Set([...recentPaths, ...rules.map((r) => r.path_prefix)])].filter((p) => p && usable(p));
  const ruleOf = (path: string) => matchDirectoryMapping(rules as FolderRule[], path);
  const mappedHere = (path: string, autoShare: boolean) => {
    const rule = ruleOf(path);
    return !!rule && !rule.private && String(rule.team_id ?? "") === team && !!rule.auto_share === autoShare;
  };
  const shared = candidates.find((p) => mappedHere(p, true));
  if (shared) return { path: shared };
  const mapped = candidates.find((p) => mappedHere(p, false));
  return mapped ? { path: mapped } : null;
}

/** What the store reads for it: the priority's row, the person's folder rules and recent folders, their machines. */
type StartFolderState = {
  priorities?: Record<string, { workspace?: string } | undefined>;
  settingsData?: Record<string, { value?: unknown } | undefined>;
  currentUser?: { _id?: unknown } | null;
  recentProjects?: ReadonlyArray<{ path: string }>;
  machineRoster?: ReadonlyArray<Pick<MachineCandidate, "local_project_roots">>;
};

/** The Start folder for priority `shortId` off the store, or null (lib/priorityStartFolder startFolderFor). */
export function startFolderInStore(st: StartFolderState, shortId: string): StartFolder | null {
  const priority = lookup(st.priorities as Record<string, any>, shortId) as { workspace?: string } | undefined;
  const key = settingsDataKey("directoryMappings", st.currentUser?._id ? String(st.currentUser._id) : null);
  const rules = (key ? st.settingsData?.[key]?.value : undefined) as FolderRule[] | undefined;
  const roster = (st.machineRoster ?? []) as MachineCandidate[];
  return startFolderFor(priority?.workspace, rules, (st.recentProjects ?? []).map((p) => p.path), (p) => pathOnMyMachines(roster, p));
}
