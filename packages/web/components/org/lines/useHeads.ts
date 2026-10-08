// The head of a role and of a person, worked out once for every place that
// introduces them (a sheet, a hover card, the role page's header, a summary):
// what they answer for, and the facts, Serves and Carried by those make.
import { useMemo } from "react";
import { personRefOf, type OrgObjectKind } from "@codecast/shared/entities";
import type { InitiativeRow } from "@codecast/shared/contracts/initiative";
import { useInboxStore, type ProjectItem } from "../../../store/inboxStore";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useInitiatives } from "../../../hooks/useInitiatives";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { roleInitiatives } from "../../../lib/roleInitiatives";
import { rolesInTreeOrder } from "../staffingModel";
import { roleWords } from "../orgStaffingTypes";
import type { SummaryCarried } from "./ObjectSummary";
import type { OrgRole } from "../orgTypes";
import { namedLead } from "./lineData";
import { personFacts, roleFacts, type LinePerson } from "./lineFacts";
import { useLineTree } from "./lineTree";

type Named = { kind: OrgObjectKind; ref: string; title: string };
const projectSig = (p: ProjectItem) => `${p.title}|${p.status}|${p.short_id ?? ""}|${p.owner_role_id ?? ""}|${p.color ?? ""}|${p.target_date ?? ""}`;
const goalNamed = (g: InitiativeRow): Named => ({ kind: "initiative", ref: g.short_id || g._id, title: g.title });

/** A role's head, worked out once for every place that introduces the role
 *  (its sheet, its hover card, the role page's header): whom it reports to,
 *  the projects it leads, the roles under it, the goals it drives, and the
 *  facts, Serves and Carried by those make. */
export function useRoleHead(role: OrgRole) {
  const all = useInitiatives();
  const tree = useLineTree();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const now = useCoarseNow(60_000);
  return useMemo(() => {
    const live = rolesInTreeOrder(tree);
    const parentRole = role.reports_to.kind === "role" ? live.find((r) => r._id === (role.reports_to as { role_id: string }).role_id) : undefined;
    const parent = parentRole ? roleWords(parentRole).name : tree?.people.find((p) => p.user_id === (role.reports_to as { user_id: string }).user_id)?.name;
    const leads = projects.filter((p) => namedLead(p, live)?._id === role._id);
    const under = live.filter((r) => r.reports_to.kind === "role" && r.reports_to.role_id === role._id);
    const goals = roleInitiatives(role._id, role.scope.project_ids, all);
    // The projects it leads and the roles under it, by name: the facts leave them to this line.
    const carried: SummaryCarried = { label: "Carries", names: [...leads.map((p) => p.title), ...under.map((r) => roleWords(r).name)] };
    const facts = roleFacts({ role, reportsTo: parent ? { name: parent } : null, leads, goals: goals.filter((g) => g.owned), charter: role.charter }, now, true);
    const serves: Named[] = goals.map((g) => ({ kind: "initiative", ref: g.ref || g.id, title: g.title }));
    return { words: roleWords(role), leads, under, goals, facts, serves, carried, now };
  }, [role, tree, projects, all, now]);
}

type MemberRow = { _id: string; name?: string; image?: string; github_avatar_url?: string; github_username?: string; joined_at?: number };

/** A person's head, worked out once for their sheet, their hover card and
 *  their summary: who they are (the org tree when it holds them, else the
 *  roster), the roles they host or that report to them, the goals they own,
 *  the projects their roles lead, and the facts, Serves and Carried by those
 *  make. `ref` is a user id or a handle. Null while neither knows them. */
export function usePersonHead(ref: string | null) {
  const all = useInitiatives();
  const tree = useLineTree();
  const projects = useWorkspaceCollection<ProjectItem>("projects", projectSig);
  const now = useCoarseNow(60_000);
  const key = ref ? ref.replace(/^@/, "") : "";
  // The member fields the head reads, as a signature: the roster re-pushes on every heartbeat.
  const memberSig = useInboxStore((s) => {
    if (!key) return "";
    const low = key.toLowerCase();
    const m = ((s.teamMembers ?? []) as MemberRow[]).find((x) => String(x._id) === key || x.github_username?.toLowerCase() === low);
    return m ? JSON.stringify([String(m._id), m.name ?? "", m.image ?? m.github_avatar_url ?? "", m.github_username ?? "", m.joined_at ?? 0]) : "";
  });
  return useMemo(() => {
    const [memberId, memberName, memberImage, handle, joined] = memberSig ? (JSON.parse(memberSig) as [string, string, string, string, number]) : [null, "", "", "", 0];
    const userId = memberId ?? (tree?.people.some((p) => p.user_id === key) ? key : null);
    const person = userId ? tree?.people.find((p) => p.user_id === userId) ?? null : null;
    const name = person?.name || memberName;
    if (!userId || !name) return null;
    const live = rolesInTreeOrder(tree);
    const roles = live.filter((r) => (r.reports_to.kind === "user" && r.reports_to.user_id === userId) || r.host_user_id === userId);
    const roleIds = new Set(roles.map((r) => r._id));
    const leads = projects.filter((p) => { const lead = namedLead(p, live); return !!lead && roleIds.has(lead._id); });
    const goals = all.filter((g) => g.owner?.kind === "user" && g.owner.user_id === userId && g.status !== "completed" && g.status !== "cancelled");
    const image = person?.image || memberImage || undefined;
    const line: LinePerson = { id: userId, name, image, me: !!person?.is_me, ref: personRefOf({ _id: userId, github_username: handle || undefined }), access: person?.role, presence: person?.presence, sessions: person?.counts ?? null, ...(joined ? { joined_at: joined } : {}), roles, goals };
    // Their roles by name; the goals they own are its Serves. The facts keep only what is live.
    const carried: SummaryCarried = { label: "Carries", names: roles.map((r) => roleWords(r).name) };
    return { userId, name, image, handle: handle || null, person, line, roles, goals, leads, facts: personFacts(line, now, { named: true }), serves: goals.map(goalNamed), carried, now };
  }, [memberSig, key, tree, projects, all, now]);
}

