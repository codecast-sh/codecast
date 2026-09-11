"use client";
// The scope page (docs/architecture/scopes-and-feed.md F3; org-roles-standing.md
// T6): one role, or the workspace root, as a header, a board line and tabs.
// Paints from the orgTree store singleton (the same feeder the org page mounts)
// plus three per view queries: the feed page, the board counts and the brief.
// Every edit is a store action that moves the page in the same tick and rides
// dispatch to orgRoles.*; Talk opens the standing session; Wake sends it a line.
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { Anchor as AnchorGlyph, ArrowLeft, Bell, CheckSquare, FileText, Layers, ListChecks, MessageCircleQuestion, MessageSquare, Network, Pause, Play, Rss, ScrollText, Settings2, Terminal } from "lucide-react";
import { useInboxStore, useTrackedStore, type PlanItem, type ProjectItem } from "../../../store/inboxStore";
import { useSyncOrgTree } from "../../../hooks/useSyncOrgTree";
import { useSyncProjects } from "../../../hooks/useSyncProjects";
import { useSyncTasks } from "../../../hooks/useSyncTasks";
import { useSyncPlans } from "../../../hooks/useSyncPlans";
import { useSyncDocs } from "../../../hooks/useSyncDocs";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { useIsPhone } from "../../../hooks/useIsPhone";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useRoleBrief, useScopeSummary, type ScopeRef } from "../../../hooks/useScopeQueries";
import { compactAge } from "../../../lib/threadState";
import { cn } from "../../../lib/utils";
import { TaskListContent } from "../../../app/tasks/page";
import { Avatar } from "../../tasks/TaskCommentStream";
import { ShortcutTooltip } from "../../KeyboardShortcutsHelp";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { ORG_STATE_META, StateTally } from "../OrgNodeCards";
import { parentName } from "../OrgScopePanel";
import type { OrgAnchor, OrgParentRef, OrgRole, OrgTree } from "../orgTypes";
import { ScopeFeed } from "./ScopeFeed";
import { ScopeBriefTab, ScopeCharterTab, ScopeDecisionsTab, ScopeDocsTab, ScopePlansTab, ScopeSessionsTab, useScopeIds } from "./ScopeTabs";
import { ScopeSettings } from "./ScopeSettings";
import { DEFAULT_CAPS, TRUST_META, briefFirstLine, type TrustStage } from "./scopeTypes";

const api = _api as any;

type TabKey = "feed" | "tasks" | "plans" | "docs" | "sessions" | "decisions" | "brief" | "charter" | "settings";
const TABS: { key: TabKey; label: string; icon: any; roleOnly?: boolean }[] = [
  { key: "feed", label: "Feed", icon: Rss },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  { key: "plans", label: "Plans", icon: Layers },
  { key: "docs", label: "Docs", icon: FileText },
  { key: "sessions", label: "Sessions", icon: Terminal },
  { key: "decisions", label: "Decisions", icon: MessageCircleQuestion },
  { key: "brief", label: "Brief", icon: ScrollText, roleOnly: true },
  { key: "charter", label: "Charter", icon: CheckSquare, roleOnly: true },
  { key: "settings", label: "Settings", icon: Settings2, roleOnly: true },
];

const todayUtc = () => new Date().toISOString().slice(0, 10);

export function ScopePageInner({ id }: { id: string }) {
  const { tree, ready } = useSyncOrgTree();
  // The tabs paint from the store: keep the workspace's collections fed here
  // the way the project page does.
  useSyncProjects(); useSyncTasks(); useSyncPlans(); useSyncDocs();
  const router = useRouter();
  const searchParams = useSearchParams();
  const phone = useIsPhone();
  const openLinked = useOpenLinkedSession();
  const now = useCoarseNow(30_000);
  const s = useTrackedStore([(st) => st.currentUser?._id]);
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;

  const isRoot = id === "workspace";
  const role: OrgRole | null = useMemo(() => (!tree || isRoot ? null : tree.roles.find((r) => r.short_id === id || r._id === id) ?? null), [tree, id, isRoot]);
  const roleAnchorIds = useMemo(() => new Set((tree?.roles ?? []).map((r) => r.anchor_id).filter(Boolean)), [tree]);
  const anchor: OrgAnchor | null = useMemo(() => {
    if (!tree) return null;
    if (role) return role.anchor_id ? tree.anchors.find((a) => a.anchor_id === role.anchor_id) ?? null : null;
    return tree.anchors.find((a) => !roleAnchorIds.has(a.anchor_id)) ?? null;
  }, [tree, role, roleAnchorIds]);

  const projects = useWorkspaceCollection<ProjectItem>("projects");
  const plans = useWorkspaceCollection<PlanItem>("plans");
  const scopeIds = useScopeIds(role ? role.scope : null, plans);
  // The root's scope is every project of the workspace: the server reads an
  // empty scope as "nothing" unless a role names it, so name the projects.
  const scopeRef: ScopeRef | null = useMemo(() => {
    if (role) return { role_id: role._id };
    if (!tree) return null;
    return { scope: { project_ids: projects.map((p) => p._id), plan_ids: [] }, ...(tree.workspace.kind === "team" ? { team_id: tree.workspace.id } : {}) };
  }, [role, tree, projects]);
  const { data: summary } = useScopeSummary(scopeRef ?? "skip");
  const { data: brief } = useRoleBrief(role?._id ?? null);

  // -------- tabs in the URL, like the project page
  const tabParam = searchParams.get("tab") as TabKey | null;
  const tab: TabKey = tabParam && TABS.some((t) => t.key === tabParam && (!t.roleOnly || role)) ? tabParam : "feed";
  const setTab = useCallback((next: TabKey) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "feed") params.delete("tab"); else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `/org/${id}?${qs}` : `/org/${id}`);
  }, [searchParams, router, id]);

  // -------- permissions: admins and the host reshape; the parent also edits the brief
  const me = tree?.people.find((p) => p.is_me) ?? (meId ? tree?.people.find((p) => p.user_id === meId) : undefined);
  const isAdmin = !!tree && (me?.role === "admin" || me?.role === "owner" || tree.workspace.kind === "user");
  const canEdit = !!role && (isAdmin || role.host_user_id === (me?.user_id ?? meId));
  const isParent = !!role && role.reports_to.kind === "user" && role.reports_to.user_id === (me?.user_id ?? meId);
  const canEditBrief = canEdit || isParent;

  // -------- actions
  const store = useInboxStore.getState;
  const update = useCallback((fields: Parameters<ReturnType<typeof store>["updateOrgRole"]>[1]) => { if (role) store().updateOrgRole(role._id, fields); }, [role, store]);
  const reparent = useCallback((target: OrgParentRef) => { if (role) store().reparentOrgRole(role._id, target); }, [role, store]);
  const retire = useCallback(() => { if (!role) return; store().retireOrgRole(role._id); toast.success(`Retired ${role.name}`); router.push("/org"); }, [role, store, router]);
  const wakeMutation = useMutation(api.orgRoles.wake);
  const [wakeOpen, setWakeOpen] = useState(false);
  const [wakeText, setWakeText] = useState("");
  const [waking, setWaking] = useState(false);
  const sendWake = useCallback(async () => {
    if (!role || !wakeText.trim()) return;
    setWaking(true);
    try {
      await wakeMutation({ role_id: role._id, message: wakeText.trim() });
      toast.success(`Woke @${role.handle}`);
      setWakeOpen(false); setWakeText("");
    } catch (e: any) {
      toast.error(e?.message?.replace(/^\[Request ID: [^\]]+\] Server Error\s*/i, "").split("\n")[0] ?? "Wake failed");
    } finally { setWaking(false); }
  }, [role, wakeText, wakeMutation]);
  const talk = useCallback(() => {
    if (!anchor?.conversation_id) return;
    openLinked({ _id: anchor.conversation_id, short_id: anchor.short_id, title: anchor.name, agent_type: "claude_code" });
  }, [anchor, openLinked]);

  // -------- header facts
  const standing = useInboxStore((st) => (anchor?.conversation_id ? st.sessions[anchor.conversation_id] : undefined));
  const model = (standing as any)?.model ?? null;
  const hostName = role ? tree?.people.find((p) => p.user_id === role.host_user_id)?.name ?? "the host" : tree?.workspace.name ?? "";
  const workState = anchor?.work_state;
  const stateMeta = workState ? ORG_STATE_META[workState] : null;
  const trust: TrustStage = role?.trust ?? "understand";
  const caps = role?.caps ?? DEFAULT_CAPS;
  const counters = role?.counters && role.counters.day === todayUtc() ? role.counters : null;
  const boardLine = briefFirstLine(brief?.narrative);
  const standingStateLine = (standing as any)?.thread_state ? String((standing as any).thread_state).split("\n")[0] : null;
  const stripeLine = boardLine || standingStateLine;

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
  const noStanding = !anchor?.conversation_id;
  const visibleTabs = TABS.filter((t) => !t.roleOnly || role);
  const backHref = `/org/${id}?tab=${tab}`;

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }}>
      <style>{`
        @keyframes scope-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .scope-rise { animation: scope-rise .32s cubic-bezier(.2,.7,.2,1) both; }
        .scope-feed-row { animation: scope-rise .28s cubic-bezier(.2,.7,.2,1) both; }
        @media (prefers-reduced-motion: reduce) { .scope-rise, .scope-feed-row { animation: none; } }
      `}</style>

      {/* state stripe: the standing session's work state, as a hairline the whole width */}
      <div className="shrink-0 h-[3px] w-full" style={{ background: stateMeta ? `linear-gradient(90deg, ${stateMeta.color}, color-mix(in srgb, ${stateMeta.color} 30%, transparent) 70%, transparent)` : "color-mix(in srgb, var(--sol-violet) 55%, transparent)" }} aria-hidden />

      {/* header */}
      <header className={cn("shrink-0 border-b scope-rise", phone ? "px-3 pt-2.5 pb-2" : "px-6 pt-4 pb-3")} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)", background: stateMeta ? `linear-gradient(180deg, color-mix(in srgb, ${stateMeta.color} 5%, var(--sol-bg)) 0%, var(--sol-bg) 100%)` : undefined }}>
        <div className="flex items-start gap-3">
          <Link href="/org" className="shrink-0 mt-[3px] inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-sol-bg-highlight/70" style={{ color: "var(--sol-text-muted)" }} aria-label="Back to the org">
            <ArrowLeft className="w-4 h-4" />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap min-w-0">
              <span className="inline-flex items-center h-[20px] px-1.5 rounded-md text-[10.5px] font-medium" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>@{handle}</span>
              {role && <span className="text-[10.5px]" style={{ color: "var(--sol-text-dim)", fontFamily: "var(--font-mono)" }}>{role.short_id}</span>}
              {!role && <span className="inline-flex items-center gap-1 text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}><AnchorGlyph className="w-3 h-3" /> root anchor</span>}
              {stateMeta && (
                <span className="inline-flex items-center gap-1.5 h-[20px] px-1.5 rounded-md text-[10.5px] font-medium border" style={{ borderColor: `color-mix(in srgb, ${stateMeta.color} 45%, transparent)`, color: stateMeta.color }}>
                  <span className={cn("w-[6px] h-[6px] rounded-full", workState === "working" && "animate-pulse")} style={{ background: stateMeta.color }} />
                  {stateMeta.label}
                </span>
              )}
              {paused && <span className="text-[10px] px-1.5 h-[18px] inline-flex items-center rounded-md" style={{ background: "color-mix(in srgb, var(--sol-yellow) 14%, transparent)", color: "var(--sol-yellow)" }}>paused</span>}
            </div>
            <h1 className={cn("mt-1 font-semibold tracking-tight leading-none truncate", phone ? "text-[20px]" : "text-[26px]")} style={{ fontFamily: "var(--font-serif)" }}>{name}</h1>
            {!phone && (
              <div className="mt-2 flex items-center gap-x-3 gap-y-1 flex-wrap text-[12px]" style={{ color: "var(--sol-text-muted)" }}>
                {role && (
                  <ShortcutTooltip label={TRUST_META[trust].sentence} side="bottom">
                    <span className="inline-flex items-center gap-1.5 h-[22px] px-2 rounded-full border text-[11px] font-medium cursor-help" style={{ borderColor: `color-mix(in srgb, ${TRUST_META[trust].color} 50%, transparent)`, color: TRUST_META[trust].color, background: `color-mix(in srgb, ${TRUST_META[trust].color} 8%, transparent)` }}>
                      trust · {TRUST_META[trust].label}
                    </span>
                  </ShortcutTooltip>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <span style={{ color: "var(--sol-text-dim)" }}>host</span>
                  <span style={{ color: "var(--sol-text)" }}>{hostName}</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span style={{ color: "var(--sol-text-dim)" }}>model</span>
                  <span style={{ color: "var(--sol-text)", fontFamily: "var(--font-mono)" }}>{model ?? (noStanding ? "none" : "…")}</span>
                </span>
                {role && (
                  <span className="inline-flex items-center gap-1.5">
                    <span style={{ color: "var(--sol-text-dim)" }}>reports to</span>
                    {role.reports_to.kind === "role"
                      ? <Link href={`/org/${tree.roles.find((r) => r._id === (role.reports_to as any).role_id)?.short_id ?? ""}`} className="font-medium hover:underline" style={{ color: "var(--sol-text)" }}>{parentName(tree, role.reports_to)}</Link>
                      : <Link href="/org" className="font-medium hover:underline inline-flex items-center gap-1" style={{ color: "var(--sol-text)" }}><Avatar name={parentName(tree, role.reports_to)} image={tree.people.find((p) => p.user_id === (role.reports_to as any).user_id)?.image} size="sm" />{parentName(tree, role.reports_to)}</Link>}
                  </span>
                )}
                {role && (
                  <span className="inline-flex items-center gap-1.5 tabular-nums" title="today's wakes, hands and tokens against the daily caps">
                    <span style={{ color: "var(--sol-text-dim)" }}>today</span>
                    <span style={{ color: "var(--sol-text)" }}>{counters?.wakes ?? 0}<span style={{ color: "var(--sol-text-dim)" }}>/{caps.wakes_per_day} wakes</span></span>
                    <span style={{ color: "var(--sol-text)" }}>{counters?.hands ?? 0}<span style={{ color: "var(--sol-text-dim)" }}>/{caps.hands_per_day} hands</span></span>
                    <span style={{ color: "var(--sol-text)" }}>{Math.round((counters?.tokens ?? 0) / 1000)}k<span style={{ color: "var(--sol-text-dim)" }}>/{Math.round(caps.tokens_per_day / 1000)}k tokens</span></span>
                  </span>
                )}
                {anchor?.conversation_id && standing && <span style={{ color: "var(--sol-text-dim)" }}>active {compactAge(now - ((standing as any).updated_at ?? now))} ago</span>}
              </div>
            )}
          </div>
          {!phone && (
            <div className="shrink-0 flex items-center gap-1.5">
              <ActionButton icon={MessageSquare} label="Talk" primary disabled={noStanding} tip={noStanding ? "No standing session yet. Provision one with cast role provision." : "Open the standing session"} onClick={talk} />
              {role && <ActionButton icon={Bell} label="Wake" disabled={noStanding} tip={noStanding ? "No standing session yet." : "Send the role one line; it wakes now"} onClick={() => setWakeOpen(true)} />}
              {role && canEdit && (
                <ActionButton icon={paused ? Play : Pause} label={paused ? "Resume" : "Pause"} tip={paused ? "Held wakes ship as one frame" : "Hands stop at a safe point; wakes hold"} onClick={() => update({ status: paused ? "active" : "paused" })} />
              )}
              {role && canEdit && <ActionButton icon={Settings2} label="Retire" danger tip="Retire from Settings, with a confirmation" onClick={() => setTab("settings")} />}
            </div>
          )}
        </div>

        {/* board line */}
        <div className={cn("flex items-center gap-3 flex-wrap", phone ? "mt-1.5" : "mt-3")}>
          {stripeLine ? (
            <p className={cn("min-w-0 flex-1 truncate", phone ? "text-[12px]" : "text-[13px]")} style={{ color: "var(--sol-text-secondary)" }} title={stripeLine}>{stripeLine}</p>
          ) : (
            <p className={cn("min-w-0 flex-1 truncate italic", phone ? "text-[12px]" : "text-[13px]")} style={{ color: "var(--sol-text-dim)" }}>{role ? "No brief line yet." : "Everything in the workspace, as one scope."}</p>
          )}
          {summary && !phone && (
            <div className="shrink-0 flex items-center gap-2 text-[11px] tabular-nums" style={{ color: "var(--sol-text-muted)" }}>
              <Stat n={summary.tasks.open} label="open tasks" />
              <Stat n={summary.plans.length} label="plans" />
              <Stat n={summary.decisions.open} label="open decisions" tone={summary.decisions.open > 0 ? "var(--sol-yellow)" : undefined} />
              <span className="inline-flex items-center gap-1.5 h-[24px] px-2 rounded-md border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
                <span>{summary.sessions.total} sessions</span>
                <StateTally counts={summary.sessions} />
              </span>
            </div>
          )}
        </div>

        {/* tabs */}
        <nav className={cn("flex items-center gap-1 -mb-px overflow-x-auto no-scrollbar", phone ? "mt-2" : "mt-3")} aria-label="Scope sections">
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            const count = t.key === "decisions" ? summary?.decisions.open : t.key === "tasks" ? summary?.tasks.open : undefined;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn("relative shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 text-[12.5px] transition-colors rounded-t-md", active ? "font-semibold" : "hover:bg-sol-bg-highlight/60")}
                style={{ color: active ? "var(--sol-text)" : "var(--sol-text-muted)" }}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="w-3.5 h-3.5" style={{ color: active ? "var(--sol-violet)" : undefined }} />
                {t.label}
                {count ? <span className="text-[10px] tabular-nums px-1 rounded-sm" style={{ background: "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: "var(--sol-text-dim)" }}>{count}</span> : null}
                {active && <span className="absolute left-2 right-2 -bottom-px h-[2px] rounded-full" style={{ background: "var(--sol-violet)" }} />}
              </button>
            );
          })}
        </nav>
      </header>

      {/* body */}
      {tab === "feed" && scopeRef && <ScopeFeed key={JSON.stringify(scopeRef)} scope={scopeRef} fill />}
      {tab === "tasks" && (
        <div className="flex-1 min-h-0">
          <TaskListContent scope={scopeIds.whole ? undefined : { projectIds: scopeIds.projectIds, planIds: scopeIds.planIds }} />
        </div>
      )}
      {tab !== "feed" && tab !== "tasks" && (
        <div data-scope-scroll className={cn("flex-1 min-h-0 overflow-y-auto", phone ? "px-2 py-3" : "px-5 py-4")}>
          <div className="scope-rise">
            {tab === "plans" && <ScopePlansTab ids={scopeIds} />}
            {tab === "docs" && <ScopeDocsTab ids={scopeIds} />}
            {tab === "sessions" && <ScopeSessionsTab tree={tree} role={role} />}
            {tab === "decisions" && <ScopeDecisionsTab ids={scopeIds} />}
            {tab === "brief" && role && <ScopeBriefTab role={role} facts={brief?.facts ?? null} narrative={brief?.narrative ?? ""} canEdit={canEditBrief} backHref={backHref} />}
            {tab === "charter" && role && <ScopeCharterTab role={role} charter={brief?.charter ?? role.charter ?? ""} canEdit={canEdit} backHref={backHref} onUpdateCharter={(v) => update({ charter: v })} />}
            {tab === "settings" && role && (
              <ScopeSettings tree={tree} role={role} canEdit={canEdit} overlaps={summary?.overlaps ?? []} hostName={hostName} model={model} onUpdate={update} onReparent={reparent} onRetire={retire} />
            )}
          </div>
        </div>
      )}

      {/* phone actions: a bottom bar so the header stays two lines */}
      {phone && role && (
        <div className="shrink-0 border-t px-3 py-2 flex items-center gap-2" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)", background: "var(--sol-bg)" }}>
          <ActionButton icon={MessageSquare} label="Talk" primary disabled={noStanding} tip={noStanding ? "No standing session yet" : "Open the standing session"} onClick={talk} grow />
          <ActionButton icon={Bell} label="Wake" disabled={noStanding} tip={noStanding ? "No standing session yet" : "Wake the role"} onClick={() => setWakeOpen(true)} grow />
          {canEdit && <ActionButton icon={paused ? Play : Pause} label={paused ? "Resume" : "Pause"} tip="" onClick={() => update({ status: paused ? "active" : "paused" })} grow />}
        </div>
      )}

      <Dialog open={wakeOpen} onOpenChange={setWakeOpen}>
        <DialogContent className="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle style={{ fontFamily: "var(--font-serif)" }}>Wake @{handle}</DialogTitle>
            <DialogDescription>One line the role reads first in its next frame. It wakes now, ahead of the coalesce window.</DialogDescription>
          </DialogHeader>
          <textarea
            autoFocus
            value={wakeText}
            onChange={(e) => setWakeText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void sendWake(); } }}
            rows={3}
            placeholder="What should the role look at?"
            className="w-full rounded-md px-2.5 py-2 border outline-none text-[13px] bg-sol-bg-alt"
            style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text)" }}
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" onClick={() => setWakeOpen(false)} className="h-8 px-3 rounded-md text-[12.5px]" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
            <button type="button" disabled={waking || !wakeText.trim()} onClick={() => void sendWake()} className="h-8 px-3.5 rounded-md text-[12.5px] font-semibold disabled:opacity-50" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)" }}>{waking ? "Waking…" : "Wake"}</button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: string }) {
  return (
    <span className="inline-flex items-center gap-1 h-[24px] px-2 rounded-md border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)" }}>
      <span className="font-semibold" style={{ color: tone ?? "var(--sol-text)" }}>{n}</span>
      <span style={{ color: "var(--sol-text-dim)" }}>{label}</span>
    </span>
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
