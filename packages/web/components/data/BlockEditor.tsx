// Edit one block in the drawer: its words, its source and how its rows are
// shaped. Selects write at once; typed fields write when they lose focus or
// on Enter, so typing stays as cheap as a bare text field.
import { ArgsEditor } from "./ArgsEditor";
import { LiveTextField } from "./LiveTextField";
import { WhereBuilder } from "./WhereBuilder";
import { useCommittedDraft } from "../../hooks/useCommittedDraft";
import { Trash2 } from "lucide-react";
import { dashboard, type ArtifactElement, type ArtifactOp, type Json } from "@codecast/shared/artifacts";
import { PanelShell, Field } from "./CheckPanel";
import { resultFor } from "../../hooks/useDashboardData";
import type { BlockEnv } from "./blocks";

const KIND_LABEL: Record<string, string> = { kpi: "KPI", chart: "Chart", table: "Table", text: "Text", section: "Section" };
const FORMATS = ["number", "compact", "usd", "percent"] as const;

export function BlockEditor({ docId, block, env, apply, onClose, onRemove }: { docId: string; block: ArtifactElement | undefined; env: BlockEnv; apply: (ops: ArtifactOp[]) => void; onClose: () => void; onRemove: () => void }) {
  if (!block) {
    return (
      <PanelShell title="Edit" onClose={onClose}>
        <p className="text-meta text-sol-text-dim">This block is gone.</p>
      </PanelShell>
    );
  }
  const set = (fields: Record<string, Json>) => apply([{ k: block.key, set: fields }]);
  const result = resultFor(env.results, block);
  const columns = result?.columns ?? [];
  const sample = result?.rows.find((r) => r.some((v) => v !== null && v !== undefined)) ?? [];
  const numeric = columns.filter((_, i) => typeof sample[i] === "number");
  const labels = columns.filter((_, i) => typeof sample[i] !== "number");
  const kpis = [...env.blocks.values()].filter((b) => b.kind === "kpi" && b.key !== block.key).sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  const q = dashboard.blockQuery(block);
  return (
    <PanelShell
      title={`${KIND_LABEL[block.kind] ?? block.kind}${block.title ? ` · ${block.title}` : ""}`}
      onClose={onClose}
      actions={
        <button type="button" onClick={onRemove} title="Remove block" aria-label="Remove block" className="p-1 rounded text-sol-text-muted hover:text-sol-red hover:bg-sol-red/10">
          <Trash2 className="w-4 h-4" />
        </button>
      }
    >
      {block.kind !== "text" ? <TextField label="Title" value={block.title} onCommit={(v) => set({ title: v || null })} /> : null}
      {block.kind === "text" ? <LiveTextField label="Text" value={block.text} kpis={kpis} multiline onCommit={(v) => set({ text: v })} /> : <TextField label="Caption" value={block.caption} onCommit={(v) => set({ caption: v || null })} />}

      {block.kind === "kpi" || block.kind === "chart" || block.kind === "table" ? (
        <>
          <QueryField docId={docId} block={block} onCommit={(query) => set({ query: query as unknown as Json })} problem={result?.error && !result.refreshed_at ? result.error : undefined} />
          {block.kind === "kpi" ? (
            <>
              <Row>
                <Select label="Value" value={block.agg ?? (block.field ? "sum" : "count")} options={dashboard.KPI_AGGS} onChange={(v) => set({ agg: v })} />
                <Select label="of" value={block.field} options={columns} empty="–" onChange={(v) => set({ field: v || null })} />
              </Row>
              {block.agg === "top" ? <Select label="Named by" value={block.label} options={columns} empty="auto" onChange={(v) => set({ label: v || null })} /> : null}
              <Row>
                <Select label="Format" value={block.format ?? "number"} options={FORMATS} onChange={(v) => set({ format: v })} />
                <Select label="Compare to" value={block.compare} options={["halves", "prev", ...columns]} labels={{ halves: "earlier half", prev: "previous row" }} empty="none" onChange={(v) => set({ compare: v || null })} />
              </Row>
              {block.compare ? <Select label="Good when" value={block.good} options={["up", "down"]} empty="neutral" onChange={(v) => set({ good: v || null })} /> : null}
              {!q ? <TextField label="Typed value (not verified)" value={block.value === undefined ? undefined : String(block.value)} onCommit={(v) => set({ value: v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : v })} /> : null}
            </>
          ) : null}
          {block.kind === "chart" ? (
            <>
              <Select label="Chart" value={block.chart ?? "line"} options={dashboard.CHART_TYPES} labels={{ hbar: "ranked bars", stacked: "stacked bars" }} onChange={(v) => set({ chart: v })} />
              <Row>
                <Select label="X" value={block.x} options={labels.length ? labels : columns} empty="first" onChange={(v) => set({ x: v || null })} />
                <Select label="Split by" value={block.series} options={labels.filter((c) => c !== (block.x ?? columns[0]))} empty="none" onChange={(v) => set({ series: v || null, ...(v && String(block.y ?? "").includes(",") ? { y: String(block.y).split(",")[0] } : {}) })} />
              </Row>
              <SeriesPicker value={block.y} options={numeric} single={!!block.series} onChange={(v) => set({ y: v })} />
              <Row>
                <Select label="Format" value={block.format ?? "number"} options={FORMATS} onChange={(v) => set({ format: v })} />
              </Row>
              <label className="flex items-center gap-2 text-sm text-sol-text-secondary">
                <input type="checkbox" checked={!!block.cumulative} onChange={(e) => set({ cumulative: e.target.checked ? true : null })} className="accent-[var(--sol-blue)]" />
                Running total
              </label>
            </>
          ) : null}
          {block.kind === "table" ? (
            <>
              <TextField label="Columns" placeholder="all, or a,b,c" value={block.columns} onCommit={(v) => set({ columns: v || null })} />
              <Row>
                <Select label="Sort" value={block.sort} options={columns.flatMap((c) => [`-${c}`, c])} labels={Object.fromEntries(columns.flatMap((c) => [[`-${c}`, `${c} ↓`], [c, `${c} ↑`]]))} empty="source order" onChange={(v) => set({ sort: v || null })} />
                <TextField label="Limit" value={block.limit === undefined ? undefined : String(block.limit)} onCommit={(v) => set({ limit: v && Number(v) > 0 ? Number(v) : null })} />
              </Row>
            </>
          ) : null}
          <Field label="Filter rows">
            <WhereBuilder where={block.where as dashboard.Where | undefined} columns={columns} rows={result?.rows ?? []} onChange={(w) => set({ where: (w ?? null) as Json })} />
          </Field>
        </>
      ) : null}

      <Select label="Width" value={String(dashboard.blockSpan(block))} options={dashboard.SPANS.map(String)} labels={{ "3": "quarter", "4": "third", "6": "half", "8": "two thirds", "12": "full" }} onChange={(v) => set({ span: Number(v) })} />

      <Field label="In a story">
        <LiveTextField label="Story title" value={block.say_title} kpis={kpis} onCommit={(v) => set({ say_title: v || null })} />
        <div className="h-2" />
        <LiveTextField label="Story line" value={block.say} kpis={kpis} multiline onCommit={(v) => set({ say: v || null })} />
        <label className="mt-2 flex items-center gap-2 text-sm text-sol-text-secondary">
          <input type="checkbox" checked={block.in_story !== false} onChange={(e) => set({ in_story: e.target.checked ? null : false })} className="accent-[var(--sol-blue)]" />
          Show in stories
        </label>
      </Field>
    </PanelShell>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-2">{children}</div>;
}

const inputCls = "w-full rounded-md bg-sol-bg border border-sol-border/60 px-2 h-8 text-sm text-sol-text outline-none focus:border-sol-blue";

function TextField({ label, value, onCommit, multiline, mono, placeholder, hint, validate }: { label: string; value: unknown; onCommit: (v: string) => void; multiline?: boolean; mono?: boolean; placeholder?: string; hint?: string; validate?: (v: string) => string | null }) {
  const shown = value === undefined || value === null ? "" : String(value);
  const { draft, setDraft, onFocus, onBlur } = useCommittedDraft(shown);
  const error = validate ? validate(draft) : null;
  const props = {
    value: draft,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onFocus,
    onBlur: () => {
      onBlur();
      if (!error && draft !== shown) onCommit(draft);
    },
    "aria-label": label,
    "aria-invalid": error ? true : undefined,
    placeholder,
  };
  const bad = error ? "border-sol-red/70" : "";
  return (
    <label className="block space-y-1">
      <span className="text-meta text-sol-text-dim">{label}</span>
      {multiline ? (
        <textarea {...props} rows={4} className={`${inputCls} h-auto py-1.5 resize-y leading-6 ${bad}`} />
      ) : (
        <input {...props} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} className={`${inputCls} ${mono ? "font-mono text-[12px]" : ""} ${bad}`} />
      )}
      {error ? <span className="block text-meta text-sol-red">{error}</span> : hint ? <span className="block text-meta text-sol-text-dim truncate" title={hint}>{hint}</span> : null}
    </label>
  );
}


function Select({ label, value, options, labels, empty, onChange }: { label: string; value: unknown; options: readonly string[]; labels?: Record<string, string>; empty?: string; onChange: (v: string) => void }) {
  const v = value === undefined || value === null ? "" : String(value);
  const opts = v && !options.includes(v) ? [v, ...options] : options;
  return (
    <label className="block space-y-1 min-w-0">
      <span className="text-meta text-sol-text-dim">{label}</span>
      <select value={v} onChange={(e) => onChange(e.target.value)} className={`${inputCls} pr-6`}>
        {empty !== undefined ? <option value="">{empty}</option> : null}
        {opts.map((o) => (
          <option key={o} value={o}>
            {labels?.[o] ?? o}
          </option>
        ))}
      </select>
    </label>
  );
}

function QueryField({ docId, block, onCommit, problem }: { docId: string; block: ArtifactElement; onCommit: (q: dashboard.DataQuery | null) => void; problem?: string }) {
  const q = dashboard.blockQuery(block);
  return (
    <Field label="Source">
      <select
        value={q?.source ?? ""}
        onChange={(e) => {
          const s = e.target.value;
          onCommit(s ? { source: s, args: (dashboard.DEFAULT_ARGS[s] ?? {}) as any } : null);
        }}
        className={`${inputCls} pr-6`}
        aria-label="Source"
      >
        <option value="">No source</option>
        {dashboard.DATA_SOURCES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      {q ? <ArgsEditor docId={docId} source={q.source} args={(q.args ?? {}) as Record<string, Json>} onChange={(args) => onCommit({ ...q, args })} /> : null}
      {problem ? <div className="text-meta text-sol-red break-words">{problem}</div> : null}
    </Field>
  );
}

/** The value columns a chart draws: any number of them, or one when the chart splits by a column. Auto picks the numeric ones. */
function SeriesPicker({ value, options, single, onChange }: { value: unknown; options: string[]; single: boolean; onChange: (v: string | null) => void }) {
  const chosen = typeof value === "string" && value ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const all = [...new Set([...chosen, ...options])];
  const toggle = (c: string) => {
    const next = single ? (chosen[0] === c ? [] : [c]) : chosen.includes(c) ? chosen.filter((x) => x !== c) : [...chosen, c];
    onChange(next.length ? next.join(",") : null);
  };
  return (
    <div className="space-y-1">
      <span className="text-meta text-sol-text-dim">{single ? "Value" : "Values"}</span>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Values">
        <button type="button" aria-pressed={!chosen.length} onClick={() => onChange(null)} className={`h-7 px-2 rounded-md border text-xs ${!chosen.length ? "border-sol-blue/50 bg-sol-blue/10 text-sol-text" : "border-sol-border/60 text-sol-text-muted hover:text-sol-text"}`}>
          auto
        </button>
        {all.map((c) => (
          <button key={c} type="button" aria-pressed={chosen.includes(c)} onClick={() => toggle(c)} className={`h-7 px-2 rounded-md border text-xs ${chosen.includes(c) ? "border-sol-blue/50 bg-sol-blue/10 text-sol-text" : "border-sol-border/60 text-sol-text-muted hover:text-sol-text"} ${options.includes(c) ? "" : "line-through"}`}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
