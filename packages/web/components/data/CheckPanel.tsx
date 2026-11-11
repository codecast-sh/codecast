// The check behind a number: the block's source, the exact query that ran,
// how the number was computed and the rows it was computed from (the ones it
// used marked), with a Re-run that asks the source again now and says
// whether it still gives the number on screen.
import { useMemo, useState } from "react";
import { Copy, Play, X } from "lucide-react";
import { toast } from "sonner";
import { dashboard, type ArtifactElement } from "@codecast/shared/artifacts";
import { CheckMark, type BlockEnv } from "./blocks";
import { CheckRows, type RowsScope } from "./CheckRows";
import { blockCheck } from "./blockCheck";
import { resultFor, useRerun, type DataResult } from "../../hooks/useDashboardData";

type Rerun = { at: number; ms: number; outcome: ReturnType<typeof dashboard.compareRerun> };

function evalOf(b: ArtifactElement, r: DataResult | undefined, scope: dashboard.Where | undefined): { how?: string; used?: number[]; problem?: string } {
  if (b.kind !== "kpi" && b.kind !== "chart" && b.kind !== "table") return {};
  const ev = dashboard.evaluateBlock(b.kind, b, r, scope);
  if (ev.state === "ok") return { how: ev.how, used: ev.used };
  if (ev.state === "problem") return { problem: ev.problem };
  return {};
}

/** A chart point the check opened on: its x and, on a split chart, its series. */
export type CheckPoint = { x: string; series?: string };

export function CheckPanel({ docId, block, env, onClose, canRerun = true, point }: { docId: string; block: ArtifactElement | undefined; env: BlockEnv; onClose: () => void; canRerun?: boolean; point?: CheckPoint }) {
  const rerunAction = useRerun();
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<Rerun | null>(null);
  const result = block ? resultFor(env.results, block) : undefined;
  const q = block ? dashboard.blockQuery(block) : null;
  const check = block ? blockCheck(block, env) : null;
  const ev = useMemo(() => (block ? evalOf(block, result, env.scope) : {}), [block, result, env.scope]);
  const used = useMemo(() => new Set(ev.used ?? []), [ev.used]);
  const scopes = useMemo(() => {
    const out: RowsScope[] = [];
    if (point && block && block.kind === "chart") out.push({ label: point.series ? `${point.x} · ${point.series}` : point.x, rows: new Set(dashboard.chartPointRows(block as dashboard.ChartBlock, result, point.x, point.series, env.scope)) });
    if (result && used.size && used.size < result.rows.length) out.push({ label: env.scope ? "Filtered" : "Used", rows: used });
    return out;
  }, [point, block, result, used, env.scope]);

  if (!block) {
    return (
      <PanelShell title="Check" onClose={onClose}>
        <p className="text-meta text-sol-text-dim">This block is gone.</p>
      </PanelShell>
    );
  }
  const source = q ? dashboard.DATA_SOURCES.find((s) => s.id === q.source) : undefined;
  const cli = q ? `cast data query ${docId} ${q.source} --args '${JSON.stringify(q.args ?? {})}'` : "";
  const shown = dashboard.blockValue(block.kind, block, result, env.scope)?.shown ?? null;

  const rerun = async () => {
    if (!q) return;
    setRunning(true);
    const before = result;
    try {
      const fresh = await rerunAction({ doc_id: docId as any, qkey: dashboard.queryKey(q) });
      setLast({ at: Date.now(), ms: fresh.ran_ms, outcome: dashboard.compareRerun(block.kind, block, before, fresh, env.scope) });
    } catch (e) {
      setLast({ at: Date.now(), ms: 0, outcome: { same: false, before: shown, after: null, problem: e instanceof Error ? e.message.replace(/^.*Error: /, "") : String(e) } });
    } finally {
      setRunning(false);
    }
  };

  return (
    <PanelShell title={String(block.title || block.kind)} onClose={onClose}>
      {check ? (
        <div className="flex items-start gap-2.5 rounded-lg bg-sol-bg-alt/60 px-3 py-2.5" data-check-state={check.state}>
          <CheckMark check={check} size={18} />
          <div className="min-w-0">
            <div className="text-sm font-medium text-sol-text">{check.label}</div>
            {check.detail ? <div className="text-meta text-sol-text-muted mt-0.5 break-words">{check.detail}</div> : null}
          </div>
        </div>
      ) : null}

      {q ? (
        <>
          <Field label="Shows">
            <div className="text-sm text-sol-text tabular-nums">{shown ?? "–"}</div>
            {ev.how ? <div className="text-meta text-sol-text-muted">{ev.how}</div> : null}
            {ev.problem ? <div className="text-meta text-sol-red">{ev.problem}</div> : null}
          </Field>

          <Field label="Source">
            <div className="text-sm text-sol-text">{source?.label ?? q.source}</div>
            <div className="text-meta text-sol-text-muted break-words">{result?.query_text ?? "Not read yet"}</div>
            {result?.refreshed_at ? (
              <div className="text-meta text-sol-text-dim mt-0.5">
                Read {dashboard.ago(env.now - result.refreshed_at)} · every {Math.round(result.refresh_ms / 60_000)}m
              </div>
            ) : null}
          </Field>

          <Field label="Query">
            <pre className="text-meta leading-5 font-mono text-sol-text-secondary bg-sol-bg-alt/60 rounded-md px-2.5 py-2 whitespace-pre-wrap break-all">{JSON.stringify({ source: q.source, args: q.args ?? {} }, null, 1)}</pre>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(cli).then(() => toast.success("Copied"))}
              className="mt-1 inline-flex items-center gap-1.5 text-meta text-sol-text-muted hover:text-sol-text"
            >
              <Copy className="w-3 h-3" /> Copy as cast command
            </button>
          </Field>

          {canRerun ? <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={rerun}
              disabled={running}
              data-rerun
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium bg-sol-text text-sol-bg hover:opacity-90 disabled:opacity-50"
            >
              <Play className="w-3 h-3" /> {running ? "Running…" : "Re-run now"}
            </button>
            {last ? <RerunOutcome r={last} /> : null}
          </div> : null}

          {result && result.columns.length ? (
            <Field label="Rows">
              <CheckRows key={point ? `${point.x}|${point.series ?? ""}` : "all"} columns={result.columns} rows={result.rows} scopes={scopes} truncated={result.truncated} />
            </Field>
          ) : null}
        </>
      ) : (
        <p className="text-meta text-sol-text-muted">{block.kind === "text" ? "Numbers in this text are typed. Reference a KPI as {b_key} to show its live, checked value." : "This block has no source. Bind it to one in the editor."}</p>
      )}
    </PanelShell>
  );
}

function RerunOutcome({ r }: { r: Rerun }) {
  const o = r.outcome;
  if (o.problem) return <span className="text-meta text-sol-red min-w-0 truncate" title={o.problem} data-rerun-outcome="failed">Can't reproduce: {o.problem}</span>;
  if (o.same) return <span className="text-meta text-sol-green" data-rerun-outcome="same">Reproduced · {Math.max(1, Math.round(r.ms))}ms</span>;
  return (
    <span className="text-meta text-sol-yellow min-w-0 truncate" data-rerun-outcome="changed" title={`Was ${o.before}, now ${o.after}`}>
      Moved: {o.before} → {o.after}
    </span>
  );
}

export function PanelShell({ title, onClose, children, actions }: { title: string; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="h-full flex flex-col min-h-0" data-data-panel>
      <div className="flex items-center gap-2 h-11 px-3 border-b border-sol-border/40 shrink-0">
        <span className="text-sm font-semibold text-sol-text truncate flex-1">{title}</span>
        {actions}
        <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-4">{children}</div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-meta text-sol-text-dim">{label}</div>
      {children}
    </div>
  );
}
