"use client";

/**
 * Settings → Migration: move MANY sessions between a laptop and a cloud host
 * in one gesture, in either direction, while they may be mid-turn.
 *
 * Three steps on one panel — pick a destination, tick sessions, go — then the
 * batch narrates itself row by row from the server rows the runner updates
 * (convex/sessionMigrations.ts). Nothing here moves files: the batch wakes an
 * executor daemon, which runs `cast migrate run` and reports back.
 */

import { useCallback, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useShallow } from "zustand/react/shallow";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CheckSquare,
  History,
  Loader2,
  RotateCcw,
  Search,
  Square,
  X,
} from "lucide-react";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SelectBox } from "../../../components/ui/select-box";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { SettingsCallout, SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";
import {
  DeviceDot,
  DeviceIcon,
  deviceDisplayName,
  deviceWakesOnUse,
  relativeSeen,
  useDevices,
  type Device,
} from "../../../components/DeviceBadge";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useInboxStore } from "../../../store/inboxStore";
import { cn } from "../../../lib/utils";
import {
  MID_TURN_STATUSES,
  ROW_STATUS_LABEL,
  WAIT_PRESETS,
  batchLooksUnclaimed,
  eligibilityFor,
  isRowActive,
  isRowTerminal,
  type MigrationCandidate,
  type MigrationRowStatus,
} from "../../../lib/migrationPlan";

const api = _api as any;

type BatchRow = {
  migration_id: string;
  conversation_id: string;
  title: string | null;
  short_id: string | null;
  direction: "to_cloud" | "to_local";
  from_device_id: string | null;
  to_device_id: string;
  executor_device_id: string;
  status: MigrationRowStatus;
  stage: string | null;
  error: string | null;
  attempt: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
  destination_path: string | null;
  verification: string | null;
};

type Batch = {
  batch_id: string;
  to_device_id: string;
  created_at: number;
  updated_at: number;
  cancelled_at: number | null;
  wait_for_idle_ms: number;
  concurrency: number;
  executor_device_ids: string[];
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  active: number;
  queued: number;
  state: "running" | "done" | "partial" | "failed" | "cancelled" | "empty";
  rows: BatchRow[];
};

function shortName(c: { title: string | null; short_id: string | null; conversation_id?: string; _id?: string }): string {
  return c.title?.trim() || c.short_id || (c.conversation_id ?? c._id ?? "").slice(0, 8);
}

function duration(from: number | null, to: number | null, now: number): string {
  if (!from) return "";
  const ms = Math.max(0, (to ?? now) - from);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

/** A once-a-second clock, only while something is live. */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useWatchEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const STATUS_TONE: Record<MigrationRowStatus, string> = {
  queued: "bg-sol-bg-highlight/60 text-sol-text-muted",
  waiting_idle: "bg-sol-yellow/15 text-sol-yellow",
  quiescing: "bg-sol-orange/15 text-sol-orange",
  transferring: "bg-sol-blue/15 text-sol-blue",
  switching: "bg-sol-violet/15 text-sol-violet",
  resuming: "bg-sol-cyan/15 text-sol-cyan",
  done: "bg-sol-green/15 text-sol-green",
  failed: "bg-sol-red/15 text-sol-red",
  cancelled: "bg-sol-bg-highlight/60 text-sol-text-dim",
};

function StatusPill({ status }: { status: MigrationRowStatus }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium whitespace-nowrap", STATUS_TONE[status])}>
      {isRowActive(status) && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {status === "done" && <Check className="h-2.5 w-2.5" />}
      {status === "failed" && <AlertTriangle className="h-2.5 w-2.5" />}
      {ROW_STATUS_LABEL[status]}
    </span>
  );
}

const AGENT_DOT: Record<string, string> = {
  working: "bg-sol-green animate-pulse",
  thinking: "bg-sol-green animate-pulse",
  compacting: "bg-sol-green animate-pulse",
  permission_blocked: "bg-sol-yellow",
  waiting: "bg-sol-blue",
  idle: "bg-gray-500",
  hibernated: "bg-gray-600",
};

// ── Destination picker ───────────────────────────────────────────────────────

function DestinationCard({ d, selected, count, onPick }: { d: Device; selected: boolean; count: number; onPick: () => void }) {
  const usable = d.online || (d.is_remote && deviceWakesOnUse(d));
  const state = d.online ? "online" : d.is_remote && deviceWakesOnUse(d) ? "asleep — wakes on move" : `offline · seen ${relativeSeen(d.last_seen)}`;
  return (
    <button
      type="button"
      disabled={!usable}
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        selected ? "border-sol-cyan bg-sol-cyan/10" : "border-sol-border bg-sol-bg-alt hover:border-sol-text-muted",
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <DeviceIcon d={d} className={cn("h-3.5 w-3.5 shrink-0", d.is_remote ? "text-sol-violet" : "text-sol-blue")} />
        <span className={cn("truncate text-sm font-medium", selected ? "text-sol-cyan" : "text-sol-text")}>{deviceDisplayName(d)}</span>
        <DeviceDot online={d.online} className="ml-auto" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-sol-text-muted">
        <span>{d.is_remote ? "cloud host" : "laptop"} · {state}</span>
        <span className="shrink-0">{count} session{count === 1 ? "" : "s"} here</span>
      </div>
    </button>
  );
}

// ── Session picker row ───────────────────────────────────────────────────────

function CandidateRow({
  c, device, checked, eligible, reason, agentStatus, onToggle,
}: {
  c: MigrationCandidate;
  device: Device | undefined;
  checked: boolean;
  eligible: boolean;
  reason: string | null;
  agentStatus: string | undefined;
  onToggle: () => void;
}) {
  const Box = checked ? CheckSquare : Square;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={!eligible}
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors sm:px-5",
        eligible ? "hover:bg-sol-bg-highlight/40" : "opacity-55 cursor-not-allowed",
        checked && "bg-sol-cyan/5",
      )}
    >
      <Box className={cn("h-4 w-4 shrink-0", checked ? "text-sol-cyan" : "text-sol-text-dim")} />
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", AGENT_DOT[agentStatus ?? ""] ?? "bg-gray-600")}
        title={agentStatus ? `agent ${agentStatus.replace(/_/g, " ")}` : "not live"}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 min-w-0">
          <span className="truncate text-sm text-sol-text">{shortName(c)}</span>
          {c.short_id && <span className="shrink-0 font-mono text-[10px] text-sol-text-dim">{c.short_id}</span>}
          {c.has_pending_messages && <span className="shrink-0 rounded bg-sol-yellow/15 px-1 text-[9px] text-sol-yellow">message waiting</span>}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-sol-text-muted min-w-0">
          {device ? (
            <span className="inline-flex items-center gap-1 shrink-0">
              <DeviceIcon d={device} className="h-2.5 w-2.5" />
              {deviceDisplayName(device)}
            </span>
          ) : (
            <span className="shrink-0">unplaced</span>
          )}
          {c.worktree_name && <span className="truncate font-mono text-[10px] text-sol-cyan">{c.worktree_name}</span>}
          {!c.worktree_name && c.project_path && <span className="truncate font-mono text-[10px]">{c.project_path.split("/").filter(Boolean).pop()}</span>}
          <span className="ml-auto shrink-0">{relativeSeen(c.updated_at)}</span>
        </span>
      </span>
      {!eligible && reason && <span className="shrink-0 max-w-[40%] truncate text-[11px] text-sol-text-dim" title={reason}>{reason}</span>}
    </button>
  );
}

// ── Batch card ───────────────────────────────────────────────────────────────

function BatchCard({ b, devices, now, expandedDefault }: { b: Batch; devices: Map<string, Device>; now: number; expandedDefault: boolean }) {
  const [expanded, setExpanded] = useState(expandedDefault);
  const cancel = useMutation(api.sessionMigrations.cancelBatch);
  const retry = useMutation(api.sessionMigrations.retryFailed);
  const [busy, setBusy] = useState<"cancel" | "retry" | null>(null);
  const to = devices.get(b.to_device_id);
  const toName = to ? deviceDisplayName(to) : b.to_device_id.slice(0, 8);
  const running = b.state === "running";
  const pct = b.total ? Math.round(((b.done + b.failed + b.cancelled) / b.total) * 100) : 0;
  const unclaimed = running && batchLooksUnclaimed(b, now);
  const executors = b.executor_device_ids.map((id) => devices.get(id)).filter(Boolean) as Device[];
  const stateLabel =
    b.state === "running" ? "running"
    : b.state === "done" ? "all moved"
    : b.state === "partial" ? "partly moved"
    : b.state === "failed" ? "failed"
    : b.state === "cancelled" ? "cancelled" : "empty";
  const stateTone =
    b.state === "running" ? "text-sol-cyan"
    : b.state === "done" ? "text-sol-green"
    : b.state === "failed" ? "text-sol-red"
    : "text-sol-text-muted";

  const act = async (kind: "cancel" | "retry") => {
    setBusy(kind);
    try {
      if (kind === "cancel") {
        const r = await cancel({ batch_id: b.batch_id });
        toast.success(`Cancelled ${r.cancelled} queued session${r.cancelled === 1 ? "" : "s"}`);
      } else {
        const r = await retry({ batch_id: b.batch_id });
        toast.success(`Re-queued ${r.requeued} session${r.requeued === 1 ? "" : "s"}`);
      }
    } catch (e: any) {
      toast.error(e?.message ?? `Could not ${kind}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          {running ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-sol-cyan" /> : <ArrowRightLeft className="h-3.5 w-3.5 shrink-0 text-sol-text-dim" />}
          <span className="truncate text-sm text-sol-text">
            {b.total} session{b.total === 1 ? "" : "s"} → {toName}
          </span>
          <span className={cn("shrink-0 text-[11px] font-medium", stateTone)}>{stateLabel}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-sol-text-dim">{b.batch_id} · {relativeSeen(b.created_at)}</span>
        </button>
        {running && b.queued > 0 && (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => act("cancel")} className="h-7 text-xs">
            <X className="h-3 w-3" /> Cancel rest
          </Button>
        )}
        {!running && b.failed > 0 && (
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act("retry")} className="h-7 text-xs">
            <RotateCcw className="h-3 w-3" /> Retry {b.failed} failed
          </Button>
        )}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-sol-bg-highlight/60">
          <div className="flex h-full">
            <div className="h-full bg-sol-green transition-all" style={{ width: `${b.total ? (b.done / b.total) * 100 : 0}%` }} />
            <div className="h-full bg-sol-red transition-all" style={{ width: `${b.total ? (b.failed / b.total) * 100 : 0}%` }} />
            <div className="h-full bg-sol-text-dim/40 transition-all" style={{ width: `${b.total ? (b.cancelled / b.total) * 100 : 0}%` }} />
          </div>
        </div>
        <span className="shrink-0 text-[11px] text-sol-text-muted">
          {b.done} moved{b.failed ? ` · ${b.failed} failed` : ""}{b.cancelled ? ` · ${b.cancelled} cancelled` : ""}{b.active ? ` · ${b.active} in progress` : ""}{b.queued ? ` · ${b.queued} queued` : ""} · {pct}%
        </span>
      </div>
      {unclaimed && (
        <SettingsCallout tone="warning" className="mt-2">
          Nothing has started yet. The transfer runs on {executors.length ? executors.map(deviceDisplayName).join(", ") : "the executor machine"} — check that its
          codecast daemon is online and up to date (<code className="font-mono">cast update</code>), then retry.
        </SettingsCallout>
      )}
      {expanded && (
        <ul className="mt-2 divide-y divide-sol-border/30 rounded-md border border-sol-border/40 bg-sol-bg/40">
          {b.rows.map((r) => {
            const from = r.from_device_id ? devices.get(r.from_device_id) : undefined;
            const dest = devices.get(r.to_device_id);
            return (
              <li key={r.migration_id} className="flex items-start gap-3 px-3 py-2">
                <StatusPill status={r.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm text-sol-text">{shortName(r)}</span>
                    {r.short_id && <span className="shrink-0 font-mono text-[10px] text-sol-text-dim">{r.short_id}</span>}
                    <span className="ml-auto shrink-0 text-[10px] text-sol-text-dim">
                      {duration(r.started_at, isRowTerminal(r.status) ? r.finished_at : null, now)}
                    </span>
                  </div>
                  <div className="text-[11px] text-sol-text-muted truncate">
                    {from ? deviceDisplayName(from) : "unplaced"} → {dest ? deviceDisplayName(dest) : r.to_device_id.slice(0, 8)}
                    {r.attempt > 1 && ` · attempt ${r.attempt}`}
                  </div>
                  {r.error ? (
                    <div className="mt-0.5 text-[11px] leading-relaxed text-sol-red break-words">{r.error}</div>
                  ) : r.stage ? (
                    <div className={cn("mt-0.5 text-[11px] leading-relaxed", isRowActive(r.status) ? "text-sol-text" : "text-sol-text-muted")}>{r.stage}</div>
                  ) : null}
                  {r.status === "done" && r.verification && (
                    <div className="mt-0.5 text-[10px] text-sol-text-dim break-words">{r.verification}</div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── The panel ────────────────────────────────────────────────────────────────

export default function MigratePanel() {
  const { devices, byId, locals, remotes, loaded } = useDevices();
  const { data: candidatesRaw } = useQueryNoThrow(api.sessionMigrations.candidates, {}) as { data: MigrationCandidate[] | null | undefined };
  const { data: batchesRaw } = useQueryNoThrow(api.sessionMigrations.listBatches, {}) as { data: Batch[] | null | undefined };
  const createBatch = useMutation(api.sessionMigrations.createBatch);

  const candidates = useMemo(() => candidatesRaw ?? [], [candidatesRaw]);
  const batches = useMemo(() => batchesRaw ?? [], [batchesRaw]);
  const anyRunning = batches.some((b) => b.state === "running");
  const now = useTicker(anyRunning);

  // Live agent status for the rows the inbox already has, keyed by conversation id.
  const liveStatus = useInboxStore(
    useShallow((s) => {
      const out: Record<string, string | undefined> = {};
      for (const c of candidates) {
        const row = s.sessions[s.resolveLiveSessionId(c._id)] ?? s.conversations[c._id];
        if (row?.agent_status) out[c._id] = row.agent_status;
      }
      return out;
    }),
  );

  const [pickedTargetId, setTargetId] = useState<string | null>(null);
  const [picked, setSelected] = useState<Set<string>>(() => new Set());
  const [query, setQuery] = useState("");
  const [fromFilter, setFromFilter] = useState<string>("all");
  const [eligibleOnly, setEligibleOnly] = useState(true);
  const [waitMs, setWaitMs] = useState<number>(WAIT_PRESETS[2].value);
  const [concurrency, setConcurrency] = useState(2);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Default destination: the cloud host when there is exactly one, else nothing —
  // derived, so the roster arriving late picks it without a render round-trip.
  const targetId = useMemo(() => {
    if (pickedTargetId && byId.has(pickedTargetId)) return pickedTargetId;
    const usableRemotes = remotes.filter((d) => d.online || deviceWakesOnUse(d));
    return usableRemotes.length === 1 ? usableRemotes[0].device_id : null;
  }, [pickedTargetId, byId, remotes]);

  const target = targetId ? byId.get(targetId) : undefined;
  const planDevices = useMemo(() => devices.map((d) => ({ device_id: d.device_id, is_remote: d.is_remote, online: d.online, label: deviceDisplayName(d) })), [devices]);
  const planTarget = useMemo(
    () => (target ? { device_id: target.device_id, is_remote: target.is_remote, online: target.online, label: deviceDisplayName(target) } : undefined),
    [target],
  );

  const countsByDevice = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of candidates) if (c.owner_device_id) m.set(c.owner_device_id, (m.get(c.owner_device_id) ?? 0) + 1);
    return m;
  }, [candidates]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return candidates
      .map((c) => {
        const e = eligibilityFor(c, planTarget, planDevices);
        return { c, eligible: e.ok, reason: e.ok ? null : e.reason, direction: e.ok ? e.direction : null };
      })
      .filter(({ c, eligible }) => {
        if (eligibleOnly && !eligible) return false;
        if (fromFilter !== "all" && (c.owner_device_id ?? "none") !== fromFilter) return false;
        if (!q) return true;
        return [c.title, c.short_id, c.project_path, c.worktree_name, c.worktree_branch].some((f) => f?.toLowerCase().includes(q));
      });
  }, [candidates, planTarget, planDevices, eligibleOnly, fromFilter, query]);

  // Picks survive a destination change, but only the ones eligible for the
  // CURRENT destination count — derived, so nothing is pruned behind the
  // user's back and switching back restores the same selection.
  const eligibleIds = useMemo(() => new Set(candidates.filter((c) => eligibilityFor(c, planTarget, planDevices).ok).map((c) => c._id)), [candidates, planTarget, planDevices]);
  const selected = useMemo(() => new Set([...picked].filter((id) => eligibleIds.has(id))), [picked, eligibleIds]);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);
  const visibleEligible = rows.filter((r) => r.eligible).map((r) => r.c._id);
  const allVisibleSelected = visibleEligible.length > 0 && visibleEligible.every((id) => selected.has(id));
  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleEligible.forEach((id) => next.delete(id));
      else visibleEligible.forEach((id) => next.add(id));
      return next;
    });
  };

  const selectedRows = candidates.filter((c) => selected.has(c._id));
  const midTurn = selectedRows.filter((c) => MID_TURN_STATUSES.has(liveStatus[c._id] ?? "")).length;
  const directions = new Set(selectedRows.map((c) => { const e = eligibilityFor(c, planTarget, planDevices); return e.ok ? e.direction : null; }).filter(Boolean));
  const targetName = target ? deviceDisplayName(target) : "…";
  const waitLabel = WAIT_PRESETS.find((p) => p.value === waitMs)?.label ?? `${Math.round(waitMs / 60_000)} min`;

  const submit = async () => {
    if (!target || selected.size === 0) return;
    setSubmitting(true);
    try {
      const res = await createBatch({
        conversation_ids: [...selected],
        to_device_id: target.device_id,
        wait_for_idle_ms: waitMs,
        concurrency,
      });
      if (res.skipped.length) {
        toast.message(`${res.skipped.length} session${res.skipped.length === 1 ? "" : "s"} skipped`, {
          description: res.skipped.slice(0, 4).map((s: any) => `${s.short_id ?? s.conversation_id.slice(0, 8)}: ${s.reason}`).join("\n"),
        });
      }
      if (res.batch_id) {
        toast.success(`Moving ${res.rows.length} session${res.rows.length === 1 ? "" : "s"} to ${targetName}`);
        setSelected(new Set());
      } else {
        toast.error("Nothing could be moved");
      }
      setConfirming(false);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not start the migration");
    } finally {
      setSubmitting(false);
    }
  };

  const fromOptions = useMemo(() => {
    const ids = new Set(candidates.map((c) => c.owner_device_id ?? "none"));
    return devices.filter((d) => ids.has(d.device_id));
  }, [candidates, devices]);

  return (
    <SettingsPanel>
      <SettingsSection
        title="Destination"
        icon={ArrowRightLeft}
        description="Where the selected sessions should run. Moving to a cloud host pushes each worktree and transcript there; moving to a laptop pulls them back with any uncommitted work intact."
        padded
      >
        {!loaded ? (
          <div className="text-xs text-sol-text-muted">Loading your machines…</div>
        ) : devices.length === 0 ? (
          <SettingsCallout>No machines yet. Install the CLI and run <code className="font-mono">cast start</code> on a laptop first.</SettingsCallout>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {[...remotes, ...locals].map((d) => (
              <DestinationCard key={d.device_id} d={d} selected={targetId === d.device_id} count={countsByDevice.get(d.device_id) ?? 0} onPick={() => setTargetId(d.device_id)} />
            ))}
          </div>
        )}
        {loaded && remotes.length === 0 && (
          <SettingsCallout className="mt-3">
            No cloud host is registered. Provision one with <code className="font-mono">cast hosts add &lt;instance-id&gt; --key &lt;pem&gt;</code> and <code className="font-mono">cast hosts provision</code>; sessions on it can then be brought back here.
          </SettingsCallout>
        )}
      </SettingsSection>

      <SettingsSection
        title="Sessions"
        icon={CheckSquare}
        description={target ? `Tick the sessions to move to ${targetName}. Greyed rows say why they cannot go.` : "Pick a destination first."}
        actions={
          <button type="button" onClick={toggleAll} disabled={visibleEligible.length === 0} className="text-xs text-sol-cyan hover:underline disabled:text-sol-text-dim disabled:no-underline">
            {allVisibleSelected ? "Clear" : `Select all ${visibleEligible.length}`}
          </button>
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-4 py-2 sm:px-5">
          <div className="relative min-w-[180px] flex-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sol-text-dim" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by title, id, project, worktree" className="h-8 pl-7 text-xs" />
          </div>
          <SelectBox value={fromFilter} onChange={(e) => setFromFilter(e.target.value)} aria-label="Sessions on">
            <option value="all">All machines</option>
            {fromOptions.map((d) => (
              <option key={d.device_id} value={d.device_id}>On {deviceDisplayName(d)}</option>
            ))}
            {candidates.some((c) => !c.owner_device_id) && <option value="none">Unplaced</option>}
          </SelectBox>
          <label className="flex items-center gap-1.5 text-xs text-sol-text-muted cursor-pointer select-none">
            <input type="checkbox" checked={eligibleOnly} onChange={(e) => setEligibleOnly(e.target.checked)} className="accent-sol-cyan" />
            movable only
          </label>
        </div>
        {candidatesRaw === undefined ? (
          <div className="px-4 py-6 text-center text-xs text-sol-text-muted sm:px-5">Loading sessions…</div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-sol-text-muted sm:px-5">
            {candidates.length === 0 ? "No live sessions to move." : eligibleOnly ? "No session here can move to this destination. Untick “movable only” to see why." : "Nothing matches."}
          </div>
        ) : (
          <div className="max-h-[420px] overflow-y-auto divide-y divide-sol-border/30">
            {rows.map(({ c, eligible, reason }) => (
              <CandidateRow
                key={c._id}
                c={c}
                device={c.owner_device_id ? byId.get(c.owner_device_id) : undefined}
                checked={selected.has(c._id)}
                eligible={eligible}
                reason={reason}
                agentStatus={liveStatus[c._id]}
                onToggle={() => toggle(c._id)}
              />
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="How to handle running turns" icon={History}>
        <SettingsRow
          label="Sessions mid-turn"
          description="A session that is producing finishes its turn first. Messages you send meanwhile wait and arrive after the move, so nothing is lost either way."
          alignTop
        >
          <SelectBox value={String(waitMs)} onChange={(e) => setWaitMs(Number(e.target.value))} aria-label="Wait for idle">
            {WAIT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </SelectBox>
        </SettingsRow>
        <SettingsRow label="Transfers at once" description="How many sessions one machine pushes or pulls in parallel.">
          <SelectBox value={String(concurrency)} onChange={(e) => setConcurrency(Number(e.target.value))} aria-label="Concurrency">
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </SelectBox>
        </SettingsRow>
      </SettingsSection>

      <div className="sticky bottom-0 -mx-1 flex items-center justify-between gap-4 rounded-xl border border-sol-border/80 bg-sol-bg/95 px-4 py-3 backdrop-blur sm:px-5">
        <div className="min-w-0 text-xs text-sol-text-muted">
          {selected.size === 0 ? (
            <span>No sessions selected.</span>
          ) : (
            <span>
              <span className="text-sol-text">{selected.size} session{selected.size === 1 ? "" : "s"}</span> → {targetName}
              {midTurn > 0 && <span> · {midTurn} mid-turn ({waitLabel.toLowerCase()})</span>}
            </span>
          )}
        </div>
        <Button size="sm" disabled={!target || selected.size === 0 || submitting} onClick={() => setConfirming(true)}>
          <ArrowRightLeft className="h-3.5 w-3.5" />
          Move {selected.size || ""} to {targetName}
        </Button>
      </div>

      <SettingsSection
        title="Migrations"
        icon={History}
        description={batches.length ? "Live progress, newest first. Each row narrates its own step; a failed row keeps its session where it was." : "Batches you start show their progress here."}
      >
        {batches.length === 0 ? (
          <div className="px-4 py-5 text-center text-xs text-sol-text-muted sm:px-5">No migrations yet.</div>
        ) : (
          batches.map((b, i) => <BatchCard key={b.batch_id} b={b} devices={byId} now={now} expandedDefault={i === 0 || b.state === "running"} />)
        )}
      </SettingsSection>

      <Dialog open={confirming} onOpenChange={(o) => !submitting && setConfirming(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Move {selected.size} session{selected.size === 1 ? "" : "s"} to {targetName}?</DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-2 text-xs leading-relaxed text-sol-text-muted">
                <p>
                  {directions.has("to_cloud") && directions.has("to_local")
                    ? "Some sessions go to the cloud host and some come back to this laptop; each is transferred by an online laptop over SSH."
                    : directions.has("to_local")
                      ? "Each session's worktree and transcript are pulled from the cloud host by this laptop, uncommitted work included, then the session resumes here."
                      : "Each session's worktree and transcript are pushed to the cloud host by the laptop that runs it now, then the session resumes there."}
                </p>
                <p>
                  {midTurn > 0
                    ? `${midTurn} of them ${midTurn === 1 ? "is" : "are"} mid-turn: ${waitMs === 0 ? "their turn is interrupted and they move at once" : `each finishes its turn first (${waitLabel.toLowerCase()}, then it is interrupted)`}.`
                    : "None of them is mid-turn right now."}{" "}
                  Messages sent while a session moves wait and arrive on the destination, and each agent gets a note saying which machine it is on now.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={submitting} onClick={() => setConfirming(false)}>Cancel</Button>
            <Button size="sm" disabled={submitting} onClick={submit}>
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
              Move {selected.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPanel>
  );
}
