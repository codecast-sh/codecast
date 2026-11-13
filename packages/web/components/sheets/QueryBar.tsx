// The bar over a live query tab: what it shows (source, project, task status)
// as menus a person can change, when it last loaded, and Refresh.
import { Check, ChevronDown, Radio, RefreshCw } from "lucide-react";
import { useRef, useState } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { useMountEffect } from "../../hooks/useMountEffect";
import { TASK_STATUS_CATEGORIES } from "@codecast/shared/tasks";
import type { QuerySource, TabQuery } from "./sheetCore";
import { QUERY_LABEL, ago } from "./sheetActions";

const SOURCES = Object.keys(QUERY_LABEL) as QuerySource[];
const STATUS_LABEL: Record<string, string> = { "": "Not done", all: "All", backlog: "Backlog", open: "Open", in_progress: "In progress", in_review: "In review", done: "Done", dropped: "Dropped" };
// Finished projects drop out of the menu; planning and paused ones still hold tasks.
const projectName = (p: { title?: string; status?: string }) => (p.status === "done" ? "" : p.title ?? "");

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

export function QueryBar({ query, refreshedAt, error, refreshing, readOnly, now, empty, workspace, onChange, onRefresh }: {
  query: TabQuery;
  /** The sheet's workspace: its projects are the ones a query can name (the server looks them up there). */
  workspace?: string;
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
  const barRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useMountEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 760));
    ro.observe(el);
    return () => ro.disconnect();
  });
  const projects = useWorkspaceCollection<{ title?: string; status?: string }>("projects", projectName, workspace ?? null);
  const names = [...new Set(projects.map(projectName).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const set = (patch: Partial<TabQuery>) => {
    const next: TabQuery = { ...query, ...patch };
    for (const k of Object.keys(next) as Array<keyof TabQuery>) if (next[k] === undefined || next[k] === "") delete next[k];
    onChange(next);
  };
  // Source, project and status: three menus, or one folded menu when the bar is narrow.
  type ChipSpec = { label: string; value: string; options: Array<{ v: string; text: string }>; onPick: (v: string) => void };
  const chips: ChipSpec[] = [
    { label: "Source", value: query.source, options: SOURCES.map((x) => ({ v: x, text: QUERY_LABEL[x] })), onPick: (v) => set({ source: v as QuerySource, ...(v === "tasks" ? {} : { status: undefined }), ...(v === "metrics" ? { project: undefined } : {}) }) },
    ...(query.source !== "metrics"
      ? [{ label: "Project", value: query.project ?? "", options: [{ v: "", text: "All projects" }, ...(query.project && !names.includes(query.project) ? [query.project] : []).concat(names).map((n) => ({ v: n, text: n }))], onPick: (v: string) => set({ project: v || undefined }) }]
      : []),
    ...(query.source === "tasks" ? [{ label: "Status", value: query.status ?? "", options: ["", "all", ...TASK_STATUS_CATEGORIES].map((x) => ({ v: x, text: STATUS_LABEL[x] ?? x })), onPick: (v: string) => set({ status: v || undefined }) }] : []),
  ];
  const textOf = (c: ChipSpec) => c.options.find((o) => o.v === c.value)?.text ?? c.value;
  return (
    <div className="sheet-query-bar" data-sheet-query ref={barRef}>
      <Radio className="w-3.5 h-3.5 text-sol-green" />
      <span className="text-sol-text">Live</span>
      {narrow && !readOnly ? (
        // A narrow bar folds the three menus into one, so nothing wraps.
        <DropdownMenu>
          <DropdownMenuTrigger className="sheet-query-chip is-menu is-folded" aria-label="Query">
            <span className="truncate">{chips.map((c) => textOf(c)).join(" · ")}</span>
            <ChevronDown className="w-3 h-3 shrink-0" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" data-owns-keys>
            {chips.map((c) => (
              <DropdownMenuSub key={c.label}>
                <DropdownMenuSubTrigger>{c.label} <span className="ml-auto pl-3 text-sol-text-dim">{textOf(c)}</span></DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-80 overflow-y-auto">
                  {c.options.map((o) => (
                    <DropdownMenuItem key={o.v || "_"} onSelect={() => c.onPick(o.v)}>
                      <Check className={`w-3.5 h-3.5 ${o.v === c.value ? "" : "invisible"}`} /> {o.text}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        chips.map((c) => <Chip key={c.label} label={c.label} value={c.value} disabled={readOnly} options={c.options} onPick={c.onPick} />)
      )}
      <span className="text-sol-text-dim">{refreshedAt ? `updated ${ago(refreshedAt, now)}` : "loading"}</span>
      {error ? <span className="text-sol-red truncate">{error}</span> : empty && refreshedAt ? <span className="sheet-query-chip">0 {QUERY_LABEL[query.source].toLowerCase()}</span> : null}
      {/* The way out of a narrow or failing query: widen it in one press. */}
      {!readOnly && (error || (empty && refreshedAt)) && query.project && (
        <button type="button" className="sheet-query-widen" onClick={() => set({ project: undefined })}>All projects</button>
      )}
      {!readOnly && !error && empty && refreshedAt && !query.project && query.source === "tasks" && query.status !== "all" && (
        <button type="button" className="sheet-query-widen" onClick={() => set({ status: "all" })}>Include done</button>
      )}
      <span className="flex-1" />
      <button type="button" className="sheet-query-refresh" onClick={onRefresh} disabled={refreshing || readOnly}>
        <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
      </button>
    </div>
  );
}
