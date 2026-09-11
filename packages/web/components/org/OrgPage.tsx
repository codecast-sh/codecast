"use client";
// /org: the reporting structure of the active workspace as one tree, edited by
// reparenting. Paints from the `orgTree` store singleton (fed here by
// useSyncOrgTree); every edit is a store action that moves the card in the
// same tick and rides dispatch to the orgRoles mutation.
import { useCallback, useMemo, useRef, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { create as mutate } from "mutative";
import { Network, Plus, Map as MapIcon, Users, Briefcase, Search, ArrowRightLeft, ChevronDown, ChevronRight, ExternalLink, Trash2, Pencil } from "lucide-react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { createOrgSlice, orgRoleReparentMakesCycle, type OrgUpdateRoleInput } from "../../store/orgSlice";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useOrgSessionsUnder } from "../../hooks/useOrgSessionsUnder";
import { useOpenLinkedSession } from "../../hooks/useOpenLinkedSession";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import type { PlanItem, ProjectItem } from "../../store/inboxStore";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator, CtxSub, CtxSubTrigger, CtxSubContent } from "../ui/context-menu";
import { SessionMenuItems } from "../menus/ObjectContextMenus";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { SelectBox } from "../ui/select-box";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Avatar } from "../tasks/TaskCommentStream";
import { cn } from "../../lib/utils";
import { OrgGraph, type OrgReparentRequest } from "./OrgGraph";
import { OrgScopePanel, type OrgSessionsSource } from "./OrgScopePanel";
import { StateTally } from "./OrgNodeCards";
import { layoutOrgTree, parentNodeId, parentRefOfNodeId, type OrgLayoutNode, type OrgLayoutView } from "./orgLayout";
import { ORG_FIXTURE, ORG_FIXTURE_ALL_SESSIONS } from "./orgFixture";
import { sortOrgSessions, sameParent, type OrgParentRef, type OrgSession, type OrgTree, EMPTY_COUNTS } from "./orgTypes";

const PAGE = 8;
const MOBILE_MAX_WIDTH = 768;

type MoveSubject = { kind: "session" | "role"; id: string; title: string };

function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.innerWidth < MOBILE_MAX_WIDTH);
  useMountEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_MAX_WIDTH - 1}px)`);
    const on = () => setPhone(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  });
  return phone;
}

// ---------------------------------------------------------------- sessionsUnder pager

/** One mounted loader per requested page; reports rows up once and unmounts. */
function SessionsUnderPager({ parentId, teamId, cursor, onPage, preview }: {
  parentId: string; teamId?: string; cursor?: string; preview: boolean;
  onPage: (parentId: string, rows: OrgSession[], next?: string) => void;
}) {
  const parent = useMemo(() => parentRefOfNodeId(parentId)!, [parentId]);
  const { data } = useOrgSessionsUnder(
    !preview ? { parent, ...(teamId ? { team_id: teamId } : {}), ...(cursor ? { cursor } : {}), limit: PAGE } : "skip",
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
      const start = cursor ? Number(cursor) : PAGE;
      const rows = all.slice(start, start + PAGE);
      setTimeout(() => onPage(parentId, rows, start + PAGE < all.length ? String(start + PAGE) : undefined), 250);
      return;
    }
    if (!data) return;
    done.current = true;
    onPage(parentId, (data.sessions ?? []) as OrgSession[], data.next_cursor ?? undefined);
  }, [data, preview, parentId, cursor, onPage, parent]);
  return null;
}

// ---------------------------------------------------------------- page

export function OrgPageInner() {
  const { tree: storeTree, ready, missing } = useSyncOrgTree();
  const s = useTrackedStore([
    (st) => st.currentUser?._id,
    (st) => st.clientState.ui?.active_team_id,
  ]);
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;
  const activeTeamId = s.clientState.ui?.active_team_id as string | undefined;

  // Until the backend ships org.tree (the query answers "Could not find public
  // function"), the page runs on the fixture and edits apply to a local copy
  // through the SAME slice bodies the store uses.
  const preview = missing && !storeTree;
  const [previewTree, setPreviewTree] = useState<OrgTree>(ORG_FIXTURE);
  const tree: OrgTree | null = preview ? previewTree : storeTree;

  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Record<string, OrgSession[]>>({});
  const [cursors, setCursors] = useState<Record<string, string | null>>({});
  const [requests, setRequests] = useState<Record<string, { cursor?: string }>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(false);
  const [pendingMove, setPendingMove] = useState<OrgReparentRequest | null>(null);
  const [movePicker, setMovePicker] = useState<MoveSubject | null>(null);
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const menu = useContextMenu<OrgLayoutNode>();
  const phone = useIsPhone();
  const openLinked = useOpenLinkedSession();

  const view = useMemo<OrgLayoutView>(() => ({ collapsed, expanded }), [collapsed, expanded]);
  const layout = useMemo(() => (tree ? layoutOrgTree(tree, view) : null), [tree, view]);
  const selectedNode = useMemo(() => layout?.nodes.find((n) => n.id === selectedId) ?? null, [layout, selectedId]);
  if (selectedId && layout && !selectedNode) setSelectedId(null);

  // -------- store actions (or the preview equivalent)
  const slice = useMemo(() => createOrgSlice(), []);
  const run = useCallback(<K extends "reparentOrgSession" | "reparentOrgRole" | "createOrgRole" | "updateOrgRole" | "retireOrgRole">(name: K, ...args: Parameters<ReturnType<typeof createOrgSlice>[K]>) => {
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
    if (cursors[parentId] === null || requests[parentId]) return;
    setRequests((r) => ({ ...r, [parentId]: { cursor: cursors[parentId] ?? undefined } }));
  }, [cursors, requests]);
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
  const openSession = useCallback((conversationId: string) => {
    const row = tree ? [...tree.people, ...tree.roles].flatMap((b) => b.sessions).find((x) => x._id === conversationId) : null;
    if (preview) return;
    openLinked({ _id: conversationId, title: row?.title, short_id: row?.short_id, agent_type: row?.agent_type, updated_at: row?.updated_at ?? Date.now(), is_active: row?.work_state === "working" });
  }, [tree, preview, openLinked]);

  const requestMove = useCallback((req: OrgReparentRequest) => {
    if (!tree) return;
    if (req.subject.kind === "role" && orgRoleReparentMakesCycle(tree, req.subject.id, req.target)) { setResetKey((k) => k + 1); return; }
    if (req.subject.kind === "session") {
      const sess = [...tree.people, ...tree.roles].flatMap((b) => b.sessions).find((x) => x._id === req.subject.id);
      if (!sess || !canMoveSession(sess)) { setResetKey((k) => k + 1); return; }
    } else if (!canEditRole(req.subject.id)) { setResetKey((k) => k + 1); return; }
    setPendingMove(req);
  }, [tree, canMoveSession, canEditRole]);
  const commitMove = useCallback((req: OrgReparentRequest) => {
    if (req.subject.kind === "session") run("reparentOrgSession", req.subject.id, req.target);
    else run("reparentOrgRole", req.subject.id, req.target);
    setPendingMove(null);
    setResetKey((k) => k + 1);
  }, [run]);
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

  const panelOpen = !!selectedNode && selectedNode.kind !== "cluster";

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
          <p className="mt-1.5 text-[12.5px]" style={{ color: "var(--sol-text-muted)" }}>
            Who reports to whom: people, the roles they created, standing anchors, every session. Drag a card to move it.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {stats && (
            <div className="hidden sm:flex items-center gap-2">
              <HeaderStat icon={Users} value={stats.people} label="people" />
              <HeaderStat icon={Briefcase} value={stats.roles} label="roles" tint="var(--sol-violet)" />
              <div className="flex items-center gap-2 h-[34px] px-3 rounded-lg border" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
                <span className="text-[14px] font-semibold tabular-nums">{stats.sessions}</span>
                <span className="text-[11px]" style={{ color: "var(--sol-text-dim)" }}>sessions</span>
                <span className="w-px h-4" style={{ background: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} />
                <StateTally counts={stats.counts} />
              </div>
            </div>
          )}
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
            <button type="button" onClick={() => setAddRoleOpen(true)} className="h-[34px] inline-flex items-center gap-1.5 px-3 rounded-lg text-[12.5px] font-semibold transition-colors hover:brightness-110" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>
              <Plus className="w-3.5 h-3.5" /> Add a role
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div className="shrink-0 px-4 sm:px-6 py-1.5 text-[11.5px] flex items-center gap-2 border-b" style={{ background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)", borderColor: "color-mix(in srgb, var(--sol-yellow) 25%, transparent)", color: "var(--sol-text-muted)" }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--sol-yellow)" }} />
          Preview data: the org backend is not deployed yet. Edits here stay on this page.
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
              onNodeContextMenu={(e, n) => menu.open(e, n, { force: true })}
              onOpenSession={openSession}
              resetKey={resetKey}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center">
              {!ready && !tree ? (
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
          {tree && tree.roles.filter((r) => r.status !== "retired").length === 0 && isAdmin && (
            <button type="button" onClick={() => setAddRoleOpen(true)} className="absolute top-3 left-3 sm:left-4 z-10 inline-flex items-center gap-2 pl-2 pr-3 h-9 rounded-xl border text-left transition-colors hover:bg-sol-bg-highlight/70 backdrop-blur" style={{ background: "color-mix(in srgb, var(--sol-card) 88%, transparent)", borderColor: "color-mix(in srgb, var(--sol-violet) 45%, transparent)" }}>
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-md" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}><Plus className="w-3.5 h-3.5" /></span>
              <span className="text-[12px]"><b className="font-semibold">Add a role</b> <span style={{ color: "var(--sol-text-muted)" }}>— a seat sessions can report to</span></span>
            </button>
          )}
          <div className="pointer-events-none absolute bottom-3 right-3 hidden lg:flex items-center gap-2 text-[10.5px] whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }}>
            <span>drag to move · double click to open</span>
            <span className="inline-flex items-center gap-1"><KeyCap size="xs">esc</KeyCap> clear</span>
          </div>
        </div>

        {/* panel: right on desktop, bottom sheet on phone */}
        {panelOpen && tree && selectedNode && !phone && (
          <aside className="w-[320px] xl:w-[380px] shrink-0 border-l min-h-0" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 25%, transparent)", background: "color-mix(in srgb, var(--sol-bg-alt) 40%, var(--sol-bg))" }}>
            <OrgScopePanel
              tree={tree}
              node={selectedNode}
              sessions={sessionsSource}
              canEdit={selectedNode.kind === "role" ? canEditRole(selectedNode.role._id) : selectedNode.kind === "session" ? canMoveSession(selectedNode.session) : !!isAdmin}
              onClose={() => setSelectedId(null)}
              onOpenSession={openSession}
              onMove={setMovePicker}
              onUpdateRole={updateRole}
              onRetireRole={retireRole}
              onSelectNode={setSelectedId}
            />
          </aside>
        )}
        {panelOpen && tree && selectedNode && phone && (
          <div className="absolute inset-x-0 bottom-0 z-20 h-[62%] rounded-t-2xl border-t shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.45)] org-sheet-in" style={{ background: "var(--sol-bg)", borderColor: "color-mix(in srgb, var(--sol-border) 35%, transparent)" }}>
            <div className="flex justify-center pt-2"><span className="w-10 h-1 rounded-full" style={{ background: "color-mix(in srgb, var(--sol-border) 60%, transparent)" }} /></div>
            <div className="h-[calc(100%-12px)]">
              <OrgScopePanel
                tree={tree}
                node={selectedNode}
                sessions={sessionsSource}
                canEdit={selectedNode.kind === "role" ? canEditRole(selectedNode.role._id) : selectedNode.kind === "session" ? canMoveSession(selectedNode.session) : !!isAdmin}
                onClose={() => setSelectedId(null)}
                onOpenSession={openSession}
                onMove={setMovePicker}
                onUpdateRole={updateRole}
                onRetireRole={retireRole}
                onSelectNode={setSelectedId}
              />
            </div>
          </div>
        )}
      </div>

      {/* pagers */}
      {Object.entries(requests).map(([pid, r]) => (
        parentRefOfNodeId(pid) ? <SessionsUnderPager key={`${pid}:${r.cursor ?? ""}`} parentId={pid} cursor={r.cursor} teamId={activeTeamId} onPage={onPage} preview={preview} /> : null
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
        <AddRoleDialog
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
          <button type="button" data-primary onClick={onConfirm} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-cyan)", color: "var(--sol-bg)" }}>Move</button>
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

// ---------------------------------------------------------------- add role dialog

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
}

function AddRoleDialog({ open, onClose, tree, meId, onCreate }: { open: boolean; onClose: () => void; tree: OrgTree; meId: string; onCreate: (input: Parameters<ReturnType<typeof createOrgSlice>["createOrgRole"]>[0]) => void }) {
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [reportsTo, setReportsTo] = useState<string>(meId ? parentNodeId({ kind: "user", user_id: meId }) : "");
  const [charter, setCharter] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [planIds, setPlanIds] = useState<string[]>([]);
  const projects = useWorkspaceCollection<ProjectItem>("projects");
  const plans = useWorkspaceCollection<PlanItem>("plans");
  const effHandle = handleTouched ? handle : slugify(name);
  const taken = tree.roles.some((r) => r.handle === effHandle && r.status !== "retired");
  const valid = name.trim().length > 0 && /^[a-z0-9-]{2,32}$/.test(effHandle) && !taken && !!reportsTo;
  const submit = () => {
    if (!valid) return;
    const ref = parentRefOfNodeId(reportsTo) ?? { kind: "user" as const, user_id: meId };
    onCreate({
      name: name.trim(),
      handle: effHandle,
      ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}),
      scope: { project_ids: projectIds, plan_ids: planIds },
      reports_to: ref,
      ...(charter.trim() ? { charter: charter.trim() } : {}),
      host_user_id: meId,
      client_id: `orgrolestub-${Math.random().toString(36).slice(2)}`,
    });
  };
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[440px]" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
        <DialogHeader>
          <DialogTitle className="text-[17px]" style={{ fontFamily: "var(--font-serif)" }}>Add a role</DialogTitle>
          <DialogDescription className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>A seat in the reporting structure. Sessions and other roles can report to it; a scope says what it owns.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <Field label="Name">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Head of Growth" className={INPUT} style={INPUT_STYLE} />
          </Field>
          <Field label="Handle" hint={taken ? "already used in this workspace" : "letters, digits and dashes"}>
            <div className="flex items-center gap-1">
              <span className="text-[13px]" style={{ color: "var(--sol-violet)", fontFamily: "var(--font-mono)" }}>@</span>
              <input value={effHandle} onChange={(e) => { setHandleTouched(true); setHandle(slugify(e.target.value)); }} placeholder="growth" className={INPUT} style={{ ...INPUT_STYLE, fontFamily: "var(--font-mono)", ...(taken ? { borderColor: "var(--sol-red)" } : {}) }} />
            </div>
          </Field>
          <Field label="Reports to">
            <SelectBox value={reportsTo} onChange={(e) => setReportsTo(e.target.value)} className="text-[13px]">
              <optgroup label="People">
                {tree.people.map((p) => <option key={p.user_id} value={parentNodeId({ kind: "user", user_id: p.user_id })}>{p.name}{p.is_me ? " (you)" : ""}</option>)}
              </optgroup>
              {tree.roles.filter((r) => r.status !== "retired").length > 0 && (
                <optgroup label="Roles">
                  {tree.roles.filter((r) => r.status !== "retired").map((r) => <option key={r._id} value={parentNodeId({ kind: "role", role_id: r._id })}>@{r.handle} · {r.name}</option>)}
                </optgroup>
              )}
            </SelectBox>
          </Field>
          <Field label="Scope" hint={projectIds.length + planIds.length === 0 ? "nothing picked = the whole workspace" : `${projectIds.length} project${projectIds.length === 1 ? "" : "s"}, ${planIds.length} plan${planIds.length === 1 ? "" : "s"}`}>
            <div className="max-h-[132px] overflow-y-auto rounded-lg border p-1" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
              {projects.length === 0 && plans.length === 0 && <p className="px-2 py-1.5 text-[11.5px]" style={{ color: "var(--sol-text-dim)" }}>No projects or plans in this workspace yet.</p>}
              {projects.map((p) => <ScopeOption key={p._id} checked={projectIds.includes(p._id)} onToggle={() => toggle(projectIds, setProjectIds, p._id)} tone="blue" label={p.title} sub="project" />)}
              {plans.map((p) => <ScopeOption key={p._id} checked={planIds.includes(p._id)} onToggle={() => toggle(planIds, setPlanIds, p._id)} tone="magenta" label={p.title} sub={p.short_id} />)}
            </div>
          </Field>
          <Field label="Charter" hint="optional">
            <textarea value={charter} onChange={(e) => setCharter(e.target.value)} rows={2} placeholder="What this seat owns." className={INPUT} style={INPUT_STYLE} />
          </Field>
          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="h-8 px-3 rounded-lg text-[12.5px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
            <button type="submit" disabled={!valid} className="h-8 px-3.5 rounded-lg text-[12.5px] font-semibold disabled:opacity-50" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>Create role</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const INPUT = "w-full h-9 px-2.5 rounded-lg border outline-none text-[13px] focus:border-sol-cyan";
const INPUT_STYLE: React.CSSProperties = { background: "var(--sol-bg-alt)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", color: "var(--sol-text)" };

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: "var(--sol-text-dim)" }}>{label}</span>
        {hint && <span className="text-[10.5px]" style={{ color: hint.startsWith("already") ? "var(--sol-red)" : "var(--sol-text-dim)" }}>{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function ScopeOption({ checked, onToggle, tone, label, sub }: { checked: boolean; onToggle: () => void; tone: "blue" | "magenta"; label: string; sub: string }) {
  const color = tone === "blue" ? "var(--sol-blue)" : "var(--sol-magenta)";
  return (
    <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-sol-bg-highlight/70">
      <span className="w-3.5 h-3.5 rounded-[4px] border inline-flex items-center justify-center shrink-0" style={{ borderColor: checked ? color : "color-mix(in srgb, var(--sol-border) 60%, transparent)", background: checked ? color : "transparent" }}>
        {checked && <span className="w-1.5 h-1.5 rounded-[1px]" style={{ background: "var(--sol-bg)" }} />}
      </span>
      <span className="flex-1 min-w-0 truncate text-[12.5px]" style={{ color: "var(--sol-text)" }}>{label}</span>
      <span className="text-[10.5px] shrink-0" style={{ color, fontFamily: tone === "magenta" ? "var(--font-mono)" : undefined }}>{sub}</span>
    </button>
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
