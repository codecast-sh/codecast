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
import { useWorkflowRun } from "../../../hooks/useSyncWorkflows";
import { useNamedFlow, useRunFlow, type FlowLibraryState } from "../../../hooks/useFlowObject";
import { type AppFlow } from "../../../lib/line/flowPool";
import { flowRunState, readFlowFence } from "../../../lib/line/flowFence";
import { CodeBlock } from "../../CodeBlock";
import { lineWorkspaceHref } from "../../../lib/line/lineWorkspaceUrl";
import { useInboxStore } from "../../../store/inboxStore";
import { FlowDiagram } from "./FlowDiagram";
import "../workspace/workspace.css";

export default function FlowFence({ code }: { code: string }) {
  const read = useMemo(() => readFlowFence(code), [code]);
  if (!read.ok) return <CodeBlock code={code} language="json" />;
  return read.spec.run ? <FlowRunCard runId={read.spec.run} title={read.spec.title} /> : <FlowCard slug={read.spec.flow!} title={read.spec.title} />;
}

const KIND_WORD = { line: "Flow", segment: "Segment" } as const;

function FlowHead({ flow, title, library, children }: { flow: AppFlow; title?: string | null; library: FlowLibraryState; children?: React.ReactNode }) {
  const inLibrary = flow.where === "shipped" || flow.where === "team";
  return (
    <div className="lw-flow-head">
      <span className="lw-flow-kind" data-kind={flow.kind}>{KIND_WORD[flow.kind]}</span>
      {inLibrary
        ? <a className="lw-flow-name" href={lineWorkspaceHref(null, { view: "flows", item: flow.slug })} data-flow-open={flow.slug}>{title ?? flow.label}</a>
        : <span className="lw-flow-name">{title ?? flow.label}</span>}
      {flow.base ? <a className="lw-flow-base" href={lineWorkspaceHref(null, { view: "flows", item: flow.base })} data-flow-base={flow.base}>on {flow.base}</a> : null}
      <span className="lw-flow-path">{flow.base ? null : flow.description}</span>
      {children}
      <LibraryAction library={library} />
    </div>
  );
}

/** Save into the team's library (flowLibrary.save through the store), or where the library already holds it. */
function LibraryAction({ library }: { library: FlowLibraryState }) {
  if (!library || library.kind === "library") return null;
  if (library.kind === "saved") {
    return <a className="lw-flow-saved" href={lineWorkspaceHref(null, { view: "flows", item: library.slug })} data-flow-saved={library.slug}>Saved · {library.slug} v{library.version}</a>;
  }
  return (
    <button type="button" className="lw-flow-save" data-flow-save={library.id}
      onClick={() => useInboxStore.getState().saveSessionFlow(library.id, library.variantOf ? { variant_of: library.variantOf } : undefined)}>
      Save to library
    </button>
  );
}

/** One flow, by name: the library's, or one this session defined. */
export const FlowCard = memo(function FlowCard({ slug, title }: { slug: string; title?: string | null }) {
  const { flow, library } = useNamedFlow(slug);
  if (flow === undefined) return <div className="lw-widget lw-flow lw-flow-cold" aria-busy data-flow-card={slug} />;
  if (!flow) return <div className="lw-widget"><div className="lw-fence-fallback" data-flow-missing={slug}>No flow <b>{slug}</b> in the library.</div></div>;
  return (
    <div className="lw-widget lw-flow" data-flow-card={flow.slug}>
      <FlowHead flow={flow} title={title} library={library} />
      <FlowDiagram flow={flow} />
    </div>
  );
});

/** One run of a flow: the graph it ran, where the change is, the path it took, and how it ended. */
export const FlowRunCard = memo(function FlowRunCard({ runId, title }: { runId: string; title?: string | null }) {
  const run = useWorkflowRun(runId);
  const { flow, library } = useRunFlow(run);
  if (run === undefined || (run && flow === undefined)) return <div className="lw-widget lw-flow lw-flow-cold" aria-busy data-flow-run={runId} />;
  if (!run || !flow) return <div className="lw-widget"><div className="lw-fence-fallback" data-flow-run-missing={runId}>A flow run you cannot open here.</div></div>;
  const state = flowRunState(run, flow);
  return (
    <div className="lw-widget lw-flow" data-flow-run={runId} data-flow-state={state.tone}>
      <FlowHead flow={flow} title={title} library={library}>
        <span className="lw-flow-state" data-tone={state.tone}>{state.words}</span>
        {run.task_short_id ? <a className="lw-flow-task" href={`/tasks/${run.task_short_id}`}>{run.task_short_id}</a> : null}
        {state.tone === "running" || state.tone === "waiting" ? (
          <button type="button" className="lw-flow-stop" onClick={() => void useInboxStore.getState().stopLineRun(runId)} data-flow-stop={runId}>Stop</button>
        ) : null}
      </FlowHead>
      <FlowDiagram flow={flow} run={run} />
      {state.why ? <div className="lw-flow-why">{state.why}</div> : null}
    </div>
  );
});
