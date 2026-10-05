"use client";

// The resource monitor: every machine you run, what it is spending, and which
// sessions are spending it. Presentational: it renders ResourceMonitorProps
// and calls back, so the live page and the fixture preview share every pixel.
import React from "react";
import { AlertTriangle, Cloud, Laptop, Search, X } from "lucide-react";
import { sustainedResourcePressure } from "@codecast/shared/contracts";
import { cn } from "../../lib/utils";
import { HealthStrip, MiniTrace } from "./HealthStrip";
import { OffloadReview, OffloadRuns } from "./OffloadReview";
import { ResourceTable } from "./ResourceTable";
import {
  KINDS, KIND_LABEL, buildRows, processesUnavailable, fmtAgo, fmtBytes, freshness, machineTotals, memoryUsed, memoryUsedPct, sortRows, DEFAULT_SORT_DIR,
  type Freshness, type GroupBy, type Sort, type SortBy, type TableRow, type Usage,
} from "./resourceModel";
import type { ResourceMachine, ResourceMonitorProps, ResourceSessionState } from "./types";

const FRESH_DOT: Record<Freshness, string> = {
  live: "bg-sol-green",
  stale: "bg-sol-yellow",
  cold: "bg-sol-text-dim/50",
  offline: "bg-sol-text-dim/30",
};
const FRESH_LABEL: Record<Freshness, string> = { live: "live", stale: "stale", cold: "no data yet", offline: "offline" };

const KIND_TONE: Record<string, string> = {
  agent: "bg-sol-cyan", tool: "bg-sol-blue", browser: "bg-sol-orange", simulator: "bg-sol-magenta", app: "bg-sol-violet", system: "bg-sol-text-dim/60",
};

type StateFilter = "all" | ResourceSessionState;

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center rounded border border-sol-border/40 p-px">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn("rounded-[3px] px-1.5 py-0.5 text-[11px]", value === v ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:text-sol-text")}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

function MachineIcon({ m, className }: { m: ResourceMachine; className?: string }) {
  return m.role === "local" ? <Laptop className={className} /> : <Cloud className={className} />;
}

function Composition({ machines }: { machines: ResourceMachine[] }) {
  const byKind = new Map<string, Usage>();
  for (const m of machines) for (const g of m.snapshot?.groups ?? []) {
    const u = byKind.get(g.kind) ?? { cpu: 0, rss: 0, count: 0 };
    u.cpu += g.cpu; u.rss += g.rss; u.count += g.processCount;
    byKind.set(g.kind, u);
  }
  const total = { cpu: 0, rss: 0 };
  for (const u of byKind.values()) { total.cpu += u.cpu; total.rss += u.rss; }
  if (!total.cpu && !total.rss) return null;
  const bar = (f: (u: Usage) => number, t: number, label: string) => (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-wide text-sol-text-dim">{label}</span>
      <div className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-sm bg-sol-bg-highlight/60">
        {KINDS.map((k) => {
          const u = byKind.get(k); if (!u || !t) return null;
          return <span key={k} className={cn("h-full", KIND_TONE[k])} style={{ width: `${(f(u) / t) * 100}%` }} title={`${KIND_LABEL[k]}: ${label === "CPU" ? `${(f(u) / 100).toFixed(1)} cores` : fmtBytes(f(u))}`} />;
        })}
      </div>
    </div>
  );
  return (
    <div className="space-y-1 border-b border-sol-border/30 px-4 py-2">
      {bar((u) => u.cpu, total.cpu, "CPU")}
      {bar((u) => u.rss, total.rss, "Resident")}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 pl-16 text-[10px] text-sol-text-muted">
        {KINDS.filter((k) => byKind.has(k)).map((k) => (
          <span key={k} className="inline-flex items-center gap-1"><span className={cn("h-1.5 w-1.5 rounded-sm", KIND_TONE[k])} />{KIND_LABEL[k]} {fmtBytes(byKind.get(k)!.rss)}</span>
        ))}
      </div>
    </div>
  );
}

function MachineList({ machines, now, onPick }: { machines: ResourceMachine[]; now: number; onPick: (id: string) => void }) {
  return (
    <div className="border-b border-sol-border/30">
      {machines.map((m) => {
        const f = freshness(m, now);
        const p = m.snapshot?.sample;
        return (
          <button key={m.deviceId} type="button" onClick={() => onPick(m.deviceId)} className={cn("grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-sol-border/15 px-4 py-2 text-left last:border-b-0 hover:bg-sol-bg-highlight/40 sm:grid-cols-[minmax(0,14rem)_1fr_1fr_auto]", f !== "live" && "opacity-70")}>
            <span className="flex min-w-0 items-center gap-2 text-[12px] text-sol-text">
              <MachineIcon m={m} className="h-3.5 w-3.5 shrink-0 text-sol-text-muted" />
              <span className="truncate">{m.name}</span>
            </span>
            <span className="hidden items-center gap-2 text-[11px] tabular-nums text-sol-blue sm:flex">
              <MiniTrace points={m.history} f={(q) => q.cpuPercent} max={100} />
              {p?.cpuPercent !== undefined ? `${p.cpuPercent.toFixed(0)}% CPU` : ""}
            </span>
            <span className="hidden items-center gap-2 text-[11px] tabular-nums text-sol-violet sm:flex">
              <MiniTrace points={m.history} f={memoryUsedPct} max={100} />
              {p ? `${fmtBytes(memoryUsed(p))} / ${fmtBytes(p.memoryTotal)}` : ""}
            </span>
            <span className="flex items-center gap-1.5 text-[10px] text-sol-text-muted">
              <span className={cn("h-1.5 w-1.5 rounded-full", FRESH_DOT[f])} />
              {m.asleep && !m.online ? "asleep" : f === "live" ? `${p?.pressure ?? ""} pressure` : f === "stale" || f === "offline" ? `${FRESH_LABEL[f]} · ${fmtAgo(m.receivedAt, now)}` : FRESH_LABEL[f]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ResourceMonitor({ machines, sessions, ready, now, plans = [], runs = [], actions, actionsDisabledReason, sampleNotice }: ResourceMonitorProps) {
  const reporting = machines.filter((m) => m.snapshot || m.online);
  const defaultMachine = plans[0]?.deviceId
    ?? reporting.find((m) => m.role === "local" && freshness(m, now) === "live")?.deviceId
    ?? reporting[0]?.deviceId ?? "all";
  const [machineId, setMachineId] = React.useState<string>(defaultMachine);
  React.useEffect(() => {
    if (machineId !== "all" && !machines.some((m) => m.deviceId === machineId)) setMachineId(defaultMachine);
  }, [machines, machineId, defaultMachine]);
  const [groupBy, setGroupBy] = React.useState<GroupBy>("session");
  const [sort, setSort] = React.useState<Sort>({ by: "memory", dir: "desc" });
  const onSort = (by: SortBy) => setSort((s) => (s.by === by ? { by, dir: s.dir === "asc" ? "desc" : "asc" } : { by, dir: DEFAULT_SORT_DIR[by] }));
  const [stateFilter, setStateFilter] = React.useState<StateFilter>("all");
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [reviewing, setReviewing] = React.useState<{ deviceId: string; preselect?: string[] } | null>(null);

  const scope = machineId === "all" ? machines : machines.filter((m) => m.deviceId === machineId);
  const machine = machineId === "all" ? undefined : scope[0];
  const fr = machine ? freshness(machine, now) : undefined;

  const allRows = React.useMemo(() => buildRows(scope, sessions, groupBy), [scope, sessions, groupBy]);
  const sharedRows = React.useMemo(() => buildRows(scope, sessions, "session").filter((r) => r.type === "shared"), [scope, sessions]);
  const q = query.trim().toLowerCase();
  const matches = (r: TableRow): boolean => {
    if (r.children) return r.children.some(matches) || (!!q && r.label.toLowerCase().includes(q));
    if (stateFilter !== "all" && r.session?.state !== stateFilter) return false;
    if (!q) return true;
    return [r.label, r.session?.shortId, r.session?.projectPath, ...r.processes.map((p) => p.name)].some((s) => s?.toLowerCase().includes(q));
  };
  const rows = sortRows(allRows.filter(matches), sort);
  const totals = scope.reduce<Usage>((a, m) => {
    if (!m.snapshot) return a;
    const t = machineTotals(m.snapshot);
    return { cpu: a.cpu + t.cpu, rss: a.rss + t.rss, count: a.count + t.count };
  }, { cpu: 0, rss: 0, count: 0 });

  const plan = plans.find((p) => p.deviceId === (reviewing?.deviceId ?? machine?.deviceId)) ?? (machineId === "all" ? plans[0] : undefined);
  const incident = plan?.incident ?? (machine && fr === "live" ? sustainedResourcePressure(machine.history, now) : null);
  const destinations = new Map(machines.map((m) => [m.deviceId, m.name]));
  for (const p of plans) for (const d of p.destinations) destinations.set(d.deviceId, d.name);
  const selectedIds = [...selected];
  const off = actionsDisabledReason ?? "Not available here";

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectedSessions = sessions.filter((s) => selected.has(s.sessionId));
  const parkable = selectedSessions.filter((s) => s.state === "idle" || s.state === "needs_input");
  const resumable = selectedSessions.filter((s) => s.state === "hibernated");

  if (!ready && machines.length === 0) {
    return (
      <div className="flex h-full flex-col bg-sol-bg" aria-busy="true">
        <div className="h-11 border-b border-sol-border/30" />
        <div className="grid grid-cols-2 gap-px border-b border-sol-border/30 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-[88px] animate-pulse bg-sol-bg-highlight/30" />)}
        </div>
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="mx-3 my-1.5 h-6 animate-pulse rounded bg-sol-bg-highlight/25" />)}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-sol-bg text-sol-text">
      <div className={cn("flex min-w-0 flex-1 flex-col", reviewing && "hidden lg:flex")}>
        {sampleNotice && (
          <div className="border-b border-sol-yellow/30 bg-sol-yellow/10 px-4 py-1 text-[11px] text-sol-yellow" role="note">{sampleNotice}</div>
        )}
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-sol-border/30 px-4 py-2">
          <h1 className="text-[13px] font-semibold">Resources</h1>
          {machines.length > 0 && (
            <nav className="-mb-px flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" aria-label="Machines">
              {machines.length > 1 && (
                <button type="button" onClick={() => setMachineId("all")} className={cn("shrink-0 rounded px-2 py-1 text-[11px]", machineId === "all" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:text-sol-text")}>
                  All machines
                </button>
              )}
              {machines.map((m) => {
                const f = freshness(m, now);
                const hot = plans.some((p) => p.deviceId === m.deviceId);
                return (
                  <button
                    key={m.deviceId}
                    type="button"
                    onClick={() => setMachineId(m.deviceId)}
                    aria-current={machineId === m.deviceId ? "true" : undefined}
                    title={`${m.name}: ${m.asleep && !m.online ? "asleep" : FRESH_LABEL[f]}`}
                    className={cn("inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[11px]", machineId === m.deviceId ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:text-sol-text")}
                  >
                    <MachineIcon m={m} className="h-3 w-3" />
                    <span className="max-w-[11rem] truncate">{m.name}</span>
                    {hot ? <AlertTriangle className="h-3 w-3 text-sol-red" /> : <span className={cn("h-1.5 w-1.5 rounded-full", FRESH_DOT[f])} />}
                  </button>
                );
              })}
            </nav>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {machines.length === 0 ? (
            <div className="px-6 py-16 text-center">
              <p className="text-[13px] text-sol-text">No machine has reported resources yet.</p>
              <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-sol-text-muted">
                Each machine running the codecast daemon reports its CPU, memory and processes about every 30 seconds once it is on a version with resource reporting. Update the daemon on a machine and it appears here.
              </p>
            </div>
          ) : (
            <>
              {incident && (
                <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-[12px]", incident.level === "critical" ? "border-sol-red/30 bg-sol-red/[0.07]" : "border-sol-yellow/30 bg-sol-yellow/[0.07]")}>
                  <AlertTriangle className={cn("h-3.5 w-3.5 shrink-0", incident.level === "critical" ? "text-sol-red" : "text-sol-yellow")} />
                  <span className="min-w-0 flex-1">
                    <span className="text-sol-text">{incident.reason}</span>
                    <span className="text-sol-text-muted"> for {fmtAgo(incident.since, now).replace(" ago", "")}{machineId === "all" && plan ? ` on ${destinations.get(plan.deviceId)}` : ""}.</span>
                    {plan && (() => {
                      const movable = plan.candidates.filter((c) => Object.values(c.perDestination).some((d) => d.readiness === "ready" || d.readiness === "preflight_required")).length;
                      return <span className="text-sol-text-muted"> {movable} of {plan.candidates.length} reviewed session{plan.candidates.length === 1 ? "" : "s"} could move.</span>;
                    })()}
                  </span>
                  {plan && (
                    <button type="button" onClick={() => setReviewing({ deviceId: plan.deviceId })} className="rounded bg-sol-text px-2 py-0.5 text-[11px] font-semibold text-sol-bg hover:opacity-90">
                      Review suggestion
                    </button>
                  )}
                  {plan && (actions?.onDismissPlan
                    ? <button type="button" onClick={() => actions.onDismissPlan!(plan.deviceId, now + 3600_000)} className="text-[11px] text-sol-text-muted hover:text-sol-text">Dismiss for 1h</button>
                    : <span className="text-[11px] text-sol-text-dim" title={off}>Dismiss for 1h</span>)}
                </div>
              )}
              <OffloadRuns runs={runs} sessions={sessions} destinations={destinations} now={now} actions={actions} actionsDisabledReason={actionsDisabledReason} />
              {machine ? <HealthStrip machine={machine} freshness={fr!} now={now} /> : <MachineList machines={machines} now={now} onPick={setMachineId} />}
              <Composition machines={scope} />

              <div className="sticky top-0 z-[2] flex flex-wrap items-center gap-2 border-b border-sol-border/30 bg-sol-bg px-3 py-1.5">
                <Seg label="Group by" value={groupBy} onChange={setGroupBy} options={[["session", "Session"], ["project", "Project"], ["kind", "Kind"], ...(machines.length > 1 ? [["machine", "Machine"] as [GroupBy, string]] : [])]} />
                <select aria-label="Session state" value={stateFilter} onChange={(e) => setStateFilter(e.target.value as StateFilter)} className="rounded border border-sol-border/40 bg-sol-bg px-1 py-0.5 text-[11px] text-sol-text">
                  <option value="all">All states</option>
                  <option value="working">Working</option>
                  <option value="needs_input">Needs you</option>
                  <option value="idle">Idle</option>
                  <option value="hibernated">Parked</option>
                </select>
                <label className="flex min-w-[9rem] flex-1 items-center gap-1 rounded border border-sol-border/40 px-1.5 py-0.5 sm:max-w-[16rem]">
                  <Search className="h-3 w-3 text-sol-text-dim" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter sessions, projects, processes" className="min-w-0 flex-1 bg-transparent text-[11px] text-sol-text outline-none placeholder:text-sol-text-dim" />
                  {query && <button type="button" aria-label="Clear filter" onClick={() => setQuery("")}><X className="h-3 w-3 text-sol-text-dim" /></button>}
                </label>
                {selected.size > 0 && (
                  <div className="flex w-full items-center gap-1 text-[11px] sm:ml-auto sm:w-auto">
                    <span className="font-semibold">{selected.size} selected</span>
                    <button type="button" disabled={!actions?.onPark || !parkable.length} title={!actions?.onPark ? off : !parkable.length ? "Only idle sessions or ones waiting on you can be parked" : undefined} onClick={() => actions?.onPark?.(parkable.map((s) => s.sessionId))} className="rounded px-1.5 py-0.5 hover:bg-sol-bg-highlight disabled:cursor-not-allowed disabled:opacity-40">Park {parkable.length || ""}</button>
                    {resumable.length > 0 && <button type="button" disabled={!actions?.onResume} title={!actions?.onResume ? off : undefined} onClick={() => actions?.onResume?.(resumable.map((s) => s.sessionId))} className="rounded px-1.5 py-0.5 hover:bg-sol-bg-highlight disabled:cursor-not-allowed disabled:opacity-40">Resume {resumable.length}</button>}
                    <button
                      type="button"
                      disabled={!plan}
                      title={!plan ? "Moves are suggested while a machine is under sustained pressure; Settings → Migration moves sessions any time" : undefined}
                      onClick={() => plan && setReviewing({ deviceId: plan.deviceId, preselect: selectedIds })}
                      className="rounded px-1.5 py-0.5 text-sol-cyan hover:bg-sol-bg-highlight disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Review move…
                    </button>
                    <button type="button" onClick={() => setSelected(new Set())} className="rounded px-1.5 py-0.5 text-sol-text-muted hover:bg-sol-bg-highlight">Clear</button>
                  </div>
                )}
              </div>

              {scope.some((m) => processesUnavailable(m.snapshot)) && (
                <div className="border-b border-sol-border/20 bg-sol-bg-alt/60 px-4 py-2 text-[11px] text-sol-text-muted">
                  <span className="text-sol-text-secondary">Process details are unavailable in the latest sample{scope.length > 1 ? ` from ${scope.filter((m) => processesUnavailable(m.snapshot)).map((m) => m.name).join(", ")}` : ""}.</span>{" "}
                  CPU, memory and load are current, but listing processes did not finish in time. Sessions are listed without usage so you can still park or open them; no move is suggested until a sample includes process ownership.
                </div>
              )}
              {scope.every((m) => !m.snapshot) ? (
                <div className="px-4 py-8 text-center text-[11px] text-sol-text-muted">
                  {machine ? `${machine.name} has not sent a process sample yet, so nothing can be attributed.` : "No machine has sent a process sample yet."}
                </div>
              ) : rows.length === 0 ? (
                <div className="px-4 py-8 text-center text-[11px] text-sol-text-muted">Nothing matches this filter.</div>
              ) : (
                <ResourceTable
                  rows={rows}
                  sharedRows={sharedRows}
                  totals={totals}
                  machines={scope}
                  now={now}
                  selected={selected}
                  onToggle={toggle}
                  actions={actions}
                  actionsDisabledReason={actionsDisabledReason}
                  showMachine={scope.length > 1}
                  sort={sort}
                  onSort={onSort}
                />
              )}
              {machine?.snapshot && machine.snapshot.limitations.length > 0 && (
                <ul className="px-3 pb-4 text-[10px] text-sol-text-dim">
                  {machine.snapshot.limitations.map((l) => <li key={l}>{l}</li>)}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
      {reviewing && plan && (
        <aside className="fixed inset-0 z-30 flex flex-col lg:static lg:z-auto lg:w-[34rem] lg:shrink-0 lg:border-l lg:border-sol-border/30">
          <OffloadReview
            key={`${plan.deviceId}:${reviewing.preselect?.join(",") ?? ""}`}
            plan={plan}
            sessions={sessions}
            sourceName={destinations.get(plan.deviceId) ?? "this machine"}
            now={now}
            initialSelected={reviewing.preselect}
            actions={actions}
            actionsDisabledReason={actionsDisabledReason}
            onClose={() => setReviewing(null)}
          />
        </aside>
      )}
    </div>
  );
}
