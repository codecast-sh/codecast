// A row filter as controls: one line per condition (column, operator, value),
// the values offered from the rows the source returned. A condition still
// being set up stays on screen without filtering anything until it has a
// value; every complete one is stored as the block's `where`.
import { useMemo, useRef, useState } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { Plus, X } from "lucide-react";
import { dashboard, type Json } from "@codecast/shared/artifacts";
import { useCommittedDraft } from "../../hooks/useCommittedDraft";
import { useWatchEffect } from "../../hooks/useWatchEffect";

type Clause = dashboard.WhereClause;

const OP_LABEL: Record<dashboard.WhereOp, string> = { eq: "is", ne: "is not", in: "is any of", nin: "is none of", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "contains" };
const TIME = /^(day|date|week|month|at|time)$/;
const fieldCls = "h-7 min-w-0 rounded-md bg-sol-bg border border-sol-border/60 px-1.5 text-xs text-sol-text outline-none focus:border-sol-blue";

const complete = (c: Clause) => !!c.column && (Array.isArray(c.value) ? c.value.length > 0 : c.value !== "" && c.value !== null && c.value !== undefined);

/** Distinct values per column, most frequent first, from the rows the source sent. */
function distinctValues(columns: readonly string[], rows: readonly unknown[][]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  columns.forEach((c, i) => {
    const n = new Map<string, number>();
    for (const r of rows) {
      const v = r[i];
      if (v === null || v === undefined || v === "") continue;
      const k = String(v);
      n.set(k, (n.get(k) ?? 0) + 1);
    }
    out.set(c, [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k));
  });
  return out;
}

export function WhereBuilder({ where, columns, rows, onChange }: { where: dashboard.Where | undefined; columns: readonly string[]; rows: readonly unknown[][]; onChange: (next: dashboard.Where | undefined) => void }) {
  const stored = useMemo(() => dashboard.whereClauses(where), [where]);
  const [lines, setLines] = useState<Clause[]>(stored);
  const sig = dashboard.stableJson(where ?? null);
  // A write from elsewhere (an agent, another tab) replaces the lines; conditions still being set up survive it.
  useWatchEffect(() => setLines((cur) => [...stored, ...cur.filter((c) => !complete(c))]), [sig, stored]);
  const values = useMemo(() => distinctValues(columns, rows), [columns, rows]);

  const commit = (next: Clause[]) => {
    setLines(next);
    const w = dashboard.whereFrom(next.filter(complete));
    if (dashboard.stableJson(w ?? null) !== sig) onChange(w);
  };
  const patch = (i: number, p: Partial<Clause>) => commit(lines.map((c, j) => (j === i ? { ...c, ...p } : c)));

  return (
    <div className="space-y-1.5" data-where-builder>
      {lines.map((c, i) => (
        <div key={i} className="flex items-center gap-1" data-where-line={c.column || "new"}>
          <select aria-label="Column" value={c.column} onChange={(e) => patch(i, { column: e.target.value, value: c.op === "in" || c.op === "nin" ? [] : c.value })} className={`${fieldCls} w-[34%] pr-5`}>
            {!c.column ? <option value="">Column</option> : null}
            {c.column && !columns.includes(c.column) ? <option value={c.column}>{c.column} (gone)</option> : null}
            {columns.map((col) => (
              <option key={col} value={col}>
                {col}
              </option>
            ))}
          </select>
          <select
            aria-label="Operator"
            value={c.op}
            onChange={(e) => {
              const op = e.target.value as dashboard.WhereOp;
              const list = op === "in" || op === "nin";
              const value: Json = list ? (Array.isArray(c.value) ? c.value : c.value === "" ? [] : [c.value]) : Array.isArray(c.value) ? (c.value[0] ?? "") : c.value;
              patch(i, { op, value });
            }}
            className={`${fieldCls} w-[22%] pr-5`}
          >
            {dashboard.WHERE_OPS.map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
          <div className="min-w-0 flex-1">
            <ValueControl clause={c} options={values.get(c.column) ?? []} onSet={(value) => patch(i, { value })} />
          </div>
          <button type="button" aria-label="Remove condition" onClick={() => commit(lines.filter((_, j) => j !== i))} className="shrink-0 p-1 rounded text-sol-text-dim hover:text-sol-red hover:bg-sol-red/10">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => setLines([...lines, { column: "", op: "eq", value: "" }])} disabled={!columns.length} className="inline-flex items-center gap-1 h-7 px-1.5 -ml-1.5 rounded-md text-xs text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-alt disabled:opacity-40">
        <Plus className="w-3.5 h-3.5" /> Condition
      </button>
    </div>
  );
}

function ValueControl({ clause, options, onSet }: { clause: Clause; options: string[]; onSet: (v: Json) => void }) {
  const { column, op, value } = clause;
  if (op === "in" || op === "nin") {
    const chosen = (Array.isArray(value) ? value : []).map(String);
    const rest = options.filter((o) => !chosen.includes(o));
    return (
      <div className="flex flex-wrap items-center gap-1">
        {chosen.map((v) => (
          <span key={v} className="inline-flex items-center gap-0.5 h-6 pl-1.5 pr-0.5 rounded bg-sol-blue/15 text-xs text-sol-text max-w-full">
            <span className="truncate">{v}</span>
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onSet(chosen.filter((x) => x !== v))} className="p-0.5 rounded text-sol-text-dim hover:text-sol-text">
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <select aria-label="Add a value" value="" onChange={(e) => e.target.value && onSet([...chosen, e.target.value])} className={`${fieldCls} flex-1 pr-5`} disabled={!rest.length}>
          <option value="">{rest.length ? "Add…" : chosen.length ? "All picked" : "No values"}</option>
          {rest.slice(0, 200).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }
  const shown = value === null || value === undefined ? "" : String(value);
  // A short list of values reads best as a pick; dates get a date field; anything else is typed.
  if ((op === "eq" || op === "ne") && options.length && options.length <= 60) {
    return (
      <select aria-label="Value" value={shown} onChange={(e) => onSet(e.target.value)} className={`${fieldCls} w-full pr-5`}>
        {!shown ? <option value="">Value</option> : null}
        {shown && !options.includes(shown) ? <option value={shown}>{shown}</option> : null}
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  const date = TIME.test(column) && /^\d{4}-\d\d-\d\d$/.test(options[0] ?? "");
  const numeric = options.length > 0 && options.every((o) => Number.isFinite(Number(o)));
  return <CommittedValue value={shown} type={date ? "date" : "text"} numeric={numeric} placeholder={op === "contains" ? "text" : "value"} onCommit={(v) => onSet(numeric && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v)} />;
}

/** A typed value that writes on blur or Enter, so typing stays cheap. */
function CommittedValue({ value, type, numeric, placeholder, onCommit }: { value: string; type: "date" | "text"; numeric: boolean; placeholder: string; onCommit: (v: string) => void }) {
  const { draft, setDraft, onFocus, onBlur } = useCommittedDraft(value);
  // Saved after a pause in typing as well as on blur, so a reload never drops a typed value.
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  useMountEffect(() => () => {
    if (idle.current) clearTimeout(idle.current);
  });
  return (
    <input
      aria-label="Value"
      type={type}
      inputMode={numeric ? "decimal" : undefined}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        // A date picker commits on pick: there is no typing to keep cheap.
        if (type === "date") return onCommit(v);
        if (idle.current) clearTimeout(idle.current);
        idle.current = setTimeout(() => v !== value && commitRef.current(v), 900);
      }}
      onFocus={onFocus}
      onBlur={() => {
        onBlur();
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`${fieldCls} w-full`}
    />
  );
}
