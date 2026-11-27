// /priorities across every workspace the viewer belongs to, as pure functions
// over the list's rows: the sections each grouping draws, the page's controls
// (chips, Group by, headings), the header count and where drag to rank works.
// Within one person in one workspace the order is lib/priorities ownerGroups.
import { ownerGroups, type OwnerGroup, type PriorityRow } from "./priorities";

export type GroupBy = "workspace_person" | "person_workspace" | "workspace";

export const DEFAULT_GROUP_BY: GroupBy = "workspace_person";
const GROUP_BYS: readonly GroupBy[] = ["workspace_person", "person_workspace", "workspace"];

export type SectionOptions = {
  /** The workspace key the viewer has open: its section comes first. */
  activeWorkspace: string | null;
  /** Workspace keys the viewer turned off. */
  hidden: readonly string[];
  /** A team workspace's name; the personal (`user:`) workspace is always "Personal". */
  workspaceName: (key: string) => string;
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

export function workspaceLabel(key: string, workspaceName: (key: string) => string): string {
  return key.startsWith("user:") ? "Personal" : workspaceName(key);
}

/** The rows a page draws: merged ones never, hidden workspaces' never. */
function shownRows(rows: readonly PriorityRow[], hidden: readonly string[]): PriorityRow[] {
  return rows.filter((r) => r.status !== "merged" && !hidden.includes(r.workspace));
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
    .map(([key, rows]) => ({ key, name: workspaceLabel(key, opts.workspaceName), rows }))
    .sort((a, b) =>
      Number(b.key === opts.activeWorkspace) - Number(a.key === opts.activeWorkspace)
      || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      || a.key.localeCompare(b.key));
}

/** A stored Group by as the page uses it: unknown values, and Person then workspace with one workspace shown, read as the default. */
export function effectiveGroupBy(pref: unknown, visibleWorkspaces: number): GroupBy {
  const groupBy = GROUP_BYS.find((g) => g === pref) ?? DEFAULT_GROUP_BY;
  return groupBy === "person_workspace" && visibleWorkspaces < 2 ? DEFAULT_GROUP_BY : groupBy;
}

/** Every #1, then every #2, …; within a rank the order ownerGroups gives (the viewer first, then by owner name). */
function interleave(people: readonly OwnerGroup[]): RankedRow[] {
  const out: RankedRow[] = [];
  const depth = Math.max(0, ...people.map((p) => p.active.length));
  for (let i = 0; i < depth; i++) {
    for (const p of people) if (p.active[i]) out.push({ row: p.active[i], rank: i + 1 });
  }
  return out;
}

export function buildSections(rows: readonly PriorityRow[], opts: SectionOptions & { groupBy: unknown }): Sections {
  const workspaces = byWorkspace(shownRows(rows, opts.hidden), opts);
  const groupBy = effectiveGroupBy(opts.groupBy, workspaces.length);

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
  /** Every workspace on the page, hidden or not, in section order, with its priority count. */
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
  const workspaces = byWorkspace(shownRows(rows, []), opts).map(({ key, name, rows }) => ({ key, name, count: rows.length }));
  const shown = shownRows(rows, opts.hidden);
  const visible = workspaces.filter((w) => !opts.hidden.includes(w.key)).length;
  return {
    workspaces,
    showChips: workspaces.length > 1,
    showGroupBy: shown.some((r) => !r.mine),
    groupByOptions: GROUP_BYS.filter((g) => g !== "person_workspace" || visible > 1),
    showSectionHeadings: visible > 1,
  };
}

/** The header count: priorities in the sections shown. */
export function visibleCount(rows: readonly PriorityRow[], hidden: readonly string[]): number {
  return shownRows(rows, hidden).length;
}

/** Drag to rank: the viewer's own active priorities, in the two nested groupings only. */
export function rankDraggable(groupBy: GroupBy, row: Pick<PriorityRow, "mine" | "status">): boolean {
  return groupBy !== "workspace" && row.mine && row.status === "active";
}
