// Which workspace /line reads (line-journeys.md LJ5 "Workspace"). /line reads
// one workspace of its own, never silently the app's active one: a founder
// whose app sits on Personal still lands on the team his lines run in. A
// workspace is offered when it holds problems (cause tasks); the one read is,
// in order: the workspace of the thing a link names (a
// need, a decision, a problem), the one last picked on this device, else the
// one with the most problems not closed. Picking another is remembered on the
// device; a link carries its workspace through the thing it names. Pure, so a test reads it.
import type { WorkspaceKey } from "../workspaceScope";

export type LineSpace = {
  key: WorkspaceKey;
  /** The team's name, "Personal" for the viewer's own. */
  name: string;
  /** Problems not done or dropped. */
  open: number;
  problems: number;
};

type CauseRow = { cause?: unknown; status?: string; workspace?: string | null };
type TeamRow = { _id?: string; name?: string };

const terminal = (status?: string) => status === "done" || status === "dropped";

/** The workspaces with problems, busiest first (open problems, then all), the viewer's Personal last on a tie. */
export function lineSpaces(tasks: Iterable<CauseRow>, teams: ReadonlyArray<TeamRow>, viewerId: string | null): LineSpace[] {
  const own = viewerId ? `user:${viewerId}` : null;
  const teamName = new Map(teams.map((t) => [`team:${t._id}`, t.name ?? "Team"]));
  const by = new Map<string, { open: number; problems: number }>();
  for (const t of tasks) {
    if (!t.cause || !t.workspace) continue;
    // Only the viewer's own workspaces: a cached row of a team they left, or of another person, is not offered.
    if (t.workspace !== own && !teamName.has(t.workspace)) continue;
    const n = by.get(t.workspace) ?? { open: 0, problems: 0 };
    n.problems++;
    if (!terminal(t.status)) n.open++;
    by.set(t.workspace, n);
  }
  return [...by].map(([key, n]) => ({ key, name: key === own ? "Personal" : teamName.get(key)!, ...n }))
    .sort((a, b) => b.open - a.open || b.problems - a.problems || Number(a.key === own) - Number(b.key === own) || a.name.localeCompare(b.name));
}

/** The workspace /line reads: the first of `asked` (the linked thing's) that is offered, then `remembered`
 *  that is offered, else the busiest. Null when no workspace has a problem: the app's active one holds. */
export function pickLineSpace(spaces: ReadonlyArray<LineSpace>, asked: ReadonlyArray<string | null | undefined>, remembered: string | null): WorkspaceKey | null {
  const offered = (k: string | null | undefined): k is string => !!k && spaces.some((s) => s.key === k);
  for (const k of asked) if (offered(k)) return k;
  if (offered(remembered)) return remembered;
  return spaces[0]?.key ?? null;
}

const STORE = "line.workspace";
export function readLastLineSpace(): string | null {
  try { return typeof localStorage === "undefined" ? null : localStorage.getItem(STORE); } catch { return null; }
}
export function rememberLineSpace(key: string): void {
  try { localStorage.setItem(STORE, key); } catch { /* private mode: the pick lasts the page */ }
}
