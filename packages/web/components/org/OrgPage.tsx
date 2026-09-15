"use client";
// /org: the reporting structure of the active workspace as one tree, edited by
// reparenting. Paints from the `orgTree` store singleton (fed here by
// useSyncOrgTree); every edit is a store action that moves the card in the
// same tick and rides dispatch to the orgRoles mutation.
import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { create as mutate } from "mutative";
import { Network, Plus, Map as MapIcon, Users, Briefcase, Search, ArrowRightLeft, ChevronDown, ChevronRight, ExternalLink, Trash2, Pencil } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { createOrgSlice, orgRoleReparentMakesCycle, type OrgUpdateRoleInput } from "../../store/orgSlice";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncOrgHealth } from "../../hooks/useSyncOrgHealth";
import { useSyncOrgProposals, useSyncOrgProposal } from "../../hooks/useSyncOrgProposals";
import { useSwitchWorkspace } from "../../hooks/useSwitchWorkspace";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { spawnSessionWithPrompt } from "../../lib/spawnSession";
import { resolveComposeProjectPath } from "../../store/inboxStore";
import { useOrgSessionsUnder } from "../../hooks/useOrgSessionsUnder";
import { useOpenLinkedSession } from "../../hooks/useOpenLinkedSession";
import { useIsPhone } from "../../hooks/useIsPhone";
import { isConvexId } from "../../lib/entityLinks";
import { toast } from "sonner";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator, CtxSub, CtxSubTrigger, CtxSubContent } from "../ui/context-menu";
import { SessionMenuItems } from "../menus/ObjectContextMenus";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Avatar } from "../tasks/TaskCommentStream";
import { cn } from "../../lib/utils";
import { OrgGraph, type OrgReparentRequest } from "./OrgGraph";
import { OrgScopePanel, type OrgPanelMode, type OrgSessionsSource } from "./OrgScopePanel";
import { HireRoleDialog, type HireRoleInitial } from "./HireRoleDialog";
import { StaffingPane, type ProposalLinkLine } from "./StaffingPane";
import { changeNodeId, composeParam, findChiefOfStaff, openProposals, orgPreviewEnabled, pickProposal, proposalParam, proposalProgress, resolveProposalLink, roleChangeEdits, roleChangeInitial } from "./staffingModel";
import { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import { joinProposals, type OrgHealth, type OrgProposalChange, type OrgProposalRow } from "./orgStaffingTypes";
import { StateTally } from "./OrgNodeCards";
import { OrgButton } from "./OrgButton";
import { layoutOrgTree, parentNodeId, parentRefOfNodeId, ORG_STACK_VISIBLE, type OrgFocusTarget, type OrgLayoutNode, type OrgLayoutView } from "./orgLayout";
import { firstServerCursor, moveExpandedSession } from "./orgPager";
import { ORG_FIXTURE, ORG_FIXTURE_ALL_SESSIONS } from "./orgFixture";
import { sortOrgSessions, sameParent, type OrgParentRef, type OrgSession, type OrgTree, EMPTY_COUNTS } from "./orgTypes";

const PAGE = 8;
/** The DEV preview flag is read from the live URL on every render (see
 *  orgPreviewEnabled): a module constant survived in-app navigation and kept
 *  painting fixtures on a workspace with no tree after the flag was gone. */
const ORG_PREVIEW_DEV = !!import.meta.env.DEV;
/** The desktop panel overlays the canvas; the graph fits to what is left. */
const PANEL_W = 380;
/** "Propose an org now" shows a reviewing state until a proposal lands or
 *  this long passes: a review that ends without one (the session died, the
 *  analyzer found nothing) must give the buttons back. */
const REVIEW_TTL_MS = 15 * 60_000;

type MoveSubject = { kind: "session" | "role"; id: string; title: string };

// ---------------------------------------------------------------- sessionsUnder pager

/** One mounted loader per requested page; reports rows up once and unmounts. */
function SessionsUnderPager({ parentId, teamId, cursor, onPage, preview }: {
  parentId: string; teamId?: string; cursor: string; preview: boolean;
  onPage: (parentId: string, rows: OrgSession[], next?: string) => void;
}) {
  const parent = useMemo(() => parentRefOfNodeId(parentId)!, [parentId]);
  const { data, error } = useOrgSessionsUnder(
    !preview ? { parent, ...(teamId ? { team_id: teamId } : {}), cursor, limit: PAGE } : "skip",
  );
  // One shot: the page unmounts this loader when the page lands, so the
  // report must never be cancelled by a re-render in between.
  const done = useRef(false);
  useWatchEffect(() => {
    if (done.current) return;
    if (preview) {
      // The fixture pages itself so the expand gesture can be exercised offline.
      done.current = true;
      const all = sortOrgSessions(ORG_FIXTURE_ALL_SESSIONS.filter((s) => parent.kind === "user" ? s.owner_user_id === parent.user_id && !s.org_role_id : s.org_role_id === parent.role_id));
      const start = Number(cursor);
      const rows = all.slice(start, start + PAGE);
      setTimeout(() => onPage(parentId, rows, start + PAGE < all.length ? String(start + PAGE) : undefined), 250);
      return;
    }
    if (error) {
      // A terminal error must still settle the request, or the cluster card
      // reads "Loading…" forever. Close the cursor so the click does not loop.
      done.current = true;
      toast.error("Could not load more sessions");
      onPage(parentId, [], undefined);
      return;
    }
    if (!data) return;
    done.current = true;
    onPage(parentId, (data.sessions ?? []) as OrgSession[], data.next_cursor ?? undefined);
  }, [data, error, preview, parentId, cursor, onPage, parent]);
  return null;
}

// ---------------------------------------------------------------- page

export function OrgPageInner() {
  const { tree: storeTree, ready, missing } = useSyncOrgTree();
  const { health: storeHealth, missing: healthMissing } = useSyncOrgHealth();
  useSyncOrgProposals();
  // Proposals are two collections (list rows, and the changes of opened
  // proposals) joined at render; the focus scalar is what a ghost click and
  // a change row click both set (org-staffing.md S5).
  const s = useTrackedStore([
    (st) => st.currentUser?._id,
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.orgProposals,
    (st) => st.orgProposalChanges,
    (st) => st.orgFocusChangeId,
    (st) => st.orgIntentNotice?.at,
    (st) => st.currentSessionId,
    (st) => st.teams,
  ]);
  const storeFocusChangeId = s.orgFocusChangeId;
  // The journal put an edit back on its own (no echo within its TTL): say
  // so, because a ghost or a paused badge that quietly reappears reads as a
  // bug. A refusal toasts from the dispatch hook; this is the silent case.
  const intentNotice = s.orgIntentNotice;
  useWatchEffect(() => {
    if (intentNotice) toast.error(intentNotice.text);
  }, [intentNotice?.at]);
  const router = useRouter();
  const searchParams = useSearchParams();
  const switchWorkspace = useSwitchWorkspace();
  // The session the viewer is looking from: an adopt ghost offering it reads
  // "this session" (org-staffing.md S5). Short id read loosely off the row.
  const viewerSession = useMemo(() => {
    const id = s.currentSessionId;
    const row = id ? (s.sessions as Record<string, { short_id?: string } | undefined>)[id] : undefined;
    return id ? { id, short_id: row?.short_id ?? null } : null;
  }, [s.currentSessionId]); // eslint-disable-line react-hooks/exhaustive-deps
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;
  const activeTeamId = s.clientState.ui?.active_team_id as string | undefined;

  // A client ahead of a backend deploy (CLAUDE.md: web ships on push, Convex
  // when a person runs deploy.sh) answers "Could not find public function".
  // That is an honest empty state, never invented people with real names.
  // The fixture is a DEV preview only (`?preview=1` in the live URL), for
  // design work offline; its edits apply to a local copy through the SAME
  // slice bodies the store uses. Never a fallback for missing data.
  const preview = orgPreviewEnabled(searchParams.toString(), ORG_PREVIEW_DEV);
  const [previewTree, setPreviewTree] = useState<OrgTree>(ORG_FIXTURE);
  const [previewProposals, setPreviewProposals] = useState<OrgProposalRow[]>([ORG_STAFFING_FIXTURE_PROPOSAL]);
  // The slot holds one tree. After a workspace switch it still holds the
  // previous workspace's until the new answer lands; a tree that names another
  // workspace is not this page's data, so paint the skeleton for that round
  // trip instead of a foreign org. Personal = the viewer's own user id.
  const wantedWorkspace = activeTeamId && isConvexId(activeTeamId) ? activeTeamId : meId;
  const treeMatches = !storeTree || !wantedWorkspace || storeTree.workspace.id === wantedWorkspace;
  const tree: OrgTree | null = preview ? previewTree : treeMatches ? storeTree : null;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Record<string, OrgSession[]>>({});
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [requests, setRequests] = useState<Record<string, { cursor: string }>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [pendingMove, setPendingMove] = useState<OrgReparentRequest | null>(null);
  const [movePicker, setMovePicker] = useState<MoveSubject | null>(null);
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const menu = useContextMenu<OrgLayoutNode>();
  const phone = useIsPhone();
  const openLinked = useOpenLinkedSession();
  const now = useCoarseNow(30_000);

  // -------- staffing (org-staffing.md S5): the sheet's second mode
  // `?proposal=op-N` opens the sheet in staffing mode on that proposal; the
  // Staffing tab and a ghost click open it too. The mode is the sheet's own;
  // selecting a node while it is open keeps the pane and highlights the node.
  const proposalShortId = proposalParam(searchParams.toString());
  // `?compose=<text>` (a charter empty state links here) opens the pane and
  // seeds the chief of staff's composer with the text.
  const composeText = composeParam(searchParams.toString());
  const [panelMode, setPanelModeState] = useState<OrgPanelMode>(proposalShortId || composeText ? "staffing" : "node");
  const [staffingOpen, setStaffingOpen] = useState(!!proposalShortId || !!composeText);
  const [editRoleChange, setEditRoleChange] = useState<OrgProposalChange | null>(null);
  const [reviewingSince, setReviewingSince] = useState<number | null>(null);
  /** The session "Propose an org now" started: its stub id at once, the real
   *  id once the server names it, so "Open the review session" always lands. */
  const [reviewSession, setReviewSession] = useState<string | null>(null);
  /** A node the chart should bring into view (a flag row, a change on an
   *  existing role): OrgGraph pans to it the way it pans to a focused ghost. */
  const [graphFocus, setGraphFocus] = useState<OrgFocusTarget | null>(null);
  const focusSeq = useRef(0);
  const askFocus = useCallback((kind: OrgFocusTarget["kind"], id: string) => setGraphFocus({ kind, id, seq: ++focusSeq.current }), []);
  const proposals = useMemo<OrgProposalRow[]>(() => preview ? previewProposals : joinProposals(s.orgProposals, s.orgProposalChanges), [preview, previewProposals, s.orgProposals, s.orgProposalChanges]);
  const workspaceProposals = useMemo(() => {
    const wanted = tree?.workspace;
    return wanted ? proposals.filter((p) => wanted.kind === "team" ? p.team_id === wanted.id : !p.team_id) : proposals;
  }, [proposals, tree]);
  const proposal = useMemo(() => pickProposal(workspaceProposals, proposalShortId), [workspaceProposals, proposalShortId]);
  // The linked proposal, whatever workspace it lives in: the get feeder fills
  // its row and changes, and the resolver names a foreign or unreadable link.
  const linkedRef = proposalShortId ?? proposal?.short_id ?? null;
  const lookup = useSyncOrgProposal(preview ? null : linkedRef);
  const activeWorkspace = tree ? { kind: tree.workspace.kind, id: tree.workspace.id } : null;
  const linkState = useMemo(() => preview ? { kind: "open" as const } : resolveProposalLink(proposalShortId, proposals, activeWorkspace, lookup), [preview, proposalShortId, proposals, activeWorkspace?.kind, activeWorkspace?.id, lookup.ready, lookup.missing]);
  const link = useMemo<ProposalLinkLine | undefined>(() => {
    if (linkState.kind === "open") return undefined;
    if (linkState.kind !== "foreign") return linkState;
    const ws = linkState.workspace;
    const team = ws.kind === "team" ? (s.teams ?? []).find((t: { _id?: string }) => t?._id === ws.id) : null;
    const workspaceName = ws.kind === "team" ? (team?.name ?? "another team") : ws.id === meId ? "your personal workspace" : "another workspace";
    // The switch keeps `?proposal=` in the URL: the feeders re-scope to the
    // new pointer and the pane opens on the proposal once its list row lands.
    return { kind: "foreign", shortId: linkState.shortId, workspaceName, onSwitch: () => void switchWorkspace(ws.kind === "team" ? ws.id : null) };
  }, [linkState, s.teams, meId, switchWorkspace]);
  const health: OrgHealth | null = preview ? ORG_STAFFING_FIXTURE_HEALTH : storeHealth;
  const chief = useMemo(() => findChiefOfStaff(tree), [tree]);
  // Reviewing until a proposal newer than the click lands, or the TTL passes
  // (`now` is the coarse clock, so the state falls back on its own).
  const reviewing = reviewingSince !== null && now - reviewingSince < REVIEW_TTL_MS && !openProposals(workspaceProposals).some((p) => p.created_at >= reviewingSince);
  const setProposalParam = useCallback((shortId: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (shortId) params.set("proposal", shortId); else params.delete("proposal");
    const qs = params.toString();
    router.replace(qs ? `/org?${qs}` : "/org");
  }, [searchParams, router]);
  const setPanelMode = useCallback((mode: OrgPanelMode) => {
    setPanelModeState(mode);
    if (mode === "staffing") setStaffingOpen(true);
  }, []);
  const focusChangeId = storeFocusChangeId;
  const setFocusChangeId = useCallback((id: string | null) => useInboxStore.getState().setOrgFocusChangeId(id), []);
  // The compose text lands in the standing session's store draft, which is
  // what the embedded composer seeds from (MessageInput reads getDraft), then
  // the parameter leaves the URL so a reload does not seed it twice. A draft
  // the person already typed wins.
  useWatchEffect(() => {
    const conv = chief?.standing?.conversation_id;
    if (!composeText || !conv) return;
    const st = useInboxStore.getState();
    const existing = st.getDraft(conv) ?? {};
    if (!existing.draft_message) st.setDraft(conv, { ...existing, draft_message: composeText });
    const params = new URLSearchParams(searchParams.toString());
    params.delete("compose");
    const qs = params.toString();
    router.replace(qs ? `/org?${qs}` : "/org");
  }, [composeText, chief?.standing?.conversation_id]);
  // A ghost click on the chart sets the scalar; the pane opens on that change.
  useWatchEffect(() => {
    if (storeFocusChangeId) setPanelMode("staffing");
  }, [storeFocusChangeId, setPanelMode]);

  const view = useMemo<OrgLayoutView>(() => ({ collapsed, expanded }), [collapsed, expanded]);
  const layout = useMemo(() => (tree ? layoutOrgTree(tree, view) : null), [tree, view]);
  const selectedNode = useMemo(() => layout?.nodes.find((n) => n.id === selectedId) ?? null, [layout, selectedId]);
  if (selectedId && layout && !selectedNode) setSelectedId(null);

  // -------- store actions (or the preview equivalent)
  const slice = useMemo(() => createOrgSlice(), []);
  const run = useCallback(<K extends "reparentOrgSession" | "reparentOrgRole" | "createOrgRole" | "updateOrgRole" | "retireOrgRole" | "staffChiefOfStaff">(name: K, ...args: Parameters<ReturnType<typeof createOrgSlice>[K]>) => {
    if (preview) {
      setPreviewTree((t) => mutate(t, (draft) => { (slice[name] as any).call({ orgTree: draft }, ...args); }));
      return;
    }
    (useInboxStore.getState() as any)[name](...args);
  }, [preview, slice]);

  // -------- permissions
  const me = tree?.people.find((p) => p.is_me) ?? (meId ? tree?.people.find((p) => p.user_id === meId) : undefined);
  const isAdmin = me?.role === "admin" || me?.role === "owner" || tree?.workspace.kind === "user";
  const canEditRole = useCallback((roleId: string) => {
    const r = tree?.roles.find((x) => x._id === roleId);
    return !!r && (isAdmin || r.host_user_id === (me?.user_id ?? meId));
  }, [tree, isAdmin, me, meId]);
  const canMoveSession = useCallback((sess: OrgSession) => isAdmin || sess.owner_user_id === (me?.user_id ?? meId), [isAdmin, me, meId]);
  /** Which cards may be picked up at all: no drag that would only snap back. */
  const canDrag = useCallback((n: OrgLayoutNode) => n.kind === "session" ? canMoveSession(n.session) : n.kind === "role" ? canEditRole(n.role._id) : false, [canMoveSession, canEditRole]);

  // -------- sessions under a parent: tree bucket + loaded pages
  const sessionsUnder = useCallback((parentId: string): OrgSession[] => {
    if (!tree) return [];
    const ref = parentRefOfNodeId(parentId);
    const bucket = ref?.kind === "user" ? tree.people.find((p) => p.user_id === ref.user_id) : ref ? tree.roles.find((r) => r._id === ref.role_id) : null;
    const base = bucket?.sessions ?? [];
    const seen = new Set(base.map((x) => x._id));
    return [...base, ...(expanded[parentId] ?? []).filter((x) => !seen.has(x._id))];
  }, [tree, expanded]);
  const totalUnder = useCallback((parentId: string): number => {
    if (!tree) return 0;
    const ref = parentRefOfNodeId(parentId);
    const bucket = ref?.kind === "user" ? tree.people.find((p) => p.user_id === ref.user_id) : ref ? tree.roles.find((r) => r._id === ref.role_id) : null;
    return bucket?.total ?? 0;
  }, [tree]);
  const loadMore = useCallback((parentId: string) => {
    // First click: the stack draws five of the payload's eight; open it to
    // show what is already here before asking the server for more.
    if (!(parentId in expanded) && sessionsUnder(parentId).length > ORG_STACK_VISIBLE) {
      setExpanded((e) => ({ ...e, [parentId]: [] }));
      return;
    }
    if (cursors[parentId] === null || requests[parentId]) return;
    setExpanded((e) => (parentId in e ? e : { ...e, [parentId]: [] }));
    // The server pages by offset and the tree's payload IS page one, so the
    // first request starts past what the tree already carries (orgPager.ts).
    setRequests((r) => ({ ...r, [parentId]: { cursor: firstServerCursor(cursors[parentId], sessionsUnder(parentId).length) } }));
  }, [cursors, requests, expanded, sessionsUnder]);
  const onPage = useCallback((parentId: string, rows: OrgSession[], next?: string) => {
    setExpanded((e) => {
      const have = new Set([...(e[parentId] ?? [])].map((x) => x._id));
      return { ...e, [parentId]: [...(e[parentId] ?? []), ...rows.filter((x) => !have.has(x._id))] };
    });
    setCursors((c) => ({ ...c, [parentId]: next ?? null }));
    setRequests((r) => { const { [parentId]: _drop, ...rest } = r; return rest; });
  }, []);
  const collapseCluster = useCallback((parentId: string) => {
    setExpanded((e) => { const { [parentId]: _drop, ...rest } = e; return rest; });
    setCursors((c) => { const { [parentId]: _drop, ...rest } = c; return rest; });
  }, []);
  const sessionsSource = useMemo<OrgSessionsSource>(() => ({
    sessionsUnder,
    hasMore: (id) => cursors[id] !== null && sessionsUnder(id).length < totalUnder(id),
    loading: (id) => !!requests[id],
    loadMore,
  }), [sessionsUnder, cursors, totalUnder, requests, loadMore]);
  const loadingClusters = useMemo(() => new Set(Object.keys(requests)), [requests]);

  // -------- gestures
  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((c) => { const n = new Set(c); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);
  /** Bring a node into view from the pane (a flag row, a change on an
   *  existing role): expand every collapsed ancestor so it has a card, select
   *  it, and hand it to the chart as a viewport target. A bare setSelectedId
   *  only toggles the highlight, which off screen or under a collapsed parent
   *  shows the person nothing. */
  const focusNode = useCallback((nodeId: string) => {
    if (tree) {
      const ancestors: string[] = [];
      let ref = parentRefOfNodeId(nodeId);
      for (let depth = 0; ref && ref.kind === "role" && depth < 32; depth++) {
        const role = tree.roles.find((r) => r._id === (ref as { role_id: string }).role_id);
        if (!role) break;
        ref = role.reports_to;
        ancestors.push(parentNodeId(ref));
      }
      if (ancestors.some((id) => collapsed.has(id))) setCollapsed((c) => { const n = new Set(c); for (const id of ancestors) n.delete(id); return n; });
    }
    setSelectedId(nodeId);
    askFocus("node", nodeId);
  }, [tree, collapsed, askFocus]);
  /** A session by id, from the tree's top N or from any loaded page. */
  const findSession = useCallback((conversationId: string): OrgSession | null => {
    if (!tree) return null;
    for (const b of [...tree.people, ...tree.roles]) { const s = b.sessions.find((x) => x._id === conversationId); if (s) return s; }
    for (const rows of Object.values(expanded)) { const s = rows.find((x) => x._id === conversationId); if (s) return s; }
    return null;
  }, [tree, expanded]);
  const openSession = useCallback((conversationId: string) => {
    const row = findSession(conversationId);
    if (preview) return;
    openLinked({ _id: conversationId, title: row?.title, short_id: row?.short_id, agent_type: row?.agent_type, updated_at: row?.updated_at ?? Date.now(), is_active: row?.state === "working" });
  }, [findSession, preview, openLinked]);

  const requestMove = useCallback((req: OrgReparentRequest) => {
    if (!tree) return;
    if (req.subject.kind === "role" && orgRoleReparentMakesCycle(tree, req.subject.id, req.target)) { setResetKey((k) => k + 1); return; }
    if (req.subject.kind === "session") {
      const sess = findSession(req.subject.id);
      if (!sess || !canMoveSession(sess)) { setResetKey((k) => k + 1); return; }
    } else if (!canEditRole(req.subject.id)) { setResetKey((k) => k + 1); return; }
    setPendingMove(req);
  }, [tree, canMoveSession, canEditRole, findSession]);
  const commitMove = useCallback((req: OrgReparentRequest) => {
    if (req.subject.kind === "session") {
      // The row may live only in a loaded page (beyond the tree's top N): hand
      // it to the slice so counts move, and move it between the page's own
      // lists so it is drawn once, under the target.
      const row = findSession(req.subject.id);
      setExpanded((e) => moveExpandedSession(e, req.subject.id, parentNodeId(req.target), row));
      run("reparentOrgSession", req.subject.id, req.target, row);
    } else {
      run("reparentOrgRole", req.subject.id, req.target);
    }
    setPendingMove(null);
    setResetKey((k) => k + 1);
  }, [run, findSession]);
  const cancelMove = useCallback(() => { setPendingMove(null); setResetKey((k) => k + 1); }, []);

  const currentParentOf = useCallback((subject: MoveSubject): OrgParentRef | null => {
    if (!tree) return null;
    if (subject.kind === "role") return tree.roles.find((r) => r._id === subject.id)?.reports_to ?? null;
    for (const p of tree.people) if (p.sessions.some((x) => x._id === subject.id)) return { kind: "user", user_id: p.user_id };
    for (const r of tree.roles) if (r.sessions.some((x) => x._id === subject.id)) return { kind: "role", role_id: r._id };
    for (const [pid, rows] of Object.entries(expanded)) if (rows.some((x) => x._id === subject.id)) return parentRefOfNodeId(pid);
    return null;
  }, [tree, expanded]);

  const moveTargets = useMemo(() => {
    if (!tree) return [];
    return [
      ...tree.people.map((p) => ({ ref: { kind: "user", user_id: p.user_id } as OrgParentRef, id: parentNodeId({ kind: "user", user_id: p.user_id }), title: p.name, sub: p.is_me ? "you" : p.role, kind: "person" as const, image: p.image })),
      ...tree.roles.filter((r) => r.status !== "retired").map((r) => ({ ref: { kind: "role", role_id: r._id } as OrgParentRef, id: parentNodeId({ kind: "role", role_id: r._id }), title: r.name, sub: `@${r.handle}`, kind: "role" as const, image: undefined })),
    ];
  }, [tree]);

  const pickTarget = useCallback((subject: MoveSubject, target: OrgParentRef, targetTitle: string) => {
    const cur = currentParentOf(subject);
    if (cur && sameParent(cur, target)) return;
    if (subject.kind === "role" && (target.kind === "role" && target.role_id === subject.id || (tree && orgRoleReparentMakesCycle(tree, subject.id, target)))) return;
    setMovePicker(null);
    commitMove({ subject, target, targetTitle, at: { x: window.innerWidth / 2, y: window.innerHeight / 2 } } as OrgReparentRequest);
  }, [currentParentOf, tree, commitMove]);

  const updateRole = useCallback((roleId: string, fields: OrgUpdateRoleInput) => run("updateOrgRole", roleId, fields), [run]);
  const retireRole = useCallback((roleId: string) => { run("retireOrgRole", roleId); setSelectedId(null); }, [run]);

  // -------- staffing actions
  /** The preview decides on its local copy; live, the store action flips the
   *  row and rides dispatch to orgProposals.decide. */
  const decideChange = useCallback((changeId: string, verdict: "accept" | "skip", edits?: Record<string, unknown>) => {
    if (preview) {
      setPreviewProposals((rows) => rows.map((p) => ({ ...p, changes: p.changes.map((c) => c._id === changeId ? { ...c, status: verdict === "accept" ? "applied" : "skipped", decided_at: Date.now(), ...(edits ? { edits } : {}) } : c) })));
      return;
    }
    useInboxStore.getState().decideOrgProposalChange(changeId, verdict, edits);
  }, [preview]);
  const acceptAll = useCallback((proposalId: string) => {
    if (preview) {
      setPreviewProposals((rows) => rows.map((p) => p._id !== proposalId ? p : { ...p, changes: p.changes.map((c) => c.status === "proposed" ? { ...c, status: "applied" as const, decided_at: Date.now() } : c) }));
      return;
    }
    useInboxStore.getState().acceptAllOrgProposal(proposalId);
  }, [preview]);
  /** Click on a change: focus its ghost (the scalar) and, when its subject
   *  already exists on the chart, highlight that node. */
  const selectChange = useCallback((changeId: string | null) => {
    setFocusChangeId(changeId);
    const change = changeId ? proposal?.changes.find((c) => c._id === changeId) : null;
    const nodeId = change ? changeNodeId(change.change, tree) : null;
    if (nodeId) focusNode(nodeId);
    else if (changeId) askFocus("change", changeId);
    else setGraphFocus(null);
  }, [proposal, tree, setFocusChangeId, focusNode, askFocus]);
  /** A paused chief holds every line sent to it until resumed (orgRoles
   *  wakeIsHeld); the composer says so and this is its Resume. */
  const resumeChief = useCallback((roleId: string) => updateRole(roleId, { status: "active" }), [updateRole]);
  const hireChief = useCallback(() => {
    const host = me?.user_id ?? meId;
    if (!tree || !host) return;
    // The provisioned standing session starts in a project, like every
    // session the web starts (the same resolution proposeNow uses).
    const st = useInboxStore.getState();
    const projectPath = resolveComposeProjectPath({
      conversation: st.currentConversation,
      activeProjectFilter: st.activeProjectFilter,
      activeProjectPath: st.activeProjectPath,
      chipFilterExclude: st.chipFilterExclude,
      recentProjects: st.recentProjects,
      machineRoster: st.machineRoster,
    });
    run("staffChiefOfStaff", { ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}), ...(projectPath ? { project_path: projectPath } : {}), host_user_id: host, client_id: `orgrolestub-chief-${Math.random().toString(36).slice(2)}` });
    toast.success("Hiring the chief of staff: its first review lands as a proposal here");
  }, [tree, me, meId, run]);
  /** "Propose an org now": one review from a fresh session, no hire (S8).
   *  Rides the same spawn route as every session the web starts. */
  const proposeNow = useCallback(() => {
    setReviewingSince(Date.now());
    setReviewSession(null);
    if (preview) {
      // The fixture lands after a beat so the reviewing state can be seen.
      setTimeout(() => setPreviewProposals((rows) => rows.length ? rows : [{ ...ORG_STAFFING_FIXTURE_PROPOSAL, created_at: Date.now() }]), 1500);
      return;
    }
    const st = useInboxStore.getState();
    const projectPath = resolveComposeProjectPath({
      conversation: st.currentConversation,
      activeProjectFilter: st.activeProjectFilter,
      activeProjectPath: st.activeProjectPath,
      chipFilterExclude: st.chipFilterExclude,
      recentProjects: st.recentProjects,
      machineRoster: st.machineRoster,
    });
    const { stubId } = spawnSessionWithPrompt({
      prompt: "Review this company's organization: run `cast org review` and write the proposal it asks for. Propose the smallest set of changes that removes the bottlenecks you find, with evidence a person can click; apply nothing.",
      projectPath: projectPath ?? undefined,
      failureLabel: "Failed to start the org review",
    });
    setReviewSession(stubId);
    // The stub is re-keyed when the server names the row; follow it so the
    // link still opens the session after that.
    void st.awaitConvexId(stubId).then((id) => { if (id) setReviewSession(String(id)); }).catch(() => {});
    toast.success("Reviewing the company in a fresh session");
  }, [preview]);
  const closePanel = useCallback(() => {
    setSelectedId(null);
    setGraphFocus(null);
    setStaffingOpen(false);
    setFocusChangeId(null);
    if (proposalShortId) setProposalParam(null);
  }, [proposalShortId, setProposalParam, setFocusChangeId]);
  // The proposal's scope refs and reports_to string land in the form as ids
  // and a parent ref (the dialog's own language); submit translates back.
  const editRoleInitial = useMemo<HireRoleInitial | undefined>(() => editRoleChange && tree ? roleChangeInitial(editRoleChange, tree) : undefined, [editRoleChange, tree]);

  // -------- header stats
  const stats = useMemo(() => {
    if (!tree) return null;
    const counts = { ...EMPTY_COUNTS };
    let sessions = 0;
    for (const b of [...tree.people, ...tree.roles]) {
      sessions += b.total;
      for (const k of Object.keys(counts) as (keyof typeof counts)[]) counts[k] += b.counts[k] ?? 0;
    }
    return { people: tree.people.length, roles: tree.roles.filter((r) => r.status !== "retired").length, anchors: tree.anchors.length, sessions, counts };
  }, [tree]);

  const nodeSelected = !!selectedNode && selectedNode.kind !== "cluster";
  const panelOpen = nodeSelected || staffingOpen;
  const panelWidth = panelOpen && !phone ? PANEL_W : 0;
  // On the phone the pane is a bottom sheet over the same canvas: it grows
  // to 90% while the composer has focus so the thread and the keyboard fit,
  // and the graph centres a focused ghost in what stays free above it.
  const [composerFocused, setComposerFocused] = useState(false);
  const sheetFraction = panelOpen && phone ? (composerFocused ? 0.9 : 0.62) : 0;
  const staffingCount = proposal ? proposalProgress(proposal).remaining : 0;
  const staffingPane = tree ? (
    <StaffingPane
      tree={tree}
      health={health}
      healthMissing={!preview && healthMissing}
      proposals={workspaceProposals}
      proposal={proposal}
      selectedChangeId={focusChangeId}
      chief={chief}
      reviewing={reviewing}
      reviewSessionId={reviewSession}
      now={now}
      onSelectChange={selectChange}
      onDecide={decideChange}
      onAcceptAll={acceptAll}
      onEditRole={setEditRoleChange}
      onSelectNode={focusNode}
      onOpenSession={openSession}
      onPickProposal={setProposalParam}
      onHireChief={hireChief}
      onProposeNow={proposeNow}
      onResumeChief={resumeChief}
      link={link}
    />
  ) : null;
  const panelProps = tree ? {
    tree,
    node: nodeSelected ? selectedNode : null,
    sessions: sessionsSource,
    canEdit: selectedNode?.kind === "role" ? canEditRole(selectedNode.role._id) : selectedNode?.kind === "session" ? canMoveSession(selectedNode.session) : !!isAdmin,
    onClose: closePanel,
    onOpenSession: openSession,
    onMove: setMovePicker,
    onUpdateRole: updateRole,
    onRetireRole: retireRole,
    onSelectNode: setSelectedId,
    mode: panelMode,
    onMode: setPanelMode,
    staffing: staffingPane,
    staffingCount,
    changes: proposal?.status === "open" ? proposal.changes : undefined,
    focusChangeId,
    onSelectChange: selectChange,
  } : null;

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }}>
      {/* header */}
      <div className="shrink-0 px-4 sm:px-6 pt-4 pb-3 border-b flex items-end justify-between gap-3 flex-wrap" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }}>
        <div className="min-w-0">
          <h1 className="text-[26px] leading-none font-semibold tracking-tight flex items-center gap-2.5" style={{ fontFamily: "var(--font-serif)" }}>
            <Network className="w-6 h-6" style={{ color: "var(--sol-violet)" }} strokeWidth={1.75} />
            Org
            {tree && <span className="text-[13px] font-normal mt-1 truncate" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>/ {tree.workspace.name || (tree.workspace.kind === "user" ? "personal" : "team")}</span>}
          </h1>
          <p className="mt-1.5 text-[12.5px] truncate" style={{ color: "var(--sol-text-muted)" }}>
            <span className="hidden sm:inline">Who reports to whom: people, the roles they created, standing anchors, every session. Drag a card to move it.</span>
            <span className="sm:hidden">Who reports to whom. Drag a card to move it.</span>
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {stats && (
            <div className="flex items-center gap-2">
              <div className="hidden sm:flex items-center gap-2">
                <HeaderStat icon={Users} value={stats.people} label="people" />
                <HeaderStat icon={Briefcase} value={stats.roles} label="roles" tint="var(--sol-violet)" />
              </div>
              <div className="flex items-center gap-2 h-[34px] px-3 rounded-lg border" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
                <span className="text-[14px] font-semibold tabular-nums">{stats.sessions}</span>
                <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>sessions</span>
                <span className="hidden md:inline w-px h-4" style={{ background: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} />
                {/* The header is the one place the tally is labelled in words;
                    the cluster cards reuse the dots under a StateBar that sets the context. */}
                <span className="hidden md:inline"><StateTally counts={stats.counts} labels /></span>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setPanelMode("staffing")}
            className={cn("h-[34px] inline-flex items-center gap-1.5 px-3 rounded-lg border text-[12.5px] font-medium transition-colors", staffingOpen && panelMode === "staffing" ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60")}
            style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: "var(--sol-text-muted)" }}
            title={proposal ? `${proposal.short_id}: ${staffingCount} to decide` : "Company health and the chief of staff"}
            aria-pressed={staffingOpen && panelMode === "staffing"}
          >
            Staffing
            {staffingCount > 0 && <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular-nums" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>{staffingCount}</span>}
          </button>
          <button
            type="button"
            onClick={() => setShowMiniMap((v) => !v)}
            className={cn("h-[34px] w-[34px] inline-flex items-center justify-center rounded-lg border transition-colors", showMiniMap ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60")}
            style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: showMiniMap ? "var(--sol-text)" : "var(--sol-text-muted)" }}
            title={showMiniMap ? "Hide minimap" : "Show minimap"}
            aria-pressed={showMiniMap}
          >
            <MapIcon className="w-4 h-4" />
          </button>
          {tree && isAdmin !== false && (
            <button type="button" onClick={() => setAddRoleOpen(true)} title="A seat that sessions and other roles report to, with a scope of projects and plans" className="h-[34px] inline-flex items-center gap-1.5 pl-3 pr-3.5 rounded-lg text-[12.5px] font-semibold transition-colors hover:brightness-110" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>
              <Plus className="w-3.5 h-3.5" /> Add a role
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div className="shrink-0 px-4 sm:px-6 py-1.5 text-[11.5px] flex items-center gap-2 border-b" style={{ background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)", borderColor: "color-mix(in srgb, var(--sol-yellow) 25%, transparent)", color: "var(--sol-text-muted)" }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--sol-yellow)" }} />
          Preview data (dev only, ?preview=1). Edits here stay on this page.
        </div>
      )}

      {/* body */}
      <div className="flex-1 min-h-0 relative flex">
        <div className="relative flex-1 min-w-0" style={{ background: "radial-gradient(ellipse at 50% 0%, color-mix(in srgb, var(--sol-bg-alt) 55%, transparent) 0%, transparent 60%)" }}>
          {tree && layout && layout.nodes.length > 0 ? (
            <OrgGraph
              tree={tree}
              view={view}
              selectedId={selectedId}
              loadingClusters={loadingClusters}
              showMiniMap={showMiniMap}
              onSelect={setSelectedId}
              onToggleCollapse={toggleCollapse}
              onExpandCluster={loadMore}
              onCollapseCluster={collapseCluster}
              onReparentRequest={requestMove}
              canDrag={canDrag}
              onNodeContextMenu={(e, n) => menu.open(e, n, { force: true })}
              onOpenSession={openSession}
              resetKey={resetKey}
              panelWidth={panelWidth}
              panelHeightFraction={sheetFraction}
              changes={proposal?.status === "open" ? proposal.changes : undefined}
              health={health}
              viewerSession={viewerSession}
              focusChangeId={focusChangeId}
              focusTarget={graphFocus}
              onFocusChange={selectChange}
              onDecideChange={decideChange}
              onEditRoleChange={setEditRoleChange}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              {missing && !tree ? (
                <div className="text-center max-w-xs px-6">
                  <Network className="w-8 h-8 mx-auto mb-3" style={{ color: "var(--sol-text-dim)" }} />
                  <div className="text-sm font-medium">The org backend is not deployed yet</div>
                  <p className="mt-1 text-[12.5px]" style={{ color: "var(--sol-text-muted)" }}>This page will fill in on its own once it is.</p>
                </div>
              ) : !ready && !tree ? (
                <div className="flex flex-col items-center gap-3" style={{ color: "var(--sol-text-dim)" }}>
                  <Network className="w-8 h-8 animate-pulse" style={{ color: "var(--sol-violet)" }} />
                  <span className="text-sm">Drawing the tree…</span>
                </div>
              ) : (
                <div className="text-center max-w-xs px-6">
                  <div className="text-sm font-medium">Nobody here yet</div>
                  <p className="mt-1 text-[12.5px]" style={{ color: "var(--sol-text-muted)" }}>Sessions from the last 30 days appear under their owners.</p>
                </div>
              )}
            </div>
          )}
          <div className="pointer-events-none absolute bottom-3 hidden lg:flex items-center gap-2 text-[10.5px] whitespace-nowrap transition-[right] duration-200" style={{ color: "var(--sol-text-dim)", right: panelWidth + 12 }}>
            <span>drag to move · double click to open</span>
            <span className="inline-flex items-center gap-1"><KeyCap size="xs">esc</KeyCap> clear</span>
          </div>
        </div>

        {/* panel: right on desktop, bottom sheet on phone */}
        {panelOpen && panelProps && !phone && (
          <aside className="absolute right-0 top-0 bottom-0 z-20 border-l min-h-0 org-panel-in shadow-[-16px_0_40px_-24px_rgba(0,0,0,0.45)]" style={{ width: PANEL_W, borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", background: "var(--sol-bg)" }}>
            <OrgScopePanel {...panelProps} />
          </aside>
        )}
        {panelOpen && panelProps && phone && (
          <div
            className="absolute inset-x-0 bottom-0 z-20 rounded-t-2xl border-t shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.45)] org-sheet-in transition-[height] duration-200"
            style={{ height: `${Math.round(sheetFraction * 100)}%`, background: "var(--sol-bg)", borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }}
            data-org-sheet
            onFocusCapture={(e) => { if ((e.target as HTMLElement).closest?.("[data-composer]")) setComposerFocused(true); }}
            onBlurCapture={(e) => { if (!(e.relatedTarget as HTMLElement | null)?.closest?.("[data-composer]")) setComposerFocused(false); }}
          >
            <div className="flex justify-center pt-2"><span className="w-10 h-1 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 60%, transparent)" }} /></div>
            <div className="h-[calc(100%-12px)]">
              <OrgScopePanel {...panelProps} />
            </div>
          </div>
        )}
      </div>

      {/* pagers */}
      {Object.entries(requests).map(([pid, r]) => (
        parentRefOfNodeId(pid) ? <SessionsUnderPager key={`${pid}:${r.cursor ?? ""}`} parentId={pid} cursor={r.cursor} teamId={activeTeamId && isConvexId(activeTeamId) ? activeTeamId : undefined} onPage={onPage} preview={preview} /> : null
      ))}

      {/* confirm popover */}
      {pendingMove && <MoveConfirm req={pendingMove} onConfirm={() => commitMove(pendingMove)} onCancel={cancelMove} />}

      {/* move picker */}
      {movePicker && tree && (
        <MovePicker
          subject={movePicker}
          current={currentParentOf(movePicker)}
          targets={moveTargets.filter((t) => !(movePicker.kind === "role" && t.ref.kind === "role" && (t.ref.role_id === movePicker.id || orgRoleReparentMakesCycle(tree, movePicker.id, t.ref))))}
          onPick={(t) => pickTarget(movePicker, t.ref, t.title)}
          onClose={() => setMovePicker(null)}
        />
      )}

      {/* add role */}
      {tree && addRoleOpen && (
        <HireRoleDialog
          key={me?.user_id ?? meId ?? ""}
          open={addRoleOpen}
          onClose={() => setAddRoleOpen(false)}
          tree={tree}
          meId={me?.user_id ?? meId ?? ""}
          onCreate={(input) => {
            run("createOrgRole", input);
            setAddRoleOpen(false);
          }}
        />
      )}

      {/* edit a proposed role (S5): the hire dialog prefilled; submit accepts with edits */}
      {tree && editRoleChange && (
        <HireRoleDialog
          key={editRoleChange._id}
          open
          onClose={() => setEditRoleChange(null)}
          tree={tree}
          meId={me?.user_id ?? meId ?? ""}
          title="Edit the proposed role"
          submitLabel="Accept with edits"
          initial={editRoleInitial}
          onCreate={(input) => {
            // The dialog speaks in ids and parent refs; the change contract in
            // refs and a string (staffingModel.roleChangeEdits).
            decideChange(editRoleChange._id, "accept", roleChangeEdits(input, tree, me?.user_id ?? meId ?? ""));
            setEditRoleChange(null);
          }}
        />
      )}

      {/* context menu */}
      <ContextMenu state={menu}>
        {(n) => <OrgNodeMenu node={n} tree={tree!} onToggleCollapse={toggleCollapse} onOpenSession={openSession} onMove={(s) => setMovePicker(s)} onSelect={setSelectedId} onRetire={retireRole} canEditRole={canEditRole} canMoveSession={canMoveSession} targets={moveTargets} onPick={pickTarget} currentParentOf={currentParentOf} />}
      </ContextMenu>
    </div>
  );
}

function HeaderStat({ icon: Icon, value, label, tint }: { icon: any; value: number; label: string; tint?: string }) {
  return (
    <div className="flex items-center gap-2 h-[34px] px-3 rounded-lg border" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
      <Icon className="w-3.5 h-3.5" style={{ color: tint ?? "var(--sol-cyan)" }} />
      <span className="text-[14px] font-semibold tabular-nums">{value}</span>
      <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------- confirm popover

function MoveConfirm({ req, onConfirm, onCancel }: { req: OrgReparentRequest; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useMountEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button[data-primary]")?.focus();
  });
  useEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
  }, undefined, { capture: true });
  const w = 280;
  const x = Math.max(12, Math.min(req.at.x - w / 2, (typeof window !== "undefined" ? window.innerWidth : 1200) - w - 12));
  const y = Math.max(12, req.at.y + 14);
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onCancel} />
      <div ref={ref} className="fixed z-50 rounded-xl border p-3 org-pop-in" style={{ left: x, top: y, width: w, background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", boxShadow: "0 18px 48px -18px rgba(0,0,0,0.5), 0 3px 10px rgba(0,0,0,0.12)" }} role="dialog" aria-label="Confirm move">
        <div className="text-[12.5px] leading-snug" style={{ color: "var(--sol-text)" }}>
          Move <b className="font-semibold">{req.subject.title}</b> under <b className="font-semibold">{req.targetTitle}</b>?
        </div>
        <div className="mt-1 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>
          {req.subject.kind === "session"
            ? req.target.kind === "user" ? "The session becomes owned by this person." : "The session keeps its owners and reports to this role."
            : "The role and everything under it move together."}
        </div>
        <div className="mt-2.5 flex items-center justify-end gap-1.5">
          <button type="button" onClick={onCancel} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
          <OrgButton primary data-primary onClick={onConfirm} size="sm">Move</OrgButton>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- move picker

type MoveTarget = { ref: OrgParentRef; id: string; title: string; sub: string; kind: "person" | "role"; image?: string };

function MovePicker({ subject, current, targets, onPick, onClose }: { subject: MoveSubject; current: OrgParentRef | null; targets: MoveTarget[]; onPick: (t: MoveTarget) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const list = targets.filter((t) => !q || t.title.toLowerCase().includes(q.toLowerCase()) || t.sub.toLowerCase().includes(q.toLowerCase()));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[380px] p-0 gap-0 overflow-hidden" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-[15px]" style={{ fontFamily: "var(--font-serif)" }}>Move {subject.kind === "role" ? "role" : "session"}</DialogTitle>
          <DialogDescription className="text-[12px] truncate" style={{ color: "var(--sol-text-muted)" }}>{subject.title}</DialogDescription>
        </DialogHeader>
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 h-9 px-2.5 rounded-lg border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", background: "var(--sol-bg-alt)" }}>
            <Search className="w-3.5 h-3.5" style={{ color: "var(--sol-text-dim)" }} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Person or role…" className="flex-1 bg-transparent outline-none text-[13px]" style={{ color: "var(--sol-text)" }} />
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto px-2 pb-3">
          {list.length === 0 && <p className="px-2.5 py-3 text-[12px]" style={{ color: "var(--sol-text-dim)" }}>No match.</p>}
          {list.map((t) => {
            const isCurrent = !!current && sameParent(current, t.ref);
            return (
              <button key={t.id} type="button" disabled={isCurrent} onClick={() => onPick(t)} className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-sol-bg-highlight/70 disabled:opacity-50 disabled:cursor-default">
                {t.kind === "person" ? <Avatar name={t.title} image={t.image} /> : <span className="w-5 h-5 rounded-md inline-flex items-center justify-center text-[9px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>@</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{t.title}</span>
                  <span className="block truncate text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>{t.sub}{isCurrent ? " · current" : ""}</span>
                </span>
                {!isCurrent && <ArrowRightLeft className="w-3.5 h-3.5" style={{ color: "var(--sol-text-dim)" }} />}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- context menu

function OrgNodeMenu({ node, tree, onToggleCollapse, onOpenSession, onMove, onSelect, onRetire, canEditRole, canMoveSession, targets, onPick, currentParentOf }: {
  node: OrgLayoutNode; tree: OrgTree;
  onToggleCollapse: (id: string) => void; onOpenSession: (id: string) => void; onMove: (s: MoveSubject) => void; onSelect: (id: string) => void; onRetire: (id: string) => void;
  canEditRole: (id: string) => boolean; canMoveSession: (s: OrgSession) => boolean;
  targets: MoveTarget[]; onPick: (s: MoveSubject, t: OrgParentRef, title: string) => void; currentParentOf: (s: MoveSubject) => OrgParentRef | null;
}) {
  const moveSub = (subject: MoveSubject) => {
    const cur = currentParentOf(subject);
    const list = targets.filter((t) => !(subject.kind === "role" && t.ref.kind === "role" && (t.ref.role_id === subject.id || orgRoleReparentMakesCycle(tree, subject.id, t.ref))));
    return (
      <CtxSub>
        <CtxSubTrigger icon={ArrowRightLeft}>Move to…</CtxSubTrigger>
        <CtxSubContent>
          {list.slice(0, 12).map((t) => {
            const isCur = !!cur && sameParent(cur, t.ref);
            return (
              <CtxItem key={t.id} disabled={isCur} onSelect={() => onPick(subject, t.ref, t.title)} leading={t.kind === "person" ? <Avatar name={t.title} image={t.image} /> : <span className="w-4 h-4 rounded inline-flex items-center justify-center text-[8px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>@</span>} trailing={isCur ? <span className="text-[10px]" style={{ color: "var(--sol-text-dim)" }}>current</span> : undefined}>
                {t.title}
              </CtxItem>
            );
          })}
          {list.length > 12 && <CtxItem icon={Search} onSelect={() => onMove(subject)}>More…</CtxItem>}
        </CtxSubContent>
      </CtxSub>
    );
  };

  if (node.kind === "session") {
    const row = useInboxStore.getState().sessions[node.session._id];
    const subject: MoveSubject = { kind: "session", id: node.session._id, title: node.session.title || node.session.short_id };
    const meId = useInboxStore.getState().currentUser?._id;
    const foreign = !row || (row as any).user_id !== meId;
    return (
      <>
        {row ? (
          <SessionMenuItems session={row as any} isForeign={foreign} onOpen={() => onOpenSession(node.session._id)} />
        ) : (
          <>
            <CtxHeader title={node.session.title || "Session"} />
            <CtxItem icon={ExternalLink} onSelect={() => onOpenSession(node.session._id)}>Open</CtxItem>
          </>
        )}
        {canMoveSession(node.session) && (
          <>
            <CtxSeparator />
            {moveSub(subject)}
          </>
        )}
      </>
    );
  }
  if (node.kind === "role") {
    const subject: MoveSubject = { kind: "role", id: node.role._id, title: node.role.name };
    const can = canEditRole(node.role._id);
    return (
      <>
        <CtxHeader title={node.role.name} id={`@${node.role.handle}`} />
        <CtxItem icon={Pencil} onSelect={() => onSelect(node.id)}>Edit scope</CtxItem>
        <CtxItem icon={node.collapsed ? ChevronRight : ChevronDown} onSelect={() => onToggleCollapse(node.id)}>{node.collapsed ? "Expand" : "Collapse"}</CtxItem>
        {can && (
          <>
            <CtxSeparator />
            {moveSub(subject)}
            <CtxSeparator />
            <CtxItem icon={Trash2} danger onSelect={() => onSelect(node.id)}>Retire…</CtxItem>
          </>
        )}
      </>
    );
  }
  if (node.kind === "person") {
    return (
      <>
        <CtxHeader title={node.person.name} />
        <CtxItem icon={node.collapsed ? ChevronRight : ChevronDown} onSelect={() => onToggleCollapse(node.id)}>{node.collapsed ? "Expand" : "Collapse"}</CtxItem>
        <CtxItem icon={Users} onSelect={() => onSelect(node.id)}>Show sessions</CtxItem>
      </>
    );
  }
  if (node.kind === "anchor") {
    return (
      <>
        <CtxHeader title={node.anchor.name} />
        {node.anchor.conversation_id && <CtxItem icon={ExternalLink} onSelect={() => onOpenSession(node.anchor.conversation_id!)}>Open its session</CtxItem>}
      </>
    );
  }
  return <CtxHeader title={`+${node.remaining} sessions`} />;
}
