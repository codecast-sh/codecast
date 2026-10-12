"use client";
// The `line` fenced block (line-workspace.md LW3): a widget an agent names in
// a small JSON spec, drawn live wherever markdown renders. It reads the
// project's line from the store like the workspace does (useLineWorkspace),
// so it follows the line as it moves, and every step or run in it links into
// the project's workspace. A spec it cannot read stays the code it is; a
// project the viewer cannot read says so instead of drawing an empty frame.
import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useLineProjectId, useLineWorkspace } from "../../../hooks/useLineWorkspace";
import { readLineFence, type LineFenceSpec } from "../../../lib/line/lineFence";
import { lineWorkspaceHref } from "../../../lib/line/lineWorkspaceUrl";
import { lineProjectParam } from "../../../lib/line/lineStations";
import type { LineIssue, LineModel } from "../../../lib/line/lineModel";
import { graphKeyOf, newestRunByTask } from "../../../lib/line/lineGraphs";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useCollectionRows } from "../../../hooks/useCollectionRows";
import { ProblemCard } from "./ProblemCard";
import { CodeBlock } from "../../CodeBlock";
import { BeforeAfterTable } from "./BeforeAfterTable";
import { DecisionCard, DecisionList } from "./DecisionCard";
import { LineGraphWidget } from "./LineGraphWidget";
import { PromptDiff } from "./PromptDiff";
import { PromptView } from "./PromptView";
import { RunPath } from "./RunPath";
import { StepCard } from "./StepCard";
import { KindTag, LineNavProvider, NavLink, useLineFenceScope, type LineNav } from "./parts";
import "../workspace/workspace.css";

function Fallback({ children }: { children: React.ReactNode }) {
  return <div className="lw-widget"><div className="lw-fence-fallback" data-line-fence-fallback>{children}</div></div>;
}

const WIDGET_WORDS: Record<LineFenceSpec["widget"], string> = {
  graph: "the line's graph", step: "a step", prompt: "a step's prompt", diff: "a prompt change", decision: "a decision",
  decisions: "a step's decisions", "before-after": "a before and after comparison", run: "a run", problem: "a problem's history",
};

type CaseRow = { _id: string; short_id?: string | null };
type CaseRun = { task_id?: string | null; created_at: number; workflow_slug?: string; workflow_name?: string };

/** A problem spec's cause (its task id or ref) and the graph its newest run
 *  ran, resolved over rows the caller already holds, so a fence that names a
 *  case and no graph draws the graph that worked it. */
export function resolveCase(spec: LineFenceSpec, tasks: ReadonlyArray<CaseRow>, runs: ReadonlyArray<CaseRun>): { taskId: string | null; graph: string | null } {
  const ref = spec.widget === "problem" ? spec.case : null;
  const taskId = ref ? tasks.find((t) => t._id === ref || t.short_id === ref)?._id ?? null : null;
  if (!taskId || spec.graph) return { taskId, graph: spec.graph ?? null };
  const newest = newestRunByTask(runs.filter((r) => r.task_id === taskId)).get(taskId);
  return { taskId, graph: newest ? graphKeyOf(newest) : null };
}

const shortIdSig = (t: CaseRow) => t.short_id ?? "";
const runSig = (r: CaseRun) => `${r.created_at}`;

/** The issue a problem spec names, by id or ref. */
const issueOf = (model: LineModel, ref: string | null, taskId: string | null): LineIssue | null =>
  model.issues.find((i) => i.id === taskId || i.id === ref || (!!ref && i.ref === ref)) ?? null;

export default function LineFence({ code }: { code: string }) {
  const read = useMemo(() => readLineFence(code), [code]);
  if (!read.ok) return <CodeBlock code={code} language="json" />;
  return <LineFenceSpecView spec={read.spec} />;
}

function LineFenceSpecView({ spec }: { spec: LineFenceSpec }) {
  const projectId = useLineProjectId(spec.project);
  if (!projectId) {
    return <Fallback><b>{WIDGET_WORDS[spec.widget].replace(/^./, (c) => c.toUpperCase())}</b> from the line of project {spec.project}, which is not one you can open here.</Fallback>;
  }
  return <LineFenceIn spec={spec} projectId={projectId} />;
}

/** Inside the project's own workspace, from its model and rows; anywhere else, read live. */
function LineFenceIn({ spec: asked, projectId }: { spec: LineFenceSpec; projectId: string }) {
  const scope = useLineFenceScope();
  const mine = scope && scope.projectId === projectId ? scope : null;
  const { taskId, graph } = useMemo(() => (mine ? resolveCase(asked, mine.rows.tasks, mine.rows.runs) : { taskId: null, graph: asked.graph ?? null }), [mine, asked]);
  if (!mine) return asked.widget === "problem" ? <LineFenceCase spec={asked} projectId={projectId} /> : <LineFenceLive spec={asked} projectId={projectId} taskId={null} />;
  const spec = graph && graph !== asked.graph ? { ...asked, graph } : asked;
  if (spec.graph && spec.graph !== mine.model.graphKey) return <LineFenceLive spec={spec} projectId={projectId} taskId={taskId} />;
  return (
    <div className="lw-widget" data-line-fence={spec.widget}>
      <Widget spec={spec} model={mine.model} nav={mine.nav} now={mine.now} />
    </div>
  );
}

/** A problem fence outside its project's workspace: the cause by ref from the workspace's tasks, its newest run from the runs on it. */
function LineFenceCase({ spec: asked, projectId }: { spec: LineFenceSpec; projectId: string }) {
  const tasks = useWorkspaceCollection<CaseRow>("tasks", shortIdSig);
  const ref = asked.widget === "problem" ? asked.case : null;
  const id = useMemo(() => (ref ? tasks.find((t) => t._id === ref || t.short_id === ref)?._id ?? null : null), [tasks, ref]);
  const where = useCallback((r: CaseRun) => !!id && r.task_id === id, [id]);
  const runs = useCollectionRows<CaseRun>("workflowRuns", { where, sig: runSig });
  const { taskId, graph } = useMemo(() => resolveCase(asked, tasks, runs), [asked, tasks, runs]);
  const spec = graph && graph !== asked.graph ? { ...asked, graph } : asked;
  return <LineFenceLive spec={spec} projectId={projectId} taskId={taskId} />;
}

function LineFenceLive({ spec, projectId, taskId }: { spec: LineFenceSpec; projectId: string; taskId: string | null }) {
  const router = useRouter();
  const { model, project, now } = useLineWorkspace(projectId, spec.graph, taskId);
  const param = project ? lineProjectParam(project) : spec.project;
  const graph = model?.graphKey ?? spec.graph;
  const nav = useMemo<LineNav>(() => {
    const stepHref = (id: string) => lineWorkspaceHref(param, { graph, step: id });
    const runHref = (runId: string, caseId: string | null) => lineWorkspaceHref(param, { graph, run: runId, case: caseId, view: "replay" });
    const caseHref = (caseId: string) => lineWorkspaceHref(param, { graph, case: caseId, view: "timeline" });
    return {
      openStep: (id) => router.push(stepHref(id)),
      openRun: (runId, caseId) => router.push(runHref(runId, caseId)),
      openCase: (caseId) => router.push(caseHref(caseId)),
      stepHref,
      runHref,
      caseHref,
    };
  }, [router, param, graph]);

  if (!model) return <Fallback>Reading the line…</Fallback>;
  return (
    <LineNavProvider nav={nav}>
      <div className="lw-widget" data-line-fence={spec.widget}>
        <Widget spec={spec} model={model} nav={nav} now={now} />
      </div>
    </LineNavProvider>
  );
}

function Widget({ spec, model, nav, now }: { spec: LineFenceSpec; model: LineModel; nav: LineNav; now: number }) {
  const step = spec.step ? model.steps[spec.step] ?? null : null;
  const run = spec.run ? model.runs.find((r) => r.id === spec.run) ?? null : null;
  if (spec.step && !step) return <div className="lw-fence-fallback"><b>{model.title}</b> has no step named {spec.step}.</div>;
  if (spec.run && !run && spec.widget !== "decision") return <div className="lw-fence-fallback">That run is not on {model.title} any more.</div>;

  switch (spec.widget) {
    case "problem": {
      const issue = issueOf(model, spec.case, null);
      if (!issue) return <div className="lw-fence-fallback">{model.title} has no problem {spec.case}.</div>;
      return <ProblemCard model={model} issue={issue} now={now} title={spec.title} exceptRunId={spec.run ?? undefined} />;
    }
    case "graph":
      return <LineGraphWidget model={model} run={run} selectedStep={spec.step} compact />;
    case "step":
      return <StepCard model={model} stepId={step!.id} />;
    case "run":
      return <RunPath run={run!} framed selectedStep={spec.step} />;
    case "prompt":
      if (!step!.prompt) return <div className="lw-fence-fallback">{step!.label} has no text recorded.</div>;
      return (
        <div className="lw-obj" data-line-widget="prompt">
          <div className="lw-obj-head">
            <KindTag kind={step!.kind}>{step!.label}</KindTag>
            {step!.prompt.file && <span className="lw-obj-meta lw-file">{step!.prompt.file}</span>}
            <span className="lw-spacer" />
          </div>
          <div className="lw-obj-body" style={{ maxHeight: 480, overflow: "auto" }}><PromptView prompt={step!.prompt} nodes={model.graph.nodes} layout="flat" /></div>
          <div className="lw-obj-foot"><NavLink className="lw-act" href={nav.stepHref(step!.id)} onOpen={() => nav.openStep(step!.id)}>Open the step</NavLink></div>
        </div>
      );
    case "diff":
      return <PromptDiff label={step!.label} kind={step!.kind} file={step!.prompt?.file} before={spec.before ?? step!.prompt?.text ?? ""} after={spec.after!} versions={spec.title} />;
    case "decision": {
      const d = step!.decisions.find((x) => x.runId === spec.run);
      if (!d) return <div className="lw-fence-fallback">{step!.label} has no decision on that run.</div>;
      return <DecisionCard decision={d} step={step!} open />;
    }
    case "decisions":
      return (
        <div className="lw-obj" data-line-widget="decisions">
          <div className="lw-obj-head">
            <KindTag kind={step!.kind}>{step!.label}</KindTag>
            <span className="lw-obj-title">{spec.title ?? `${step!.decisions.length} ${step!.decisions.length === 1 ? "decision" : "decisions"}`}</span>
          </div>
          <DecisionList step={step!} compact limit={spec.limit ?? 8} outcome={spec.outcome} onOpen={(d) => nav.openRun(d.runId, d.caseId)} />
        </div>
      );
    case "before-after":
      return (
        <BeforeAfterTable
          label={step!.label}
          kind={step!.kind}
          title={spec.title ?? undefined}
          rows={spec.rows!.map((r, i) => ({ id: `${i}:${r.case}`, caseTitle: r.case, caseRef: r.ref, before: { outcome: null, words: r.before }, after: { outcome: null, words: r.after } }))}
        />
      );
  }
}
