// The numbers a goal or a project is read by, edited in place: each a name
// and a target, read live from a series (a metric watch) or from reports,
// and marked a guardrail when the work must not make it worse. One editor for
// the goal's "Measured by" and the project's numbers, so both write the same
// shape (contracts/initiative InitiativeMetric).
import { useState } from "react";
import { Plus, X } from "lucide-react";
import { INITIATIVE_METRICS_MAX, type InitiativeMetric } from "@codecast/shared/contracts/initiative";
import { formatSeriesValue } from "@codecast/shared/contracts/ingest";
import type { OpsWatch } from "../ops/opsTypes";
import { FormButtons, GhostButton } from "./formBits";
import { draftOf, metricsOfDraft, type Draft } from "./metricsDraft";

const HAIRLINE = "color-mix(in srgb, var(--sol-border) 26%, transparent)";
const DIM = "var(--sol-text-dim)";
const FIELD = "h-7 rounded-md border bg-transparent px-2 text-[12.5px] outline-none placeholder:text-sol-text-dim focus:border-sol-cyan/60";

const watchLabel = (w: OpsWatch) => `${w.name}${w.last_value !== null ? ` · ${formatSeriesValue(w.last_value, w.unit)}` : ""}`;

export function MetricsEditor({ metrics, watches, onSave, onCancel }: { metrics: readonly InitiativeMetric[]; watches: readonly OpsWatch[]; onSave: (next: InitiativeMetric[]) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Draft[]>(() => draftOf(metrics));
  const set = (i: number, patch: Partial<Draft>) => setDraft(draft.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = () => onSave(metricsOfDraft(draft));
  return (
    <div className="space-y-1.5" data-initiative-metrics-form>
      {draft.map((m, i) => {
        const watch = watches.find((w) => w.short_id === m.series);
        return (
          <div key={i} className="flex items-center gap-1.5" data-metric-draft={i}>
            <input autoFocus={i === 0} value={m.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="Weekly active teams" className={`${FIELD} flex-1 min-w-0`} style={{ borderColor: HAIRLINE }} aria-label="Metric name" />
            <input value={m.target} onChange={(e) => set(i, { target: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} placeholder={watch?.unit === "$" ? "under $250" : "target 1,000"} className={`${FIELD} w-[110px] tabular-nums`} style={{ borderColor: HAIRLINE }} aria-label="Target" />
            <select
              value={m.series}
              onChange={(e) => {
                const next = watches.find((w) => w.short_id === e.target.value);
                set(i, { series: e.target.value, ...(next && !m.name.trim() ? { name: next.name } : {}) });
              }}
              className={`${FIELD} w-[150px] cursor-pointer pr-1`}
              style={{ borderColor: HAIRLINE, color: m.series ? "var(--sol-text)" : DIM }}
              aria-label="Where the value comes from"
              title={watch ? `${watch.short_id} · ${watch.source_name ?? ""}` : "Reported by its owner"}
              data-metric-series-pick
            >
              <option value="">Reported</option>
              {watches.map((w) => <option key={w.short_id} value={w.short_id}>{watchLabel(w)}</option>)}
            </select>
            <button
              type="button"
              aria-pressed={m.guardrail}
              onClick={() => set(i, { guardrail: !m.guardrail })}
              className="h-7 rounded-md border px-1.5 text-[11.5px] transition-colors"
              style={{ borderColor: m.guardrail ? "var(--sol-text-muted)" : HAIRLINE, color: m.guardrail ? "var(--sol-text)" : DIM }}
              title="A number the work must not make worse"
              data-metric-guardrail-toggle
            >
              Guardrail
            </button>
            <button type="button" onClick={() => setDraft(draft.filter((_, j) => j !== i))} className="inline-flex items-center justify-center w-6 h-6 rounded-md hover:bg-sol-bg-highlight/70" style={{ color: DIM }} aria-label="Remove this metric"><X className="w-3 h-3" /></button>
          </div>
        );
      })}
      <div className="flex items-center gap-1.5">
        {draft.length < INITIATIVE_METRICS_MAX && <GhostButton icon={Plus} onClick={() => setDraft([...draft, { name: "", target: "", series: "", guardrail: false }])}>Another number</GhostButton>}
        <span className="flex-1" />
        <FormButtons submit="Save" onCancel={onCancel} onSubmit={save} />
      </div>
      <p className="text-[11px]" style={{ color: DIM }}>Write "under 5%" for a number to stay below.</p>
    </div>
  );
}
