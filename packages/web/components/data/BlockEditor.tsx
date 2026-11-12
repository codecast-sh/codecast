// Edit one block in the drawer: its words, its source and how its rows are
// shaped. Selects write at once; typed fields write when they lose focus or
// on Enter, so typing stays as cheap as a bare text field.
import { ArgsEditor } from "./ArgsEditor";
import { LiveTextField } from "./LiveTextField";
import { WhereBuilder } from "./WhereBuilder";
import { useInboxStore } from "../../store/inboxStore";
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
  // Grouped, a table has the group, its summed numbers and a row count; sorting picks among those.
  const tableCols = typeof block.group === "string" && block.group ? [block.group, ...numeric, "rows"] : columns;
  const kpis = [...env.blocks.values()].filter((b) => b.kind === "kpi").sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  const preview = (key: string, part: dashboard.TokenPart) => {
    const k = env.blocks.get(key);
    return k ? dashboard.kpiPartText(dashboard.evaluateKpi(k as dashboard.KpiBlock, resultFor(env.results, k), env.scope), part) : "";
  };
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
      {block.kind === "text" ? <LiveTextField label="Text" value={block.text} kpis={kpis} preview={preview} multiline holdKey={`${docId}:${block.key}:text`} onCommit={(v) => set({ text: v })} /> : <TextField label="Caption" value={block.caption} onCommit={(v) => set({ caption: v || null })} />}

      {block.kind === "kpi" || block.kind === "chart" || block.kind === "table" ? (
        <>
          <QueryField docId={docId} block={block} onCommit={(query) => set({ query: query as unknown as Json })} problem={result?.error && !result.refreshed_at ? result.error : undefined} />
          {block.kind === "kpi" ? (
            <>
              <Row>
                <Select label="Value" value={block.agg ?? (block.field ? "sum" : "count")} options={dashboard.KPI_AGGS} onChange={(v) => set({ agg: v })} />
                <Select label="of" value={block.field} options={columns} empty="–" onChange={(v) => set({ field: v || null, ...(v && formatFor(v) !== (block.format ?? "number") ? { format: formatFor(v) } : {}) })} />
              </Row>
              {block.agg === "top" ? <Select label="Named by" value={block.label} options={columns} empty="auto" onChange={(v) => set({ label: v || null })} /> : null}
              <Select label="Format" value={block.format ?? "number"} options={FORMATS} onChange={(v) => set({ format: v })} />
              <Select label="Compare to" value={block.compare} options={["halves", "prev", ...columns]} labels={{ halves: "the window's earlier half", prev: "the previous row" }} empty="nothing" onChange={(v) => set({ compare: v || null })} />
              {block.compare ? <Select label="Good when" value={block.good} options={["up", "down"]} empty="neutral" onChange={(v) => set({ good: v || null })} /> : null}
              {!q ? <TextField label="Typed value (not verified)" value={block.value === undefined ? undefined : String(block.value)} onCommit={(v) => set({ value: v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : v })} /> : null}
              {q ? <AlertFields block={block} result={result} onSet={(alert) => set({ alert })} /> : null}
            </>
          ) : null}
          {block.kind === "chart" ? (
            <>
              <Select label="Chart" value={block.chart ?? "line"} options={dashboard.CHART_TYPES} labels={{ hbar: "ranked bars", stacked: "stacked bars" }} onChange={(v) => set({ chart: v })} />
              <Row>
                <Select label="X" value={block.x} options={labels.length ? labels : columns} empty="first" onChange={(v) => set({ x: v || null })} />
                <Select label="Series" value={block.series} options={labels.filter((c) => c !== (block.x ?? columns[0]))} empty="none" onChange={(v) => set({ series: v || null, ...(v && String(block.y ?? "").includes(",") ? { y: String(block.y).split(",")[0] } : {}) })} />
              </Row>
              <SeriesPicker value={block.y} options={numeric} single={!!block.series} onChange={(v) => set({ y: v, ...(v && formatFor(v.split(",")[0]) !== (block.format ?? "number") ? { format: formatFor(v.split(",")[0]) } : {}) })} />
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
              <Select label="One row per" value={block.group} options={labels} empty="source row" onChange={(v) => set({ group: v || null, columns: null, sort: v ? `-${numeric[0] ?? "rows"}` : null })} />
              <TextField label="Columns" placeholder="all, or a,b,c" value={block.columns} onCommit={(v) => set({ columns: v || null })} />
              <Row>
                <Select label="Sort" value={block.sort} options={tableCols.flatMap((c) => [`-${c}`, c])} labels={Object.fromEntries(tableCols.flatMap((c) => [[`-${c}`, `${c} ↓`], [c, `${c} ↑`]]))} empty="source order" onChange={(v) => set({ sort: v || null })} />
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
        <LiveTextField label="Story title" value={block.say_title} kpis={kpis} preview={preview} holdKey={`${docId}:${block.key}:say_title`} onCommit={(v) => set({ say_title: v || null })} />
        <div className="h-2" />
        <LiveTextField label="Story line" value={block.say} kpis={kpis} preview={preview} multiline holdKey={`${docId}:${block.key}:say`} onCommit={(v) => set({ say: v || null })} />
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
  // The query as the block stores it. blockQuery(block) is what is read (a period KPI reads twice its window); editing that would double the window on every change.
  const q = dashboard.blockQuery({ query: block.query });
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
  // Chips stay where they are when picked; a chosen column the source no longer has goes last.
  const all = [...options, ...chosen.filter((c) => !options.includes(c))];
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

/** Notify me when this number goes above or below a line. Empty both to stop. The alert fires whenever the number is read: while the page is open, or on the dashboard's schedule. */
function AlertFields({ block, result, onSet }: { block: ArtifactElement; result: ReturnType<typeof resultFor>; onSet: (alert: Json) => void }) {
  const me = useInboxStore((s: any) => (s.currentUser?._id ? String(s.currentUser._id) : undefined));
  const alert = dashboard.readAlert(block);
  // Editing someone else's alert keeps it theirs: changing a line never moves who hears it.
  const owner = alert?.by ?? me;
  // Lines are typed the way the tile shows the number: "20K", "$1.5M", "15" on a percent tile meaning 15%.
  const percent = block.format === "percent";
  const parse = (v: string): number | undefined | null => {
    const t = v.trim().replace(/[$,\s%]/g, "");
    if (!t) return undefined;
    const m = t.match(/^(-?\d*\.?\d+)([kmb])?$/i);
    if (!m) return null;
    const n = Number(m[1]) * (m[2] ? { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase() as "k" | "m" | "b"] : 1);
    return percent ? n / 100 : n;
  };
  const shownLine = (n: number | undefined) => (n === undefined ? undefined : percent ? String(Math.round(n * 1e6) / 1e4) : String(n));
  const write = (side: "above" | "below", v: string) => {
    const n = parse(v);
    if (n === null) return;
    const next = { ...(alert ?? {}), [side]: n };
    const above = next.above;
    const below = next.below;
    onSet(above === undefined && below === undefined ? null : { ...(above !== undefined ? { above } : {}), ...(below !== undefined ? { below } : {}), ...(owner ? { by: owner } : {}) });
  };
  const check = (side: "above" | "below") => (v: string) => {
    const n = parse(v);
    if (n === null) return "A number, like 20K";
    // An upper line under the lower one would always be alerting.
    const other = side === "above" ? alert?.below : alert?.above;
    if (n !== undefined && other !== undefined && (side === "above" ? n < other : n > other)) return side === "above" ? "Above sits under Below" : "Below sits over Above";
    return null;
  };
  const ev = dashboard.evaluateKpi(block as dashboard.KpiBlock, result);
  const state = dashboard.alertState(block, result);
  const now = ev.state === "ok" ? `now ${ev.display}` : "–";
  return (
    <Field label="Alert when it goes">
      <Row>
        <TextField label={percent ? "Above (%)" : "Above"} value={shownLine(alert?.above)} placeholder={now} validate={check("above")} onCommit={(v) => write("above", v)} />
        <TextField label={percent ? "Below (%)" : "Below"} value={shownLine(alert?.below)} placeholder={now} validate={check("below")} onCommit={(v) => write("below", v)} />
      </Row>
      <div className="flex flex-wrap gap-x-2 text-meta text-sol-text-dim tabular-nums" data-alert-status>
        {ev.state === "ok" ? <span>Now {ev.display}</span> : null}
        {alert ? <span>· notifies {!alert.by || alert.by === me ? "you" : "the person who set it"}</span> : null}
        {state && state.state !== "ok" ? <span className="text-sol-red">· past the line now: an alert goes out on the next read</span> : null}
      </div>
    </Field>
  );
}

/** The format a newly picked column reads in: money as money, token counts compact, ratios as percents. The person can change it after. */
function formatFor(column: string): string {
  const c = column.toLowerCase();
  if (/spend|cost|usd|price|revenue|amount|dollars/.test(c)) return "usd";
  if (/rate|ratio|pct|percent|share/.test(c)) return "percent";
  if (/tokens|bytes|events|views/.test(c)) return "compact";
  return "number";
}
