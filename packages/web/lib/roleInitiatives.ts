// The initiatives a role's scope view lists (docs/architecture/
// initiatives-projects-role-page.md I1 "Everywhere else"): the ones the role
// owns first, then the ones its projects contribute to. Pure over store rows
// and derived at render, like the rest of the scope (lib/roleScope): nothing
// here is stored, so setting an owner or adding a project shows at once.
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";

export type RoleInitiative = {
  id: string;
  ref: string;
  title: string;
  health: InitiativeRow["health"];
  /** When the owner last said it. */
  health_at?: number;
  /** The role drives it; otherwise its projects only contribute to it. */
  owned: boolean;
  /** How many of the role's projects carry it. */
  projects: number;
};

/** How the role stands to the goal, in words: it drives it, or its projects carry it. */
export const initiativeRelation = (i: RoleInitiative): string =>
  i.owned ? "drives it" : `through ${i.projects} ${i.projects === 1 ? "project" : "projects"}`;

const CLOSED: ReadonlySet<string> = new Set(["completed", "cancelled"]);

/** `projectIds` is the role's scope, or every project of the workspace for a
 *  role that looks after all of it. */
export function roleInitiatives(roleId: string, projectIds: readonly string[], initiatives: readonly InitiativeRow[]): RoleInitiative[] {
  const mine = new Set(projectIds.map(String));
  const rows: RoleInitiative[] = [];
  for (const i of initiatives) {
    if (CLOSED.has(i.status)) continue;
    const owned = i.owner?.kind === "role" && String(i.owner.role_id) === String(roleId);
    const projects = i.project_ids.filter((id) => mine.has(String(id))).length;
    if (owned || projects > 0) rows.push({ id: String(i._id), ref: i.short_id, title: i.title, health: i.health, health_at: i.health_at, owned, projects });
  }
  // Owned first; inside each group, the order the store holds them in.
  return rows.sort((a, b) => Number(b.owned) - Number(a.owned));
}
