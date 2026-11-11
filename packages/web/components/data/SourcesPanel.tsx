// The Data sources drawer (the database icon): what this dashboard reads now,
// and everything it could read (codecast's own record, metric watches,
// connectors, sheets). Pick a source, adjust its args, run it to see the
// columns and rows, then add a KPI, chart or table bound to it.
import { useMemo, useState } from "react";
import { BarChart3, ChevronRight, Hash, Loader2, Play, Table2 } from "lucide-react";
import { dashboard, newElementKey, type ArtifactElement, type ArtifactOp, type Json } from "@codecast/shared/artifacts";
import { PanelShell, Field } from "./CheckPanel";
import { RowsTable, CheckMark, type BlockEnv } from "./blocks";
import { ArgsEditor } from "./ArgsEditor";
import { useDataSources, usePreviewQuery, type DataResult, type SourceRow } from "../../hooks/useDashboardData";

const GROUPS: Array<{ id: string; label: string }> = [
  { id: "codecast", label: "Codecast" },
  { id: "metrics", label: "Metric watches" },
  { id: "product", label: "Product events" },
  { id: "connectors", label: "Connectors" },
  { id: "sheets", label: "Sheets" },
];

type Preview = { columns: string[]; rows: unknown[][]; total: number; query_text: string; error?: string };

export function SourcesPanel({
  docId,
  blocks,
  env,
  canEdit,
  onClose,
  onAdd,
  onCheck,
}: {
  docId: string;
  blocks: ArtifactElement[];
  env: BlockEnv;
  canEdit: boolean;
  onClose: () => void;
  onAdd: (ops: ArtifactOp[], key: string) => void;
  onCheck: (key: string) => void;
}) {
  const { rows, loading } = useDataSources(docId, true);
  const [open, setOpen] = useState<string | null>(null);
  const inUse = useMemo(() => {
    const byKey = new Map<string, { q: dashboard.DataQuery; blocks: ArtifactElement[]; result?: DataResult }>();
    for (const b of blocks) {
      const q = dashboard.blockQuery(b);
      if (!q) continue;
      const k = dashboard.queryKey(q);
      const entry = byKey.get(k) ?? { q, blocks: [], result: env.results.get(k) };
      entry.blocks.push(b);
      byKey.set(k, entry);
    }
    return [...byKey.values()];
  }, [blocks, env.results]);

  return (
    <PanelShell title="Data sources" onClose={onClose}>
      {inUse.length ? (
        <Field label={`In use · ${inUse.length}`}>
          <div className="space-y-1">
            {inUse.map(({ q, blocks: bs, result }) => {
              const label = dashboard.DATA_SOURCES.find((s) => s.id === q.source)?.label ?? q.source;
              const check = dashboard.checkBlock(bs[0].kind, bs[0], result, env.now);
              return (
                <button key={dashboard.queryKey(q)} type="button" onClick={() => onCheck(bs[0].key)} className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sol-bg-alt">
                  {check ? <CheckMark check={check} size={14} onClick={() => onCheck(bs[0].key)} /> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-sol-text truncate">{label}</span>
                    <span className="block text-meta text-sol-text-dim truncate">{argsLine(q.args)} · {bs.length} {bs.length === 1 ? "block" : "blocks"}</span>
                  </span>
                  <span className="text-meta text-sol-text-dim shrink-0">{result?.refreshed_at ? dashboard.ago(env.now - result.refreshed_at) : "…"}</span>
                </button>
              );
            })}
          </div>
        </Field>
      ) : null}

      {GROUPS.map((g) => {
        const list = rows.filter((r) => r.group === g.id);
        if (!list.length && !(loading && g.id === "codecast")) return null;
        return (
          <Field key={g.id} label={g.label}>
            {loading && !list.length ? <Loader2 className="w-4 h-4 animate-spin text-sol-text-dim" /> : null}
            <div className="space-y-0.5">
              {list.map((s) => (
                <SourceItem key={s._id} docId={docId} s={s} open={open === s._id} onToggle={() => setOpen(open === s._id ? null : s._id)} canEdit={canEdit} blocks={blocks} onAdd={onAdd} />
              ))}
            </div>
          </Field>
        );
      })}
    </PanelShell>
  );
}

function argsLine(args: Record<string, unknown> | undefined): string {
  const entries = Object.entries(args ?? {});
  return entries.length ? entries.map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ") : "defaults";
}

function SourceItem({ docId, s, open, onToggle, canEdit, blocks, onAdd }: { docId: string; s: SourceRow; open: boolean; onToggle: () => void; canEdit: boolean; blocks: ArtifactElement[]; onAdd: (ops: ArtifactOp[], key: string) => void }) {
  const preview = usePreviewQuery();
  const [args, setArgs] = useState<Record<string, Json>>(() => ({ ...((dashboard.DEFAULT_ARGS[s.source] ?? {}) as Record<string, Json>), ...((s.args ?? {}) as Record<string, Json>) }));
  const [running, setRunning] = useState(false);
  // The preview belongs to the exact args it ran with; change them and Add waits for a new run.
  const [out, setOut] = useState<(Preview & { ran: string }) | null>(null);
  const current = dashboard.stableJson(args);
  const fresh = out?.ran === current;

  const run = async () => {
    setRunning(true);
    try {
      setOut({ ...(await preview({ doc_id: docId as any, query: { source: s.source, args } })), ran: current });
    } catch (e) {
      setOut({ columns: [], rows: [], total: 0, query_text: "", error: e instanceof Error ? e.message : String(e), ran: current });
    } finally {
      setRunning(false);
    }
  };

  const add = (kind: "kpi" | "chart" | "table") => {
    if (!out || !fresh) return;
    const key = newElementKey("b");
    const fields = dashboard.suggestFields(kind, out.columns, out.rows[0]);
    const order = dashboard.orderAfter(dashboard.orderedBlocks(blocks), undefined);
    onAdd([{ k: key, put: { kind, order, title: s.label, query: { source: s.source, args } as unknown as Json, ...fields } }], key);
  };

  return (
    <div className={`rounded-md ${open ? "bg-sol-bg-alt/50" : ""}`}>
      <button type="button" onClick={onToggle} className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sol-bg-alt" aria-expanded={open}>
        <ChevronRight className={`w-3.5 h-3.5 text-sol-text-dim shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-sol-text truncate">{s.label}</span>
          <span className="block text-meta text-sol-text-dim truncate">{s.columns ?? s.detail}</span>
        </span>
      </button>
      {open ? (
        <div className="px-2 pb-2 space-y-2">
          <ArgsEditor docId={docId} source={s.source} args={args} onChange={setArgs} />
          <div className="flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={run} disabled={running} className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium bg-sol-text text-sol-bg disabled:opacity-40">
              {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />} Run
            </button>
            {out && !out.error && canEdit ? (
              <>
                <span className="flex-1" />
                <AddButton icon={Hash} label="KPI" disabled={!fresh} onClick={() => add("kpi")} />
                <AddButton icon={BarChart3} label="Chart" disabled={!fresh} onClick={() => add("chart")} />
                <AddButton icon={Table2} label="Table" disabled={!fresh} onClick={() => add("table")} />
              </>
            ) : null}
          </div>
          {out?.error ? <div className="text-meta text-sol-red break-words">{out.error}</div> : null}
          {out && !out.error ? (
            <div className={fresh ? "" : "opacity-50"}>
              <div className="text-meta text-sol-text-muted break-words mb-1.5">{out.total} rows</div>
              <RowsTable columns={out.columns} rows={out.rows.slice(0, 50)} maxHeight={220} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AddButton({ icon: Icon, label, onClick, disabled }: { icon: typeof Hash; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={disabled ? "Run it again with these args first" : `Add a ${label} bound to this query`} className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs text-sol-text-secondary border border-sol-border/60 hover:text-sol-text hover:border-sol-border disabled:opacity-40 disabled:pointer-events-none">
      <Icon className="w-3 h-3" /> {label}
    </button>
  );
}
