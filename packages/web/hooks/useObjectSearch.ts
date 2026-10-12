// Every kind of object a search can name besides conversations, answered from
// the local store as the person types: to-dos, plans, notes, routines,
// projects, goals, roles, people and published pages. The matchers are the
// palette's (lib/universalSearch), so /search and Cmd+K agree on what a query
// finds. Each hit carries the object's own row, so a list draws it with the
// same marks and facts its card does (components/search/ObjectHit).
import { useMemo } from "react";
import type { EntityType } from "@codecast/shared/entities";
import { entityRoute, objectHref, personRefOf } from "@codecast/shared/entities";
import { isPerson } from "@codecast/shared/team/memberKind";
import { useInboxStore } from "../store/inboxStore";
import { useCollectionRows } from "./useCollectionRows";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { triggerSig } from "./useSyncTriggers";
import { useOrgRoles } from "./useOrgRoles";
import { useArtifacts } from "./useSyncArtifacts";
import {
  assistantSearchIndex, humanSearchIndex, matchGoals, matchMentionGroups, matchProjects,
  matchRoles, matchRoutines, matchRows, openTasksFirst,
} from "../lib/universalSearch";
import { isAssistantRoutine, withinScope } from "../lib/assistantScope";
import { memberDisplayName } from "../lib/liveEntities";
import { useModeWords, useSurfaceMode } from "../lib/surfaces";

/** The kinds the search page lists, in the order its tabs and groups read. */
export type ObjectKind = "task" | "plan" | "doc" | "trigger" | "project" | "initiative" | "role" | "person" | "page";

export type ObjectHit = {
  key: string;
  kind: ObjectKind;
  /** The entity kind whose marks and facts the row draws; pages have none. */
  type: EntityType | null;
  /** The object's row: the store's when it holds one, else the index's. */
  entity: any;
  title: string;
  href: string;
  /** Opens outside the app (a published page). */
  external?: boolean;
  at?: number;
};

/** An object's page, by its id (the address the palette opens). The module
 *  stays free of web-only imports: the phone's search reads this hook too. */
const pagePath = (type: "task" | "plan" | "doc" | "trigger", row: { _id: unknown }) => entityRoute(type, String(row._id)) ?? "/";

export type ObjectGroup = { kind: ObjectKind; label: string; hits: ObjectHit[] };

/** A kind's name as the app calls it in the viewer's mode (To-dos, Notes and
 *  Routines in hosted mode). */
export function objectKindLabel(kind: ObjectKind, words: ReturnType<typeof useModeWords>): string {
  switch (kind) {
    case "task": return words.tasksPage;
    case "doc": return words.docsPage;
    case "trigger": return words.triggers;
    case "plan": return "Plans";
    case "project": return "Projects";
    case "initiative": return "Goals";
    case "role": return "Roles";
    case "person": return "People";
    case "page": return "Pages";
  }
}

export function useObjectSearch(query: string, { scopeOnly, cap }: { scopeOnly: boolean; cap: number }): ObjectGroup[] {
  const words = useModeWords();
  const surface = useSurfaceMode();
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? undefined);
  const routines = useCollectionRows<any>("agentTasks", { sig: triggerSig });
  const projects = useWorkspaceCollection<any>("projects");
  const goals = useWorkspaceCollection<any>("initiatives");
  const { roles } = useOrgRoles();
  const { artifacts } = useArtifacts();
  const orgShown = surface.showsPage("/org");

  return useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    // Read at the query's change, not on every entity sync: the store's
    // collections churn and the page need not repaint with them.
    const st = useInboxStore.getState();
    const index = scopeOnly ? assistantSearchIndex(st) : humanSearchIndex(st);
    const { tasks, docs, plans } = matchMentionGroups(index, q, teamId, cap);
    const own = (coll: Record<string, any> | undefined, row: any) => coll?.[String(row._id)] ?? row;
    const groups: ObjectGroup[] = [
      {
        kind: "task", label: objectKindLabel("task", words),
        hits: openTasksFirst(tasks).map((t) => ({ key: String(t._id), kind: "task" as const, type: "task" as const, entity: own(st.tasks, t), title: t.title || "Untitled", href: pagePath("task", t), at: t.updated_at })),
      },
      {
        kind: "plan", label: objectKindLabel("plan", words),
        hits: surface.showsPage("/plans") ? plans.map((p) => ({ key: String(p._id), kind: "plan" as const, type: "plan" as const, entity: own(st.plans, p), title: p.title || "Untitled", href: pagePath("plan", p), at: p.updated_at })) : [],
      },
      {
        kind: "doc", label: objectKindLabel("doc", words),
        hits: docs.map((d) => ({ key: String(d._id), kind: "doc" as const, type: "doc" as const, entity: own(st.docs, d), title: d.title || "Untitled", href: pagePath("doc", d), at: d.updated_at })),
      },
      {
        kind: "trigger", label: objectKindLabel("trigger", words),
        hits: matchRoutines<any>(withinScope<any>(routines, scopeOnly, isAssistantRoutine), q, cap)
          .map((t) => ({ key: String(t._id), kind: "trigger" as const, type: "trigger" as const, entity: t, title: t.display_title || t.title || "Routine", href: pagePath("trigger", t), at: t.updated_at })),
      },
      {
        kind: "project", label: objectKindLabel("project", words),
        hits: scopeOnly ? [] : matchProjects(projects, q, cap).map((p) => ({ key: String(p._id), kind: "project" as const, type: "project" as const, entity: p, title: p.title || "Untitled", href: objectHref("project", p.short_id || String(p._id)), at: p.updated_at })),
      },
      {
        kind: "initiative", label: objectKindLabel("initiative", words),
        hits: !orgShown || scopeOnly ? [] : matchGoals(goals, q, cap).map((g) => ({ key: String(g._id), kind: "initiative" as const, type: "initiative" as const, entity: g, title: g.title || "Untitled", href: objectHref("initiative", g.short_id || String(g._id)), at: g.updated_at })),
      },
      {
        kind: "role", label: objectKindLabel("role", words),
        hits: !orgShown || scopeOnly ? [] : matchRoles(roles, q, cap).map((r) => ({ key: String(r._id), kind: "role" as const, type: "role" as const, entity: r, title: r.name, href: objectHref("role", r.short_id || String(r._id)) })),
      },
      {
        kind: "person", label: objectKindLabel("person", words),
        hits: scopeOnly ? [] : matchRows(((st as any).teamMembers ?? []).filter(isPerson), q, (m: any) => [memberDisplayName(m, ""), m.github_username, m.email], cap)
          .map((m: any) => ({ key: String(m._id), kind: "person" as const, type: "person" as const, entity: m, title: memberDisplayName(m), href: objectHref("person", personRefOf(m)) })),
      },
      {
        kind: "page", label: objectKindLabel("page", words),
        hits: scopeOnly || !surface.showsPage("/pages") ? [] : matchRows(artifacts, q, (a: any) => [a.title, a.slug], cap, (a: any) => a.updated_at ?? 0)
          .map((a: any) => ({ key: String(a.slug), kind: "page" as const, type: null, entity: a, title: a.title || a.slug, href: a.url, external: true, at: a.updated_at })),
      },
    ];
    return groups.filter((g) => g.hits.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, teamId, routines, projects, goals, roles, artifacts, scopeOnly, cap, words, orgShown]);
}
