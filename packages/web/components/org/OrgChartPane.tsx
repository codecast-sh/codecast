"use client";
// `/org?view=chart`: the chart alone (docs/architecture/org-staffing.md S36).
// No page header and no staffing pane: the lens toggle, the proposal's name
// and the canvas. It is an ordinary route, so the stage hosts it as a pane
// beside a conversation, and its address is its whole state: `proposal` draws
// that proposal's ghosts, `focus` pans to one thing, `lens` picks the lens and
// `s` names the conversation it follows. While following, the newest pointer
// in that thread (orgChartPointer) re-points the pane; whatever the person
// picks here holds until a newer one arrives.
import { useCallback, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, Flag, Network, Radio, Users } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useSyncOrgTree } from "../../hooks/useSyncOrgTree";
import { useSyncOrgProposal } from "../../hooks/useSyncOrgProposals";
import { useSyncOrgHealth } from "../../hooks/useSyncOrgHealth";
import { useInitiatives } from "../../hooks/useInitiatives";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { findEntityInStore } from "../../lib/liveEntities";
import { proposalAnswersOf } from "../../lib/reviewActions";
import { cn } from "../../lib/utils";
import { OrgGraph, type OrgLens } from "./OrgGraph";
import { ProposalMeta } from "./ProposalCard";
import { useGhostAnswers } from "./ProposalLedger";
import { ProposalReplyBox, proposalBatchKey } from "./ProposalReplyBox";
import { proposalSeen, useProposalChanges } from "./proposalHooks";
import { orgPreviewEnabled, proposalWorkspace, sameWorkspace } from "./staffingModel";
import { proposalThread } from "./staffingRevise";
import { ORG_FIXTURE } from "./orgFixture";
import { GOALS_PREVIEW_FIXTURES } from "./goalsFixture";
import { ORG_STAFFING_FIXTURE_PROPOSAL } from "./orgStaffingFixture";
import { chartPointerOfParams, chartView, orgChartPath, type ChartPointer } from "./orgChartPointer";
import { useThreadChartPointer } from "./orgChartLink";
import type { OrgFocusTarget, OrgLayoutView } from "./orgLayout";
import type { OrgProposalChange, OrgProposalListRow } from "./orgStaffingTypes";
import type { OrgGraphProps } from "./OrgGraph";

const LENSES: { lens: OrgLens; label: string; title: string; icon: typeof Users }[] = [
  { lens: "people", label: "People", title: "Who reports to whom", icon: Users },
  { lens: "goals", label: "Goals", title: "What the company is trying to reach, and who owns each part", icon: Flag },
];

/** People or Goals: the one toggle the org page and the pane share. */
export function OrgLensToggle({ lens, onChange, size = "md" }: { lens: OrgLens; onChange: (lens: OrgLens) => void; size?: "sm" | "md" }) {
  return (
    <div className={cn("inline-flex shrink-0 items-center rounded-lg border p-[2px]", size === "sm" ? "h-7" : "h-[34px]")} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 30%, transparent)", background: "var(--sol-card)" }} role="group" aria-label="What the chart shows" data-org-lens={lens}>
      {LENSES.map(({ lens: l, label, title, icon: Icon }) => (
        <button
          key={l}
          type="button"
          onClick={() => onChange(l)}
          aria-pressed={lens === l}
          title={title}
          className={cn("inline-flex h-full items-center gap-1.5 rounded-md font-medium transition-colors", size === "sm" ? "px-2 text-[11.5px]" : "px-2.5 text-[12.5px]", lens === l ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/50")}
          style={{ color: lens === l ? "var(--sol-text)" : "var(--sol-text-muted)" }}
          data-org-lens-pick={l}
        >
          <Icon className="h-3.5 w-3.5" style={lens === l ? { color: l === "goals" ? "var(--sol-cyan)" : "var(--sol-violet)" } : undefined} /> {label}
        </button>
      ))}
    </div>
  );
}

/** `?preview=1` on a dev build draws a fixture org and its fixture proposals,
 *  as the org page does: each goals proposal brings the org it belongs to. */
const PREVIEW_DEV = !!import.meta.env?.DEV;
const PREVIEW_FIXTURES = [...GOALS_PREVIEW_FIXTURES, { proposal: ORG_STAFFING_FIXTURE_PROPOSAL, tree: ORG_FIXTURE, goalsData: GOALS_PREVIEW_FIXTURES[0].goalsData, health: GOALS_PREVIEW_FIXTURES[1].health }];

const NO_CLUSTERS: ReadonlySet<string> = new Set();
const NO_CHANGES: readonly OrgProposalChange[] = [];
const noop = () => {};
let focusSeq = 0;

export function OrgChartPane({ goalsData: goalsProp }: { /** Fixture rows for the goals lens (a test). */ goalsData?: OrgGraphProps["goalsData"] }) {
  const router = useRouter();
  const params = useSearchParams();
  const search = params.toString();
  const pointer = useMemo<ChartPointer>(() => chartPointerOfParams(new URLSearchParams(search)), [search]);
  const session = params.get("s");
  const following = !!session && params.get("follow") !== "0";

  const preview = orgPreviewEnabled(search, PREVIEW_DEV);
  const previewFixture = preview ? PREVIEW_FIXTURES.find((f) => f.proposal.short_id === pointer.proposal) ?? PREVIEW_FIXTURES[0] : undefined;
  const goalsData = goalsProp ?? previewFixture?.goalsData;
  const fixture = previewFixture && previewFixture.proposal.short_id === pointer.proposal ? previewFixture.proposal : undefined;
  const { tree: storeTree } = useSyncOrgTree();
  const tree = previewFixture ? previewFixture.tree : storeTree;
  useSyncOrgProposal(preview ? null : pointer.proposal ?? null);
  const storeProposal = useInboxStore((s) => (pointer.proposal && !preview ? (findEntityInStore(s, "proposal", pointer.proposal) as OrgProposalListRow | undefined) : undefined));
  const storeChanges = useProposalChanges(storeProposal?._id);
  const proposal: OrgProposalListRow | undefined = fixture ?? storeProposal;
  const allChanges = fixture?.changes ?? storeChanges;
  // A proposal from another workspace is not drawn on this one's chart.
  const foreign = !!proposal && !!tree && !sameWorkspace(proposalWorkspace(proposal), tree.workspace);
  const changes = proposal && !foreign ? allChanges : undefined;
  const storeGoals = useInitiatives();
  const initiatives = goalsData?.initiatives ?? storeGoals;

  const view = useMemo(() => chartView(pointer, { changes: changes ?? [], initiatives, roles: tree?.roles ?? [] }), [pointer, changes, initiatives, tree]);
  // The people lens' flags and each role's open work (its close card) read org.health; the goals lens does not ask for it.
  const { health: storeHealth } = useSyncOrgHealth(view.lens === "people" && !preview);
  const health = previewFixture ? previewFixture.health : storeHealth;
  const go = useCallback((next: ChartPointer, follow = following) => router.replace(orgChartPath({ ...next, session, follow, preview })), [router, session, following, preview]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** A card the person asked to see here (an owner opened in the people lens). */
  const [pan, setPan] = useState<OrgFocusTarget | null>(null);
  // The thread's newest pointer moves the pane; the one that was there when
  // the pane opened does not, so opening on an older proposal's card holds.
  const thread = useThreadChartPointer(session);
  const applied = useRef(thread?.key ?? null);
  useWatchEffect(() => {
    if (!following || !thread || applied.current === thread.key) return;
    applied.current = thread.key;
    setPan(null);
    go({ proposal: thread.proposal, focus: thread.focus, lens: thread.lens });
  }, [following, thread?.key]);

  const [picked, setPicked] = useState<{ changeId: string | null; for: string } | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const layoutView = useMemo<OrgLayoutView>(() => ({ collapsed, expanded: {} }), [collapsed]);
  const toggleCollapse = useCallback((id: string) => setCollapsed((prev) => { const next = new Set(prev); if (!next.delete(id)) next.add(id); return next; }), []);
  // The change in focus: the one the person clicked here, else the address'.
  const focusChangeId = picked?.for === search ? picked.changeId : view.focus?.kind === "change" ? view.focus.id : null;
  const addressed = useMemo<OrgFocusTarget | null>(() => (view.focus ? { ...view.focus, seq: ++focusSeq } : null), [view.focus?.kind, view.focus?.id, search]); // eslint-disable-line react-hooks/exhaustive-deps
  const focusTarget = pan && (!addressed || pan.seq > addressed.seq) ? pan : addressed;
  // Edit (accept with edits) is the chart's one direct verdict (S39).
  const editAccept = useCallback((id: string, edits: Record<string, unknown>) => {
    if (preview) return; // fixture rows: nothing to decide
    useInboxStore.getState().decideOrgProposalChange(id, "accept", edits, proposalSeen(allChanges));
  }, [allChanges, preview]);
  // Where a ghost's answers wait (S39): beside a conversation, in that
  // conversation's batch, so its composer tray shows them and its send
  // carries them; alone, in the proposal's own key, with a reply box at the
  // pane's foot to send them from. The thread's key is not used beside a
  // conversation: the person answers where they are looking.
  const threadKey = useMemo(() => { const t = proposal && proposal.status === "open" ? proposalThread(proposal, tree) : null; return t ? { conversation_id: t.conversationId } : null; }, [proposal, tree]);
  const batchKey = proposal && changes ? session ?? proposalBatchKey(proposal._id, threadKey) : null;
  const ghostAnswers = useGhostAnswers(proposal && changes ? proposal : undefined, changes ?? NO_CHANGES, batchKey);
  // The preview's send flips nothing: the fixture rows stay; the batch empties.
  const previewSend = useCallback(() => {
    if (!proposal || !batchKey) return;
    const s = useInboxStore.getState();
    for (const c of proposalAnswersOf(s.reviewComments[batchKey], proposal._id)) s.removeReviewComment(batchKey, c.id);
  }, [proposal, batchKey]);
  const openInPeople = useCallback((nodeId: string) => { setSelectedId(nodeId); setPan({ kind: "node", id: nodeId, seq: ++focusSeq }); go({ ...pointer, lens: "people", focus: undefined }); }, [go, pointer]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }} data-org-chart-pane={view.lens}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b px-3 py-1.5" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }}>
        <OrgLensToggle lens={view.lens} size="sm" onChange={(lens) => { setPan(null); go({ ...pointer, lens }); }} />
        <div className="min-w-0 flex-1">
          {proposal ? (
            <div className="min-w-0" data-chart-proposal={proposal.short_id}>
              <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-tight">
                <span className="shrink-0 font-mono text-[10.5px]" style={{ color: "var(--sol-violet)" }}>{proposal.short_id}</span>
                <span className="truncate font-medium">{proposal.title}</span>
              </div>
              {foreign ? <div className="text-[11px] text-sol-text-dim">From another workspace, so it is not drawn on this chart.</div> : <ProposalMeta proposal={proposal} changes={allChanges} />}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[12px] text-sol-text-muted"><Network className="h-3.5 w-3.5" style={{ color: "var(--sol-violet)" }} /> {tree?.workspace.name || "Org"}</div>
          )}
        </div>
        {session && (
          <button
            type="button"
            onClick={() => (following ? go(pointer, false) : go(thread ? { proposal: thread.proposal, focus: thread.focus, lens: thread.lens } : pointer, true))}
            aria-pressed={following}
            title={following ? "The chart moves to what the conversation points at. Click to hold it still." : "Let the conversation move the chart again"}
            className={cn("inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium transition-colors", following ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60")}
            style={{ borderColor: following ? "color-mix(in srgb, var(--sol-violet) 45%, transparent)" : "color-mix(in srgb, var(--sol-border) 30%, transparent)", color: following ? "var(--sol-text)" : "var(--sol-text-muted)" }}
            data-chart-follow={following ? "on" : "off"}
          >
            <Radio className="h-3 w-3" style={following ? { color: "var(--sol-violet)" } : undefined} /> {following ? "Following" : "Follow"}
          </button>
        )}
        <Link href={pointer.proposal ? `/org?proposal=${pointer.proposal}` : "/org"} className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] no-underline hover:bg-sol-bg-highlight/60" style={{ color: "var(--sol-text-muted)" }} title="Open the org page" data-chart-open-page>
          Org page <ArrowUpRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="relative min-h-0 flex-1">
        {tree ? (
          <OrgGraph
            tree={tree}
            view={layoutView}
            lens={view.lens}
            goalsData={goalsData}
            selectedId={selectedId}
            loadingClusters={NO_CLUSTERS}
            showMiniMap={false}
            onSelect={setSelectedId}
            onToggleCollapse={toggleCollapse}
            onExpandCluster={noop}
            onCollapseCluster={noop}
            onReparentRequest={noop}
            onNodeContextMenu={noop}
            canDrag={() => false}
            changes={changes}
            health={health}
            focusChangeId={focusChangeId}
            focusTarget={focusTarget}
            onFocusChange={(changeId) => setPicked({ changeId, for: search })}
            ghostAnswers={ghostAnswers}
            onEditAccept={editAccept}
            onOpenInPeople={openInPeople}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-[12.5px] text-sol-text-dim" data-chart-loading>The chart appears here when it is ready.</div>
        )}
      </div>
      {/* Alone (no conversation beside it): the answers show and send from here. Beside one, its composer tray has them. */}
      {!session && proposal && changes && batchKey && (
        <div className="shrink-0 border-t px-3 pb-2 pt-1" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }} data-chart-reply>
          <ProposalReplyBox proposal={proposal} changes={changes} batchKey={batchKey} thread={threadKey} onSend={preview ? previewSend : undefined} className="border-t-0 pt-1" />
        </div>
      )}
    </div>
  );
}
