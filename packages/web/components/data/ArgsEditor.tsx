// A source's arguments as controls: a days field, a split-by select, a sheet
// picker, a range. The raw JSON stays one toggle away for the arguments a
// control doesn't cover, and refuses to commit until it parses.
import { useRef, useState } from "react";
import { useCommittedDraft } from "../../hooks/useCommittedDraft";
import { Braces } from "lucide-react";
import { dashboard, type Json } from "@codecast/shared/artifacts";
import { useDataSources } from "../../hooks/useDashboardData";
import { SheetRangePicker } from "./SheetRangePicker";

type Args = Record<string, Json>;

const fieldCls = "w-full rounded-md bg-sol-bg border border-sol-border/60 px-2 h-8 text-sm text-sol-text outline-none focus:border-sol-blue";

export function ArgsEditor({ docId, source, args, onChange }: { docId: string; source: string; args: Args; onChange: (next: Args) => void }) {
  const params = dashboard.SOURCE_PARAMS[source as dashboard.DataSourceId] ?? [];
  const needsList = params.some((p) => p.kind === "sheet" || p.kind === "watch");
  const { rows, loading } = useDataSources(docId, needsList);
  const [raw, setRaw] = useState(false);
  const set = (name: string, value: Json | undefined) => {
    const next = { ...args };
    if (value === undefined || value === "") delete next[name];
    else next[name] = value;
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {!raw ? (
        <div className="grid grid-cols-2 gap-2">
          {params.map((p) =>
            source === "sheet" && p.name === "range" && typeof args.doc === "string" && args.doc ? (
              <div key={p.name} className="col-span-2 space-y-1">
                <span className="text-meta text-sol-text-dim">{p.label}</span>
                <SheetRangePicker sheetId={args.doc} range={typeof args.range === "string" ? args.range : undefined} header={args.header !== false} onRange={(r) => set("range", r)} />
              </div>
            ) : (
              <ParamControl key={p.name} p={p} value={args[p.name]} rows={rows} loading={loading} onSet={(v) => set(p.name, v)} />
            ),
          )}
        </div>
      ) : (
        <RawArgs args={args} onChange={onChange} />
      )}
      <button type="button" onClick={() => setRaw((r) => !r)} aria-pressed={raw} className={`inline-flex items-center gap-1 text-meta ${raw ? "text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}>
        <Braces className="w-3 h-3" /> JSON
      </button>
    </div>
  );
}

function ParamControl({ p, value, rows, loading, onSet }: { p: dashboard.SourceParam; value: Json | undefined; rows: Array<{ source: string; label: string; args?: Record<string, unknown> }>; loading: boolean; onSet: (v: Json | undefined) => void }) {
  const wide = p.kind === "sheet" || (p.kind === "text" && (p.name === "query" || p.name === "range"));
  const label = <span className="text-meta text-sol-text-dim">{p.label}</span>;
  if (p.kind === "bool") {
    return (
      <label className="col-span-2 flex items-center gap-2 text-sm text-sol-text-secondary">
        <input type="checkbox" checked={value !== false} onChange={(e) => onSet(e.target.checked ? undefined : false)} className="accent-[var(--sol-blue)]" />
        {p.label}
      </label>
    );
  }
  if (p.kind === "enum") {
    return (
      <label className="block space-y-1 min-w-0">
        {label}
        <select value={String(value ?? p.options?.[0] ?? "")} onChange={(e) => onSet(e.target.value)} className={`${fieldCls} pr-6`}>
          {p.options?.map((o) => (
            <option key={o} value={o}>
              {o.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>
    );
  }
  if (p.kind === "sheet" || p.kind === "watch") {
    const want = p.kind === "sheet" ? "sheet" : "metric";
    const opts = rows.filter((r) => r.source === want).map((r) => ({ id: String(p.kind === "sheet" ? r.args?.doc : r.args?.watch), label: r.label }));
    const v = String(value ?? "");
    return (
      <label className={`block space-y-1 min-w-0 ${wide ? "col-span-2" : ""}`}>
        {label}
        <select value={v} onChange={(e) => onSet(e.target.value || undefined)} className={`${fieldCls} pr-6`}>
          <option value="">{opts.length ? "Pick one" : loading ? "Loading…" : "None in this workspace"}</option>
          {v && !opts.some((o) => o.id === v) ? <option value={v}>{v}</option> : null}
          {opts.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className={`block space-y-1 min-w-0 ${wide ? "col-span-2" : ""}`}>
      {label}
      <Committed
        value={value === undefined || value === null ? "" : String(value)}
        placeholder={p.placeholder}
        numeric={p.kind === "days"}
        max={p.max}
        onCommit={(t) => onSet(p.kind === "days" ? (t ? Number(t) : undefined) : t || undefined)}
      />
    </label>
  );
}

/** A text field that writes on blur or Enter, so typing stays cheap; a days field takes whole numbers only. */
function Committed({ value, placeholder, numeric, max, onCommit }: { value: string; placeholder?: string; numeric?: boolean; max?: number; onCommit: (v: string) => void }) {
  const { draft, setDraft, onFocus, onBlur } = useCommittedDraft(value);
  // A window the source can't serve is refused here, where it is typed, not after the save.
  const bad = numeric && draft !== "" && (!/^\d{1,3}$/.test(draft) || Number(draft) < 1 || (max !== undefined && Number(draft) > max));
  return (
    <input
      value={draft}
      inputMode={numeric ? "numeric" : undefined}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        onFocus();
        // A number is replaced, not appended to: typing 7 into "30" gives 7, not 307.
        if (numeric) e.currentTarget.select();
      }}
      onBlur={() => {
        onBlur();
        if (!bad && draft !== value) onCommit(draft);
      }}
      title={bad && max !== undefined ? `1 to ${max} days` : undefined}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      aria-invalid={bad || undefined}
      className={`${fieldCls} ${bad ? "border-sol-red/70" : ""}`}
    />
  );
}

function RawArgs({ args, onChange }: { args: Args; onChange: (next: Args) => void }) {
  const shown = JSON.stringify(args);
  const { draft, setDraft, onFocus, onBlur } = useCommittedDraft(shown);
  let error: string | null = null;
  let parsed: Args | null = null;
  try {
    const v = JSON.parse(draft || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) parsed = v as Args;
    else error = "Needs a JSON object";
  } catch {
    error = "Not valid JSON";
  }
  return (
    <div className="space-y-1">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={onFocus}
        onBlur={() => {
          onBlur();
          if (parsed && draft !== shown) onChange(parsed);
        }}
        rows={2}
        spellCheck={false}
        aria-label="Args as JSON"
        aria-invalid={!!error || undefined}
        className={`w-full resize-y rounded-md bg-sol-bg border px-2 py-1.5 font-mono text-[12px] text-sol-text outline-none focus:border-sol-blue ${error ? "border-sol-red/70" : "border-sol-border/60"}`}
      />
      {error ? <div className="text-meta text-sol-red">{error}</div> : null}
    </div>
  );
}
