// The bar over a live query tab: what it shows (source, project, task status)
// as menus a person can change, when it last loaded, and Refresh.
import { Check, ChevronDown, Radio, RefreshCw } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { TASK_STATUS_CATEGORIES } from "@codecast/shared/tasks";
import type { QuerySource, TabQuery } from "./sheetCore";
import { QUERY_LABEL, ago } from "./sheetActions";

const SOURCES = Object.keys(QUERY_LABEL) as QuerySource[];
const STATUS_LABEL: Record<string, string> = { "": "Not done", all: "All", backlog: "Backlog", open: "Open", in_progress: "In progress", in_review: "In review", done: "Done", dropped: "Dropped" };
const projectName = (p: { title?: string; status?: string }) => (p.status === "archived" ? "" : p.title ?? "");

function Chip({ label, value, options, onPick, disabled }: { label: string; value: string; options: Array<{ v: string; text: string }>; onPick: (v: string) => void; disabled?: boolean }) {
  if (disabled) return <span className="sheet-query-chip">{options.find((o) => o.v === value)?.text ?? value}</span>;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="sheet-query-chip is-menu" aria-label={label}>
        {options.find((o) => o.v === value)?.text ?? value}
        <ChevronDown className="w-3 h-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto" data-owns-keys>
        {options.map((o) => (
          <DropdownMenuItem key={o.v || "_"} onSelect={() => onPick(o.v)}>
            <Check className={`w-3.5 h-3.5 ${o.v === value ? "" : "invisible"}`} /> {o.text}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function QueryBar({ query, refreshedAt, error, refreshing, readOnly, now, empty, onChange, onRefresh }: {
  query: TabQuery;
  /** Loaded, and nothing matched (the header row alone). */
  empty: boolean;
  refreshedAt?: number;
  error?: string | null;
  refreshing: boolean;
  readOnly: boolean;
  now: number;
  onChange: (q: TabQuery) => void;
  onRefresh: () => void;
}) {
  const projects = useWorkspaceCollection<{ title?: string; status?: string }>("projects", projectName);
  const names = [...new Set(projects.map(projectName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const set = (patch: Partial<TabQuery>) => {
    const next: TabQuery = { ...query, ...patch };
    for (const k of Object.keys(next) as Array<keyof TabQuery>) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange(next);
  };
  return (
    <div className="sheet-query-bar" data-sheet-query>
      <Radio className="w-3.5 h-3.5 text-sol-green" />
      <span className="text-sol-text">Live</span>
      <Chip label="Source" value={query.source} disabled={readOnly} options={SOURCES.map((s) => ({ v: s, text: QUERY_LABEL[s] }))} onPick={(v) => set({ source: v as QuerySource, ...(v === "tasks" ? {} : { status: undefined }), ...(v === "metrics" ? { project: undefined } : {}) })} />
      {query.source !== "metrics" && (
        <Chip
          label="Project"
          value={query.project ?? ""}
          disabled={readOnly}
          options={[{ v: "", text: "All projects" }, ...(query.project && !names.includes(query.project) ? [query.project] : []).concat(names).map((n) => ({ v: n, text: n }))]}
          onPick={(v) => set({ project: v || undefined })}
        />
      )}
      {query.source === "tasks" && (
        <Chip label="Status" value={query.status ?? ""} disabled={readOnly} options={["", "all", ...TASK_STATUS_CATEGORIES].map((s) => ({ v: s, text: STATUS_LABEL[s] ?? s }))} onPick={(v) => set({ status: v || undefined })} />
      )}
      <span className="text-sol-text-dim">{refreshedAt ? `updated ${ago(refreshedAt, now)}` : "loading"}</span>
      {error ? <span className="text-sol-red truncate">{error}</span> : empty && refreshedAt ? <span className="sheet-query-chip">0 {QUERY_LABEL[query.source].toLowerCase()}</span> : null}
      <span className="flex-1" />
      <button type="button" className="sheet-query-refresh" onClick={onRefresh} disabled={refreshing || readOnly}>
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
      </button>
    </div>
  );
}
