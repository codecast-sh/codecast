import { workProjectChipKey, workProjectsBySession, type WorkProjectSource } from "../store/workProjects";

export const WORK_PROJECT_SEP = "\u0000";

type SigState = WorkProjectSource & {
  projects: Record<string, { title?: string; color?: string }>;
  activeProjectFilter?: string | null;
  chipFilterExclude?: boolean;
  extraProjectFilters?: unknown[] | null;
};

/** The card's project as one short string (id, colour, title), empty when it
 *  has none or the inbox already shows only that project. */
export function workProjectSig(s: SigState, sessionId: string): string {
  const pid = workProjectsBySession(s).get(sessionId);
  const p = pid ? s.projects[pid] : undefined;
  if (!pid || !p) return "";
  if (s.activeProjectFilter === workProjectChipKey(pid) && !s.chipFilterExclude && !s.extraProjectFilters?.length) return "";
  return [pid, p.color ?? "", p.title ?? ""].join(WORK_PROJECT_SEP);
}
