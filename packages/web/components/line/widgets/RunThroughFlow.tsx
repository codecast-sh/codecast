"use client";
// "Run through" on a session (docs/architecture/flows.md FL4, FL6): the pool
// of flows, each drawn on pick, and the press that asks this session to send
// its own change through the one picked. The session does the run (it knows
// what its change is and names its task); the review says what starts first,
// since agent stations start sessions of their own.
import { useMemo, useState } from "react";
import { useWorkspaceFeature } from "../../../lib/teamFeatures";
import { Route } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { usePoolFlowRows } from "../../../hooks/useSyncWorkflows";
import { appPool, flowRowPath, linesFirst, type AppFlow } from "../../../lib/line/flowPool";
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
          <button type="button" className={`cq-sq6 ${HEADER_CHIP}`} title="Run this session's change through a flow" data-run-through>
            <Route className="w-3 h-3" />
            <span className="cq-sq2">Run through</span>
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
  const pool = useMemo(() => linesFirst(appPool(workflows).filter((f) => f.takes.includes("branch"))), [workflows]);
  const [picked, setPicked] = useState<string>("change");
  const flow = pool.find((f) => f.slug === picked) ?? pool[0];
  if (!flow) return null;
  return (
    <div className="lw-widget rtf">
      <ul className="rtf-list" role="listbox" aria-label="Flows">
        {pool.map((f) => (
          <li key={f.slug}>
            <button type="button" role="option" aria-selected={f.slug === flow.slug} className="rtf-row" onClick={() => setPicked(f.slug)} onDoubleClick={() => onRun(f)} data-run-through-flow={f.slug}>
              <span className="lw-flow-kind" data-kind={f.kind}>{f.kind === "line" ? "Flow" : "Segment"}</span>
              <b>{f.label}</b>
              <span className="rtf-path">{flowRowPath(f)}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="rtf-preview">
        <FlowDiagram flow={flow} compact />
      </div>
      <footer className="rtf-foot">
        <span className="rtf-desc">{flow.description}</span>
        <button type="button" className="rtf-go" onClick={() => onRun(flow)} data-run-through-go={flow.slug}>Run through {flow.label}</button>
      </footer>
    </div>
  );
}
