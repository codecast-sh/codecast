"use client";
// "Flows" on a session (docs/architecture/flows.md FL4, FL6): the team's library
// of flows a change can go through, the team's default first and picked, each
// named with what it does and drawn on pick, and the press that asks this
// session to send its own change through the one picked. The session does the run (it knows
// what its change is and names its task); the review says what starts first,
// since agent stations start sessions of their own.
import { useMemo, useState } from "react";
import { useWorkspaceFeature } from "../../../lib/teamFeatures";
import { Route } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { usePoolFlowRows, useTeamDefaultFlowSlug } from "../../../hooks/useSyncWorkflows";
import { appPool, defaultFlowOf, linesFirst, takesSessionChange, type AppFlow } from "../../../lib/line/flowPool";
import { flowAsks, flowDiagram } from "../../../lib/line/flowDiagram";
import { flowRunLedger } from "../../consequential/ledgers";
import { runThroughMessage } from "../../../lib/line/flowMessages";
import { SwitchReview } from "../../consequential/ConsequentialSwitch";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { FlowDiagram } from "./FlowDiagram";
import { HEADER_CHIP } from "../../../lib/headerChip";
import "../workspace/workspace.css";

/** A command step that only looks (the project's check, a proof going red or green, the evals), not one that acts. */
const CHECKS = /(^|__)(verify|check|red|green|eval)$/;

/** Every step a run of the flow visits on its passing path, segments opened up, as the review counts them. */
function passingSteps(flow: AppFlow) {
  return flowDiagram(flow).steps.flatMap((s) => (s.inner.length ? s.inner : [s])).map((s) => ({ label: s.label, kind: s.kind === "script" && !CHECKS.test(s.id) ? "auto" : s.kind }));
}

/** Shown only where the workspace has Flows on: off, the button is gone with the rest of the feature. */
export function RunThroughFlow(props: { conversationId: string; sessionTitle: string }) {
  return useWorkspaceFeature("line") ? <RunThroughFlowButton {...props} /> : null;
}

function RunThroughFlowButton({ conversationId, sessionTitle }: { conversationId: string; sessionTitle: string }) {
  const [open, setOpen] = useState(false);
  // The flow under review: held here, so the review outlives the popover that picked it.
  const [reviewing, setReviewing] = useState<AppFlow | null>(null);
  const send = (flow: AppFlow) => {
    setReviewing(null);
    useInboxStore.getState().sendMessage(conversationId, runThroughMessage(flow));
  };
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type="button" className={`cq-sq6 ${HEADER_CHIP}`} title="Check, review and ship this session's change through a flow" data-run-through>
            <Route className="w-3 h-3" />
            <span className="cq-sq2">Flows</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[640px] max-w-[calc(100vw-2rem)] p-0 border-sol-border bg-sol-bg" data-run-through-pool>
          {/* Mounted only while open: the pool's feed is read when someone looks, never by every header. */}
          <PoolPicker onRun={(flow) => { setOpen(false); setReviewing(flow); }} />
        </PopoverContent>
      </Popover>
      {reviewing ? <SwitchReview ledger={ledgerFor(reviewing, sessionTitle)} onClose={() => setReviewing(null)} onConfirm={() => send(reviewing)} /> : null}
    </>
  );
}

function ledgerFor(flow: AppFlow, session: string) {
  const d = flowDiagram(flow);
  const stops = d.steps.flatMap((s) => [...s.side, ...s.inner.flatMap((i) => i.side)]).filter((r) => r.tone === "stop").map((r) => r.outcome);
  return flowRunLedger({ flow: flow.label, session, stations: passingSteps(flow), asks: flowAsks(flow), ends: [...(d.end ? [d.end] : []), ...stops] });
}

function PoolPicker({ onRun }: { onRun: (flow: AppFlow) => void }) {
  const workflows = usePoolFlowRows();
  const teamSlug = useTeamDefaultFlowSlug();
  const { pool, fallback } = useMemo(() => {
    const all = linesFirst(appPool(workflows).filter(takesSessionChange));
    const d = defaultFlowOf(all, teamSlug);
    return { pool: d ? [d, ...all.filter((f) => f !== d)] : all, fallback: d };
  }, [workflows, teamSlug]);
  const [picked, setPicked] = useState<string | null>(null);
  const flow = pool.find((f) => f.slug === picked) ?? fallback ?? pool[0];
  if (!flow) return null;
  return (
    <div className="lw-widget rtf">
      <ul className="rtf-list" role="listbox" aria-label="Flows">
        {pool.map((f) => (
          <li key={f.slug}>
            <button type="button" role="option" aria-selected={f.slug === flow.slug} className="rtf-row" onClick={() => setPicked(f.slug)} onDoubleClick={() => onRun(f)} data-run-through-flow={f.slug}>
              <b>{f.label}</b>
              {f === fallback ? <span className="rtf-default" data-run-through-default="">Default</span> : <span className="lw-flow-kind" data-kind={f.kind}>{f.kind === "line" ? "Flow" : "Segment"}</span>}
              {f.description ? <span className="rtf-desc">{f.description}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      <div className="rtf-preview">
        <FlowDiagram flow={flow} compact />
      </div>
      <footer className="rtf-foot">
        <button type="button" className="rtf-go" onClick={() => onRun(flow)} data-run-through-go={flow.slug}>Run through {flow.label}</button>
      </footer>
    </div>
  );
}
