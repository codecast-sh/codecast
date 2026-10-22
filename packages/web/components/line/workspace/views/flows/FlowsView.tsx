// The Line app's Flows view (docs/architecture/flows.md FL6): the team's pool
// of flows a change can run through. Lines and segments on the left, each with
// its passing path and how many changes are in it now; the picked flow on the
// right, drawn, with the segments it is made of, the lines it is part of, and
// the changes that ran through it, each opening its run.
import { useMemo } from "react";
import { flowPathWords } from "@codecast/shared/contracts/flowPool";
import { useWorkflowRuns, useWorkflows } from "../../../../../hooks/useSyncWorkflows";
import { appPool, flowBySlug, flowOfRun, type AppFlow } from "../../../../../lib/line/flowPool";
import { flowRunState } from "../../../../../lib/line/flowFence";
import { ageShort } from "../../../../../lib/lineFlow";
import { FlowDiagram } from "../../../widgets/FlowDiagram";
import { FlowRunCard } from "../../../widgets/FlowFence";
import type { LineViewProps } from "../types";
import "./flows.css";

type Run = { _id: string; status: string; current_node_id?: string | null; fail_reason?: string | null; task_short_id?: string | null; workflow_slug?: string; workflow_name?: string; created_at: number; updated_at: number };

const LIVE = new Set(["running", "paused", "pending"]);
const KIND_TITLE = { line: "Lines", segment: "Segments" } as const;

export function FlowsView({ selection, select, workspace }: LineViewProps) {
  const { workflows } = useWorkflows();
  const pool = useMemo(() => appPool(workflows), [workflows]);
  const slugs = useMemo(() => new Set(pool.map((f) => f.slug)), [pool]);
  const where = useMemo(() => (r: Run) => !!flowOfRun(pool, r) && slugs.has(flowOfRun(pool, r)!.slug), [pool, slugs]);
  const runs = useWorkflowRuns(where) as Run[];
  const runsOf = useMemo(() => {
    const m = new Map<string, Run[]>();
    for (const r of runs) {
      const f = flowOfRun(pool, r);
      if (!f) continue;
      m.set(f.slug, [...(m.get(f.slug) ?? []), r]);
    }
    return m;
  }, [runs, pool]);
  const picked = flowBySlug(pool, selection.item) ?? flowBySlug(pool, "change") ?? pool[0];
  const usedBy = pool.filter((f) => f.uses.includes(picked.slug));
  const pickedRuns = (runsOf.get(picked.slug) ?? []).slice().sort((a, b) => b.created_at - a.created_at);
  const openRun = selection.run ? pickedRuns.find((r) => r._id === selection.run) ?? null : null;
  const now = workspace.now;

  return (
    <div className="flv" data-line-flows>
      <nav className="flv-list" aria-label="Flows">
        {(["line", "segment"] as const).map((kind) => (
          <section key={kind}>
            <h2 className="flv-h">{KIND_TITLE[kind]}<span className="lw-num">{pool.filter((f) => f.kind === kind).length}</span></h2>
            <ul>
              {pool.filter((f) => f.kind === kind).map((f) => {
                const all = runsOf.get(f.slug) ?? [];
                const live = all.filter((r) => LIVE.has(r.status)).length;
                return (
                  <li key={f.slug}>
                    <button type="button" className="flv-row" aria-current={f.slug === picked.slug ? "true" : undefined} onClick={() => select({ item: f.slug, run: null })} data-flow-row={f.slug}>
                      <span className="flv-row-name">{f.label}</span>
                      <span className="flv-row-path">{rowPath(f)}</span>
                      <span className="flv-row-n" title={`${all.length} runs, ${live} running now`}>
                        {live ? <b data-live>{live}</b> : null}
                        <span>{all.length || ""}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>

      <article className="flv-main" data-flow={picked.slug}>
        <header className="flv-head">
          <span className="lw-flow-kind" data-kind={picked.kind}>{picked.kind === "line" ? "Line" : "Segment"}</span>
          <h1>{picked.label}</h1>
          <span className="flv-where">{picked.where === "shipped" ? "ships with codecast" : "published by the team"}</span>
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
                      <span className="flv-run-task">{r.task_short_id ?? "no task"}</span>
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

/** A flow's path in its row, unless it only repeats the flow's own name: then what it is for. */
function rowPath(f: AppFlow): string {
  const { path } = flowPathWords(f);
  return path && path !== f.label ? path : f.description ?? path;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flv-fact"><span className="flv-fact-k">{label}</span><span className="flv-fact-v">{children}</span></div>;
}

function FlowChip({ flow, slug, onPick }: { flow: AppFlow | null; slug: string; onPick: (slug: string) => void }) {
  return <button type="button" className="flv-chip flv-chip-btn" onClick={() => onPick(slug)}>{flow?.label ?? slug}</button>;
}
