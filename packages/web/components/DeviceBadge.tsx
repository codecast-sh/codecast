"use client";

/**
 * First-class "device" UI primitives. A session always runs on exactly one device
 * (its owner); these surface which one, whether it's online, and let the user move
 * it. The remote Mac is only ever an owner via an explicit move — auto-routing
 * lands on the most-recently-active local laptop/desktop (see convex/deviceRouting).
 */

import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { deviceDisplayName, deviceKindLabel, distinctDeviceNames } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { Mark } from "./Mark";
import { localDeviceIdOf } from "../hooks/useLocalDeviceId";
import { wakesOnUse } from "../lib/machinePicker";
import { useSyncDevices } from "../hooks/useSyncDevices";
import type { RestartPhase, RestartStage } from "../hooks/useSessionRestart";
import { useConversationCommands } from "../hooks/useSessionCommands";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useSyncCollection } from "../hooks/useSyncCollection";
import {
  conversationMigrationOf,
  isRowTerminal,
  MIGRATION_FAILED_LINGER_MS,
  migrationMoveView,
  ROW_STATUS_LABEL,
  type MigrationBatch,
  type MigrationBatchRow,
  type MigrationMoveView,
} from "../lib/migrationPlan";
import {
  DISPATCH_REFUSED,
  deviceMoveStatusOf,
  latestSessionCommand,
  requestSessionMove,
  sessionCommandTimedOut,
  type MoveTarget,
} from "../lib/sessionCommands";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";
import { TEAM_ICONS, TeamIcon } from "./TeamIcon";

import { useWatchEffect } from "../hooks/useWatchEffect";
export type { Device } from "../lib/deviceRow";
import type { Device } from "../lib/deviceRow";

/**
 * One device off the persisted roster, WITHOUT mounting the feeder. For dense
 * lists (a session card per row) where useDevices() would mount the roster
 * query once per row; the shared feeder elsewhere keeps the roster live. The
 * selector returns the roster's own object, so it is Object.is-stable between
 * roster pushes.
 */
export function useRosterDevice(deviceId: string | null | undefined): Device | undefined {
  return useInboxStore((s) => rosterDeviceOf(s.machineRoster as Device[], deviceId));
}

/** The projection behind useRosterDevice, callable as one dep of a caller's own
 *  useTrackedStore — a dense list folds every row's store reads into a single
 *  subscription instead of one per hook (ct-49746). */
export function rosterDeviceOf(roster: Device[] | null | undefined, deviceId: string | null | undefined): Device | undefined {
  return deviceId ? roster?.find((d) => d.device_id === deviceId) : undefined;
}

/**
 * Can this device be woken by a move? True for the cloud Linux class: an EC2
 * box whose idle state is "stopped" — the source daemon's move command boots
 * it before transferring. A remote Mac cannot stop (so "offline" means gone),
 * and a laptop can only be opened by a human.
 */
export function deviceWakesOnUse(d: Device): boolean {
  return wakesOnUse(d);
}

/** Naming lives in the shared contract so web and mobile agree; re-exported so
 * every existing import site keeps working. */
export { deviceDisplayName, deviceKindLabel };

/** Per-kind accent classes. Literal strings so Tailwind's JIT keeps them. */
export function deviceAccentClasses(d: Device): string {
  if (d.is_remote) return "bg-sol-violet/10 text-sol-violet border-sol-violet/30";
  if (/linux/i.test(d.platform)) return "bg-sol-orange/10 text-sol-orange border-sol-orange/30";
  return "bg-sol-blue/10 text-sol-blue border-sol-blue/30";
}

export function relativeSeen(lastSeen: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - lastSeen) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** The machine's glyph, named on hover. `labeled` when its name sits beside
 *  it. The caller's className sizes and places the mark's box; the glyph fills it. */
export function DeviceIcon({ d, className = "w-3 h-3", labeled }: { d: Pick<Device, "platform"> & { is_remote?: boolean; icon?: string | null; icon_color?: string | null }; className?: string; labeled?: boolean }) {
  if (d.icon && (TEAM_ICONS as readonly string[]).includes(d.icon)) {
    return <Mark id="device.custom" labeled={labeled} tinted className={className}><TeamIcon icon={d.icon} color={d.icon_color} className="size-full" /></Mark>;
  }
  if (d.is_remote) {
    // cloud / remote box
    return (
      <Mark id="device.cloud" labeled={labeled} className={className}>
        <svg className="size-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h11a3 3 0 000-6 5 5 0 00-9.584-1.5A3.5 3.5 0 003 15z" />
        </svg>
      </Mark>
    );
  }
  if (/linux/i.test(d.platform)) {
    return (
      <Mark id="device.linux" labeled={labeled} className={className}>
        <svg className="size-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </Mark>
    );
  }
  // laptop / desktop
  return (
    <Mark id="device.computer" labeled={labeled} className={className}>
      <svg className="size-full" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    </Mark>
  );
}

/** Live online/offline dot. `marks` names it as something other than a
 *  machine's connection (the tmux pill's pane); `quiet` inside a control that
 *  already says what it is on hover. */
export function DeviceDot({ online, className = "", labeled, quiet, marks }: { online: boolean; className?: string; labeled?: boolean; quiet?: boolean; marks?: { online: string; offline: string } }) {
  return (
    // Still, never a ping: the dot is drawn once per machine row.
    <Mark id={marks ? (online ? marks.online : marks.offline) : online ? "device.online" : "device.offline"} labeled={labeled} quiet={quiet} className={className}>
      <span className="relative inline-flex h-1.5 w-1.5 flex-shrink-0">
        <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${online ? "bg-sol-green ring-2 ring-sol-green/30" : "bg-sol-text-dim"}`} />
      </span>
    </Mark>
  );
}

// Stable identity for the pre-query render, so useMemo deps don't churn.
const NO_DEVICES: Device[] = [];

/** Load the user's devices, with helpers for routing-aware decisions. */
export function useDevices() {
  // Store-fed (hooks/useSyncDevices): the roster is persisted, so a chip
  // resolves its machine on the first frame after boot; the feeder keeps it
  // live and flips machineRosterLive for the path-seeding gate.
  useSyncDevices();
  const mirrored = useInboxStore((s) => s.machineRoster) as Device[];
  const devices = mirrored.length > 0 ? mirrored : NO_DEVICES;
  return useMemo(() => {
    const byId = new Map(devices.map((d) => [d.device_id, d]));
    const locals = devices.filter((d) => !d.is_remote);
    const remotes = devices.filter((d) => d.is_remote);
    const onlineLocals = locals.filter((d) => d.online).sort((a, b) => b.last_seen - a.last_seen);
    return {
      devices,
      byId,
      locals,
      remotes,
      onlineLocals,
      onlineRemotes: remotes.filter((d) => d.online),
      mostRecentOnlineLocal: onlineLocals[0] ?? null,
      loaded: devices.length > 0,
    };
  }, [devices]);
}

/** The roster fields a machine's name and icon read, as one string. */
function rosterNamesSig(roster: Device[]): string {
  return roster.map((d) => `${d.device_id}:${deviceDisplayName(d)}:${d.platform}:${d.is_remote ? 1 : 0}:${d.icon ?? ""}:${d.icon_color ?? ""}`).join("|");
}

/**
 * The viewer's machines by id, for naming and drawing them. Wakes only when a
 * name or icon changes: the roster's ref also moves on every last_seen bump,
 * which an always-mounted list must not re-render on.
 */
export function useRosterMachines(): ReadonlyMap<string, Device> {
  const sig = useInboxStore((s) => rosterNamesSig(s.machineRoster as Device[]));
  return useMemo(
    () => new Map((useInboxStore.getState().machineRoster as Device[]).map((d) => [d.device_id, d])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig is the wake; the body reads the roster it digests
    [sig],
  );
}

/**
 * Resolve a session's owner device when it isn't one of the viewer's own — a
 * session can run on a teammate's or a shared bot machine (its daemon
 * authenticates as another account) while being assigned to the viewer, and
 * `listDevices` is strictly per-user. Server-side access is checked on the
 * conversation, so this only fires when the viewer's own list missed and a
 * conversation id is available. Returns undefined while loading, null when
 * there is nothing to resolve.
 */
export type ForeignOwnerDevice = Device & {
  is_mine?: boolean;
  /** Whose account the session's daemon runs as — null for share-token viewers. */
  runner?: { name: string | null; is_bot: boolean } | null;
};

export function useForeignOwnerDevice(
  conversationId: string | null | undefined,
  needed: boolean,
): ForeignOwnerDevice | null | undefined {
  // No-throw: this is a fallback lookup for a name we may simply not get, so a
  // backend failure resolves to "nothing to resolve" — never a throw into the
  // caller's ErrorBoundary. Errors return null rather than undefined so callers
  // stop waiting on a lookup that will not arrive.
  const { data: res, error } = useQueryNoThrow(
    api.devices.ownerDeviceDisplay,
    needed && conversationId
      ? { conversation_id: conversationId as Id<"conversations"> }
      : "skip",
  );
  if (!needed || !conversationId) return null;
  if (error) return null;
  if (res === undefined) return undefined; // loading
  if (!res) return null;
  return { ...res, local_project_roots: [] };
}

/**
 * One vocabulary for "whose machine is this?" across the pill tooltip and the
 * device menu: the agent box when the runner account is a bot, the runner's
 * first name for a teammate's machine, a generic fallback when the viewer
 * isn't allowed the name (share-token) or the runner row is gone.
 */
export function foreignRunnerNote(f: ForeignOwnerDevice): string {
  if (f.runner?.is_bot) return "the team's agent box";
  const first = f.runner?.name?.split(" ")[0];
  return first ? `${first}'s machine` : "a teammate's machine";
}

/**
 * Compact chip showing which device a session runs on + its online state. Clicking
 * is handled by the parent (usually opens the actions menu). Renders nothing until
 * devices load or when there's no owner (auto-routing will pick one on next send).
 */
export function DeviceBadge({
  ownerDeviceId,
  className = "",
  showWhenUnassigned = false,
}: {
  ownerDeviceId?: string | null;
  className?: string;
  showWhenUnassigned?: boolean;
}) {
  const { byId, loaded } = useDevices();
  if (!loaded) return null;
  const d = ownerDeviceId ? byId.get(ownerDeviceId) : undefined;

  if (!d) {
    if (!showWhenUnassigned) return null;
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-meta bg-sol-text-dim/10 text-sol-text-muted border border-sol-text-dim/25 ${className}`}
        title="No device assigned yet — the next message routes to your most-recently-active machine."
      >
        <DeviceDot online={false} labeled quiet />
        Unassigned
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-meta border ${deviceAccentClasses(d)} max-w-[160px] ${className}`}
    >
      <DeviceIcon d={d} />
      <span className="truncate" title={`Runs on ${deviceDisplayName(d)} (${deviceKindLabel(d)}) — ${d.online ? "online" : `last seen ${relativeSeen(d.last_seen)}`}`}>{deviceDisplayName(d)}</span>
      <DeviceDot online={d.online} />
    </span>
  );
}

// The machine a session runs on is disabled as a target, but it is the one
// row the reader looks for: undo the disabled dimming and mark it in blue.
export const RUNNING_HERE_ROW = "data-[disabled]:opacity-100 bg-sol-blue/10 ring-1 ring-inset ring-sol-blue/40";
const MOVING_HERE_ROW = "data-[disabled]:opacity-100 bg-sol-orange/10 ring-1 ring-inset ring-sol-orange/40";

export function RunningHereTag({ online, suffix }: { online: boolean; suffix?: string }) {
  return (
    <span className="ml-2 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-sol-blue/20 px-2 py-0.5 text-meta font-medium text-sol-blue">
      running{suffix ? ` · ${suffix}` : ""}
      <DeviceDot online={online} />
    </span>
  );
}

/**
 * Dropdown-menu items to move a conversation between devices. Drop inside an open
 * DropdownMenuContent. Shows every device, the machine this window runs on
 * first and tagged "this device"; the session's current machine is marked
 * running, every other usable machine offers "Move to". Offline devices are
 * shown disabled.
 */
export function RunOnDeviceItems({
  conversationId,
  ownerDeviceId,
  allowRemoteMove = true,
}: {
  conversationId: string;
  ownerDeviceId?: string | null;
  allowRemoteMove?: boolean;
}) {
  const { byId, locals, remotes } = useDevices();
  const foreignOwner = useForeignOwnerDevice(
    conversationId,
    !!ownerDeviceId && !byId.get(ownerDeviceId),
  );
  // A refusal ends the row failed and raises the dispatch-failure toast.
  const move = (d: Device, isRemote: boolean) =>
    void requestSessionMove(conversationId, { device_id: d.device_id, is_remote: isRemote, label: deviceDisplayName(d) }).catch(() => {});
  const localDeviceId = useInboxStore(localDeviceIdOf);
  const names = useMemo(() => distinctDeviceNames([...locals, ...remotes]), [locals, remotes]);
  const moving = useMoveInFlight(conversationId);

  const row = (d: Device, isRemote: boolean) => {
    const isOwner = d.device_id === ownerDeviceId;
    const isDest = moving?.to_device_id === d.device_id;
    // An asleep cloud box is still a valid destination: the move wakes it.
    // Only a machine that CANNOT wake (a laptop or remote Mac gone dark) is dead.
    const usable = d.online || (isRemote && deviceWakesOnUse(d));
    // One move at a time: while one runs, its destination shows how far it
    // got and no other move is offered.
    const offered = !isOwner && usable && !moving;
    const { name, host } = names.get(d.device_id) ?? { name: deviceDisplayName(d) };
    return (
      <DropdownMenuItem
        key={d.device_id}
        disabled={!offered}
        onSelect={() => offered && move(d, isRemote)}
        className={isOwner ? RUNNING_HERE_ROW : isDest ? MOVING_HERE_ROW : undefined}
      >
        <DeviceIcon d={d} className="size-4 modern:size-3.5 mr-1.5" />
        <span className="flex-1 truncate">
          {offered ? `Move to ${name}` : name}
          {host && <span className="ml-1.5 text-sol-text-dim">{host}</span>}
        </span>
        {d.device_id === localDeviceId && (
          <span className="ml-2 shrink-0 whitespace-nowrap rounded-full border border-sol-border px-2 py-0.5 text-meta text-sol-text-muted">this device</span>
        )}
        {isDest ? (
          <span className="ml-2 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-sol-orange/15 px-2 py-0.5 text-meta font-medium text-sol-orange">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            moving · {moving!.label}
          </span>
        ) : isOwner ? <RunningHereTag online={d.online} /> : (
          <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-meta text-sol-text-muted">
            {d.online ? "" : usable ? "asleep, wakes on move" : "offline"}
            <DeviceDot online={d.online} />
          </span>
        )}
      </DropdownMenuItem>
    );
  };

  return (
    <>
      <DropdownMenuLabel className="text-mark uppercase tracking-wide text-sol-text-dim">Run on device · which machine</DropdownMenuLabel>
      {foreignOwner && (
        <DropdownMenuItem disabled className={RUNNING_HERE_ROW}>
          <DeviceIcon d={foreignOwner} className="size-4 modern:size-3.5 mr-1.5" />
          <span className="flex-1 truncate">{deviceDisplayName(foreignOwner)}</span>
          <RunningHereTag
            online={foreignOwner.online}
            suffix={foreignOwner.runner?.is_bot
              ? "agent box"
              : foreignOwner.runner?.name
                ? `${foreignOwner.runner.name.split(" ")[0]}'s`
                : "teammate's"}
          />
        </DropdownMenuItem>
      )}
      {[...locals].sort((a, b) => Number(b.device_id === localDeviceId) - Number(a.device_id === localDeviceId)).map((d) => row(d, false))}
      {allowRemoteMove && remotes.length > 0 && <DropdownMenuSeparator />}
      {allowRemoteMove && remotes.map((d) => row(d, true))}
    </>
  );
}

// ── Device-move progress ─────────────────────────────────────────────────────
// A move ("Run here" / "Move to remote Mac") is a multi-step daemon pipeline —
// worktree transfer (remote only), then a resume on the destination. The store
// action (requestSessionMove → moveSessionToDevice) paints the move's
// sessionCommands row on the click; this reads it and the conversation's
// pipeline rows (lib/sessionCommands deviceMoveStatusOf) for the header strip.

export type { MoveTarget };

/**
 * Live status of a device move for the conversation header strip, in the same
 * phase/stage vocabulary as useSessionRestart so the two share a renderer:
 * "restarting" (in flight) → "restored" (running on the destination; clears
 * after a moment) | "failed" (refused, daemon error, or nothing answered in
 * time; keeps a retry for a while). Idle costs nothing: the pipeline feed
 * mounts only mid-move.
 */
export function useDeviceMoveStatus(conversationId: string | undefined): {
  phase: RestartPhase;
  stage: RestartStage | null;
  failure: string | null;
  startedAt: number | null;
  restoredLabel: string | undefined;
  retry: () => void;
  cancel?: () => void;
} {
  const gesture = useInboxStore((s) =>
    conversationId ? latestSessionCommand(s.sessionCommands, (r) => r.conversation_id === conversationId && r.kind === "move") : undefined);
  const migration = useConversationMigration(conversationId, !!gesture && !gesture.to_remote && !gesture.confirmed_at);
  const open = !!gesture && !gesture.confirmed_at && gesture.result !== DISPATCH_REFUSED;
  // Tick fast only while the strip shows something; a settled move is idle.
  const busy = deviceMoveStatusOf(gesture, [], Date.now()).phase !== "idle" || (!!migration && !isRowTerminal(migration.row.status));
  const recentMigration = !!migration && Date.now() - (migration.row.finished_at ?? migration.row.updated_at) < MIGRATION_FAILED_LINGER_MS;
  const now = useCoarseNow(busy || recentMigration ? 1_000 : 60_000);
  const rows = useConversationCommands(conversationId, open && !sessionCommandTimedOut(gesture!, now) && !migration);
  const { phase, stage, failure, resumed } = deviceMoveStatusOf(gesture, rows, now);
  const names = useMigrationNames(migration?.row);
  const view = migrationMoveView(migration, names, now);
  // A move back from a cloud host runs as a migration (sessionMigrations.runHere):
  // its row is the move's truth, and the click's own row only says it was asked.
  const migrationSpeaks = !!view && (!gesture || view.phase === "moving" || gesture.to_device_id === migration!.row.to_device_id || migration!.batch.created_at > gesture.requested_at);

  // The destination's resume landed: stamp the row confirmed, which every
  // reader of the move takes as "running there now". A click answered by a
  // migration settles with it: confirmed when it lands, dropped when it was
  // refused (a press while the move was already under way) or the move failed,
  // since the migration line says what happened.
  useWatchEffect(() => {
    if (!gesture || gesture.confirmed_at) return;
    if (resumed && !migrationSpeaks) { useInboxStore.getState().confirmSessionCommand(gesture._id); return; }
    if (!migrationSpeaks || !view) return;
    if (view.phase === "done") useInboxStore.getState().confirmSessionCommand(gesture._id);
    else if (view.phase === "failed" || gesture.result === DISPATCH_REFUSED) useInboxStore.getState().dismissSessionCommand(gesture._id);
  }, [gesture, resumed, migrationSpeaks, view?.phase]);

  const batchId = migration?.batch.batch_id;
  return useMemo(() => {
    const idle = { phase: "idle" as RestartPhase, stage: null, failure: null, startedAt: null, restoredLabel: undefined, retry: () => {} };
    if (!conversationId) return idle;
    if (migrationSpeaks && view) return migrationStatus(view, batchId!);
    if (!gesture || phase === "idle") return idle;
    const dest = gesture.to_label ?? gesture.to_device_id ?? "";
    return {
      phase: phase as RestartPhase,
      stage,
      failure,
      startedAt: gesture.requested_at,
      restoredLabel: `Session is now running on ${dest}`,
      retry: () => {
        if (!gesture.to_device_id) return;
        void requestSessionMove(conversationId, { device_id: gesture.to_device_id, is_remote: !!gesture.to_remote, label: dest }).catch(() => {});
      },
    };
  }, [conversationId, gesture, phase, stage?.label, stage?.tone, failure, migrationSpeaks, view?.phase, view?.label, (view as any)?.detail, (view as any)?.tone, (view as any)?.cancellable, (view as any)?.startedAt, batchId]);
}

function migrationStatus(view: MigrationMoveView, batchId: string) {
  const store = () => useInboxStore.getState();
  if (view.phase === "done") return { phase: "restored" as RestartPhase, stage: null, failure: null, startedAt: null, restoredLabel: view.label, retry: () => {} };
  if (view.phase === "failed") {
    return { phase: "failed" as RestartPhase, stage: null, failure: view.label, startedAt: null, restoredLabel: undefined,
      retry: () => void store().retryMigrationBatch(batchId).catch(() => {}) };
  }
  return {
    phase: "restarting" as RestartPhase,
    stage: { label: view.detail ? `${view.label} · ${view.detail}` : view.label, tone: view.tone },
    failure: null,
    startedAt: view.startedAt,
    restoredLabel: undefined,
    retry: () => {},
    cancel: view.cancellable ? () => void store().cancelResourceOffload(batchId).catch(() => {}) : undefined,
  };
}

/**
 * The conversation's newest migration (a move between a cloud host and a
 * laptop), read from the store. The batch list is fed only while one could be
 * under way: the conversation carries a migration fence, the caller has a
 * move in flight (`asked`), or the cached copy still shows one running.
 */
export function useConversationMigration(conversationId: string | undefined, asked = false): { batch: MigrationBatch; row: MigrationBatchRow } | null {
  const fenced = useInboxStore((s) =>
    conversationId ? !!(s.sessions[conversationId]?.migration_batch_id ?? (s.conversations[conversationId] as any)?.migration_batch_id) : false);
  const sig = useInboxStore((s) => {
    const m = conversationMigrationOf(s.migrationBatches, conversationId);
    return m ? [m.batch.batch_id, m.batch.cancelled_at, m.row.status, m.row.stage, m.row.error, m.row.started_at, m.row.finished_at, m.row.updated_at].join("|") : "";
  });
  const cached = useMemo(() => conversationMigrationOf(useInboxStore.getState().migrationBatches, conversationId), [conversationId, sig]);
  const live = !!cached && !isRowTerminal(cached.row.status) && !cached.batch.cancelled_at;
  useSyncCollection("migrationBatches", (api as any).sessionMigrations.listBatches, conversationId && (fenced || asked || live) ? {} : "skip");
  return cached;
}

/** Display names for the machines a migration row names. */
function useMigrationNames(row: MigrationBatchRow | undefined) {
  const roster = useInboxStore((s) => s.machineRoster as Device[]);
  return useMemo(() => {
    const name = (id: string | null | undefined, fallback: string) => {
      const d = rosterDeviceOf(roster, id);
      return d ? deviceDisplayName(d) : fallback;
    };
    return {
      dest: name(row?.to_device_id, "the other machine"),
      from: name(row?.from_device_id, "the cloud host"),
      executor: name(row?.executor_device_id, "the moving machine"),
    };
  }, [roster, row?.to_device_id, row?.from_device_id, row?.executor_device_id]);
}

/**
 * The move a conversation is in, for the device menu: where it is heading and
 * a word on how far it got. A migration (back from a cloud host) reports its
 * phase; a plain move only that it is under way.
 */
function useMoveInFlight(conversationId: string): { to_device_id: string; label: string } | null {
  const m = useConversationMigration(conversationId);
  const gesture = useInboxStore((s) => latestSessionCommand(s.sessionCommands, (r) => r.conversation_id === conversationId && r.kind === "move"));
  if (m && !isRowTerminal(m.row.status) && !m.batch.cancelled_at) {
    return { to_device_id: m.row.to_device_id, label: ROW_STATUS_LABEL[m.row.status] };
  }
  if (gesture?.to_device_id && deviceMoveStatusOf(gesture, [], Date.now()).phase === "restarting") {
    return { to_device_id: gesture.to_device_id, label: "starting" };
  }
  return null;
}
