"use client";
// The Decisions page: one home for every decision. Mine is what the viewer
// owns, escalated and blocking first; Team is every open decision of the
// workspace with its owner, Unassigned a group of its own; Unassigned,
// Escalated and Answered are the same list cut another way. Mine also keeps
// the card-by-card ways of answering: the cards (stacks, scopes, "Waiting in a
// terminal") and the stepper (`?mode=step`, or `?s=<conversation>` from an
// inbox card). /decisions/<id> opens a decision over the list.
import { useCallback, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { LayoutList, Rows3, StepForward } from "lucide-react";
import { DetailSplitLayout } from "../DetailSplitLayout";
import { ErrorBoundary } from "../ErrorBoundary";
import { SegmentedToggle } from "../SegmentedToggle";
import { DecisionQueue } from "../DecisionQueue";
import { DecisionQueueList } from "./DecisionQueueList";
import { DecisionDocument } from "./DecisionDocument";
import { DecisionList } from "./DecisionList";
import { LineDecision } from "../line/widgets/LineDecision";
import { useModeWords } from "../../lib/surfaces";
import { useDecisionView } from "../../hooks/useDecisionView";
import { useDecisionRows } from "../../hooks/useDecisionRows";
import { useSyncTeamDecisions, useSyncTeamLineDecisions } from "../../hooks/useSyncSessionDecisions";
import { isFlowDecision } from "../../lib/decisions/decisionRows";
import type { SessionDecisionItem } from "../../store/inboxStore";

const routeOf = (d: SessionDecisionItem) => `/decisions/${d.short_id ?? d._id}`;

/** A decision whole, beside the list: a flow's in the flows' reader, any other as its document. */
export function DecisionPeek({ d, onClose }: { d: SessionDecisionItem; onClose: () => void }) {
  return (
    <div className="w-[min(560px,48vw)] h-full border-l border-sol-border/40 overflow-y-auto bg-sol-bg" data-decision-peek={d.short_id ?? d._id}>
      <ErrorBoundary name="DecisionPeek" level="panel">
        {isFlowDecision(d) ? <LineDecision id={d._id} quiet inline onClose={onClose} /> : <DecisionDocument id={d.short_id ?? d._id} />}
      </ErrorBoundary>
    </div>
  );
}

/** The feeders behind the page: the workspace's decisions and its open flow decisions. */
function useDecisionFeeds(workspace: string | null) {
  useSyncTeamDecisions(workspace);
  useSyncTeamLineDecisions(workspace ? [workspace] : []);
}

export function DecisionsList({ activeId }: { activeId?: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const words = useModeWords();
  const state = useDecisionView();
  const rows = useDecisionRows();
  useDecisionFeeds(rows.workspaceKey);
  const cards = state.view.tab === "mine" && params?.get("mode") === "cards";
  const setCards = useCallback((on: boolean) => {
    const q = new URLSearchParams(params?.toString() ?? "");
    if (on) q.set("mode", "cards"); else q.delete("mode");
    router.replace(`/decisions${q.toString() ? `?${q}` : ""}`);
  }, [params, router]);

  const mineControls: ReactNode = state.view.tab === "mine" ? (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-sol-text-dim px-1 mb-1">View</div>
      <SegmentedToggle fullWidth value={cards ? "cards" : "list"} onChange={(v) => setCards(v === "cards")}
        items={[{ key: "list", label: "List", icon: LayoutList }, { key: "cards", label: "Cards", icon: Rows3 }]} />
    </div>
  ) : undefined;
  const step = state.view.tab === "mine" ? (
    <button type="button" onClick={() => router.push("/decisions?mode=step")} data-decision-step
      className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-sol-border/40 text-xs text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors">
      <StepForward className="w-3 h-3" /><span className="cq-header-collapse">One at a time</span>
    </button>
  ) : undefined;

  return (
    <DecisionList
      title={words.questionsPage}
      state={state}
      rows={rows}
      routeOf={routeOf}
      renderPreview={(d, onClose) => <DecisionPeek d={d} onClose={onClose} />}
      activeItemId={activeId ? rows.mine.find((d) => d.short_id === activeId || d._id === activeId)?._id : undefined}
      savedViews
      headerExtra={step}
      displayExtra={mineControls}
      customContent={cards ? () => <div className="flex-1 overflow-y-auto"><DecisionQueueList /></div> : undefined}
    />
  );
}

export function DecisionsPage({ id }: { id?: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const anchor = params?.get("s") ?? null;
  const exit = useCallback(() => router.push("/decisions"), [router]);
  // The stepper owns its whole canvas: one decision at a time, on the asking session's pane.
  if (!id && (anchor || params?.get("mode") === "step")) {
    return <div className="h-full bg-sol-bg"><DecisionQueue key={anchor ?? "all"} onExit={exit} initialConversationId={anchor} /></div>;
  }
  return (
    <DetailSplitLayout list={<DecisionsList activeId={id} />} closeHref="/decisions">
      {id ? (
        <ErrorBoundary name="Decision" level="panel">
          <DecisionDocument id={id} />
        </ErrorBoundary>
      ) : null}
    </DetailSplitLayout>
  );
}
