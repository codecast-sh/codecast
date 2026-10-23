// The flows app's landing view (docs/architecture/flows.md FL6). On /flows: the
// team's flows, one row per owner role, each with its switch, intake, decider,
// steps and what it holds now; under them the flows run by hand and the
// segments flows are built from, each opening its detail. On a flow's own page
// (/flows/<owner>): that flow, drawn, with its facts and its counts.
import { useContext, useMemo } from "react";
import Link from "next/link";
import { usePoolFlowRows, useWorkflowRuns } from "../../../../../hooks/useSyncWorkflows";
import { useOwnedFlows } from "../../../../../hooks/useOwnedFlows";
import { appPool, flowBySlug, flowOfRun, flowRowPath, type AppFlow } from "../../../../../lib/line/flowPool";
import { flowRunState } from "../../../../../lib/line/flowFence";
import { flowNeeds, flowOf, type OwnedFlow } from "../../../../../lib/line/ownedFlows";
import { flowHref, lineWorkspaceHref } from "../../../../../lib/line/lineWorkspaceUrl";
import { FlowPageContext } from "../../../../../lib/line/flowPageContext";
import { lineSettingsHref } from "../../../../../lib/lineSettings";
import { ageShort } from "../../../../../lib/lineFlow";
import { FlowDiagram } from "../../../widgets/FlowDiagram";
import { FlowRunCard } from "../../../widgets/FlowFence";
import type { LineViewProps } from "../types";
import "./flows.css";

type Run = { _id: string; status: string; run_kind?: string; current_node_id?: string | null; fail_reason?: string | null; task_short_id?: string | null; workflow_slug?: string; workflow_name?: string; created_at: number; updated_at: number };

const LIVE = new Set(["running", "paused", "pending"]);
const KIND_TITLE = { line: "Run by hand", segment: "Segments" } as const;


export function FlowsView(props: LineViewProps) {
  const owner = useContext(FlowPageContext);
  if (owner) return <FlowOverview {...props} owner={owner} />;
  return props.selection.item ? <PoolFlow {...props} /> : <FlowsHome {...props} />;
}

/** The pool a workspace reads, and its runs by flow. */
function usePool(space: string | null | undefined) {
  const workflows = usePoolFlowRows(space);
  const pool = useMemo(() => appPool(workflows), [workflows]);
  const where = useMemo(() => (r: Run) => !!flowOfRun(pool, r), [pool]);
  const runs = useWorkflowRuns(where) as Run[];
  const runsOf = useMemo(() => {
    const m = new Map<string, Run[]>();
    for (const r of runs) {
      const f = flowOfRun(pool, r);
      if (f) m.set(f.slug, [...(m.get(f.slug) ?? []), r]);
    }
    return m;
  }, [runs, pool]);
  return { pool, runsOf };
}

/** What a flow holds now: decisions waiting on a person, problems ready to start, and problems being built. */
function useFlowCounts(workspace: LineViewProps["workspace"], flows: ReadonlyArray<OwnedFlow>) {
  return useMemo(() => {
    const needs = workspace.needs.filter((n) => n.counted);
    const rollup = new Map(workspace.allRollups.map((r) => [r.key, r]));
    const sum = (f: OwnedFlow, k: "ready" | "build") => f.projects.reduce((n, p) => n + (rollup.get(p.id)?.[k] ?? 0), 0);
    return new Map(flows.map((f) => [f.owner.handle, { decisions: flowNeeds(needs, f).length, queued: sum(f, "ready"), running: sum(f, "build") }]));
  }, [workspace.needs, workspace.allRollups, flows]);
}

function FlowsHome({ workspace, href, select, space }: LineViewProps) {
  const flows = useOwnedFlows(workspace);
  const counts = useFlowCounts(workspace, flows);
  const { pool, runsOf } = usePool(space);
  const starts = lineSettingsHref({ section: "starts" });
  return (
    <div className="flh" data-flows-home>
      <section>
        <h2 className="flv-h">Flows<span className="lw-num">{flows.length}</span></h2>
        {flows.length === 0 ? <p className="flv-none">No role owns a flow here yet</p> : (
          <table className="flh-table" data-flows-owned>
            <thead>
              <tr>
                <th>Flow</th>
                <th>Starts</th>
                <th>Takes from</th>
                <th>Decides</th>
                <th>Steps</th>
                <th data-num="">Decisions</th>
                <th data-num="">Queued</th>
                <th data-num="">Running</th>
              </tr>
            </thead>
            <tbody>
              {flows.map((f) => {
                const c = counts.get(f.owner.handle);
                return (
                  <tr key={f.owner._id} data-flow-owned={f.owner.handle} data-on={f.on ? "" : undefined}>
                    <td className="flh-name"><Link href={flowHref(f.owner.handle)}><b>{f.owner.name}</b><span>@{f.owner.handle}</span></Link></td>
                    <td><Link href={starts} className="flh-on" data-on={f.on ? "" : undefined}>{f.on ? "On" : "Off"}</Link></td>
                    <td className="flh-dim">{f.projects.map((p) => p.title).join(" · ")}</td>
                    <td className="flh-dim">{f.deciderId ? workspace.names.get(f.deciderId) ?? "A person" : "Nobody"}</td>
                    <td className="flh-dim">{flowBySlug(pool, f.steps)?.label ?? f.steps}</td>
                    <td data-num="">{c?.decisions ? <Link href={href({ view: "foryou", flow: f.owner.handle })} className="flh-count" data-tone="ask" data-flow-decisions={f.owner.handle}>{c.decisions}</Link> : <span className="flh-zero">0</span>}</td>
                    <td data-num="">{c?.queued ? <Link href={flowHref(f.owner.handle, { view: "problems", status: "notstarted" })} className="flh-count">{c.queued}</Link> : <span className="flh-zero">0</span>}</td>
                    <td data-num="">{c?.running ? <Link href={flowHref(f.owner.handle, { view: "problems", status: "running" })} className="flh-count">{c.running}</Link> : <span className="flh-zero">0</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
      <div className="flh-pool">
        {(["line", "segment"] as const).map((kind) => (
          <section key={kind}>
            <h2 className="flv-h">{KIND_TITLE[kind]}<span className="lw-num">{pool.filter((f) => f.kind === kind).length}</span></h2>
            <PoolRows flows={pool.filter((f) => f.kind === kind)} runsOf={runsOf} picked={null} onPick={(slug) => select({ item: slug, run: null })} />
          </section>
        ))}
      </div>
    </div>
  );
}

function PoolRows({ flows, runsOf, picked, onPick }: { flows: AppFlow[]; runsOf: Map<string, Run[]>; picked: string | null; onPick: (slug: string) => void }) {
  return (
    <ul>
      {flows.map((f) => {
        const all = runsOf.get(f.slug) ?? [];
        const live = all.filter((r) => LIVE.has(r.status)).length;
        return (
          <li key={f.slug}>
            <button type="button" className="flv-row" aria-current={f.slug === picked ? "true" : undefined} onClick={() => onPick(f.slug)} data-flow-row={f.slug}>
              <span className="flv-row-name">{f.label}</span>
              {flowRowPath(f) ? <span className="flv-row-path">{flowRowPath(f)}</span> : null}
              <span className="flv-row-n">
                {live ? <b data-live>{live} running</b> : null}
                {all.length ? <span>{all.length} {all.length === 1 ? "run" : "runs"}</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One flow of the pool: drawn, with the segments it is made of, the flows it is part of, and the changes that ran through it. */
function PoolFlow({ selection, select, workspace, space }: LineViewProps) {
  const { pool, runsOf } = usePool(space);
  const picked = flowBySlug(pool, selection.item) ?? flowBySlug(pool, "change") ?? pool[0];
  const usedBy = pool.filter((f) => f.uses.includes(picked.slug));
  const pickedRuns = (runsOf.get(picked.slug) ?? []).slice().sort((a, b) => b.created_at - a.created_at);
  const openRun = selection.run ? pickedRuns.find((r) => r._id === selection.run) ?? null : null;
  const now = workspace.now;

  return (
    <div className="flv" data-line-flows>
      <nav className="flv-list" aria-label="Flows">
        <button type="button" className="flv-back" onClick={() => select({ item: null, run: null })} data-flows-back>All flows</button>
        {(["line", "segment"] as const).map((kind) => (
          <section key={kind}>
            <h2 className="flv-h">{KIND_TITLE[kind]}<span className="lw-num">{pool.filter((f) => f.kind === kind).length}</span></h2>
            <PoolRows flows={pool.filter((f) => f.kind === kind)} runsOf={runsOf} picked={picked.slug} onPick={(slug) => select({ item: slug, run: null })} />
          </section>
        ))}
      </nav>

      <article className="flv-main" data-flow={picked.slug}>
        <header className="flv-head">
          <span className="lw-flow-kind" data-kind={picked.kind}>{picked.kind === "line" ? "Flow" : "Segment"}</span>
          <h1>{picked.label}</h1>
          <span className="flv-where">{picked.where === "shipped" ? "ships with codecast" : "published by the team"}</span>
          {pickedRuns.length > 0 && (
            <button type="button" className="flv-steps" onClick={() => select({ view: "line", graph: picked.slug })} title="Each step's prompt, its decisions on past runs, and how often it sent work each way" data-flow-steps={picked.slug}>Steps</button>
          )}
        </header>
        {picked.description ? <p className="flv-desc">{picked.description}</p> : null}
        <div className="lw-flow flv-diagram"><FlowDiagram flow={picked} /></div>

        <div className="flv-facts">
          <Fact label="Takes">{picked.takes.map((t) => <span key={t} className="flv-chip">{t === "branch" ? "a branch or a session's edits" : t === "task" ? "a task" : t}</span>)}</Fact>
          {picked.uses.length ? <Fact label="Made of">{picked.uses.map((u) => <FlowChip key={u} flow={flowBySlug(pool, u)} slug={u} onPick={(s) => select({ item: s, run: null })} />)}</Fact> : null}
          {usedBy.length ? <Fact label="Part of">{usedBy.map((f) => <FlowChip key={f.slug} flow={f} slug={f.slug} onPick={(s) => select({ item: s, run: null })} />)}</Fact> : null}
        </div>

        <section className="flv-runs">
          <h2 className="flv-h">Changes run through it<span className="lw-num">{pickedRuns.length}</span></h2>
          {pickedRuns.length === 0 ? <p className="flv-none">None yet</p> : (
            <ul>
              {pickedRuns.slice(0, 30).map((r) => {
                const st = flowRunState(r, picked);
                return (
                  <li key={r._id}>
                    <button type="button" className="flv-run" aria-current={openRun?._id === r._id ? "true" : undefined} onClick={() => select({ run: openRun?._id === r._id ? null : r._id })} data-flow-run-row={r._id}>
                      <span className="lw-flow-state" data-tone={st.tone}>{st.words}</span>
                      <span className="flv-run-task">{r.task_short_id ?? (r.run_kind === "workflow" ? "in a session" : "no task")}</span>
                      <span className="flv-run-why">{st.why ?? ""}</span>
                      <span className="flv-run-age">{ageShort(now - r.created_at)}</span>
                    </button>
                    {openRun?._id === r._id ? <FlowRunCard runId={r._id} /> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </article>
    </div>
  );
}

/** One owned flow on its own page: its steps drawn, its facts, and what it holds now, each opening where it is acted on. */
function FlowOverview({ owner, workspace, select, href, space }: LineViewProps & { owner: string }) {
  const flows = useOwnedFlows(workspace);
  const flow = flowOf(flows, owner);
  const counts = useFlowCounts(workspace, flow ? [flow] : []).get(owner);
  const { pool } = usePool(space);
  if (!flow) return <p className="flv-none" data-flow-missing={owner}>{flows.length ? `No flow is owned by @${owner}` : "Loading the flow"}</p>;
  const steps = flowBySlug(pool, flow.steps);
  return (
    <article className="flv-main flo" data-flow-overview={owner}>
      <div className="flo-counts">
        <Count n={counts?.decisions ?? 0} label="decisions" tone="ask" to={counts?.decisions ? lineWorkspaceHref(null, { view: "foryou", flow: owner }) : null} />
        <Count n={counts?.queued ?? 0} label="queued" to={counts?.queued ? href({ view: "problems", status: "notstarted" }) : null} />
        <Count n={counts?.running ?? 0} label="running" to={counts?.running ? href({ view: "problems", status: "running" }) : null} />
      </div>
      <div className="flv-facts">
        <Fact label="Owner"><Link className="flv-chip flv-chip-btn" href={`/org/${flow.owner.short_id}`}>@{flow.owner.handle}</Link></Fact>
        <Fact label="Starts"><Link className="flh-on" data-on={flow.on ? "" : undefined} href={lineSettingsHref({ section: "starts" })}>{flow.on ? "On" : "Off"}</Link></Fact>
        <Fact label="Takes from">{flow.projects.map((p) => <button key={p.id} type="button" className="flv-chip flv-chip-btn" onClick={() => select({ view: "problems", project: p.id })}>{p.title}</button>)}</Fact>
        <Fact label="Decides"><span className="flv-chip">{flow.deciderId ? workspace.names.get(flow.deciderId) ?? "A person" : "Nobody"}</span></Fact>
        <Fact label="Merge"><span className="flv-chip">{flow.merge ? "On" : "Off"}</span></Fact>
        {flow.reviewAgent ? <Fact label="Review on"><span className="flv-chip">{flow.reviewAgent}</span></Fact> : null}
      </div>
      <header className="flv-head">
        <h2 className="flv-h">Steps</h2>
        <span className="flv-where">{steps?.label ?? flow.steps}</span>
        <button type="button" className="flv-steps" onClick={() => select({ view: "line", graph: flow.steps })} data-flow-steps={flow.steps}>Open steps</button>
      </header>
      {steps ? <div className="lw-flow flv-diagram"><FlowDiagram flow={steps} /></div> : null}
    </article>
  );
}

function Count({ n, label, tone, to }: { n: number; label: string; tone?: "ask"; to: string | null }) {
  const body = <><b className="lw-num">{n}</b><span>{label}</span></>;
  return to ? <Link href={to} className="flo-count" data-tone={n > 0 ? tone : undefined}>{body}</Link> : <span className="flo-count" data-quiet="">{body}</span>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flv-fact"><span className="flv-fact-k">{label}</span><span className="flv-fact-v">{children}</span></div>;
}

function FlowChip({ flow, slug, onPick }: { flow: AppFlow | null; slug: string; onPick: (slug: string) => void }) {
  return <button type="button" className="flv-chip flv-chip-btn" onClick={() => onPick(slug)}>{flow?.label ?? slug}</button>;
}
