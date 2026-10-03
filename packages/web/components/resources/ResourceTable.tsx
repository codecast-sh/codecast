"use client";

// The attribution table: one row per session (or per project, kind or
// machine), sized against everything the machines counted. A row opens into
// its processes; a process several sessions share appears once, in its own
// row, and each session that uses it points there instead of adding it.
import React from "react";
import { ChevronRight, ExternalLink, Moon, Play, Share2, Square } from "lucide-react";
import type { ResourceProcess } from "@codecast/shared/contracts";
import { cn } from "../../lib/utils";
import { KIND_LABEL, fmtAgo, fmtBytes, fmtCpu, projectName, type TableRow, type Usage } from "./resourceModel";
import type { ResourceActions, ResourceMachine, ResourceSession, ResourceSessionState } from "./types";

const STATE_STYLE: Record<ResourceSessionState, { dot: string; label: string }> = {
  working: { dot: "bg-sol-green", label: "working" },
  needs_input: { dot: "bg-sol-yellow", label: "needs you" },
  idle: { dot: "bg-sol-text-dim", label: "idle" },
  hibernated: { dot: "bg-sol-violet/70", label: "parked" },
  dead: { dot: "bg-sol-red/70", label: "exited" },
};

const COLS = "grid grid-cols-[1.25rem_minmax(0,1fr)_4.5rem_5.5rem] sm:grid-cols-[1.25rem_minmax(0,1fr)_5.5rem_7.5rem_7.5rem_3.5rem_4.5rem] items-center gap-x-3";

function Bar({ share, tone }: { share: number; tone: string }) {
  return (
    <span className="mt-0.5 block h-[3px] w-full overflow-hidden rounded-full bg-sol-bg-highlight/70">
      <span className={cn("block h-full rounded-full", tone)} style={{ width: `${Math.max(share > 0 ? 2 : 0, Math.min(100, share * 100))}%` }} />
    </span>
  );
}

function Num({ value, share, tone, className }: { value: string; share: number; tone: string; className?: string }) {
  return (
    <div className={cn("min-w-0 text-right", className)}>
      <span className="text-[12px] tabular-nums text-sol-text">{value}</span>
      <Bar share={share} tone={tone} />
    </div>
  );
}

function Disabled({ why, children }: { why: string; children: React.ReactNode }) {
  return <span title={why} className="inline-flex cursor-not-allowed items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-sol-text-dim opacity-60">{children}</span>;
}

function ActionButton({ onClick, children, tone }: { onClick: () => void; children: React.ReactNode; tone?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] hover:bg-sol-bg-highlight", tone ?? "text-sol-text")}>
      {children}
    </button>
  );
}

function ProcessTable({ processes, totals, remainder, machines }: { processes: ResourceProcess[]; totals: Usage; remainder?: Usage; machines: ResourceMachine[] }) {
  const [all, setAll] = React.useState(false);
  const shown = all ? processes : processes.slice(0, 12);
  return (
    <div className="text-[11px]">
      <div className="grid grid-cols-[4rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem] gap-x-3 border-b border-sol-border/20 pb-1 text-[10px] uppercase tracking-wide text-sol-text-dim sm:grid-cols-[4rem_minmax(0,1fr)_5.5rem_4.5rem_5rem_5rem]">
        <span>PID</span><span>Process</span><span className="hidden sm:block">Kind</span><span className="text-right">CPU</span><span className="text-right">Resident</span><span className="text-right">Started</span>
      </div>
      {shown.map((p) => (
        <div key={`${p.pid}:${p.startedAt ?? 0}`} className="grid grid-cols-[4rem_minmax(0,1fr)_4.5rem_4.5rem_4.5rem] gap-x-3 py-[3px] text-sol-text-secondary sm:grid-cols-[4rem_minmax(0,1fr)_5.5rem_4.5rem_5rem_5rem]">
          <span className="tabular-nums text-sol-text-dim">{p.pid}</span>
          <span className="truncate" title={p.name}>{p.name}</span>
          <span className="hidden text-sol-text-muted sm:block">{KIND_LABEL[p.kind].toLowerCase()}</span>
          <span className={cn("text-right tabular-nums", totals.cpu > 0 && p.cpu / totals.cpu > 0.3 && "text-sol-blue")}>{fmtCpu(p.cpu)}</span>
          <span className="text-right tabular-nums">{fmtBytes(p.rss)}</span>
          <span className="text-right text-sol-text-dim">{p.startedAt ? fmtAgo(p.startedAt, Date.now()).replace(" ago", "") : "n/a"}</span>
        </div>
      ))}
      {processes.length > 12 && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 text-[11px] text-sol-cyan hover:underline">
          {all ? "Show fewer" : `Show all ${processes.length} processes`}
        </button>
      )}
      {remainder && remainder.count > 0 && (
        <div className="mt-1.5 border-t border-dashed border-sol-border/30 pt-1.5 text-sol-text-muted">
          +{remainder.count.toLocaleString()} more processes the machine counted but did not list
          ({machines.length > 1 ? "each machine lists" : "it lists"} its 256 largest): {fmtCpu(remainder.cpu)} CPU, {fmtBytes(remainder.rss)} resident.
          They belong to no session we can name.
        </div>
      )}
    </div>
  );
}

function SharedRefs({ session, sharedRows }: { session: ResourceSession; sharedRows: TableRow[] }) {
  const mine = sharedRows.filter((r) => r.sharedWithIds?.includes(session.sessionId));
  if (mine.length === 0) return null;
  return (
    <div className="mt-2 text-[11px] text-sol-text-muted">
      <div className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-wide text-sol-text-dim"><Share2 className="h-3 w-3" /> Also uses, not counted here</div>
      {mine.map((r) => (
        <div key={r.key} className="flex gap-2">
          <span className="truncate text-sol-text-secondary">{r.label}</span>
          <span className="shrink-0 tabular-nums">{fmtCpu(r.usage.cpu)} · {fmtBytes(r.usage.rss)}</span>
          <span className="shrink-0">shared with {r.sharedWithIds!.length - 1} other{r.sharedWithIds!.length === 2 ? "" : "s"}; stays if this session moves</span>
        </div>
      ))}
    </div>
  );
}

export type ResourceTableProps = {
  rows: TableRow[];
  /** Every shared row on screen, so a session can point at the ones it uses. */
  sharedRows: TableRow[];
  totals: Usage;
  machines: ResourceMachine[];
  now: number;
  selected: Set<string>;
  onToggle: (sessionId: string) => void;
  actions?: ResourceActions;
  actionsDisabledReason?: string;
  showMachine: boolean;
};

export function ResourceTable({ rows, sharedRows, totals, machines, now, selected, onToggle, actions, actionsDisabledReason, showMachine }: ResourceTableProps) {
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const toggleOpen = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const machineName = (id: string) => machines.find((m) => m.deviceId === id)?.name ?? id;
  const off = actionsDisabledReason ?? "Not available here";

  const renderRow = (r: TableRow, depth = 0): React.ReactNode => {
    const isOpen = open.has(r.key);
    const s = r.session;
    const st = s ? STATE_STYLE[s.state] : undefined;
    const canSelect = r.type === "session" && !!s;
    return (
      <React.Fragment key={r.key}>
        <div
          className={cn(
            COLS,
            "group cursor-pointer border-b border-sol-border/15 px-3 py-1.5 hover:bg-sol-bg-highlight/40",
            isOpen && "bg-sol-bg-highlight/30",
            r.type === "unattributed" && "text-sol-text-muted",
            s && selected.has(s.sessionId) && "bg-sol-cyan/[0.07]",
          )}
          onClick={() => toggleOpen(r.key)}
          data-row-type={r.type}
        >
          <span className="flex items-center" onClick={(e) => e.stopPropagation()}>
            {canSelect ? (
              <input
                type="checkbox"
                aria-label={`Select ${r.label}`}
                className="h-3 w-3 accent-[var(--sol-cyan,#2aa198)]"
                checked={selected.has(s!.sessionId)}
                onChange={() => onToggle(s!.sessionId)}
              />
            ) : null}
          </span>
          <button
            type="button"
            aria-expanded={isOpen}
            onClick={(e) => { e.stopPropagation(); toggleOpen(r.key); }}
            className="min-w-0 rounded-sm text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-sol-cyan"
            style={{ paddingLeft: depth * 14 }}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <ChevronRight className={cn("h-3 w-3 shrink-0 text-sol-text-dim transition-transform", isOpen && "rotate-90")} />
              {r.type === "shared" && <Share2 className="h-3 w-3 shrink-0 text-sol-cyan" />}
              <span className={cn("truncate text-[12px]", r.type === "session" ? "text-sol-text" : r.type === "unattributed" ? "italic" : "font-medium text-sol-text")} title={r.label}>{r.label}</span>
              {s?.pinned && <span className="shrink-0 rounded border border-sol-border/40 px-1 text-[9px] text-sol-text-dim">pinned</span>}
              {s?.agentType && !/claude/i.test(s.agentType) && <span className="shrink-0 rounded border border-sol-border/40 px-1 text-[9px] text-sol-text-dim">{s.agentType}</span>}
            </span>
            <span className="ml-[18px] block truncate text-[10px] text-sol-text-dim">
              {s ? [s.shortId, projectName(s.projectPath), showMachine ? machineName(r.deviceIds[0]) : undefined].filter(Boolean).join(" · ")
                : r.sublabel ?? (r.children ? `${r.children.length} ${r.children.length === 1 ? "row" : "rows"}${showMachine && r.type !== "machine" ? ` · ${r.deviceIds.map(machineName).join(", ")}` : ""}` : "")}
            </span>
          </button>
          <div className="hidden items-center gap-1.5 text-[11px] text-sol-text-muted sm:flex">
            {st ? <><span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", st.dot, s!.state === "working" && "animate-pulse")} />{st.label}</> : <span className="text-sol-text-dim">{r.type === "shared" ? "shared" : r.type === "unattributed" ? "unowned" : `${r.usage.count.toLocaleString()} ${r.usage.count === 1 ? "proc" : "procs"}`}</span>}
          </div>
          {r.unmeasured ? (
            <span className="col-span-2 text-right text-[11px] text-sol-text-dim sm:col-span-3" title="No processes for this session appeared in the latest sample, so there is nothing to measure">
              {r.unmeasured === "list_unavailable" ? "usage unavailable" : s?.state === "hibernated" ? "parked, no processes" : "no processes in sample"}
            </span>
          ) : (
            <>
              <Num value={fmtCpu(r.usage.cpu)} share={totals.cpu ? r.usage.cpu / totals.cpu : 0} tone="bg-sol-blue" />
              <Num value={fmtBytes(r.usage.rss)} share={totals.rss ? r.usage.rss / totals.rss : 0} tone="bg-sol-violet" />
              <span className="hidden text-right text-[11px] tabular-nums text-sol-text-muted sm:block">{r.usage.count.toLocaleString()}</span>
            </>
          )}
          <span className="hidden text-right text-[11px] text-sol-text-muted sm:block">
            {s ? (s.state === "working" ? "now" : fmtAgo(s.lastActiveAt, now).replace(" ago", "")) : ""}
          </span>
        </div>
        {isOpen && (
          <div className="border-b border-sol-border/20 bg-sol-bg-alt/60 py-2 pl-10 pr-3">
            {r.children ? (
              <div>{r.children.map((c) => renderRow(c, depth + 1))}</div>
            ) : (
              <>
                {s && (
                  <div className="mb-2 flex flex-wrap items-center gap-1">
                    {actions?.onOpenSession ? <ActionButton onClick={() => actions.onOpenSession!(s.sessionId)}><ExternalLink className="h-3 w-3" /> Open</ActionButton> : <Disabled why={off}><ExternalLink className="h-3 w-3" /> Open</Disabled>}
                    {s.state === "hibernated"
                      ? (actions?.onResume ? <ActionButton onClick={() => actions.onResume!([s.sessionId])}><Play className="h-3 w-3" /> Resume</ActionButton> : <Disabled why={actionsDisabledReason ?? "A parked session resumes when you send it a message; open it to continue"}><Play className="h-3 w-3" /> Resume</Disabled>)
                      : (actions?.onPark && s.state !== "working"
                        ? <ActionButton onClick={() => actions.onPark!([s.sessionId])}><Moon className="h-3 w-3" /> Park</ActionButton>
                        : <Disabled why={s.state === "working" ? "Working sessions are not parked; wait for the turn to end" : off}><Moon className="h-3 w-3" /> Park</Disabled>)}
                    <Disabled why="Stopping a single process is not offered: it needs an ownership and identity check the daemon does not make yet. Park the session to stop its processes safely."><Square className="h-3 w-3" /> Stop process</Disabled>
                  </div>
                )}
                {r.type === "shared" && (
                  <div className="mb-2 text-[11px] text-sol-text-muted">
                    Serves {r.sharedWith?.map((x) => x.title).join(", ") || `${r.sharedWithIds?.length} sessions`}. Counted once here, never in each session. It stays on this machine when any one of them moves.
                  </div>
                )}
                {r.unmeasured
                  ? <div className="text-[11px] text-sol-text-muted">{r.unmeasured === "list_unavailable" ? "The latest sample could not list processes, so this session's usage is unknown." : `No processes for this session appeared in the latest sample${s?.state === "hibernated" ? "; it is parked and resumes when you resume it or send it a message" : ""}.`}</div>
                  : <ProcessTable processes={r.processes} totals={r.usage} remainder={r.remainder} machines={machines} />}
                {s && <SharedRefs session={s} sharedRows={sharedRows} />}
              </>
            )}
          </div>
        )}
      </React.Fragment>
    );
  };

  return (
    <div role="table" aria-label="Resources by session">
      <div className={cn(COLS, "sticky top-0 z-[1] border-b border-sol-border/30 bg-sol-bg px-3 py-1 text-[10px] uppercase tracking-wide text-sol-text-dim")}>
        <span />
        <span>Name</span>
        <span className="hidden sm:block">State</span>
        <span className="text-right">CPU</span>
        <span className="text-right" title="Resident memory, including pages shared between processes. Not the same as memory a move would free.">Resident</span>
        <span className="hidden text-right sm:block">Procs</span>
        <span className="hidden text-right sm:block">Idle</span>
      </div>
      {rows.map((r) => renderRow(r))}
      <div className={cn(COLS, "px-3 py-1.5 text-[11px] text-sol-text-muted")}>
        <span />
        <span>Machine total{machines.length > 1 ? "s" : ""}</span>
        <span className="hidden sm:block" />
        <span className="text-right tabular-nums">{fmtCpu(totals.cpu)}</span>
        <span className="text-right tabular-nums">{fmtBytes(totals.rss)}</span>
        <span className="hidden text-right tabular-nums sm:block">{totals.count.toLocaleString()}</span>
        <span className="hidden sm:block" />
      </div>
      <p className="px-3 pb-3 text-[10px] leading-relaxed text-sol-text-dim">
        Resident memory counts pages processes share, so these sums can exceed the machine's memory in use, and they are not what moving a session frees.
        CPU counts one core as 100%.
      </p>
    </div>
  );
}
