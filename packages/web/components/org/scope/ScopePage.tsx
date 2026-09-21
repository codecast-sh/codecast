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
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Archive, ArrowLeft, Network, PanelRightClose, PanelRightOpen, Pause, Play } from "lucide-react";
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
import { canEditRole, handsWaiting, queryProblem, roleStanding, scopeQueryRef, scopeSeatOf } from "../../../lib/scopePage";
import { AnchorOnboarding } from "../../anchor/AnchorConversation";
import { InboxConversation, type SeatSession } from "../../../app/inbox/QueuePageClient";
import { useSeat } from "./useSeat";
import { useDiffViewerStore } from "../../../store/diffViewerStore";
import { RoleFace } from "../RoleFace";
import { RolePausedNote } from "../RolePausedNote";
import { parentName } from "../orgMeta";
import type { OrgParentRef, OrgRole, OrgTree } from "../orgTypes";
import type { WorkState } from "@codecast/shared/contracts";
import { useScopeIds } from "../../../hooks/useScopeIds";
import { ScopePanel } from "./ScopePanel";
import { scopeDefaultTab, scopeTabFromParam, type ScopeTabKey } from "../../../lib/scopeTabs";
import { ConversationWithPanel } from "./ConversationWithPanel";
import { usePanelLayout } from "../../../hooks/usePanelLayout";
import { briefFirstLine } from "./scopeTypes";
import { retireToastText } from "../../../lib/retireRole";

const api = _api as any;

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
  const { layout: panelLayout, phone } = usePanelLayout();
  const now = useCoarseNow(30_000);
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;

  const isRoot = id === "workspace";
  const { role, anchor } = useMemo(() => scopeSeatOf(tree, id), [tree, id]);

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
  const summaryProblem = queryProblem(summaryError, summaryMissing, "The board counts");
  const briefProblem = queryProblem(briefError, briefMissing, "The brief");

  // -------- the panel's tab in the URL, like the project page
  const [paneTab, setPaneTab] = useState<ScopeTabKey | null>(null);
  const inPane = !!session;
  const tabParam = inPane ? paneTab : searchParams.get("tab");
  const tab: ScopeTabKey = scopeTabFromParam(tabParam, !!role);
  const setTab = useCallback((next: ScopeTabKey) => {
    if (inPane) { setPaneTab(next === scopeDefaultTab(!!role) ? null : next); return; }
    const params = new URLSearchParams(searchParams.toString());
    // The tab a scope opens on is its bare URL: a role's Scope, the root's feed.
    if (next === scopeDefaultTab(!!role)) params.delete("tab"); else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `${base}?${qs}` : base);
  }, [searchParams, router, base, role, inPane]);
  // The panel: open by default beside the conversation; on the phone the
  // conversation leads and the panel is a sheet one tap away. A link straight
  // to a tab opens the panel on it, whatever the width.
  const [panelOpen, setPanelOpen] = useState<boolean>(() => !phone || !!tabParam);
  useWatchEffect(() => { if (tabParam) setPanelOpen(true); }, [tabParam]);
  const openTab = useCallback((next: ScopeTabKey) => { setTab(next); setPanelOpen(true); }, [setTab]);

  // -------- permissions: admins and the host reshape; the parent also edits the brief
  const me = tree?.people.find((p) => p.is_me) ?? (meId ? tree?.people.find((p) => p.user_id === meId) : undefined);
  const canEdit = canEditRole(tree, role, meId);
  const isParent = !!role && role.reports_to.kind === "user" && role.reports_to.user_id === (me?.user_id ?? meId);
  const canEditBrief = canEdit || isParent;

  // -------- actions
  const store = useInboxStore.getState;
  const update = useCallback((fields: Parameters<ReturnType<typeof store>["updateOrgRole"]>[1], opts?: { leave_sessions?: boolean }) => { if (role) store().updateOrgRole(role._id, fields, opts); }, [role, store]);
  const reparent = useCallback((target: OrgParentRef) => { if (role) store().reparentOrgRole(role._id, target); }, [role, store]);
  // The header's Retire lands on Settings with the confirmation already open.
  const [retireArmed, setRetireArmed] = useState(false);
  useWatchEffect(() => { if (tab !== "settings") setRetireArmed(false); }, [tab]);
  // S16: the chief's confirm says what becomes of its standing agent; keeping
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
  const provisionMutation = useMutation(api.orgRoles.provision);
  const [provisioning, setProvisioning] = useState(false);
  const provision = useCallback(async () => {
    if (!role) return;
    setProvisioning(true);
    try {
      await provisionMutation({ role_id: role._id });
      toast.success(`@${role.handle} is coming online`);
    } catch (e: any) {
      toast.error(e?.message?.replace(/^\[Request ID: [^\]]+\] Server Error\s*/i, "").split("\n")[0] ?? "Could not bring the role online");
      setProvisioning(false);
    }
  }, [role, provisionMutation]);

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
  const waiting = handsWaiting(role, tree, summary);
  // The first thing on the page is the agent saying what this area is, what it
  // is watching and what waits on the person, from the rows themselves; the
  // seat's provisioning prompt and its working turns fold away under it.
  const lead = useMemo(() => (
    tree && (role || anchor)
      ? <ScopeLead role={role} anchorName={anchor?.name ?? null} tree={tree} waiting={waiting} standingState={standingState} />
      : null
  ), [tree, role, anchor?.name, waiting, standingState]);

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
  const seat = useSeat({ conversationId: standingId, speaker, lead, canTalk: canEditBrief, hideDiff: panelOpen, onSessionView });

  // -------- not found / loading
  if (!tree) {
    return (
      <div className="h-full flex items-center justify-center" style={{ background: "var(--sol-bg)", color: "var(--sol-text-dim)" }}>
        <div className="text-[12.5px]">{ready ? "No org tree for this workspace." : "Loading the org…"}</div>
      </div>
    );
  }
  if (!isRoot && !role) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: "var(--sol-bg)" }}>
        <Network className="w-8 h-8" style={{ color: "var(--sol-text-dim)" }} />
        <p className="text-[14px]" style={{ color: "var(--sol-text)" }}>No role <span style={{ fontFamily: "var(--font-mono)" }}>{id}</span> in this workspace.</p>
        <p className="text-[12px]" style={{ color: "var(--sol-text-muted)" }}>It may be retired, or belong to another team. Switch the workspace or go back to the org.</p>
        <Link href="/org" className="mt-1 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12.5px] font-medium" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}><ArrowLeft className="w-3.5 h-3.5" /> Org</Link>
      </div>
    );
  }

  const name = role ? role.name : anchor?.name || tree.workspace.name || "Workspace";
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
      onClose={() => setPanelOpen(false)}
      layout={panelLayout}
      waiting={waiting}
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
      armRetire={retireArmed}
      now={now}
      wakeHighlight={searchParams.get("wake")}
      backHref={backHref}
      onUpdate={update}
      onReparent={reparent}
      onRetire={retire}
    />
  );

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-scope-page={id} data-scope-layout={panelLayout} data-scope-panel-open={panelOpen ? "1" : "0"}>
      <style>{`
        @keyframes scope-rise { from { opacity: 0; transform: translateY(6px); } }
        .scope-feed-row { animation: scope-rise .28s cubic-bezier(.2,.7,.2,1) backwards; }
        @media (prefers-reduced-motion: reduce) { .scope-feed-row, .org-panel-in, .org-sheet-in { animation: none; } }
      `}</style>

      {/* state stripe: the standing session's work state, as a hairline the whole width */}
      <div className="shrink-0 h-[3px] w-full" style={{ background: stateMeta ? `linear-gradient(90deg, ${stateMeta.color}, color-mix(in srgb, ${stateMeta.color} 30%, transparent) 70%, transparent)` : "color-mix(in srgb, var(--sol-violet) 55%, transparent)" }} aria-hidden />

      {/* header: the face, the name, who it reports to, the state; the composer below is Talk */}
      <header className={cn("shrink-0 border-b", phone ? "px-3 pt-2 pb-2" : "px-5 pt-3 pb-2.5")} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)", background: stateMeta ? `linear-gradient(180deg, color-mix(in srgb, ${stateMeta.color} 5%, var(--sol-bg)) 0%, var(--sol-bg) 100%)` : undefined }}>
        <div className="flex items-start gap-3">
          {session?.onBack ? (
            <button type="button" onClick={session.onBack} className="shrink-0 mt-[3px] inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }} aria-label="Back to the inbox" data-scope-back="inbox">
              <ArrowLeft className="w-4 h-4" />
            </button>
          ) : (
            <Link href="/org" className="shrink-0 mt-[3px] inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }} aria-label="Back to the org" data-scope-back="org">
              <ArrowLeft className="w-4 h-4" />
            </Link>
          )}
          {/* The role's face (S13); the root workspace has none. */}
          {role && <RoleFace role={role} size={phone ? 34 : 40} className="shrink-0 mt-[2px]" />}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <h1 className={cn("font-semibold tracking-tight leading-none truncate", phone ? "text-[18px]" : "text-[22px]")} style={{ fontFamily: "var(--font-serif)" }}>{name}</h1>
              <span className="inline-flex items-center h-[20px] px-1.5 rounded-md text-[10.5px] font-medium" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>@{handle}</span>
              {!role && <span className="inline-flex items-center gap-1 text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}><Network className="w-3 h-3" /> the whole workspace</span>}
              {stateMeta && (
                <span className="inline-flex items-center gap-1.5 h-[20px] px-1.5 rounded-md text-[10.5px] font-medium border" style={{ borderColor: `color-mix(in srgb, ${stateMeta.color} 45%, transparent)`, color: stateMeta.color }} data-scope-state={stateMeta.label}>
                  <span className={cn("w-[6px] h-[6px] rounded-full", stateMeta.pulse && "animate-pulse")} style={{ background: stateMeta.color }} />
                  {stateMeta.label}
                </span>
              )}
              {paused && <span className="text-[10px] px-1.5 h-[18px] inline-flex items-center rounded-md" style={{ background: "color-mix(in srgb, var(--sol-yellow) 14%, transparent)", color: "var(--sol-yellow)" }}>paused</span>}
            </div>
            {/* Line two: the state line (the brief's first line, else the standing
                session's own) and who the role reports to. Trust, host, model and
                the day's counters live in the panel's Settings and Brief tabs. */}
            <div className={cn("mt-1 flex items-center gap-x-3 min-w-0", phone ? "text-[12px]" : "text-[12.5px]")}>
              {stripeLine ? (
                <p className="min-w-0 flex-1 truncate" style={{ color: "var(--sol-text-secondary)" }} title={stripeLine} data-scope-stripe>{stripeLine}</p>
              ) : (
                <p className="min-w-0 flex-1 truncate italic" style={{ color: "var(--sol-text-dim)" }} data-scope-stripe>{role ? (noStanding ? "Not online yet." : "No brief line yet.") : "Everything in the workspace, as one scope."}</p>
              )}
              {role && !phone && (
                <span className="shrink-0 inline-flex items-center gap-1.5" style={{ color: "var(--sol-text-muted)" }} data-scope-reports-to>
                  <span style={{ color: "var(--sol-text-dim)" }}>reports to</span>
                  {role.reports_to.kind === "role"
                    ? <Link href={`/org/${tree.roles.find((r) => r._id === (role.reports_to as any).role_id)?.short_id ?? ""}`} className="font-medium hover:underline" style={{ color: "var(--sol-text)" }}>{parentName(tree, role.reports_to)}</Link>
                    : <Link href="/org" className="font-medium hover:underline inline-flex items-center gap-1" style={{ color: "var(--sol-text)" }}><Avatar name={parentName(tree, role.reports_to)} image={tree.people.find((p) => p.user_id === (role.reports_to as any).user_id)?.image} size="sm" />{parentName(tree, role.reports_to)}</Link>}
                </span>
              )}
            </div>
          </div>
          <div className="shrink-0 flex items-center gap-1.5">
            {!phone && role && canEdit && (
              <ActionButton icon={paused ? Play : Pause} label={paused ? "Resume" : "Pause"} tip={paused ? "Held wakes ship as one frame" : "Hands stop at a safe point; wakes hold"} onClick={() => update({ status: paused ? "active" : "paused" })} />
            )}
            {!phone && role && canEdit && <ActionButton icon={Archive} label="Retire" danger tip="Retire this seat; you confirm on Settings" onClick={() => { setRetireArmed(true); openTab("settings"); }} />}
            <PanelToggle open={panelOpen} waiting={waiting} compact={phone} onClick={() => setPanelOpen((v) => !v)} />
          </div>
        </div>
      </header>

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

/** The agent's opening bubble (F4.1): what this area is and what waits on
 *  the person, said from the rows (the role, its scope, the hands' states),
 *  not from the transcript; the header's stripe says what it is watching.
 *  Same frame as the proposal letter, so a lead reads the same everywhere. */
export function ScopeLead({ role, anchorName, tree, waiting, standingState }: { role: OrgRole | null; anchorName: string | null; tree: OrgTree; waiting: number; standingState: WorkState | undefined }) {
  const name = role ? role.name : anchorName ?? "The workspace agent";
  const owns = role ? [...role.scope_names.projects.map((p) => p.title), ...role.scope_names.plans.map((p) => p.title)] : [];
  const area = !role ? "the whole workspace" : owns.length > 0 ? owns.join(", ") : "the whole workspace";
  const parent = role ? parentName(tree, role.reports_to) : null;
  const ask = waiting > 0
    ? `${waiting} ${waiting === 1 ? "session is" : "sessions are"} waiting on a person: the Sessions tab on the board says which.`
    : standingState === "needs_input" ? "I am waiting on you, below." : "Nothing is waiting on you.";
  return (
    <div className="conv-col mx-auto px-2 sm:px-3 md:px-4 pt-4 pb-2" data-scope-lead>
      <div className="flex items-center gap-2 mb-2">
        {role ? <RoleFace role={role} size={24} /> : <span className="w-6 h-6 rounded-full inline-flex items-center justify-center shrink-0" style={{ background: "color-mix(in srgb, var(--sol-violet) 16%, transparent)", color: "var(--sol-violet)" }}><Network className="w-3.5 h-3.5" /></span>}
        <span className="text-xs font-medium" style={{ color: "var(--sol-text-secondary)" }}>{name}</span>
      </div>
      <div className="pl-8 text-[13.5px] leading-relaxed" style={{ color: "var(--sol-text)" }}>
        <p>I look after {area}{parent ? ` and report to ${parent}` : ""}. Ask me for anything here: I answer, or start a session for the work and tell you which.</p>
        <p className="mt-1.5" style={{ color: waiting > 0 || standingState === "needs_input" ? "var(--sol-yellow)" : "var(--sol-text-muted)" }} data-scope-lead-ask>{ask}</p>
      </div>
    </div>
  );
}

/** The header's control for the board (F4.1). Closed, it still tells you
 *  the one thing that matters: a hand under this scope is waiting on a person. */
function PanelToggle({ open, waiting, compact, onClick }: { open: boolean; waiting: number; compact: boolean; onClick: () => void }) {
  const Icon = open ? PanelRightClose : PanelRightOpen;
  const tip = open ? "Close the board" : waiting > 0 ? `Open the board: ${waiting} session${waiting === 1 ? "" : "s"} waiting on a person` : "Open the board: feed, tasks, plans, pages, sessions, decisions";
  return (
    <ShortcutTooltip label={tip} side="bottom">
      <button
        type="button"
        onClick={onClick}
        className={cn("relative h-[32px] inline-flex items-center justify-center gap-1.5 rounded-lg text-[12.5px] font-medium transition-colors hover:bg-sol-bg-highlight/70", compact ? "w-[32px]" : "px-3", open && "bg-sol-bg-highlight/60")}
        style={{ border: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)", color: open ? "var(--sol-text)" : "var(--sol-text-muted)" }}
        aria-pressed={open}
        aria-label={compact ? tip : undefined}
        data-scope-panel-toggle={open ? "open" : "closed"}
        data-scope-waiting={waiting}
      >
        <Icon className="w-3.5 h-3.5" />
        {!compact && "Board"}
        {waiting > 0 && <span className="absolute -top-[3px] -right-[3px] w-[8px] h-[8px] rounded-full ring-2" style={{ background: "var(--sol-yellow)", ["--tw-ring-color" as any]: "var(--sol-bg)" }} aria-hidden data-scope-panel-dot />}
      </button>
    </ShortcutTooltip>
  );
}

/** A seat with no standing agent yet (F4.1): say what this area is, and
 *  offer the one gesture that makes sense. An empty composer would go nowhere. */
function ScopeUnseated({ role, tree, canEdit, hostName, busy, onProvision, onOpenBoard }: { role: OrgRole; tree: OrgTree; canEdit: boolean; hostName: string; busy: boolean; onProvision: () => void; onOpenBoard: () => void }) {
  const owns = [...role.scope_names.projects.map((p) => p.title), ...role.scope_names.plans.map((p) => p.title)];
  const charter = (role.charter ?? "").split("\n").map((l) => l.trim()).find(Boolean);
  const retired = role.status === "retired";
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center px-6" data-scope-unseated={role.short_id}>
      <div className="max-w-md w-full text-center">
        <RoleFace role={role} size={56} className="mx-auto mb-4" />
        <h2 className="text-[17px] font-semibold tracking-tight" style={{ fontFamily: "var(--font-serif)" }}>{role.name} is not online yet</h2>
        <p className="mt-2 text-[13px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>
          {charter ? charter : owns.length > 0 ? `This seat owns ${owns.join(", ")}.` : "This seat owns the whole workspace."}
          {charter && owns.length > 0 && <> It covers {owns.join(", ")}.</>}
          {" "}It reports to <span style={{ color: "var(--sol-text)" }}>{parentName(tree, role.reports_to)}</span>.
        </p>
        {retired ? (
          <p className="mt-3 text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>This seat is retired. Its board is still here.</p>
        ) : canEdit ? (
          <>
            <p className="mt-3 text-[12.5px]" style={{ color: "var(--sol-text-dim)" }}>Bring it online and this page becomes a conversation with it: ask for something here and it answers or starts a session for the work.</p>
            <button type="button" onClick={onProvision} disabled={busy} className="mt-4 h-9 px-4 rounded-lg text-[13px] font-semibold disabled:opacity-60 hover:brightness-110 transition-colors" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }} data-scope-provision>
              {busy ? "Bringing it online…" : `Bring @${role.handle} online`}
            </button>
          </>
        ) : (
          <p className="mt-3 text-[12.5px]" style={{ color: "var(--sol-text-dim)" }} data-scope-ask-host>Ask {hostName} to bring it online; until then the board beside this page is what there is.</p>
        )}
        <button type="button" onClick={onOpenBoard} className="mt-3 text-[12px] underline-offset-2 hover:underline" style={{ color: "var(--sol-violet)" }}>Open the board</button>
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, disabled, tip, primary, danger, grow }: { icon: any; label: string; onClick: () => void; disabled?: boolean; tip: string; primary?: boolean; danger?: boolean; grow?: boolean }) {
  const btn = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn("h-[32px] inline-flex items-center justify-center gap-1.5 px-3 rounded-lg text-[12.5px] font-medium transition-colors disabled:opacity-45 disabled:cursor-not-allowed", grow && "flex-1", !primary && !disabled && "hover:bg-sol-bg-highlight/70", primary && !disabled && "hover:brightness-110")}
      style={primary
        ? { background: "var(--sol-violet)", color: "var(--sol-bg)" }
        : { border: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)", color: danger ? "var(--sol-red)" : "var(--sol-text-muted)" }}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );
  if (!tip) return btn;
  // A disabled button swallows pointer events; the span carries the tooltip.
  return <ShortcutTooltip label={tip} side="bottom"><span className={cn("inline-flex", grow && "flex-1")}>{btn}</span></ShortcutTooltip>;
}
