"use client";
// A `cast flow` command in a transcript (docs/architecture/flows.md FL6). A
// run draws the run it started, live: which flow, where the change is, and
// the path it took. `show` and `validate` draw the flow itself, a flow the
// session wrote on stdin included; a dry run draws it with what it would run on. Anything else
// (`ls`, `import`, a failed start) keeps the one-line row with its output
// behind a click.
import { Suspense, lazy, useState } from "react";
import { Workflow } from "lucide-react";
import { flowCommandTarget, stripAnsi } from "../../../lib/line/flowCommandOutput";

const FlowRunCard = lazy(() => import("../../line/widgets/FlowFence").then((m) => ({ default: m.FlowRunCard })));
const FlowCard = lazy(() => import("../../line/widgets/FlowFence").then((m) => ({ default: m.FlowCard })));

const Cold = () => <div className="my-2 h-24 max-w-[860px] rounded-xl border border-sol-border/30 bg-sol-bg-alt/40" aria-busy />;

export function CastFlowBlock({ subcommand, args, rawCmd, output, isError }: { subcommand: string; args: string; rawCmd: string; output: string; isError: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const target = flowCommandTarget(subcommand, args, output, isError);
  return (
    <div className="my-0.5" data-cast-flow={subcommand}>
      <div className="flex items-baseline gap-1.5 text-xs cursor-pointer group flex-wrap" onClick={() => setExpanded(!expanded)}>
        <span className="flex items-center gap-1 font-mono flex-shrink-0 text-sol-blue/90">
          <Workflow className="w-3 h-3 self-center" strokeWidth={2.2} />
          <span className="group-hover:underline">flow{subcommand ? ` ${subcommand}` : ""}</span>
        </span>
        {target.flow ? <span className="text-sol-text-muted truncate">{target.flow}{target.dryRun ? " · dry run" : ""}</span> : null}
        {isError ? <span className="text-sol-red">failed</span> : null}
      </div>
      {target.runId ? (
        <Suspense fallback={<Cold />}><FlowRunCard runId={target.runId} /></Suspense>
      ) : target.flow && !isError && (subcommand === "show" || subcommand === "validate" || target.dryRun) ? (
        <Suspense fallback={<Cold />}><FlowCard slug={target.flow} /></Suspense>
      ) : null}
      {/* A dry run started nothing: what it would have run on is its whole message. */}
      {target.dryRun && !expanded ? (
        <pre className="mt-1 max-w-[860px] overflow-x-auto rounded-md bg-sol-bg-alt/50 p-2 text-[11px] text-sol-text-muted whitespace-pre-wrap">{stripAnsi(output).trim()}</pre>
      ) : null}
      {expanded ? (
        <pre className="mt-1 max-w-[860px] overflow-x-auto rounded-md bg-sol-bg-alt/50 p-2 text-[11px] text-sol-text-muted whitespace-pre-wrap">{`$ ${rawCmd}\n${stripAnsi(output)}`}</pre>
      ) : null}
    </div>
  );
}
