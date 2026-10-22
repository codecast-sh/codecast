"use client";
// The `flow` fenced block (docs/architecture/flows.md FL6): a flow of the pool,
// or one run of a flow, drawn live wherever markdown renders. An agent writes
//
//   ```flow
//   {"flow":"change"}
//   ```
//
// or `{"run":"<run id>"}` to show where a change is in its flow. The card of a
// `cast flow run` in a transcript is the same widget on the run it started.
import { memo, useMemo } from "react";
import { flowPathWords } from "@codecast/shared/contracts/flowPool";
import { useWorkflowRun, useWorkflows } from "../../../hooks/useSyncWorkflows";
import { appPool, flowBySlug, flowOfRun, type AppFlow } from "../../../lib/line/flowPool";
import { flowRunState, readFlowFence } from "../../../lib/line/flowFence";
import { CodeBlock } from "../../CodeBlock";
import { FlowGraph } from "./FlowGraph";
import "../workspace/workspace.css";

export default function FlowFence({ code }: { code: string }) {
  const read = useMemo(() => readFlowFence(code), [code]);
  if (!read.ok) return <CodeBlock code={code} language="json" />;
  return read.spec.run ? <FlowRunCard runId={read.spec.run} title={read.spec.title} /> : <FlowCard slug={read.spec.flow!} title={read.spec.title} />;
}

function usePool(): AppFlow[] {
  const { workflows } = useWorkflows();
  return useMemo(() => appPool(workflows), [workflows]);
}

const KIND_WORD = { line: "Line", segment: "Segment" } as const;

function FlowHead({ flow, title, children }: { flow: AppFlow; title?: string | null; children?: React.ReactNode }) {
  const { path, side } = flowPathWords(flow);
  return (
    <div className="lw-flow-head">
      <span className="lw-flow-kind" data-kind={flow.kind}>{KIND_WORD[flow.kind]}</span>
      <b className="lw-flow-name">{title ?? flow.label}</b>
      <span className="lw-flow-path" title={flow.description ?? undefined}>{path}{side ? <em> +{side}</em> : null}</span>
      {children}
    </div>
  );
}

/** One flow of the pool, folded. */
export const FlowCard = memo(function FlowCard({ slug, title }: { slug: string; title?: string | null }) {
  const pool = usePool();
  const flow = flowBySlug(pool, slug);
  if (!flow) return <div className="lw-widget"><div className="lw-fence-fallback" data-flow-missing={slug}>No flow <b>{slug}</b> in the pool.</div></div>;
  return (
    <div className="lw-widget lw-flow" data-flow-card={flow.slug}>
      <FlowHead flow={flow} title={title} />
      <FlowGraph flow={flow} />
    </div>
  );
});

/** One run of a flow: where the change is, and the path it took. */
export const FlowRunCard = memo(function FlowRunCard({ runId, title }: { runId: string; title?: string | null }) {
  const pool = usePool();
  const run = useWorkflowRun(runId);
  const flow = run ? flowOfRun(pool, run) : null;
  if (run === undefined) return <div className="lw-widget lw-flow lw-flow-cold" aria-busy data-flow-run={runId} />;
  if (!run || !flow) return <div className="lw-widget"><div className="lw-fence-fallback" data-flow-run-missing={runId}>A flow run you cannot open here.</div></div>;
  const state = flowRunState(run, flow);
  return (
    <div className="lw-widget lw-flow" data-flow-run={runId} data-flow-state={state.tone}>
      <FlowHead flow={flow} title={title}>
        <span className="lw-flow-state" data-tone={state.tone}>{state.words}</span>
        {run.task_short_id ? <a className="lw-flow-task" href={`/tasks/${run.task_short_id}`}>{run.task_short_id}</a> : null}
      </FlowHead>
      <FlowGraph flow={flow} run={run} />
      {state.why ? <div className="lw-flow-why">{state.why}</div> : null}
    </div>
  );
});

