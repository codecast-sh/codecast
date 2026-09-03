"use client";

/**
 * First-class "device" UI primitives. A session always runs on exactly one device
 * (its owner); these surface which one, whether it's online, and let the user move
 * it. The remote Mac is only ever an owner via an explicit move — auto-routing
 * lands on the most-recently-active local laptop/desktop (see convex/deviceRouting).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import { deviceDisplayName, deviceKindLabel } from "@codecast/shared/contracts";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { useSyncDevices } from "../hooks/useSyncDevices";
import type { RestartPhase, RestartProgressRow, RestartStage } from "../hooks/useSessionRestart";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

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
  /** Installed agent-feature snippets (by slug) + stable mode, heartbeat-reported. */
  settings?: {
    snippets?: Record<string, boolean>;
    stable_mode?: "solo" | "team" | "off";
    stable_global?: boolean;
  };
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
  online: boolean;
};

/**
 * Can this device be woken by a move? True for the cloud Linux class: an EC2
 * box whose idle state is "stopped" — the source daemon's move command boots
 * it before transferring. A remote Mac cannot stop (so "offline" means gone),
 * and a laptop can only be opened by a human.
 */
export function deviceWakesOnUse(d: Device): boolean {
  return d.is_remote && /linux/i.test(d.platform);
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

/**
 * Dropdown-menu items to move a conversation between devices. Drop inside an open
 * DropdownMenuContent. Shows every device; the current owner is marked, online
 * locals offer "Run here", and the remote box offers "Move to remote Mac" (which
 * transfers the worktree). Offline devices are shown disabled.
 */
export function RunOnDeviceItems({
  conversationId,
  ownerDeviceId,
}: {
  conversationId: string;
  ownerDeviceId?: string | null;
}) {
  const { byId, locals, remotes, loaded } = useDevices();
  const foreignOwner = useForeignOwnerDevice(
    conversationId,
    loaded && !!ownerDeviceId && !byId.get(ownerDeviceId),
  );
  const move = useMoveSessionToDevice();
  const runHere = (d: Device) => move(conversationId, { device_id: d.device_id, is_remote: false, label: deviceDisplayName(d) });
  const toRemote = (d: Device) => move(conversationId, { device_id: d.device_id, is_remote: true, label: deviceDisplayName(d) });

  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-sol-text-dim">Run on device · which machine</DropdownMenuLabel>
      {foreignOwner && (
        <DropdownMenuItem disabled>
          <DeviceIcon d={foreignOwner} className="w-3 h-3 mr-1.5" />
          <span className="flex-1 truncate">{deviceDisplayName(foreignOwner)}</span>
          <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-gray-400">
            running here ·{" "}
            {foreignOwner.runner?.is_bot
              ? "agent box"
              : foreignOwner.runner?.name
                ? `${foreignOwner.runner.name.split(" ")[0]}'s`
                : "teammate's"}
            <DeviceDot online={foreignOwner.online} />
          </span>
        </DropdownMenuItem>
      )}
      {locals.map((d) => {
        const isOwner = d.device_id === ownerDeviceId;
        return (
          <DropdownMenuItem
            key={d.device_id}
            disabled={isOwner || !d.online}
            onSelect={() => !isOwner && d.online && runHere(d)}
          >
            <DeviceIcon d={d} className="w-3 h-3 mr-1.5" />
            <span className="flex-1 truncate">{deviceDisplayName(d)}</span>
            <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-gray-400">
              {isOwner ? "running here" : d.online ? "run here" : "offline"}
              <DeviceDot online={d.online} />
            </span>
          </DropdownMenuItem>
        );
      })}
      {remotes.length > 0 && <DropdownMenuSeparator />}
      {remotes.map((d) => {
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
          >
            <DeviceIcon d={d} className="w-3 h-3 mr-1.5" />
            <span className="flex-1 truncate">{isOwner ? name : `Move to ${name}`}</span>
            <span className="ml-2 flex shrink-0 items-center gap-1 whitespace-nowrap text-[10px] text-gray-400">
              {isOwner ? "running here" : d.online ? "" : usable ? "asleep — wakes on move" : "offline"}
              <DeviceDot online={d.online} />
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

// ── Device-move progress ─────────────────────────────────────────────────────
// A move ("Run here" / "Move to remote Mac") is a multi-step daemon pipeline —
// worktree transfer (remote only), then a resume on the destination — that used
// to be narrated by nothing but a toast. These hooks give it the same live
// header strip as a kill+restart: the trigger records the move in the store
// (movingSessions) and the status hook derives real stages from the same
// daemon command rows getRestartProgress serves (it includes move_to_device).

const MOVE_UNCLAIMED_WARN_MS = 20_000;
// Give the pipeline its window before declaring failure: a local re-home is a
// quick resume; a remote move transfers the worktree, which can take minutes.
const MOVE_GIVE_UP_LOCAL_MS = 2 * 60_000;
const MOVE_GIVE_UP_REMOTE_MS = 10 * 60_000;
const MOVE_RESTORED_LINGER_MS = 5_000;
// A failed strip keeps its "Try again" this long past give-up, then the entry
// self-expires — a move navigated away from has no live owner to clear it.
const MOVE_FAILED_LINGER_MS = 5 * 60_000;

const moveGiveUpMs = (toRemote: boolean) => (toRemote ? MOVE_GIVE_UP_REMOTE_MS : MOVE_GIVE_UP_LOCAL_MS);

/** Destination of a move: a device by id + the display name to narrate with. */
export type MoveTarget = { device_id: string; is_remote: boolean; label: string };

function clearMoveEntry(convId: string, startedAt: number) {
  const cur = useInboxStore.getState().movingSessions ?? {};
  // Only clear OUR move — a retry may have replaced the entry meanwhile.
  if (cur[convId]?.started_at !== startedAt) return;
  const { [convId]: _gone, ...rest } = cur;
  useInboxStore.setState({ movingSessions: rest });
}

/**
 * Fire a device move and record it in the store so any surface (the header
 * strip) can narrate it live. Shared by the Run-on-device menu items and the
 * strip's own "Try again".
 */
export function useMoveSessionToDevice() {
  const reassign = useMutation(api.devices.reassignToDevice);
  const moveToRemote = useMutation(api.devices.moveToRemote);
  return useCallback(
    (conversationId: string, target: MoveTarget) => {
      // On a fork/new-session stub page `conversationId` is the client-minted
      // session UUID until the create resolves — follow the store's stub→real
      // mapping when it exists. The server accepts any ref (id / short id /
      // session UUID), so an unmapped UUID still resolves once the create lands.
      const s = useInboxStore.getState();
      const convId = s.getConvexId(conversationId) ?? conversationId;
      const entry = {
        started_at: Date.now(),
        to_device_id: target.device_id,
        to_remote: target.is_remote,
        to_label: target.label,
      };
      useInboxStore.setState({ movingSessions: { ...(s.movingSessions ?? {}), [convId]: entry } });
      const req = target.is_remote
        ? moveToRemote({ conversation_id: convId, to_device_id: target.device_id })
        : reassign({ conversation_id: convId, device_id: target.device_id });
      req.catch((e: any) => {
        const msg = e?.message || "Move failed";
        toast.error(msg);
        const cur = useInboxStore.getState().movingSessions ?? {};
        if (cur[convId]?.started_at === entry.started_at) {
          useInboxStore.setState({ movingSessions: { ...cur, [convId]: { ...entry, error: msg } } });
        }
      });
    },
    [reassign, moveToRemote],
  );
}

/**
 * Live status of a device move for the conversation header strip, in the same
 * phase/stage vocabulary as useSessionRestart so the two share a renderer:
 * "restarting" (in flight) → "restored" (running on the destination;
 * auto-clears) | "failed" (mutation error, daemon error, or give-up; keeps a
 * retry, then expires). Idle (no entry) costs nothing — the progress query is
 * skip-gated and the clock tick only runs mid-move.
 */
export function useDeviceMoveStatus(conversationId: string | undefined): {
  phase: RestartPhase;
  stage: RestartStage | null;
  failure: string | null;
  startedAt: number | null;
  restoredLabel: string | undefined;
  retry: () => void;
} {
  const entry = useInboxStore((s) => (conversationId ? s.movingSessions?.[conversationId] : undefined));
  const move = useMoveSessionToDevice();

  // The unclaimed warning and the give-up are time-driven, not row-driven — a
  // coarse tick re-evaluates them, gated so it costs nothing outside a move.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!entry || entry.error) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, [entry]);

  // No-throw: restart progress is a live decoration on a restart the user
  // already triggered. Losing it degrades the readout to idle; throwing would
  // take down the surface mid-restart, exactly when it is being watched.
  const { data: progressRaw } = useQueryNoThrow(
    api.conversations.getRestartProgress,
    entry && !entry.error && conversationId && isConvexId(conversationId)
      ? { conversation_id: conversationId }
      : "skip",
  ) as { data: RestartProgressRow[] | null | undefined };

  const status = useMemo(() => {
    const idle = {
      phase: "idle" as RestartPhase,
      stage: null as RestartStage | null,
      failure: null as string | null,
      startedAt: null as number | null,
      restoredLabel: undefined as string | undefined,
      retry: () => {},
    };
    if (!conversationId || !entry) return idle;
    const dest = entry.to_label;
    const base = {
      startedAt: entry.started_at,
      restoredLabel: `Session is now running on ${dest}`,
      retry: () =>
        move(conversationId, { device_id: entry.to_device_id, is_remote: entry.to_remote, label: dest }),
    };
    const failed = (failure: string) => ({ ...base, phase: "failed" as RestartPhase, stage: null, failure });
    if (entry.error) return failed(entry.error);
    // Scope to THIS move: the query returns the conversation's recent
    // kill/resume/move rows, which can include an earlier restart or move.
    // 10s tolerance covers client/server clock skew.
    const rows = (progressRaw ?? []).filter((c) => c.created_at >= entry.started_at - 10_000);
    const last = [...rows].reverse();
    const resume = last.find((c) => c.command === "resume_session");
    const mv = last.find((c) => c.command === "move_to_device");
    if (resume?.executed_at) {
      if (resume.error) return failed(`Move failed: ${resume.error}`);
      return { ...base, phase: "restored" as RestartPhase, stage: null, failure: null };
    }
    if (mv?.executed_at && mv.error) return failed(`Move failed: ${mv.error}`);
    const age = now - entry.started_at;
    if (age > moveGiveUpMs(entry.to_remote)) {
      return failed("Move didn't finish — a device may be offline. Check its daemon, or try again.");
    }
    const stage: RestartStage =
      mv?.executed_at
        ? { label: `Transferred — starting on ${dest}…`, tone: "active" }
        : !rows.some((c) => c.executed_at) && age > MOVE_UNCLAIMED_WARN_MS
          ? { label: "Waiting for the daemon to pick this up — is the source device online?", tone: "warn" }
          : mv
            ? { label: `Transferring session to ${dest} — this can take a few minutes…`, tone: "active" }
            : resume
              ? { label: `Starting on ${dest}…`, tone: "active" }
              : { label: `Moving session to ${dest}…`, tone: "active" };
    return { ...base, phase: "restarting" as RestartPhase, stage, failure: null };
  }, [conversationId, entry, progressRaw, now, move]);

  // Self-cleaning: a confirmed move lingers green then clears; a failed one
  // keeps its retry for a while, then expires rather than sticking forever.
  useEffect(() => {
    if (!conversationId || !entry) return;
    if (status.phase === "restored") {
      const t = setTimeout(() => clearMoveEntry(conversationId, entry.started_at), MOVE_RESTORED_LINGER_MS);
      return () => clearTimeout(t);
    }
    if (status.phase === "failed") {
      const expireAt = entry.started_at + moveGiveUpMs(entry.to_remote) + MOVE_FAILED_LINGER_MS;
      const t = setTimeout(() => clearMoveEntry(conversationId, entry.started_at), Math.max(0, expireAt - Date.now()));
      return () => clearTimeout(t);
    }
  }, [status.phase, conversationId, entry]);

  return status;
}
