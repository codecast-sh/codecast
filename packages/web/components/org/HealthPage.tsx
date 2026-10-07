"use client";
// `/org?view=health`: the health page (org-staffing.md S29). The same tree
// as the org screen, each role carrying its week, what waits on the person
// in one row above it, and a role's drawer with its levers. Its proposal
// rows link to the org screen; the Head of People's conversation lives
// there, not here.
import { useCallback, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncOrgHealth } from "../../hooks/useSyncOrgHealth";
import { useSyncOrgProposals } from "../../hooks/useSyncOrgProposals";
import { useDecisionQueue } from "../../hooks/useDecisionQueue";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useOpenLinkedSession } from "../../hooks/useOpenLinkedSession";
import { useIsPhone } from "../../hooks/useIsPhone";
import { useInitiatives } from "../../hooks/useInitiatives";
import { isConvexId } from "../../lib/entityLinks";
import { DEFAULT_ROLE_CAPS } from "@codecast/shared/contracts/orgCapacity";
import { OrgGraph } from "./OrgGraph";
import { OrgHeader } from "./OrgHeader";
import { HealthBoard, HEALTH_DRAWER_FRACTION } from "./HealthBoard";
import { OrgPreviewBanner, OrgReadStateBlock } from "./OrgReadStateBlock";
import { flowDays, flowMap, roleFlows } from "./orgFlow";
import { parentRefOfNodeId, roleNodeId, type OrgFocusTarget, type OrgLayoutView } from "./orgLayout";
import { findHeadOfPeople, orgPreviewEnabled, reviewRunState, type OrgReviewRun } from "./staffingModel";
import { missionOf } from "./orgScreenModel";
import { GOALS_FIXTURE_DATA, ORG_GOALS_FIXTURE_PROPOSAL } from "./goalsFixture";
import { ORG_STAFFING_FIXTURE_HEALTH, ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL } from "./orgStaffingFixture";
import { ORG_FIXTURE_WITH_HEAD } from "./orgFixture";
import { joinProposals, type OrgProposalRow } from "./orgStaffingTypes";
import type { OrgTree } from "./orgTypes";

const ORG_PREVIEW_DEV = !!import.meta.env.DEV;
const NO_CLUSTERS: ReadonlySet<string> = new Set();
const HEALTH_VIEW: OrgLayoutView = { collapsed: new Set(), expanded: {}, structureOnly: true };
const noop = () => {};
const never = () => false;
const PREVIEW_PROPOSALS: OrgProposalRow[] = [ORG_STAFFING_FIXTURE_PROPOSAL, ORG_STAFFING_FIXTURE_REVISED_PROPOSAL, ORG_GOALS_FIXTURE_PROPOSAL];
let focusSeq = 0;

export function HealthPage() {
  const { tree: storeTree } = useSyncOrgTree();
  const { health: storeHealth, missing: healthMissing, error: healthError, refresh: refreshHealth } = useSyncOrgHealth();
  useSyncOrgProposals();
  const queue = useDecisionQueue();
  const s = useTrackedStore([
    (st) => st.currentUser?._id,
    (st) => st.clientState.ui?.active_team_id,
    (st) => st.orgProposals,
    (st) => st.orgProposalChanges,
    (st) => st.clientState.ui?.org_review_run?.since,
    (st) => st.clientState.ui?.org_review_run?.session_id,
    (st) => { const id = st.clientState.ui?.org_review_run?.session_id; return id ? st.sessions[id]?.is_idle : undefined; },
    (st) => { const id = st.clientState.ui?.org_review_run?.session_id; return id ? st.sessions[id]?.status : undefined; },
  ]);
  const router = useRouter();
  const search = useSearchParams().toString();
  const preview = orgPreviewEnabled(search, ORG_PREVIEW_DEV);
  const openLinked = useOpenLinkedSession();
  const phone = useIsPhone();
  const now = useCoarseNow(30_000);
  const meId = s.currentUser?._id ? String(s.currentUser._id) : null;
  const activeTeamId = s.clientState.ui?.active_team_id as string | undefined;
  // The same workspace guard as the org screen: a tree that names another workspace is not this page's data.
  const wantedWorkspace = activeTeamId && isConvexId(activeTeamId) ? activeTeamId : meId;
  const tree: OrgTree | null = preview ? ORG_FIXTURE_WITH_HEAD : !storeTree || !wantedWorkspace || storeTree.workspace.id === wantedWorkspace ? storeTree : null;
  const health = preview ? ORG_STAFFING_FIXTURE_HEALTH : storeHealth;
  const proposals = useMemo(() => {
    const rows = preview ? PREVIEW_PROPOSALS : joinProposals(s.orgProposals, s.orgProposalChanges);
    const wanted = tree?.workspace;
    return wanted ? rows.filter((p) => wanted.kind === "team" ? p.team_id === wanted.id : !p.team_id) : rows;
  }, [preview, s.orgProposals, s.orgProposalChanges, tree]);
  const head = useMemo(() => findHeadOfPeople(tree), [tree]);
  const me = tree?.people.find((p) => p.is_me) ?? (meId ? tree?.people.find((p) => p.user_id === meId) : undefined);
  const isAdmin = me?.role === "admin" || me?.role === "owner" || tree?.workspace.kind === "user";
  const canEditRole = useCallback((roleId: string) => {
    const r = tree?.roles.find((x) => x._id === roleId);
    return !!r && (isAdmin || r.host_user_id === (me?.user_id ?? meId));
  }, [tree, isAdmin, me, meId]);
  const storeInitiatives = useInitiatives();
  const mission = useMemo(() => missionOf(preview ? GOALS_FIXTURE_DATA.initiatives : storeInitiatives), [preview, storeInitiatives]);

  // The loop (org-staffing.md S29): the in-place verbs are the store's own actions. The preview sends nothing.
  const previewOnly = useCallback(() => toast.success("Preview: nothing is sent"), []);
  const answerDecision = useCallback((decisionId: string, index: number) => { if (preview) return previewOnly(); useInboxStore.getState().answerDecision(decisionId, { index }); }, [preview, previewOnly]);
  const triggerVerb = useCallback((taskId: string, verb: "pause" | "resume" | "runNow") => { if (preview) return previewOnly(); useInboxStore.getState().triggerAction(taskId, verb); }, [preview, previewOnly]);
  const setTriggerEvery = useCallback((taskId: string, ms: number) => { if (preview) return previewOnly(); useInboxStore.getState().setTriggerInterval(taskId, ms); }, [preview, previewOnly]);
  const sendToRole = useCallback((conversationId: string, text: string) => { if (preview) return previewOnly(); useInboxStore.getState().sendMessage(conversationId, text); }, [preview, previewOnly]);
  const openSession = useCallback((conversationId: string) => { if (!preview) openLinked({ _id: conversationId, updated_at: Date.now() }); }, [preview, openLinked]);
  const setLimit = useCallback((roleId: string, perDay: number) => {
    const role = tree?.roles.find((r) => r._id === roleId);
    if (!role) return;
    if (preview) return previewOnly();
    useInboxStore.getState().updateOrgRole(roleId, { caps: { ...DEFAULT_ROLE_CAPS, ...(role.caps ?? {}), wakes_per_day: perDay } });
    toast.success(`${role.name} can now take ${perDay} a day`);
  }, [tree, preview, previewOnly]);
  const reviewRun: OrgReviewRun | null = preview ? null : s.clientState.ui?.org_review_run ?? null;
  const reviewRow = reviewRun?.session_id ? s.sessions[reviewRun.session_id] : undefined;
  const reviewState = reviewRunState(reviewRun, now, tree?.workspace.id ?? null, proposals, reviewRow ? { is_idle: reviewRow.is_idle, status: reviewRow.status } : null);

  // -------- the chart in its health mode: the same tree, each role carrying its week
  const flows = useMemo(() => roleFlows(tree, health, now), [tree, health, now]);
  const healthMap = useMemo(() => flowMap(flows), [flows]);
  const days = useMemo(() => flowDays(now), [now]);
  const roles = useMemo(() => Object.fromEntries(flows.map((f) => [f.nodeId, f])), [flows]);
  /** The role open in the drawer, and lit on its chart. */
  const [healthFocus, setHealthFocus] = useState<string | null>(null);
  const [graphFocus, setGraphFocus] = useState<OrgFocusTarget | null>(null);
  /** A role opened from its card or the drawer: the chart brings it above the drawer. */
  const focusRole = useCallback((roleId: string | null) => {
    setHealthFocus(roleId);
    setGraphFocus(roleId ? { kind: "node", id: roleNodeId(roleId), seq: ++focusSeq } : null);
  }, []);
  const focusNode = healthFocus ? roleNodeId(healthFocus) : null;

  return (
    <div className="h-full flex flex-col overflow-hidden relative" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-org-screen="health">
      <OrgHeader tree={tree} mission={mission} isAdmin={!!isAdmin} healthOn phone={phone} meId={me?.user_id ?? meId ?? ""} onCreateRole={(input) => { if (preview) return previewOnly(); useInboxStore.getState().createOrgRole(input); }} onHistory={() => router.push("/org?panel=history")} health={health} />
      {preview && <OrgPreviewBanner />}
      <p className="shrink-0 px-4 sm:px-6 py-1.5 text-[12px] border-b truncate" style={{ color: "var(--sol-text-muted)", borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }}>How work moves through the company this week, and what you can change about it.</p>
      <div className="flex-1 min-h-0 relative" data-org-body="health">
        {!tree ? <OrgReadStateBlock kind="loading" /> : (
          <HealthBoard
            tree={tree}
            health={health}
            flows={flows}
            healthMissing={!preview && healthMissing}
            healthError={!preview && !healthMissing ? healthError?.message : undefined}
            onRetryHealth={refreshHealth}
            proposals={proposals}
            queue={queue}
            head={head}
            now={now}
            phone={phone}
            focusRoleId={healthFocus}
            onFocusRole={focusRole}
            reviewing={reviewState === "reviewing"}
            reviewEnded={reviewState === "ended"}
            reviewSessionId={reviewState === "none" ? null : reviewRun?.session_id ?? null}
            onOpenSession={openSession}
            onPickProposal={(shortId) => router.push(`/org?proposal=${shortId}`)}
            onSelectNode={(nodeId) => { const ref = parentRefOfNodeId(nodeId); if (ref?.kind === "role") focusRole(ref.role_id); }}
            onAnswerDecision={answerDecision}
            onTrigger={triggerVerb}
            onSetTriggerEvery={setTriggerEvery}
            onSendToRole={sendToRole}
            onSetLimit={setLimit}
            canEditRole={canEditRole}
            map={tree.roles.length + tree.people.length > 0 ? (
              <OrgGraph
                tree={tree}
                view={HEALTH_VIEW}
                selectedId={focusNode}
                loadingClusters={NO_CLUSTERS}
                showMiniMap={false}
                onSelect={(id) => { const ref = id ? parentRefOfNodeId(id) : null; focusRole(ref?.kind === "role" ? ref.role_id : null); }}
                panelHeightFraction={healthFocus ? HEALTH_DRAWER_FRACTION : 0}
                onToggleCollapse={noop}
                onExpandCluster={noop}
                onCollapseCluster={noop}
                onReparentRequest={noop}
                onNodeContextMenu={noop}
                canDrag={never}
                onOpenSession={openSession}
                health={health}
                focusTarget={graphFocus}
                flow={{ map: healthMap, focusNodeId: focusNode, roles, days }}
              />
            ) : null}
          />
        )}
      </div>
    </div>
  );
}
