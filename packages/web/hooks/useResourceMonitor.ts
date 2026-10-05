// The resource monitor's live data: machine reports (machineResources feed)
// joined to the device roster, the managed fleet as ResourceSessions, the
// planner's suggestion per pressured laptop, and resource runs read off the
// migration batches. Everything renders from the store; this hook only joins.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { type MachineResourceSnapshot, type ResourcePoint } from "@codecast/shared/contracts";
import { useSyncCollection } from "./useSyncCollection";
import { useIsSyncHost } from "./useSyncRole";
import { useCollectionRows } from "./useCollectionRows";
import { useCoarseNow } from "./useCoarseNow";
import { useManagedSessions } from "./useSyncManagedSessions";
import { useMigrationBatches, useMigrationCandidates } from "./useSyncMigrations";
import { useDevices, deviceDisplayName, type Device } from "../components/DeviceBadge";
import { buildOffloadPlan } from "../lib/resourceOffload";
import { batchAwaitingEcho, effectiveRowStatus, isRowTerminal, type MigrationBatch } from "../lib/migrationPlan";
import type { MachineRole, OffloadPlan, OffloadRun, ResourceMachine, ResourceSession, ResourceSessionState } from "../components/resources/types";

const api = _api as any;

type MachineResourceRow = { _id: string; device_id: string; received_at: number; snapshot: MachineResourceSnapshot; history: ResourcePoint[] };

const rowSig = (r: MachineResourceRow) => `${r.device_id}|${r.received_at}`;

/** Feeder: the caller's machine reports. Global (the pressure notice reads it), so only the sync host subscribes; followers get the rows by replication. */
export function useSyncMachineResources(enabled = true) {
  const host = useIsSyncHost();
  return useSyncCollection("machineResources", api.machineResources.listMine, enabled && host ? {} : "skip");
}

export function useMachineResourceRows(): MachineResourceRow[] {
  return useCollectionRows<MachineResourceRow>("machineResources", { sig: rowSig });
}

function roleOf(d: Pick<Device, "is_remote" | "platform">): MachineRole {
  if (!d.is_remote) return "local";
  return /linux/i.test(d.platform) ? "cloud_linux" : "cloud_mac";
}

/** Machines: every registered device, with its report when it has sent one. */
export function joinMachines(devices: Device[], rows: MachineResourceRow[]): ResourceMachine[] {
  const byDevice = new Map(rows.map((r) => [r.device_id, r]));
  return devices.map((d) => {
    const r = byDevice.get(d.device_id);
    return {
      deviceId: d.device_id,
      name: deviceDisplayName(d),
      role: roleOf(d),
      platform: d.platform,
      online: d.online,
      asleep: d.is_remote && !d.online && !!d.cloud_host,
      receivedAt: r?.received_at,
      snapshot: r?.snapshot,
      history: r?.history ?? [],
    };
  }).sort((a, b) => Number(b.role === "local") - Number(a.role === "local") || Number(!!b.snapshot) - Number(!!a.snapshot) || a.name.localeCompare(b.name));
}

const WORKING = new Set(["working", "thinking", "compacting", "starting", "resuming"]);
const WAITING = new Set(["permission_blocked", "waiting"]);

export function toResourceSession(m: any, pinned: boolean): ResourceSession {
  const state: ResourceSessionState = m.agent_status === "hibernated" ? "hibernated"
    : m.is_killed || m.agent_status === "stopped" || m.agent_status === "done" ? "dead"
    : WORKING.has(m.agent_status) ? "working"
    : WAITING.has(m.agent_status) ? "needs_input"
    : "idle";
  return {
    sessionId: m.session_id,
    conversationId: m.conversation_id ?? undefined,
    shortId: m.short_id ?? undefined,
    title: m.conversation_title || m.headline || `Session ${String(m.session_id).slice(0, 7)}`,
    projectPath: m.project_path ?? undefined,
    agentType: m.agent_type ?? undefined,
    deviceId: m.owner_device_id ?? undefined,
    state,
    // Activity, not liveness: a heartbeat says the process is up, not that it did anything.
    lastActiveAt: m.conversation_updated_at ?? undefined,
    pinned,
  };
}

/** A batch as a run, with relief measured only from a sample taken after it finished. */
export function batchToRun(b: MigrationBatch, sessionByConversation: Map<string, string>, machines: ResourceMachine[]): OffloadRun {
  const status = (r: MigrationBatch["rows"][number]) => effectiveRowStatus(b, r);
  const terminal = b.rows.length > 0 && b.rows.every((r) => isRowTerminal(status(r)));
  const finishedAt = terminal ? Math.max(...b.rows.map((r) => r.finished_at ?? r.updated_at)) : undefined;
  const source = machines.find((m) => m.deviceId === b.rows[0]?.from_device_id);
  const hist = source?.history ?? [];
  const before = [...hist].reverse().find((p) => p.at <= b.created_at);
  const after = finishedAt !== undefined ? hist.find((p) => p.at > finishedAt) : undefined;
  return {
    batchId: b.batch_id,
    createdAt: b.created_at,
    waitForTurnMs: b.wait_for_idle_ms,
    finishedAt,
    cancelUnavailable: batchAwaitingEcho(b) ? "Finishing preflight before cancellation is available" : undefined,
    rows: b.rows.map((r) => ({
      sessionId: sessionByConversation.get(r.conversation_id) ?? r.conversation_id,
      destinationId: r.to_device_id,
      status: status(r),
      error: r.error ?? undefined,
      startedAt: r.started_at ?? undefined,
    })),
    measured: before ? { before, after } : undefined,
  };
}

const RUN_WINDOW_MS = 2 * 3600_000;

export function useResourceMonitor() {
  const now = useCoarseNow(15_000);
  const rows = useMachineResourceRows();
  const { devices, loaded } = useDevices();
  const { sessions: managed } = useManagedSessions();
  const { candidates } = useMigrationCandidates();
  const { batches } = useMigrationBatches();
  const pinnedIds = useCollectionRows<any>("sessions", { where: (r: any) => !!r.inbox_pinned_at, sig: (r: any) => r._id });

  const machines = useMemo(() => joinMachines(devices, rows), [devices, rows]);
  const sessions = useMemo(() => {
    const pinned = new Set(pinnedIds.map((r) => r._id));
    return managed.filter((m) => !m.is_killed).map((m) => toResourceSession(m, pinned.has(m.conversation_id)));
  }, [managed, pinnedIds]);

  const plans = useMemo(() => {
    if (!candidates) return [];
    const out: OffloadPlan[] = [];
    for (const source of machines) {
      if (source.role !== "local") continue;
      // Dismissing quiets the app-wide notice (ResourcePressureNotice); this page always offers the plan.
      const plan = buildOffloadPlan({ source, machines, sessions, devices: devices as any, candidates, now });
      if (plan) out.push(plan);
    }
    return out;
  }, [machines, sessions, devices, candidates, now]);

  const runs = useMemo(() => {
    const byConv = new Map(sessions.filter((s) => s.conversationId).map((s) => [s.conversationId!, s.sessionId]));
    return (batches ?? [])
      // Only moves started here: they carry their intent and never interrupt a turn.
      .filter((b) => !!b.resource_offload)
      .filter((b) => now - b.created_at < RUN_WINDOW_MS || b.rows.some((r) => !isRowTerminal(r.status)))
      .map((b) => batchToRun(b, byConv, machines));
  }, [batches, sessions, machines, now]);

  return { machines, sessions, plans, runs, batches: batches ?? [], now, ready: loaded || rows.length > 0 };
}

