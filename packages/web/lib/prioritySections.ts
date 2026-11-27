// /priorities across every workspace the viewer belongs to, as pure functions
// over the list's rows: the sections each grouping draws, the page's controls
// (chips, Group by, headings), the header count and where drag to rank works.
// Within one person in one workspace the order is lib/priorities ownerGroups.
import { ownerGroups, type OwnerGroup, type PriorityRow } from "./priorities";

export type GroupBy = "workspace_person" | "person_workspace" | "workspace";

export const DEFAULT_GROUP_BY: GroupBy = "workspace_person";

export const GROUP_BY_LABEL: Record<GroupBy, string> = {
  workspace_person: "Workspace, then person",
  person_workspace: "Person, then workspace",
  workspace: "Workspace",
};
const GROUP_BYS: readonly GroupBy[] = ["workspace_person", "person_workspace", "workspace"];

export type SectionOptions = {
  /** The workspace key the viewer has open (`team:<id>`, or `user:<id>` for personal, never null for it): its section comes first. */
  activeWorkspace: string | null;
  /** Workspace keys the viewer turned off; ignored while the page holds one workspace. */
  hidden: readonly string[];
  /** Team workspaces' names by key; a missing key reads as the key, and `user:` is always "Personal". */
  workspaceNames: Readonly<Record<string, string>>;
};

/** A row in Workspace grouping, with its place in its owner's list; its owner is `row.owner`. */
export type RankedRow = { row: PriorityRow; rank: number };

/** Each person's `active` is in rank order; `past` is the "Done and set aside" fold. */
export type WorkspacePersonSection = { key: string; name: string; people: OwnerGroup[] };
export type PersonWorkspaceSection = {
  user_id: string;
  owner: string;
  mine: boolean;
  workspaces: Array<{ key: string; name: string; active: PriorityRow[]; past: PriorityRow[] }>;
};
export type WorkspaceSection = { key: string; name: string; active: RankedRow[]; past: PriorityRow[] };

export type Sections =
  | { groupBy: "workspace_person"; sections: WorkspacePersonSection[] }
  | { groupBy: "person_workspace"; sections: PersonWorkspaceSection[] }
  | { groupBy: "workspace"; sections: WorkspaceSection[] };

export function workspaceLabel(key: string, workspaceNames: Readonly<Record<string, string>>): string {
  return key.startsWith("user:") ? "Personal" : workspaceNames[key] ?? key;
}

const pageRows = (rows: readonly PriorityRow[]) => rows.filter((r) => r.status !== "merged");

/** The workspaces turned off, except that a page holding one workspace never hides it into an empty page. */
function effectiveHidden(rows: readonly PriorityRow[], hidden: readonly string[]): readonly string[] {
  return new Set(pageRows(rows).map((r) => r.workspace)).size > 1 ? hidden : [];
}

/** The rows a page draws: merged ones never, hidden workspaces' never. */
function shownRows(rows: readonly PriorityRow[], hidden: readonly string[]): PriorityRow[] {
  const off = effectiveHidden(rows, hidden);
  return pageRows(rows).filter((r) => !off.includes(r.workspace));
}

/** Each workspace's rows, the active workspace first, then by name (case-insensitive). */
function byWorkspace(rows: readonly PriorityRow[], opts: Omit<SectionOptions, "hidden">): Array<{ key: string; name: string; rows: PriorityRow[] }> {
  const groups = new Map<string, PriorityRow[]>();
  for (const r of rows) {
    const g = groups.get(r.workspace);
    if (g) g.push(r);
    else groups.set(r.workspace, [r]);
  }
  return [...groups]
    .map(([key, rows]) => ({ key, name: workspaceLabel(key, opts.workspaceNames), rows }))
    .sort((a, b) =>
      Number(b.key === opts.activeWorkspace) - Number(a.key === opts.activeWorkspace)
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      || a.key.localeCompare(b.key));
}

/**
 * A stored Group by as the page uses it. It reads as the default when it is
 * unknown, when no teammate's priority is shown (Group by is not on the page
 * to change it back), and for Person then workspace with one workspace shown.
 */
export function effectiveGroupBy(pref: unknown, shown: { workspaces: number; teammates: boolean }): GroupBy {
  const groupBy = GROUP_BYS.find((g) => g === pref) ?? DEFAULT_GROUP_BY;
  if (!shown.teammates) return DEFAULT_GROUP_BY;
  return groupBy === "person_workspace" && shown.workspaces < 2 ? DEFAULT_GROUP_BY : groupBy;
}

/**
 * Every #1, then every #2, …, by each row's rank (the server's number for a
 * teammate's, so a lone #5 left after a cap still sits with the #5s; its
 * place in its owner's list where it has none); within a rank the order
 * ownerGroups gives (the viewer first, then by owner name).
 */
function interleave(people: readonly OwnerGroup[]): RankedRow[] {
  const ranked = people.flatMap((p, person) => p.active.map((row, i) => ({ row, rank: row.rank ?? i + 1, person })));
  ranked.sort((a, b) => a.rank - b.rank || a.person - b.person);
  return ranked.map(({ row, rank }) => ({ row, rank }));
}

export function buildSections(rows: readonly PriorityRow[], opts: SectionOptions & { groupBy: unknown }): Sections {
  const shown = shownRows(rows, opts.hidden);
  const workspaces = byWorkspace(shown, opts);
  const groupBy = effectiveGroupBy(opts.groupBy, { workspaces: workspaces.length, teammates: shown.some((r) => !r.mine) });

  if (groupBy === "workspace") {
    return {
      groupBy,
      sections: workspaces.map(({ key, name, rows }) => {
        const people = ownerGroups(rows);
        return { key, name, active: interleave(people), past: people.flatMap((p) => p.past) };
      }),
    };
  }

  const perWorkspace = workspaces.map(({ key, name, rows }) => ({ key, name, people: ownerGroups(rows) }));
  if (groupBy === "workspace_person") return { groupBy, sections: perWorkspace };

  const people = ownerGroups(workspaces.flatMap((w) => w.rows));
  return {
    groupBy,
    sections: people.map(({ user_id, owner, mine }) => ({
      user_id,
      owner,
      mine,
      workspaces: perWorkspace.flatMap(({ key, name, people }) => {
        const g = people.find((p) => p.user_id === user_id);
        return g ? [{ key, name, active: g.active, past: g.past }] : [];
      }),
    })),
  };
}

export type PageControls = {
  /** Every workspace on the page, hidden or not, in section order, with its active priorities' count. */
  workspaces: Array<{ key: string; name: string; count: number }>;
  /** More than one workspace on the page. */
  showChips: boolean;
  /** A teammate's priority is shown. */
  showGroupBy: boolean;
  /** Person then workspace only with more than one workspace shown. */
  groupByOptions: GroupBy[];
  /** More than one workspace shown. */
  showSectionHeadings: boolean;
};

export function pageControls(rows: readonly PriorityRow[], opts: SectionOptions): PageControls {
  const workspaces = byWorkspace(pageRows(rows), opts).map(({ key, name, rows }) => ({ key, name, count: rows.filter((r) => r.status === "active").length }));
  const shown = shownRows(rows, opts.hidden);
  const visible = new Set(shown.map((r) => r.workspace)).size;
  return {
    workspaces,
    showChips: workspaces.length > 1,
    showGroupBy: shown.some((r) => !r.mine),
    groupByOptions: GROUP_BYS.filter((g) => g !== "person_workspace" || visible > 1),
    showSectionHeadings: visible > 1,
  };
}

/** The header count: everyone's active priorities in the sections shown. */
export function visibleCount(rows: readonly PriorityRow[], hidden: readonly string[]): number {
  return shownRows(rows, hidden).filter((r) => r.status === "active").length;
}

/** Drag to rank: the viewer's own active priorities, in the two nested groupings only. `groupBy` is the one buildSections used. */
export function rankDraggable(groupBy: GroupBy, row: Pick<PriorityRow, "mine" | "status">): boolean {
  return groupBy !== "workspace" && row.mine && row.status === "active";
}
