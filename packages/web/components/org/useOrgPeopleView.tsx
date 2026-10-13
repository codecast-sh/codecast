"use client";
// The People chart's view state (orgLayout.OrgLayoutView): which people and
// roles are folded, which session stacks are opened past their first five, the
// pages of org.sessionsUnder a "+N more" card has loaded, and which cards are
// opened in place. Folding, paging and single opened cards are plain component
// state (this screen's reading position); "Expand all" is the person's own
// preference (clientState.ui.org_expand_all), and a card toggled by hand while
// it is on is the exception to it. What the cards say beyond the tree (a
// session's state line, task and latest messages; an open role's leads and
// open tasks; which project a session works on) is read from the store through
// signatures (orgSessionDetail), so a heartbeat re-renders nothing.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useOrgSessionsUnder } from "../../hooks/useOrgSessionsUnder";
import { useInboxStore } from "../../store/inboxStore";
import { ORG_STACK_VISIBLE, parentNodeId, parentRefOfNodeId, roleNodeId, sessionNodeId, type OrgLayoutView } from "./orgLayout";
import { firstServerCursor, moveExpandedSession } from "./orgPager";
import { roleDetailsOf, roleDetailsSig, sessionDetailsOf, sessionDetailsSig, sessionProjectsOf, sessionProjectsSig } from "./orgSessionDetail";
import type { OrgParentRef, OrgSession, OrgTree } from "./orgTypes";

/** One org.sessionsUnder page per click on a cluster card. */
export const ORG_PAGE = 8;

/** One mounted loader per requested page: reports its rows up once. */
function SessionsUnderPager({ parentId, teamId, cursor, onPage }: {
  parentId: string; teamId?: string; cursor: string;
  onPage: (parentId: string, rows: OrgSession[], next?: string) => void;
}) {
  const parent = useMemo(() => parentRefOfNodeId(parentId)!, [parentId]);
  const { data, error } = useOrgSessionsUnder({ parent, ...(teamId ? { team_id: teamId } : {}), cursor, limit: ORG_PAGE });
  // One shot: the page unmounts this loader when the rows land, so the report
  // must never be cancelled by a re-render in between.
  const done = useRef(false);
  useWatchEffect(() => {
    if (done.current) return;
    if (error) {
      // A terminal error still settles the request, or the cluster card reads
      // "Loading…" forever; the cursor closes so the click does not loop.
      done.current = true;
      toast.error("Could not load more sessions");
      onPage(parentId, [], undefined);
      return;
    }
    if (!data) return;
    done.current = true;
    onPage(parentId, (data.sessions ?? []) as OrgSession[], data.next_cursor ?? undefined);
  }, [data, error, parentId, onPage]);
  return null;
}

export type MoveSubject = { kind: "session" | "role"; id: string; title: string };

export type OrgPeopleView = {
  view: OrgLayoutView;
  loadingClusters: ReadonlySet<string>;
  toggleCollapse: (nodeId: string) => void;
  /** "+N more": open the stack to the payload it already holds, then page the server. */
  loadMore: (parentId: string) => void;
  /** "Show fewer": back to the first five. */
  collapseCluster: (parentId: string) => void;
  /** A session by id, from the tree's top N or any loaded page. */
  findSession: (conversationId: string) => OrgSession | null;
  /** Where a role or a session reports now. */
  currentParentOf: (subject: MoveSubject) => OrgParentRef | null;
  /** A moved session leaves every loaded page and joins its new parent's when that one is open. */
  movePagedSession: (conversationId: string, to: OrgParentRef, row: OrgSession | null) => void;
  /** The loaders for pages in flight; render them anywhere on the screen. */
  pagers: ReactNode;
  /** Open or close one card in place (a role or a session node id). */
  toggleOpen: (nodeId: string) => void;
  /** The person's "Expand all": every role and session card opened. */
  expandAll: boolean;
  setExpandAll: (on: boolean) => void;
  /** Which project each session works on (its task's or plan's), for the Everything chart. */
  sessionProject: Readonly<Record<string, string>>;
};

export function useOrgPeopleView(tree: OrgTree | null): OrgPeopleView {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Record<string, OrgSession[]>>({});
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [requests, setRequests] = useState<Record<string, { cursor: string }>>({});

  const bucketOf = useCallback((parentId: string) => {
    const ref = parentRefOfNodeId(parentId);
    if (!tree || !ref) return null;
    return ref.kind === "user" ? tree.people.find((p) => p.user_id === ref.user_id) ?? null : tree.roles.find((r) => r._id === ref.role_id) ?? null;
  }, [tree]);
  const sessionsUnder = useCallback((parentId: string): OrgSession[] => {
    const base = bucketOf(parentId)?.sessions ?? [];
    const seen = new Set(base.map((x) => x._id));
    return [...base, ...(expanded[parentId] ?? []).filter((x) => !seen.has(x._id))];
  }, [bucketOf, expanded]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }, []);
  const loadMore = useCallback((parentId: string) => {
    // A project's stack holds only what the tree already carries: "+N more" opens it, there is no page to ask for.
    if (!parentRefOfNodeId(parentId)) { setExpanded((e) => (parentId in e ? e : { ...e, [parentId]: [] })); return; }
    // First click: the stack draws five of the payload's eight; open it to show
    // what is already here before asking the server for more.
    if (!(parentId in expanded) && sessionsUnder(parentId).length > ORG_STACK_VISIBLE) {
      setExpanded((e) => ({ ...e, [parentId]: [] }));
      return;
    }
    if (cursors[parentId] === null || requests[parentId]) return;
    setExpanded((e) => (parentId in e ? e : { ...e, [parentId]: [] }));
    // The server pages by offset and the tree's payload IS page one (orgPager).
    setRequests((r) => ({ ...r, [parentId]: { cursor: firstServerCursor(cursors[parentId], sessionsUnder(parentId).length) } }));
  }, [cursors, requests, expanded, sessionsUnder]);
  const onPage = useCallback((parentId: string, rows: OrgSession[], next?: string) => {
    setExpanded((e) => {
      const have = new Set((e[parentId] ?? []).map((x) => x._id));
      return { ...e, [parentId]: [...(e[parentId] ?? []), ...rows.filter((x) => !have.has(x._id))] };
    });
    setCursors((c) => ({ ...c, [parentId]: next ?? null }));
    setRequests((r) => { const { [parentId]: _drop, ...rest } = r; return rest; });
  }, []);
  const collapseCluster = useCallback((parentId: string) => {
    if (!parentRefOfNodeId(parentId)) { setExpanded((e) => { const { [parentId]: _drop, ...rest } = e; return rest; }); return; }
    setExpanded((e) => { const { [parentId]: _drop, ...rest } = e; return rest; });
    setCursors((c) => { const { [parentId]: _drop, ...rest } = c; return rest; });
  }, []);

  const findSession = useCallback((conversationId: string): OrgSession | null => {
    if (!tree) return null;
    for (const b of [...tree.people, ...tree.roles]) { const s = b.sessions.find((x) => x._id === conversationId); if (s) return s; }
    for (const rows of Object.values(expanded)) { const s = rows.find((x) => x._id === conversationId); if (s) return s; }
    return null;
  }, [tree, expanded]);
  const currentParentOf = useCallback((subject: MoveSubject): OrgParentRef | null => {
    if (!tree) return null;
    if (subject.kind === "role") return tree.roles.find((r) => r._id === subject.id)?.reports_to ?? null;
    for (const p of tree.people) if (p.sessions.some((x) => x._id === subject.id)) return { kind: "user", user_id: p.user_id };
    for (const r of tree.roles) if (r.sessions.some((x) => x._id === subject.id)) return { kind: "role", role_id: r._id };
    for (const [pid, rows] of Object.entries(expanded)) if (rows.some((x) => x._id === subject.id)) return parentRefOfNodeId(pid);
    return null;
  }, [tree, expanded]);
  const movePagedSession = useCallback((conversationId: string, to: OrgParentRef, row: OrgSession | null) => {
    setExpanded((e) => moveExpandedSession(e, conversationId, parentNodeId(to), row));
  }, []);

  // Every session the chart can draw, and what its close card says.
  const sessionIds = useMemo(() => {
    const ids: string[] = [];
    if (tree) for (const b of [...tree.people, ...tree.roles]) for (const s of b.sessions) ids.push(s._id);
    for (const rows of Object.values(expanded)) for (const s of rows) ids.push(s._id);
    return ids;
  }, [tree, expanded]);
  const detailsSig = useInboxStore((s) => sessionDetailsSig(sessionIds, s.sessions as Record<string, any>, s.messages as Record<string, any>));
  const sessionDetails = useMemo(() => { const st = useInboxStore.getState(); return sessionDetailsOf(sessionIds, st.sessions as Record<string, any>, st.messages as Record<string, any>); }, [detailsSig]); // eslint-disable-line react-hooks/exhaustive-deps
  const projectsSig = useInboxStore((s) => sessionProjectsSig(sessionProjectsOf(sessionIds, s.sessions as Record<string, any>, s.tasks as Record<string, unknown>, s.plans as Record<string, unknown>)));
  const sessionProject = useMemo(() => { const st = useInboxStore.getState(); return sessionProjectsOf(sessionIds, st.sessions as Record<string, any>, st.tasks as Record<string, unknown>, st.plans as Record<string, unknown>); }, [projectsSig]); // eslint-disable-line react-hooks/exhaustive-deps

  // Opened in place: "Expand all" opens every card, and a card toggled by hand is the exception either way.
  const expandAll = useInboxStore((s) => s.clientState.ui?.org_expand_all === true);
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const toggleOpen = useCallback((id: string) => setToggled((t) => { const n = new Set(t); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const setExpandAll = useCallback((on: boolean) => { setToggled(new Set()); useInboxStore.getState().updateClientUI({ org_expand_all: on }); }, []);
  const opened = useMemo(() => {
    if (!expandAll) return toggled;
    const all = new Set<string>([...(tree?.roles ?? []).map((r) => roleNodeId(r._id)), ...sessionIds.map(sessionNodeId)]);
    for (const id of toggled) all.delete(id);
    return all;
  }, [expandAll, toggled, tree, sessionIds]);
  const openRoleIds = useMemo(() => (tree?.roles ?? []).filter((r) => opened.has(roleNodeId(r._id))).map((r) => r._id), [tree, opened]);
  const roleSig = useInboxStore((s) => (openRoleIds.length && tree ? roleDetailsSig(roleDetailsOf(openRoleIds, tree.roles, s.projects as Record<string, unknown>, s.tasks as Record<string, unknown>)) : ""));
  const roleDetails = useMemo(() => (roleSig ? JSON.parse(roleSig) : {}), [roleSig]);

  const view = useMemo<OrgLayoutView>(() => ({ collapsed, expanded, sessionCards: true, sessionDetails, opened, roleDetails }), [collapsed, expanded, sessionDetails, opened, roleDetails]);
  const loadingClusters = useMemo(() => new Set(Object.keys(requests)), [requests]);
  const teamId = tree?.workspace.kind === "team" ? tree.workspace.id : undefined;
  const pagers = Object.entries(requests).map(([pid, r]) => (
    parentRefOfNodeId(pid) ? <SessionsUnderPager key={`${pid}:${r.cursor}`} parentId={pid} cursor={r.cursor} teamId={teamId} onPage={onPage} /> : null
  ));
  return { view, loadingClusters, toggleCollapse, loadMore, collapseCluster, findSession, currentParentOf, movePagedSession, pagers, toggleOpen, expandAll, setExpandAll, sessionProject };
}
