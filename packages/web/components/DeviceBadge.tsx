"use client";

/**
 * First-class "device" UI primitives. A session always runs on exactly one device
 * (its owner); these surface which one, whether it's online, and let the user move
 * it. The remote Mac is only ever an owner via an explicit move — auto-routing
 * lands on the most-recently-active local laptop/desktop (see convex/deviceRouting).
 */

import { useMemo } from "react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { deviceDisplayName, deviceKindLabel } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { wakesOnUse } from "../lib/machinePicker";
import { useSyncDevices } from "../hooks/useSyncDevices";
import type { RestartPhase, RestartStage } from "../hooks/useSessionRestart";
import { useConversationCommands } from "../hooks/useSessionCommands";
import { useCoarseNow } from "../hooks/useCoarseNow";
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

import { useWatchEffect } from "../hooks/useWatchEffect";
export type Device = {
  device_id: string;
  label: string;
  platform: string;
  /** Heartbeat-reported machine name. Only ever a placeholder for ssh_host. */
  hostname?: string;
  /** User-set SSH target (Settings → Devices); absent = no way to reach it. */
  ssh_host?: string;
  last_seen: number;
  is_remote: boolean;
  local_project_roots: string[];
  /** Teams this machine is open to (Settings > Machines); teammates there may
   *  start sessions on it. Empty or absent = private. */
  shared_team_ids?: string[];
  /** Installed agent-feature snippets (by slug) + stable mode, heartbeat-reported. */
  settings?: {
    snippets?: Record<string, boolean>;
    stable_mode?: "solo" | "team" | "off";
    stable_global?: boolean;
    /** Codecast's Claude Code hooks installed here; absent from daemons that
     *  predate the switch (their hooks are always installed). */
    hooks_enabled?: boolean;
    /** May this machine update codecast without being asked each time? */
    auto_update?: boolean;
    /** Does the session trailer hook add Codecast-Session to commits here?
     *  Absent from daemons that predate the setting. */
    session_trailer?: boolean;
  };
  /** The cast version the daemon runs, a newer release it could take, and
   *  whether it is below the fleet minimum (Settings > Daemon). */
  cli_version?: string;
  update_available?: string;
  update_required?: boolean;
  /** When this daemon process started (devices.listDevices). */
  daemon_started_at?: number;
  /** Per-repo git health on this device (daemon gitPlane sweep). */
  git_plane?: Array<{
    root: string;
    origin?: string;
    origin_ok: boolean;
    fetch_ok?: boolean;
    ahead?: number;
    behind?: number;
    branch?: string;
    fetched_at?: number;
    repaired_from?: string;
    needs_access?: boolean;
    identity?: string;
    error?: string;
  }>;
  /** The device's PUBLIC git key — pasteable into GitHub to grant repo access. */
  git_pubkey?: string;
  /** The loop freeze budget for this machine: blocked ms in the last hour, the
   * worst single freeze, and the stacks it was in (devices.listDevices). */
  loop_freeze_1h_ms?: number;
  loop_freeze_max_ms?: number;
  loop_freeze_top?: string;
  /** A cloud host's own readiness (its heartbeat) and its managing laptop's report (Settings > Machines). */
  host_readiness?: import("@codecast/shared/contracts").HostReadiness;
  cloud_host?: import("@codecast/shared/contracts").CloudHostReport;
  /** What keeps this machine from reading a cloud agent provider (its heartbeat): it is not connected to that one. */
  cloud_agent_blocks?: import("@codecast/shared/contracts").CloudAgentSetupBlock[];
  online: boolean;
};

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

export function relativeSeen(lastSeen: number): string {
  const s = Math.max(0, Math.round((Date.now() - lastSeen) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function DeviceIcon({ d, className = "w-3 h-3" }: { d: Device; className?: string }) {
  if (d.is_remote) {
    // cloud / remote box
    return (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h11a3 3 0 000-6 5 5 0 00-9.584-1.5A3.5 3.5 0 003 15z" />
      </svg>
    );
  }
  if (/linux/i.test(d.platform)) {
    return (
      <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    );
  }
  // laptop / desktop
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

/** Live online/offline dot. */
export function DeviceDot({ online, className = "" }: { online: boolean; className?: string }) {
  return (
    <span className={`relative inline-flex h-1.5 w-1.5 flex-shrink-0 ${className}`}>
      {online && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sol-green opacity-60" />
      )}
      <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${online ? "bg-sol-green" : "bg-gray-500"}`} />
    </span>
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
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-gray-500/10 text-gray-400 border border-gray-500/25 ${className}`}
        title="No device assigned yet — the next message routes to your most-recently-active machine."
      >
        <DeviceDot online={false} />
        Unassigned
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border ${deviceAccentClasses(d)} max-w-[160px] ${className}`}
      title={`Runs on ${deviceDisplayName(d)} (${deviceKindLabel(d)}) — ${d.online ? "online" : `last seen ${relativeSeen(d.last_seen)}`}`}
    >
      <DeviceIcon d={d} />
      <span className="truncate">{deviceDisplayName(d)}</span>
      <DeviceDot online={d.online} />
    </span>
  );
}

// The machine a session runs on is disabled as a target, but it is the one
// row the reader looks for: undo the disabled dimming and mark it in blue.
export const RUNNING_HERE_ROW = "data-[disabled]:opacity-100 bg-sol-blue/10 ring-1 ring-inset ring-sol-blue/40";

export function RunningHereTag({ online, suffix }: { online: boolean; suffix?: string }) {
  return (
    <span className="ml-2 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-sol-blue/20 px-2 py-0.5 text-[10px] font-medium text-sol-blue">
      running here{suffix ? ` · ${suffix}` : ""}
      <DeviceDot online={online} />
    </span>
  );
}

/**
 * Dropdown-menu items to move a conversation between devices. Drop inside an open
 * DropdownMenuContent. Shows every device; the current owner is marked, online
 * locals offer "Run here", and the remote box offers "Move to remote Mac" (which
 * transfers the worktree). Offline devices are shown disabled.
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
  const runHere = (d: Device) => move(d, false);
  const toRemote = (d: Device) => move(d, true);

  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">Run on device · which machine</DropdownMenuLabel>
      {foreignOwner && (
        <DropdownMenuItem disabled className={RUNNING_HERE_ROW}>
          <DeviceIcon d={foreignOwner} className="w-3 h-3 mr-1.5" />
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
      {locals.map((d) => {
        const isOwner = d.device_id === ownerDeviceId;
        return (
          <DropdownMenuItem
            key={d.device_id}
            disabled={isOwner || !d.online}
            onSelect={() => !isOwner && d.online && runHere(d)}
            className={isOwner ? RUNNING_HERE_ROW : undefined}
          >
            <DeviceIcon d={d} className="w-3 h-3 mr-1.5" />
            <span className="flex-1 truncate">{deviceDisplayName(d)}</span>
            {isOwner ? <RunningHereTag online={d.online} /> : (
              <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-gray-400">
                {d.online ? "run here" : "offline"}
                <DeviceDot online={d.online} />
              </span>
            )}
          </DropdownMenuItem>
        );
      })}
      {allowRemoteMove && remotes.length > 0 && <DropdownMenuSeparator />}
      {allowRemoteMove && remotes.map((d) => {
        const isOwner = d.device_id === ownerDeviceId;
        // An asleep cloud box is still a valid destination — the move wakes
        // it. Only a remote that CANNOT wake (a remote Mac gone dark) is dead.
        const usable = d.online || deviceWakesOnUse(d);
        const name = deviceDisplayName(d);
        return (
          <DropdownMenuItem
            key={d.device_id}
            disabled={isOwner || !usable}
            onSelect={() => !isOwner && usable && toRemote(d)}
            className={isOwner ? RUNNING_HERE_ROW : undefined}
          >
            <DeviceIcon d={d} className="w-3 h-3 mr-1.5" />
            <span className="flex-1 truncate">{isOwner ? name : `Move to ${name}`}</span>
            {isOwner ? <RunningHereTag online={d.online} /> : (
              <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-gray-400">
                {d.online ? "" : usable ? "asleep — wakes on move" : "offline"}
                <DeviceDot online={d.online} />
              </span>
            )}
          </DropdownMenuItem>
        );
      })}
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
} {
  const gesture = useInboxStore((s) =>
    conversationId ? latestSessionCommand(s.sessionCommands, (r) => r.conversation_id === conversationId && r.kind === "move") : undefined);
  const open = !!gesture && !gesture.confirmed_at && gesture.result !== DISPATCH_REFUSED;
  // Tick fast only while the strip shows something; a settled move is idle.
  const now = useCoarseNow(deviceMoveStatusOf(gesture, [], Date.now()).phase !== "idle" ? 1_000 : 60_000);
  const rows = useConversationCommands(conversationId, open && !sessionCommandTimedOut(gesture!, now));
  const { phase, stage, failure, resumed } = deviceMoveStatusOf(gesture, rows, now);

  // The destination's resume landed: stamp the row confirmed, which every
  // reader of the move takes as "running there now".
  useWatchEffect(() => {
    if (gesture && resumed && !gesture.confirmed_at) useInboxStore.getState().confirmSessionCommand(gesture._id);
  }, [gesture, resumed]);

  return useMemo(() => {
    if (!conversationId || !gesture || phase === "idle") {
      return { phase: "idle" as RestartPhase, stage: null, failure: null, startedAt: null, restoredLabel: undefined, retry: () => {} };
    }
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
  }, [conversationId, gesture, phase, stage?.label, stage?.tone, failure]);
}
