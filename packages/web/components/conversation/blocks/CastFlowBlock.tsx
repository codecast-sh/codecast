"use client";
// A `cast flow` command in a transcript (docs/architecture/flows.md FL6). A
// run draws the run it started, live: which flow, where the change is, and
// the path it took. `show` and `validate` draw the flow itself, a flow the
// session wrote on stdin included; a dry run draws it with what it would run on. Anything else
// (`ls`, `import`, a failed start) keeps the one-line row with its output
// behind a click.
import { Suspense, useState } from "react";
import { Workflow } from "lucide-react";
import { flowCommandTarget, pipelineCommandRepo, stripAnsi } from "../../../lib/line/flowCommandOutput";
import { editFromOutput } from "../../../lib/line/flowEditFence";
import { useIsModernStyle } from "../../../hooks/useVisualStyle";
import { pressable } from "../../ops/parts";
import { lazyNamed } from "../../../lib/lazyNamed";

const FlowRunCard = lazyNamed(() => import("../../line/widgets/FlowFence"), "FlowRunCard");
const FlowCard = lazyNamed(() => import("../../line/widgets/FlowFence"), "FlowCard");
const FlowEditCard = lazyNamed(() => import("../../line/widgets/FlowEditCard"), "FlowEditCard");
const FlowPipelineCard = lazyNamed(() => import("../../line/widgets/FlowPipelineCard"), "FlowPipelineCard");

const Cold = () => <div className="my-2 h-24 max-w-[860px] rounded-xl border border-sol-border/30 bg-sol-bg-alt/40" aria-busy />;

export function CastFlowBlock({ subcommand, args, rawCmd, output, isError, conversationId = null, toolId = null }: { subcommand: string; args: string; rawCmd: string; output: string; isError: boolean; conversationId?: string | null; toolId?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const target = flowCommandTarget(subcommand, args, output, isError);
  // `edit` draws the edit it made (pipeline.md PL5), `pipeline` the repository's pipeline (PL6); a failed one keeps its row.
  const made = subcommand === "edit" && !isError ? editFromOutput(output) : null;
  const repo = subcommand === "pipeline" ? pipelineCommandRepo(output, isError) : null;
  // Modern: the row anatomy (its parts named below), a real disclosure with its chevron.
  const modern = useIsModernStyle();
  const head = modern ? { ...pressable(() => setExpanded(!expanded)), "aria-expanded": expanded, "data-cc-row-head": "" } : { onClick: () => setExpanded(!expanded) };
  return (
    <div className="my-0.5" data-cast-flow={subcommand} data-cc-row={modern ? "flow" : undefined} data-cc-row-tone={modern && isError ? "error" : undefined}>
      <div className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap" {...head}>
        <span data-cc-row-lead={modern ? "" : undefined} className="flex items-center gap-1 font-mono flex-shrink-0 text-sol-blue/90">
          <Workflow className="w-3 h-3 self-center" strokeWidth={2.2} />
          <span data-cc-row-verb={modern ? "" : undefined} className="group-hover:underline">flow{subcommand ? ` ${subcommand}` : ""}</span>
        </span>
        {made || repo ? null : target.flow ? <span data-cc-row-object={modern ? "" : undefined} className="text-sol-text-muted truncate">{target.flow}{target.dryRun ? " · dry run" : ""}</span> : null}
        {isError ? <span data-cc-row-meta={modern ? "" : undefined} className="text-sol-red">failed</span> : null}
      </div>
      {made ? (
        <Suspense fallback={<Cold />}><FlowEditCard edit={made.edit} diff={made.diff} conversationId={conversationId} madeBy={toolId} dryRun={target.dryRun} /></Suspense>
      ) : repo ? (
        <Suspense fallback={<Cold />}><FlowPipelineCard repository={repo} /></Suspense>
      ) : target.runId ? (
        <Suspense fallback={<Cold />}><FlowRunCard runId={target.runId} /></Suspense>
      ) : target.flow && !isError && (subcommand === "show" || subcommand === "validate" || target.dryRun) ? (
        <Suspense fallback={<Cold />}><FlowCard slug={target.flow} /></Suspense>
      ) : null}
      {/* A dry run started nothing: what it would have run on is its whole message. */}
      {target.dryRun && !expanded && !made ? (
        <pre className="mt-1 max-w-[860px] overflow-x-auto rounded-md bg-sol-bg-alt/50 p-2 text-meta text-sol-text-muted whitespace-pre-wrap">{stripAnsi(output).trim()}</pre>
      ) : null}
      {expanded ? (
        <pre data-cc-row-detail={modern ? "" : undefined} className="mt-1 max-w-[860px] overflow-x-auto rounded-md bg-sol-bg-alt/50 p-2 text-meta text-sol-text-muted whitespace-pre-wrap">{`$ ${rawCmd}\n${stripAnsi(output)}`}</pre>
      ) : null}
    </div>
  );
}
