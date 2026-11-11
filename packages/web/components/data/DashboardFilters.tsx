// The dashboard's own filters (state: hooks/useDashboardScope.ts): a date range and the categories its sources
// share (person, agent, project...), offered from the data itself. A choice
// lives in the URL (`?f.day=30d&f.person=ada`), so a filtered view is a link
// to send; every block whose source has the column narrows to it.
import { useState } from "react";
import { Calendar, Check, ChevronDown } from "lucide-react";
import { dashboard } from "@codecast/shared/artifacts";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { DATE_PRESETS as PRESETS, dateLabel } from "../../hooks/useDashboardScope";

export function DashboardFilters({ dims, value, values, set, clear }: { dims: dashboard.FilterDimension[]; value: (c: string) => string; values: (c: string) => string[]; set: (c: string, v: string | readonly string[] | null) => void; clear: () => void }) {
  if (!dims.length) return null;
  const any = dims.some((d) => value(d.column));
  return (
    <div className="mb-4 flex flex-wrap items-center gap-1.5" data-dashboard-filters data-export-skip>
      {dims.map((d) => (d.kind === "time" ? <DateChip key={d.column} spec={value(d.column)} onSet={(v) => set(d.column, v)} /> : <CategoryChip key={d.column} dim={d} chosen={values(d.column)} onSet={(v) => set(d.column, v)} />))}
      {any ? (
        <button type="button" onClick={clear} className="h-7 px-2 rounded-md text-xs text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt">
          Clear
        </button>
      ) : null}
    </div>
  );
}

const chipCls = (on: boolean) =>
  `inline-flex items-center gap-1.5 h-7 max-w-[260px] pl-2 pr-1.5 rounded-md border text-xs transition-colors ${on ? "border-sol-blue/50 bg-sol-blue/10 text-sol-text" : "border-sol-border/60 text-sol-text-muted hover:text-sol-text hover:border-sol-border"}`;

function DateChip({ spec, onSet }: { spec: string; onSet: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const m = spec.match(/^(\d{4}-\d\d-\d\d)?\.\.(\d{4}-\d\d-\d\d)?$/);
  const from = m?.[1] ?? "";
  const to = m?.[2] ?? "";
  const custom = (f: string, t: string) => onSet(f || t ? `${f}..${t}` : null);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={chipCls(!!spec)} data-filter-chip="date">
          <Calendar className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{spec ? dateLabel(spec) : "All dates"}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 p-1.5">
        {[{ spec: "", label: "All dates" }, ...PRESETS].map((p) => (
          <button
            key={p.spec}
            type="button"
            onClick={() => {
              onSet(p.spec || null);
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 h-7 px-2 rounded text-left text-xs text-sol-text hover:bg-sol-bg-alt"
          >
            <span className="w-3.5">{spec === p.spec ? <Check className="w-3.5 h-3.5 text-sol-blue" /> : null}</span>
            {p.label}
          </button>
        ))}
        <div className="mt-1 pt-1.5 border-t border-sol-border/50 grid grid-cols-2 gap-1.5 px-1 pb-1">
          <label className="space-y-0.5">
            <span className="text-meta text-sol-text-dim">From</span>
            <input type="date" value={from} max={to || undefined} onChange={(e) => custom(e.target.value, to)} className="w-full h-7 rounded-md bg-sol-bg border border-sol-border/60 px-1 text-xs text-sol-text outline-none focus:border-sol-blue" />
          </label>
          <label className="space-y-0.5">
            <span className="text-meta text-sol-text-dim">To</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => custom(from, e.target.value)} className="w-full h-7 rounded-md bg-sol-bg border border-sol-border/60 px-1 text-xs text-sol-text outline-none focus:border-sol-blue" />
          </label>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const NAME: Record<string, string> = { person: "Person", author: "Author", agent: "Agent", project: "Project", repository: "Repository", assignee: "Assignee", status: "Status", kind: "Kind", source: "Source", model: "Model", group: "Group" };

function CategoryChip({ dim, chosen, onSet }: { dim: dashboard.FilterDimension; chosen: string[]; onSet: (v: string[]) => void }) {
  const [q, setQ] = useState("");
  const toggle = (v: string) => onSet(chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]);
  const shown = q ? dim.values.filter((v) => v.toLowerCase().includes(q.toLowerCase())) : dim.values;
  const name = NAME[dim.column] ?? dim.column;
  return (
    <Popover onOpenChange={(o) => !o && setQ("")}>
      <PopoverTrigger asChild>
        <button type="button" className={chipCls(chosen.length > 0)} data-filter-chip={dim.column}>
          <span className="text-sol-text-dim">{name}</span>
          <span className="truncate">{chosen.length === 0 ? "All" : chosen.length === 1 ? chosen[0] : `${chosen[0]} +${chosen.length - 1}`}</span>
          <ChevronDown className="w-3 h-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1.5">
        {dim.values.length > 8 ? (
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${name.toLowerCase()}`} aria-label={`Find ${name.toLowerCase()}`} className="mb-1 w-full h-7 rounded-md bg-sol-bg border border-sol-border/60 px-2 text-xs text-sol-text outline-none focus:border-sol-blue" />
        ) : null}
        <div className="max-h-64 overflow-y-auto">
          {shown.map((v) => (
            <button key={v} type="button" role="menuitemcheckbox" aria-checked={chosen.includes(v)} onClick={() => toggle(v)} className="w-full flex items-center gap-2 h-7 px-2 rounded text-left text-xs text-sol-text hover:bg-sol-bg-alt">
              <span className={`grid place-items-center w-3.5 h-3.5 rounded-sm border ${chosen.includes(v) ? "bg-sol-blue border-sol-blue text-sol-bg" : "border-sol-border"}`}>{chosen.includes(v) ? <Check className="w-3 h-3" /> : null}</span>
              <span className="truncate">{v}</span>
            </button>
          ))}
          {!shown.length ? <div className="h-7 px-2 grid items-center text-xs text-sol-text-dim">No match</div> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
