// An initiative's projects as the scope view's project rows
// (docs/architecture/initiatives-projects-role-page.md I1, I2). The rollup a
// project shows (open and done tasks, its plans with progress, the sessions at
// work in it by who acts next) has one definition, `buildRoleScope`; here the
// "scope" is the initiative's project list, so the initiative page and a
// role's page draw the same card from the same numbers. Paints from the store
// and mounts no feeder.
import { useMemo } from "react";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore } from "../store/inboxStore";
import { buildRoleScope, type RoleScopeSource, type ScopeProject } from "../lib/roleScope";
import { boundTaskOf } from "../lib/scopePage";
import type { OrgSession, OrgTree } from "../components/org/orgTypes";
import { useScopeRows } from "./useRoleScope";

/** Every session the tree carries, under a person or a role. */
const treeSessions = (tree: OrgTree | null | undefined): OrgSession[] =>
  tree ? [...tree.people.flatMap((p) => p.sessions), ...tree.roles.flatMap((r) => r.sessions)] : [];

const NO_FACTS = { role_id: null, short_id: "", name: "", handle: "", whole: false, plans: [], charter: "", reportsTo: null, reports: [], counts: null, total: 0, caps: null, counters: null } satisfies Omit<RoleScopeSource, "projects">;

export function useInitiativeProjects(initiative: Pick<InitiativeRow, "project_ids"> | null): ScopeProject[] {
  const rows = useScopeRows();
  // Which sessions are at work, and on what: their state and the task each is
  // bound to. A heartbeat changes neither, so it wakes nothing here.
  const sessionSig = useInboxStore((s) => treeSessions(s.orgTree).map((x) => `${x._id}|${x.state}|${(s.sessions[x._id] as any)?.active_task_id ?? ""}`).join("\n"));
  const order = initiative?.project_ids.join(",") ?? "";

  return useMemo(() => {
    if (!order) return [];
    const st = useInboxStore.getState();
    const ids = order.split(",");
    const held = new Map(rows.projects.map((p) => [p._id, p]));
    // A project the viewer cannot read is not in the store: it is left out
    // rather than drawn as a bare id.
    const projects = ids.filter((id) => held.has(id)).map((id) => ({ id, title: held.get(id)!.title, short_id: held.get(id)!.short_id }));
    const sessions = treeSessions(st.orgTree).map((x) => ({
      state: x.state,
      task_id: boundTaskOf(x._id, (st.sessions[x._id] as any)?.active_task_id ?? null, rows.tasks)?._id ?? null,
    }));
    const model = buildRoleScope({ ...NO_FACTS, projects }, { ...rows, sessions } as any, new Date().toISOString().slice(0, 10));
    // The owner arranged the projects; the model's own order is a role's.
    const at = new Map(ids.map((id, i) => [id, i]));
    return model.projects.filter((p) => !p.partial).sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
  }, [order, rows.projects, rows.plans, rows.tasks, rows.roles, sessionSig]); // eslint-disable-line react-hooks/exhaustive-deps
}
