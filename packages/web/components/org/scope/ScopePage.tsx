"use client";
// The scope page (docs/architecture/scopes-and-feed.md F4; org-roles-standing.md
// T6): one role, or the workspace root, as a conversation with the agent that
// owns the area, and the board (F3's tabs) as one panel beside it. The
// composer is Talk, and sending a line is the Wake: a line into the standing
// conversation is the same pending message `orgRoles.wake` enqueues. Paints
// from the orgTree store singleton (the same feeder the org page mounts) plus
// two per view queries: the board counts and the brief. Every edit is a store
// action that moves the page in the same tick and rides dispatch to orgRoles.*.
import { useCallback, useMemo, useRef, useState } from "react";
import { useTourAutoStart } from "../../../tours/useTourAutoStart";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArrowLeft, MoreHorizontal, Network, PanelRightClose, PanelRightOpen, Pause, Pin, PinOff, Play } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { useInboxStore, useTrackedStore, type PlanItem, type ProjectItem } from "../../../store/inboxStore";
import { useSyncOrgTree } from "../../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../../hooks/useSyncProjects";
import { useSyncTasks } from "../../../hooks/useSyncTasks";
import { useSyncPlans } from "../../../hooks/useSyncPlans";
import { useSyncDocs } from "../../../hooks/useSyncDocs";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useRoleBrief, useScopeSummary, type ScopeRef } from "../../../hooks/useScopeQueries";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { cn } from "../../../lib/utils";
import { Avatar } from "../../tasks/TaskCommentStream";
import { ShortcutTooltip } from "../../KeyboardShortcutsHelp";
import { canEditRole, queryProblem, roleStanding, scopeQueryRef, scopeSeatOf, stateLineBesideName } from "../../../lib/scopePage";
import { AnchorOnboarding } from "../../anchor/AnchorConversation";
import { InboxConversation, type SeatSession } from "../../../app/inbox/QueuePageClient";
import { useSeat } from "./useSeat";
import { SeatLead } from "./SeatLead";
import { RoleOffer } from "./RoleOffer";
import { useDiffViewerStore } from "../../../store/diffViewerStore";
import { RoleFace } from "../RoleFace";
import { RolePausedNote } from "../RolePausedNote";
import { parentName } from "../orgMeta";
import type { OrgParentRef, OrgRole, OrgTree } from "../orgTypes";
import { useScopeIds } from "../../../hooks/useScopeIds";
import { ScopePanel } from "./ScopePanel";
import { ScopeGlance } from "./ScopeGlance";
import { scopeDefaultTab, scopeTabFromParam, scopeWorkViewFromParam, type ScopeTabKey } from "../../../lib/scopeTabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { RetireRoleConfirm } from "../RetireRoleConfirm";
import { isHeadOfPeopleRole, roleWords } from "../orgStaffingTypes";
import { isHeaderPinned, toggleHeaderPin } from "../../../lib/headerPins";
import { ConversationWithPanel } from "./ConversationWithPanel";
import { usePanelLayout } from "../../../hooks/usePanelLayout";
import { briefFirstLine } from "./scopeTypes";
import { retireToastText } from "../../../lib/retireRole";


const todayUtc = () => new Date().toISOString().slice(0, 10);

/** `session` is set when the inbox pane renders this page in place of a
 *  standing session (initiatives-projects-role-page.md I3): the pane's own
 *  props ride through to the conversation, the address stays the session's,
 *  and the board's tab is this visit's state rather than the URL's. */
export function ScopePageInner({ id, session, href }: { id: string; session?: SeatSession; /** The page's own address when it is not /org/<id>: /anchor renders the root role here (S22), and its tab must not move the person off it. */ href?: string }) {
  const base = href ?? `/org/${id}`;
  const { tree, ready } = useSyncOrgTree();
  // The panel's tabs paint from the store: keep the workspace's collections
  // fed here the way the project page does.
  useSyncProjects(); useSyncTasks(); useSyncPlans(); useSyncDocs();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { layout: panelLayout, phone, measureRef } = usePanelLayout();
  const now = useCoarseNow(30_000);
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;

  const isRoot = id === "workspace";
  const { role, anchor } = useMemo(() => scopeSeatOf(tree, id), [tree, id]);
  // A role's page introduces itself the first time one is opened (tours/).
  useTourAutoStart("org-role", !!role && !!tree && !phone);

  const projects = useWorkspaceCollection<ProjectItem>("projects");
  const plans = useWorkspaceCollection<PlanItem>("plans");
  const scopeIds = useScopeIds(role ? role.scope : null, plans);
  // An empty scope is the whole workspace (F1), for the root and for a role
  // alike: the server resolves a role's empty scope to nothing, so the page
  // names every project for it.
  const scopeRef: ScopeRef | null = useMemo(() => {
    if (!tree) return null;
    return scopeQueryRef(role, projects.map((p) => p._id), tree.workspace.kind === "team" ? tree.workspace.id : undefined);
  }, [role, tree, projects]);
  const { data: summary, error: summaryError, missing: summaryMissing } = useScopeSummary(scopeRef ?? "skip");
  const { data: brief, error: briefError, missing: briefMissing } = useRoleBrief(role?._id ?? null);
  // A read this server does not answer yet is nothing a person can act on: it shows as empty.
  const summaryProblem = summaryMissing ? null : queryProblem(summaryError, false, "The counts");
  const briefProblem = briefMissing ? null : queryProblem(briefError, false, "The role's notes");

  // -------- the panel's tab in the URL, like the project page
  const [paneTab, setPaneTab] = useState<ScopeTabKey | null>(null);
  const inPane = !!session;
  const tabParam = inPane ? paneTab : searchParams.get("tab");
  const tab: ScopeTabKey = scopeTabFromParam(tabParam, !!role);
  const setTab = useCallback((next: ScopeTabKey) => {
    if (inPane) { setPaneTab(next === scopeDefaultTab(!!role) ? null : next); return; }
    const params = new URLSearchParams(searchParams.toString());
    // The tab a scope opens on is its bare URL: a role's Overview, the root's activity.
    if (next === scopeDefaultTab(!!role)) params.delete("tab"); else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `${base}?${qs}` : base);
  }, [searchParams, router, base, role, inPane]);
  // The panel: the page opens on the conversation, with the panel collapsed to
  // its glance under the header; it opens beside the conversation, over it on a
  // narrow page, or as a sheet on the phone. A link straight to a tab opens the
  // panel on it, whatever the width.
  const [panelOpen, setPanelOpen] = useState<boolean>(() => !!tabParam);
  const openPanelOn = useCallback((next: ScopeTabKey) => { setTab(next); setPanelOpen(true); }, [setTab]);
  useWatchEffect(() => { if (tabParam) setPanelOpen(true); }, [tabParam]);
  // A page too narrow for the panel's column (a split pane) opens on the
  // conversation; the board would otherwise cover it as an overlay.
  useWatchEffect(() => { if (panelLayout === "overlay" && !tabParam) setPanelOpen(false); }, [panelLayout]);

  // -------- permissions: admins and the host reshape; the parent also edits the brief
  const me = tree?.people.find((p) => p.is_me) ?? (meId ? tree?.people.find((p) => p.user_id === meId) : undefined);
  const canEdit = canEditRole(tree, role, meId);
  const isParent = !!role && role.reports_to.kind === "user" && role.reports_to.user_id === (me?.user_id ?? meId);
  const canEditBrief = canEdit || isParent;

  // -------- actions
  const store = useInboxStore.getState;
  const update = useCallback((fields: Parameters<ReturnType<typeof store>["updateOrgRole"]>[1], opts?: { leave_sessions?: boolean }) => { if (role) store().updateOrgRole(role._id, fields, opts); }, [role, store]);
  const reparent = useCallback((target: OrgParentRef) => { if (role) store().reparentOrgRole(role._id, target); }, [role, store]);
  // Pause and retire live in the header's menu and nowhere else; retire asks
  // first, in one dialog.
  const [retireOpen, setRetireOpen] = useState(false);
  // S16: the Head of People's confirm says what becomes of its standing agent; keeping
  // it restores its old title, so the person is never left without the
  // assistant they had.
  const retire = useCallback((standingSession?: "keep" | "retire") => {
    if (!role) return;
    store().retireOrgRole(role._id, standingSession);
    toast.success(retireToastText(role.name, standingSession));
    router.push("/org");
  }, [role, store, router]);
  // A seat never provisioned: the one gesture is to bring its agent online.
  // The tree re-syncs with the standing session when the server is done.
  const provisionRole = useInboxStore((s) => s.provisionOrgRole);
  const [provisioning, setProvisioning] = useState(false);
  const provision = useCallback(async () => {
    if (!role) return;
    setProvisioning(true);
    try {
      await provisionRole(role._id);
      toast.success(`${role.name} is starting`);
    } catch (e: any) {
      toast.error(e?.message?.replace(/^\[Request ID: [^\]]+\] Server Error\s*/i, "").split("\n")[0] ?? "Could not start the role");
      setProvisioning(false);
    }
  }, [role, provisionRole]);

  // -------- the standing agent
  // The pointer is on the role (org.tree stamps `standing` from the
  // conversation carrying standing_role_id); the anchors row stands in for a
  // tree that predates it, and is the root's only source.
  // In the pane the session on screen is the one the person opened.
  const standingId = session?.sessionId ?? (role ? (role.standing?.conversation_id ?? anchor?.conversation_id) : anchor?.conversation_id);
  const standingState = role ? (role.standing?.state ?? anchor?.state) : anchor?.state;

  // -------- header facts
  // The standing session heartbeats about once a second; subscribe to the two
  // fields the header branches on, never the row, so a heartbeat cannot
  // re-render the page. updated_at is read raw: the "active N ago" clock is
  // coarse (useCoarseNow) and a 30s stale read changes nothing it shows.
  const st = useTrackedStore([
    (x) => (standingId ? (x.sessions[standingId] as any)?.model : undefined),
    (x) => (standingId ? (x.sessions[standingId] as any)?.thread_state : undefined),
    // What the session pane's banners read; the inbox hands them in itself.
    (x) => (standingId && !inPane ? (x.sessions[standingId] as any)?.is_idle : undefined),
    (x) => (standingId && !inPane ? (x.sessions[standingId] as any)?.session_error : undefined),
    (x) => (standingId && !inPane ? (x.sessions[standingId] as any)?.last_user_message : undefined),
  ]);
  const standing = standingId ? st.sessions[standingId] : undefined;
  const model = (standing as any)?.model ?? null;
  const hostName = role ? tree?.people.find((p) => p.user_id === role.host_user_id)?.name ?? "the host" : tree?.workspace.name ?? "";
  const stateMeta = roleStanding(standingState);
  const counters = role?.counters && role.counters.day === todayUtc() ? role.counters : null;
  const boardLine = briefFirstLine(brief?.narrative);
  const standingStateLine = (standing as any)?.thread_state ? String((standing as any).thread_state).split("\n")[0] : null;
  // The tree's own pinned line stands in when the store has no row for the
  // seat yet (the same line the org card paints).
  const treeStateLine = (role ? role.standing?.state_line : anchor?.state_line)?.trim() || null;
  // The seat's own pinned line first (it is what the org card paints and
  // moves with the session), then the brief's first line, which a seat that
  // never wrote a brief still carries from the provisioning template.
  const stripeLine = standingStateLine || treeStateLine || boardLine;
  const headLine = stripeLine ? stateLineBesideName(stripeLine, role?.name ?? "") : null;
  // The first thing on the page is the agent saying what this area is and
  // what it is watching, from the rows themselves; the seat's provisioning
  // prompt and its working turns fold away under it. What the role needs from
  // the person is in its own thread: its pinned state and its decide cards.
  const lead = useMemo(() => (
    tree && (role || anchor)
      ? <ScopeLead role={role} />
      : null
  ), [tree, role, anchor]);

  // -------- the conversation is the session page (I3)
  // The same pane the inbox mounts, so its banners, share control, context
  // panels and header actions are here by construction. The right side holds
  // one thing: the diff stays hidden while the board is open, and opening the
  // diff from the header closes the board.
  const diffOpen = useDiffViewerStore((x) => x.diffPanelOpen);
  const diffWasOpen = useRef(diffOpen);
  useWatchEffect(() => {
    if (diffOpen && !diffWasOpen.current) setPanelOpen(false);
    diffWasOpen.current = diffOpen;
  }, [diffOpen]);
  const { onSessionView, ...paneProps } = session ?? ({} as Partial<SeatSession>);
  const speaker = role ? role.name : anchor?.name ?? "the workspace agent";
  // The composer is Talk (F4.1): the host, the person the role reports to
  // and an admin send; anyone else reads and asks to send.
  // What the seat offers next sits above its composer; only the Head of
  // People's thread has one (RoleOffer renders nothing anywhere else).
  const offer = useMemo(() => (standingId ? <RoleOffer conversationId={standingId} /> : null), [standingId]);
  const seat = useSeat({ conversationId: standingId, speaker, ask: role && isHeadOfPeopleRole(role) ? "about the org, a role or a goal" : undefined, lead, offer, canTalk: canEditBrief, hideDiff: panelOpen, onSessionView });
  const pinned = useInboxStore((st) => role ? isHeaderPinned(st, "role", role._id) : false);

  // -------- not found / loading
  if (!tree) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: "var(--sol-bg)", color: "var(--sol-text-dim)" }}>
        <div className="text-[12.5px]">{ready ? "This workspace has no org yet." : "Loading the org…"}</div>
      </div>
    );
  }
  if (!isRoot && !role) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: "var(--sol-bg)" }}>
        <Network className="w-8 h-8" style={{ color: "var(--sol-text-dim)" }} />
        <p className="text-[14px]" style={{ color: "var(--sol-text)" }}>That role is not in this workspace.</p>
        <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>It may be retired, or belong to another team. Switch the workspace or go back to the org.</p>
        <Link href="/org" className="mt-1 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}><ArrowLeft className="w-3.5 h-3.5" /> Org</Link>
      </div>
    );
  }

  const words = role ? roleWords(role, tree.workspace.kind === "team" ? tree.workspace.name : null) : null;
  const name = words ? words.name : anchor?.name || tree.workspace.name || "Workspace";
  const handle = role ? role.handle : "workspace";
  const paused = role?.status === "paused";
  const noStanding = !standingId;
  const backHref = `${base}?tab=${tab}`;
  const panelNode = (
    <ScopePanel
      tree={tree}
      role={role}
      tab={tab}
      onTab={setTab}
      initialWorkView={scopeWorkViewFromParam(tabParam)}
      onClose={() => setPanelOpen(false)}
      layout={panelLayout}
      scopeRef={scopeRef}
      scopeIds={scopeIds}
      summary={summary}
      summaryProblem={summaryProblem}
      brief={brief}
      briefProblem={briefProblem}
      canEdit={canEdit}
      canEditBrief={canEditBrief}
      hostName={hostName}
      model={model}
      standingId={standingId ?? null}
      counters={counters}
      now={now}
      backHref={backHref}
      onUpdate={update}
      onReparent={reparent}
    />
  );

  return (
    <div ref={measureRef} className="h-full flex flex-col overflow-hidden" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-scope-page={id} data-scope-layout={panelLayout} data-scope-panel-open={panelOpen ? "1" : "0"}>
      <style>{`
        @keyframes scope-rise { from { opacity: 0; transform: translateY(6px); } }
        .scope-feed-row { animation: scope-rise .28s cubic-bezier(.2,.7,.2,1) backwards; }
        @media (prefers-reduced-motion: reduce) { .scope-feed-row, .org-panel-in, .org-sheet-in { animation: none; } }
      `}</style>

      {/* state stripe: the standing session's work state, as a hairline the whole width */}
      <div className="shrink-0 h-[3px] w-full" style={{ background: stateMeta ? `linear-gradient(90deg, ${stateMeta.color}, color-mix(in srgb, ${stateMeta.color} 30%, transparent) 70%, transparent)` : "color-mix(in srgb, var(--sol-violet) 55%, transparent)" }} aria-hidden />

      {/* header: one row. The face, the name, its state line, who it reports
          to; the rare controls (pause, retire) sit behind the menu, and the
          board is an icon. The composer below is Talk. */}
      <header data-scope-head className={cn("scope-head-cq shrink-0 border-b", phone ? "px-2.5 py-1.5" : "px-4 py-2")} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)", background: stateMeta ? `linear-gradient(180deg, color-mix(in srgb, ${stateMeta.color} 5%, var(--sol-bg)) 0%, var(--sol-bg) 100%)` : undefined }}>
        <div className="flex items-center gap-2 min-w-0">
          {session?.onBack ? (
            <button type="button" onClick={session.onBack} className={HEAD_ICON} style={{ color: "var(--sol-text-muted)" }} aria-label="Back to the inbox" data-scope-back="inbox">
              <ArrowLeft className="w-4 h-4" />
            </button>
          ) : (
            <Link href="/org" className={HEAD_ICON} style={{ color: "var(--sol-text-muted)" }} aria-label="Back to the org" data-scope-back="org">
              <ArrowLeft className="w-4 h-4" />
            </Link>
          )}
          {/* The role's face (S13); the root workspace has none. */}
          {role && <RoleFace role={role} size={phone ? 24 : 28} className="shrink-0" />}
          <h1 className={cn("shrink-0 max-w-[40%] font-semibold tracking-tight leading-none truncate", phone ? "text-[15px]" : "text-[17px]")} style={{ fontFamily: "var(--font-serif)" }} title={`@${handle}`}>{name}</h1>
          {words && <span className="shrink-0 whitespace-nowrap text-[11.5px]" style={{ color: "var(--sol-text-dim)" }} data-scope-title>{words.subtitle}</span>}
          {!role && <span className="shrink-0 inline-flex items-center gap-1 text-[11px]" style={{ color: "var(--sol-text-dim)" }}><Network className="w-3 h-3" /> whole workspace</span>}
          {stateMeta?.label && (
            <span className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 h-[18px] px-1.5 rounded-md text-[10.5px] font-medium border" style={{ borderColor: `color-mix(in srgb, ${stateMeta.color} 45%, transparent)`, color: stateMeta.color }} data-scope-state={stateMeta.label}>
              <span className={cn("w-[6px] h-[6px] rounded-full", stateMeta.pulse && "animate-pulse")} style={{ background: stateMeta.color }} />
              {stateMeta.label}
            </span>
          )}
          {paused && <span className="shrink-0 whitespace-nowrap text-[10px] px-1.5 h-[18px] inline-flex items-center rounded-md" style={{ background: "color-mix(in srgb, var(--sol-yellow) 14%, transparent)", color: "var(--sol-yellow)" }}>paused</span>}
          {/* The state line: the role's pinned line, else the first line of its notes. */}
          {headLine ? (
            <p className={cn("min-w-0 flex-1 truncate", phone ? "text-[12px]" : "text-[12.5px]")} style={{ color: "var(--sol-text-muted)" }} title={stripeLine ?? undefined} data-scope-stripe>{headLine}</p>
          ) : (
            <p className={cn("min-w-0 flex-1 truncate italic", phone ? "text-[12px]" : "text-[12.5px]")} style={{ color: "var(--sol-text-dim)" }} data-scope-stripe>{role ? (noStanding ? "Not started yet." : "") : "Everything in the workspace."}</p>
          )}
          {role && !phone && (
            <ShortcutTooltip label={`Reports to ${parentName(tree, role.reports_to)}`} side="bottom">
              <span className="scope-head-wide shrink-0 inline-flex items-center gap-1 text-[11.5px] whitespace-nowrap" style={{ color: "var(--sol-text-dim)" }} data-scope-reports-to>
                <span aria-hidden>↑</span>
                {role.reports_to.kind === "role"
                  ? <Link href={`/org/${tree.roles.find((r) => r._id === (role.reports_to as any).role_id)?.short_id ?? ""}`} className="hover:underline" style={{ color: "var(--sol-text-muted)" }}>{parentName(tree, role.reports_to)}</Link>
                  : <Link href="/org" className="hover:underline inline-flex items-center gap-1" style={{ color: "var(--sol-text-muted)" }}><Avatar name={parentName(tree, role.reports_to)} image={tree.people.find((p) => p.user_id === (role.reports_to as any).user_id)?.image} size="sm" />{parentName(tree, role.reports_to)}</Link>}
              </span>
            </ShortcutTooltip>
          )}
          {role && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className={HEAD_ICON} style={{ color: "var(--sol-text-muted)" }} aria-label="Role actions: pin to header, pause or retire" data-scope-actions>
                  <MoreHorizontal className="w-4 h-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                <DropdownMenuItem onSelect={() => toggleHeaderPin("role", role._id)} data-scope-action="pin">
                  {pinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                  <span>{pinned ? "Unpin from header" : "Pin to header"}</span>
                </DropdownMenuItem>
                {canEdit && (<>
                <DropdownMenuItem onSelect={() => update({ status: paused ? "active" : "paused" })} data-scope-action="pause">
                  {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
                  <span>{paused ? "Resume role" : "Pause role"}</span>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setRetireOpen(true)} style={{ color: "var(--sol-red)" }} data-scope-action="retire">
                  <Archive className="w-3.5 h-3.5" />
                  <span>Retire role…</span>
                </DropdownMenuItem>
                </>)}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <PanelToggle open={panelOpen} root={!role} onClick={() => setPanelOpen((v) => !v)} />
        </div>
      </header>

      {role && !panelOpen && <ScopeGlance role={role} summary={summary} onOpen={openPanelOn} />}

      {role && (
        <Dialog open={retireOpen} onOpenChange={setRetireOpen}>
          <DialogContent className="max-w-[440px] grid-cols-1" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-red) 35%, transparent)" }} data-retire-dialog>
            <DialogHeader>
              <DialogTitle className="text-[17px]" style={{ fontFamily: "var(--font-serif)" }}>Retire {role.name}?</DialogTitle>
              <DialogDescription className="text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
                {retireSentence(role, parentName(tree, role.reports_to))}
              </DialogDescription>
            </DialogHeader>
            <RetireRoleConfirm role={role} onRetire={(choice) => { setRetireOpen(false); retire(choice); }} onCancel={() => setRetireOpen(false)} />
          </DialogContent>
        </Dialog>
      )}

      {/* body: the conversation, the panel beside it */}
      <ConversationWithPanel open={panelOpen} layout={panelLayout} panel={panelNode} conversation={
        <div className="flex-1 min-w-0 min-h-0 flex flex-col" data-scope-conversation={standingId ?? "none"}>
          {paused && role && <RolePausedNote name={role.name} className={cn("mx-3 mt-2")} onResume={canEdit ? () => update({ status: "active" }) : undefined} />}
          {standingId ? (
            <div className="flex-1 min-h-0">
              <InboxConversation
                isIdle={!!(standing as any)?.is_idle}
                sessionError={(standing as any)?.session_error}
                lastUserMessage={(standing as any)?.last_user_message}
                {...paneProps}
                sessionId={standingId}
                seat={seat}
                autoFocusInput={!phone}
              />
            </div>
          ) : role ? (
            <ScopeUnseated role={role} tree={tree} canEdit={canEdit} hostName={hostName} busy={provisioning} onProvision={provision} onOpenBoard={() => setPanelOpen(true)} />
          ) : (
            <AnchorOnboarding compact />
          )}
        </div>
      } />
    </div>
  );
}

/** What a role looks after, in words (org-staffing.md S26): its projects and
 *  plans; the whole workspace for the Head of People while it names none; and
 *  for any other role with none, no area of its own. */
function areaOf(role: OrgRole | null): { names: string[]; whole: boolean } {
  const names = role ? [...role.scope_names.projects.map((p) => p.title), ...role.scope_names.plans.map((p) => p.title)] : [];
  return { names, whole: names.length === 0 && (!role || isHeadOfPeopleRole(role)) };
}

/** What retiring does, said once, where the person confirms it. */
function retireSentence(role: OrgRole, parent: string): string {
  const sessions = role.total === 0 ? "" : `Its ${role.total === 1 ? "session goes" : `${role.total} sessions go`} to the role that covers ${role.total === 1 ? "its" : "their"} area, or back to ${role.total === 1 ? "its owner" : "their owners"}. `;
  return `${sessions}Roles under it report to ${parent}. Its triggers are cancelled and its thread is kept.`;
}

/** The role's opening line (F4.1): what it looks after, said from the rows,
 *  not from the transcript. The header already names the role, its state and
 *  who it reports to. */
export function ScopeLead({ role }: { role: OrgRole | null }) {
  const { names, whole } = areaOf(role);
  if (role && isHeadOfPeopleRole(role)) {
    return <SeatLead data-scope-lead>I keep the org true to how the work runs: who owns what, who reports to whom, and the goals it all serves. Ask me about the structure, a role or a goal.</SeatLead>;
  }
  return (
    <SeatLead data-scope-lead>
      {names.length > 0 ? `I look after ${names.join(", ")}.` : whole ? "I look after the whole workspace." : "I have no area of my own: I run my check and answer what I am asked."} Ask me for anything here: I answer, or start a session for the work and tell you which.
    </SeatLead>
  );
}

/** The header's control for the panel beside the conversation (F4.1). */
function PanelToggle({ open, root, onClick }: { open: boolean; root: boolean; onClick: () => void }) {
  const Icon = open ? PanelRightClose : PanelRightOpen;
  const tip = open ? "Close the panel" : root ? "Open the panel: activity, work, sessions, decisions" : "Open the panel: overview, work, sessions, decisions, triggers, settings";
  return (
    <ShortcutTooltip label={tip} side="bottom">
      <button
        type="button"
        onClick={onClick}
        className={cn(HEAD_ICON, open && "bg-sol-bg-highlight/60")}
        style={{ color: open ? "var(--sol-text)" : "var(--sol-text-muted)" }}
        aria-pressed={open}
        aria-label={tip}
        data-scope-panel-toggle={open ? "open" : "closed"}
      >
        <Icon className="w-4 h-4" />
      </button>
    </ShortcutTooltip>
  );
}

const HEAD_ICON = "shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors hover:bg-sol-bg-highlight/70";

/** A role that has not started yet (F4.1): say what it looks after, and
 *  offer the one gesture that makes sense. An empty composer would go nowhere. */
function ScopeUnseated({ role, tree, canEdit, hostName, busy, onProvision, onOpenBoard }: { role: OrgRole; tree: OrgTree; canEdit: boolean; hostName: string; busy: boolean; onProvision: () => void; onOpenBoard: () => void }) {
  const { names: owns, whole } = areaOf(role);
  const charter = (role.charter ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  const retired = role.status === "retired";
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center px-6" data-scope-unseated={role.short_id}>
      <div className="max-w-md w-full text-center">
        <RoleFace role={role} size={56} className="mx-auto mb-4" />
        <h2 className="text-[17px] font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)" }}>{retired ? `${role.name} is retired` : `${role.name} has not started yet`}</h2>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
          {charter ? charter : owns.length > 0 ? `This role looks after ${owns.join(", ")}.` : whole ? "This role looks after the whole workspace." : "This role has no area of its own: it runs its check and answers what it is asked."}
          {charter && owns.length > 0 && <> It looks after {owns.join(", ")}.</>}
          {" "}It reports to <span style={{ color: "var(--sol-text)" }}>{parentName(tree, role.reports_to)}</span>.
        </p>
        {retired ? (
          <p className="mt-3 text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>Its work is still in the panel beside this page.</p>
        ) : canEdit ? (
          <>
            <p className="mt-3 text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>Start it and this page becomes a conversation with it: ask for something here and it answers or starts a session for the work.</p>
            <button type="button" onClick={onProvision} disabled={busy} className="mt-4 h-9 px-4 rounded-lg text-[13px] font-semibold disabled:opacity-60 hover:brightness-110 transition-colors" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }} data-scope-provision>
              {busy ? "Starting…" : `Start ${role.name}`}
            </button>
          </>
        ) : (
          <p className="mt-3 text-[12.5px]" style={{ color: "var(--sol-text-dim)" }} data-scope-ask-host>Ask {hostName} to start it; until then its work is in the panel beside this page.</p>
        )}
        <button type="button" onClick={onOpenBoard} className="mt-3 text-[12px] underline-offset-2 hover:underline" style={{ color: "var(--sol-violet)" }}>Open the panel</button>
      </div>
    </div>
  );
}
