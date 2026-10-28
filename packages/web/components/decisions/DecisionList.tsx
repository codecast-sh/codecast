"use client";
// The Decisions list, as the task list works: tabs (Mine, Team, Unassigned,
// Escalated, Answered), filters with saved views, a grouping and a second one
// under it, a sort, a peek beside the list, and a selection the command
// palette acts on (assign, answer, dismiss, pass with a note, escalate). The
// Decisions page renders it whole; Flows' For you renders the same list with
// its rows narrowed to the flows' decisions, so both say the same owner,
// group and order for every decision.
import { useCallback, useMemo, type ReactNode } from "react";
import { ArrowUpRight, CircleDot, Clock, FolderKanban, Inbox, Shapes, Tag, UserRound, Workflow } from "lucide-react";
import { toast } from "sonner";
import { GenericListView, type ListGroup, type ListTab } from "../GenericListView";
import { useInboxStore, type SessionDecisionItem } from "../../store/inboxStore";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useRolesAndPeopleOptions } from "../../hooks/useRolesAndPeopleOptions";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import type { DecisionViewState } from "../../hooks/useDecisionView";
import { currentViewId, isViewDirty, prefsForSaving, VIEW_ID_KEY } from "../../lib/savedViews";
import {
  arrangeDecisions, filterCounts, tabCounts, DECISION_AGES, DECISION_AXES, DECISION_AXIS_LABEL, DECISION_KINDS, DECISION_KIND_LABEL,
  DECISION_SORTS, DECISION_SORT_LABEL, DECISION_TAB_LABEL, SESSION_SOURCE, type DecisionAxis, type DecisionTab,
} from "../../lib/decisions/decisionRows";
import { DecisionListRow, type DecisionRowCtx } from "./DecisionListRow";

const TAB_ICON: Record<DecisionTab, any> = { mine: UserRound, team: Inbox, unassigned: UserRound, escalated: ArrowUpRight, answered: Clock };
const AXIS_ICON: Record<DecisionAxis, ReactNode> = {
  owner: <UserRound className="w-3 h-3" />, area: <FolderKanban className="w-3 h-3" />, kind: <Shapes className="w-3 h-3" />,
  source: <Workflow className="w-3 h-3" />, category: <Tag className="w-3 h-3" />,
};
const categoryLabel = (c: string) => (c === "unknown" ? "No category" : c[0].toUpperCase() + c.slice(1));

export type DecisionListProps = {
  title: string;
  state: DecisionViewState;
  /** The viewer's own rows from every workspace (Mine), and the active workspace's (every other tab). */
  rows: { mine: ReadonlyArray<SessionDecisionItem>; workspace: ReadonlyArray<SessionDecisionItem> };
  tabs?: ReadonlyArray<DecisionTab>;
  /** Axes this list does not offer (For you is the flows' already, so Source names one flow at most). */
  hideAxes?: ReadonlyArray<DecisionAxis>;
  routeOf: (d: SessionDecisionItem) => string;
  renderPreview?: (d: SessionDecisionItem, onClose: () => void, onOpen: () => void) => ReactNode;
  activeItemId?: string;
  /** Saved views live on the Decisions page; a scoped list keeps its view to itself. */
  savedViews?: boolean;
  headerExtra?: ReactNode;
  displayExtra?: ReactNode;
  customContent?: () => ReactNode;
  emptyMessage?: ReactNode;
  /** Draw narrow rows (the list beside a reader). */
  compact?: boolean;
};

export function DecisionList({ title, state, rows, tabs = ["mine", "team", "unassigned", "escalated", "answered"], hideAxes = [], routeOf, renderPreview, activeItemId, savedViews, headerExtra, displayExtra, customContent, emptyMessage, compact }: DecisionListProps) {
  const { view, set, prefs, replace } = state;
  const now = useCoarseNow(60_000);
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const roster = useTeamRosterIdentity();
  const { people, roles } = useRolesAndPeopleOptions(roster);
  // The areas' names, looked up by the ids the rows name (a row may come from another workspace than the active one).
  const areaIds = useMemo(() => [...new Set([...rows.mine, ...rows.workspace].map((d) => d.area_project_id).filter((p): p is string => !!p))].sort(), [rows]);
  const titlesSig = useInboxStore((s) => areaIds.map((id) => (s.projects as Record<string, { title?: string } | undefined> | undefined)?.[id]?.title ?? "").join("\u0001"));
  const projectTitle = useMemo(() => { const t = titlesSig.split("\u0001"); return new Map(areaIds.map((id, i) => [id, t[i] ?? ""])); }, [areaIds, titlesSig]);
  const areaName = useCallback((p: string) => (p && p !== "none" ? projectTitle.get(p) || "Another project" : "No project"), [projectTitle]);
  const owners = useMemo(() => {
    const m = new Map<string, { label: string; face: ReactNode }>();
    for (const p of people) m.set(`user:${p.key}`, { label: p.key === me ? `${p.label} (you)` : p.label, face: p.face });
    for (const r of roles) m.set(`role:${r.key}`, { label: r.label, face: r.face });
    return m;
  }, [people, roles, me]);
  const ownerOf = useCallback((key: string) => owners.get(key) ?? null, [owners]);
  const label = useCallback((axis: DecisionAxis, value: string) => {
    switch (axis) {
      case "owner": return value === "none" ? "Unassigned" : owners.get(value)?.label ?? (value.startsWith("role:") ? "A role" : "Someone");
      case "area": return areaName(value);
      case "kind": return DECISION_KIND_LABEL[value as keyof typeof DECISION_KIND_LABEL] ?? value;
      case "source": return value === SESSION_SOURCE ? "Sessions" : value;
      case "category": return categoryLabel(value);
    }
  }, [owners, areaName]);

  const source = view.tab === "mine" ? rows.mine : rows.workspace;
  const arranged = useMemo(() => arrangeDecisions(source, view, { me, now, label }), [source, view, me, now, label]);
  const counts = useMemo(() => {
    const ws = tabCounts(rows.workspace, me);
    return { ...ws, mine: tabCounts(rows.mine, me).mine };
  }, [rows, me]);
  const listTabs: ListTab[] = tabs.map((t) => ({ key: t, label: DECISION_TAB_LABEL[t], count: counts[t], icon: TAB_ICON[t] }));

  const groups = useMemo<ListGroup<SessionDecisionItem>[] | null>(() => arranged.groups?.map((g) => ({
    key: g.key, label: g.label, items: g.items,
    icon: g.axis === "owner" ? (g.value === "none" ? <UserRound className="w-3.5 h-3.5 text-sol-text-dim" /> : <span className="w-4 h-4 flex items-center justify-center">{owners.get(g.value)?.face}</span>) : undefined,
  })) ?? null, [arranged.groups, owners]);

  const axes = DECISION_AXES.filter((a) => !hideAxes.includes(a));
  const grouped = useMemo(() => new Set([view.group, view.sub].filter((a): a is DecisionAxis => a !== "none")), [view.group, view.sub]);
  const rowCtx: DecisionRowCtx = useMemo(() => ({ now, grouped, areaName, owner: ownerOf, compact }), [now, grouped, areaName, ownerOf, compact]);

  // Each filter's options carry how many rows picking them would show, the other filters applied.
  const opts = (filter: "owner" | "area" | "kind" | "source" | "category" | "blocking", keys: string[], name: (k: string) => string, extra?: (k: string) => object) => {
    const c = filterCounts(source, view, me, now, filter);
    const all = [...new Set([...keys, ...c.keys()])];
    return [{ key: "", label: "Any" }, ...all.filter((k) => k !== "").map((k) => ({ key: k, label: name(k), count: c.get(k) ?? 0, ...(extra?.(k) ?? {}) }))];
  };
  const filterDefs = [
    { key: "owner", label: "Owner", icon: AXIS_ICON.owner, value: view.owner, multi: true,
      options: opts("owner", [...(me ? [`user:${me}`] : []), "none", ...people.map((p) => `user:${p.key}`), ...roles.map((r) => `role:${r.key}`)], (k) => label("owner", k), (k) => ({ face: owners.get(k)?.face, section: k.startsWith("role:") ? "Roles" : k === "none" || k === `user:${me}` ? undefined : "People" })),
      onChange: (v: string) => set({ owner: v }) },
    { key: "area", label: "Area", icon: AXIS_ICON.area, value: view.area, multi: true, options: opts("area", [], areaName), onChange: (v: string) => set({ area: v }) },
    { key: "kind", label: "Kind", icon: AXIS_ICON.kind, value: view.kind, multi: true, options: opts("kind", [...DECISION_KINDS], (k) => label("kind", k)), onChange: (v: string) => set({ kind: v }) },
    { key: "source", label: "Source", icon: AXIS_ICON.source, value: view.source, multi: true, options: opts("source", [], (k) => label("source", k)), onChange: (v: string) => set({ source: v }) },
    { key: "category", label: "Category", icon: AXIS_ICON.category, value: view.category, multi: true, options: opts("category", [], categoryLabel), onChange: (v: string) => set({ category: v }) },
    { key: "blocking", label: "Blocking", icon: <CircleDot className="w-3 h-3" />, value: view.blocking, options: opts("blocking", ["blocking", "advisory"], (k) => (k === "blocking" ? "Blocking" : "Advisory")), onChange: (v: string) => set({ blocking: v }) },
    { key: "age", label: "Waiting", icon: <Clock className="w-3 h-3" />, value: view.age, options: [{ key: "", label: "Any time" }, ...DECISION_AGES.map((a) => ({ key: a.key, label: a.label }))], onChange: (v: string) => set({ age: v }) },
  ].filter((d) => !(hideAxes as readonly string[]).includes(d.key));
  const hasFilters = filterDefs.some((d) => !!d.value);

  // Saved views: the same rows as the task list's, on their own page.
  const createSavedView = useInboxStore((s) => s.createSavedView);
  const updateSavedView = useInboxStore((s) => s.updateSavedView);
  const savedRows = useInboxStore((s) => s.savedViews);
  const opened = useMemo(() => { const id = currentViewId(prefs); return id ? (savedRows as Record<string, any>)[id] : undefined; }, [savedRows, prefs]);
  const dirtyView = useMemo(() => {
    if (!savedViews || !opened || !isViewDirty(opened, prefs)) return undefined;
    return {
      name: opened.name as string,
      canUpdate: opened.is_mine !== false,
      onUpdate: () => { updateSavedView(opened._id, { prefs: prefsForSaving(prefs) }); toast.success(`Updated "${opened.name}"`); },
      onDiscard: () => replace({ ...(opened.prefs ?? {}), [VIEW_ID_KEY]: opened._id }),
    };
  }, [savedViews, opened, prefs, updateSavedView, replace]);

  return (
    <GenericListView<SessionDecisionItem>
      title={title}
      tabs={listTabs}
      activeTab={view.tab}
      onTabChange={(t) => set({ tab: t as DecisionTab })}
      groupBy={view.group}
      groupOptions={[{ value: "none", label: "No grouping" }, ...axes.map((a) => ({ value: a, label: DECISION_AXIS_LABEL[a] }))]}
      onGroupChange={(g) => set({ group: g as DecisionAxis | "none" })}
      subGroupBy={view.sub}
      subGroupOptions={[{ value: "none", label: "Nothing" }, ...axes.filter((a) => a !== view.group).map((a) => ({ value: a, label: DECISION_AXIS_LABEL[a] }))]}
      onSubGroupChange={(g) => set({ sub: g as DecisionAxis | "none" })}
      sortBy={view.sort}
      sortOptions={DECISION_SORTS.map((s) => ({ value: s, label: DECISION_SORT_LABEL[s] }))}
      onSortChange={(s) => set({ sort: s as (typeof DECISION_SORTS)[number] })}
      sortDir={view.dir}
      onSortDirChange={() => set({ dir: view.dir === "asc" ? "desc" : "asc" })}
      filters={{
        hasActive: hasFilters,
        defs: filterDefs,
        onClear: () => set({ owner: "", area: "", kind: "", source: "", category: "", blocking: "", age: "" }),
        onSaveView: savedViews ? (name) => createSavedView({ name, page: "decisions", prefs: prefsForSaving(prefs) }) : undefined,
        dirtyView,
      }}
      shareUrl={savedViews ? state.shareUrl : undefined}
      groups={groups}
      flatItems={arranged.items}
      renderRow={(d, rowState) => <DecisionListRow d={d} state={rowState} ctx={rowCtx} />}
      renderPreview={renderPreview}
      getItemId={(d) => d._id}
      getItemRoute={routeOf}
      getComposeRef={(d) => d.short_id ?? null}
      getSearchText={(d) => `${d.short_id ?? ""} ${d.question} ${d.session_title ?? ""}`}
      paletteTargetType="decision"
      paletteShortcuts={[{ action: "task.assign", mode: "assign", label: "assign" }]}
      emptyIcon={<Inbox className="w-8 h-8 opacity-30" />}
      emptyMessage={emptyMessage ?? (view.tab === "mine" ? "Nothing waits on you" : view.tab === "answered" ? "Nothing answered this week" : "No open decisions")}
      activeItemId={activeItemId}
      headerExtra={headerExtra}
      displayExtra={displayExtra}
      customContent={customContent}
    />
  );
}
