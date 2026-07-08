"use client";

/**
 * First-class "device" UI primitives. A session always runs on exactly one device
 * (its owner); these surface which one, whether it's online, and let the user move
 * it. The remote Mac is only ever an owner via an explicit move — auto-routing
 * lands on the most-recently-active local laptop/desktop (see convex/deviceRouting).
 */

import { useMemo } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { toast } from "sonner";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

export type Device = {
  device_id: string;
  label: string;
  platform: string;
  last_seen: number;
  is_remote: boolean;
  local_project_roots: string[];
  /** Installed agent-feature snippets (by slug) + stable mode, heartbeat-reported. */
  settings?: {
    snippets?: Record<string, boolean>;
    stable_mode?: "solo" | "team" | "off";
    stable_global?: boolean;
  };
  online: boolean;
};

/** A clean display name: "Remote Mac" for the box, hostname for a laptop/desktop. */
export function deviceDisplayName(d: Device | undefined | null): string {
  if (!d) return "Unknown device";
  if (d.is_remote) return "Remote Mac";
  // "macOS - MacBook-Pro-4.local" → "MacBook-Pro-4"
  const stripped = d.label.replace(/^(macOS|Linux|Windows)\s*-\s*/i, "").replace(/\.local$/i, "");
  return stripped || d.label;
}

export function deviceKindLabel(d: Device): string {
  if (d.is_remote) return "Remote";
  if (/linux/i.test(d.platform)) return "Linux";
  // process.platform is "win32" — match that (or a friendly "Windows"), NOT a
  // bare "win", which the "win" inside "darwin" would falsely trip.
  if (/win32|windows/i.test(d.platform)) return "Windows";
  return "Mac";
}

/** Per-kind accent classes. Literal strings so Tailwind's JIT keeps them. */
function accentClasses(d: Device): string {
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

function DeviceIcon({ d, className = "w-3 h-3" }: { d: Device; className?: string }) {
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

/** Load the user's devices, with helpers for routing-aware decisions. */
export function useDevices() {
  const devices = (useQuery(api.devices.listDevices, {}) ?? []) as Device[];
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
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border ${accentClasses(d)} max-w-[160px] ${className}`}
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
  const { locals, remotes } = useDevices();
  const reassign = useMutation(api.devices.reassignToDevice);
  const moveToRemote = useMutation(api.devices.moveToRemote);

  const runHere = (d: Device) => {
    toast.info(`Moving session to ${deviceDisplayName(d)}…`);
    reassign({ conversation_id: conversationId as Id<"conversations">, device_id: d.device_id })
      .then(() => toast.success(`Now running on ${deviceDisplayName(d)}`))
      .catch((e: any) => toast.error(e?.message || "Move failed"));
  };
  const toRemote = (d: Device) => {
    toast.info("Moving session to remote Mac…");
    moveToRemote({ conversation_id: conversationId as Id<"conversations">, to_device_id: d.device_id })
      .then(() => toast.success("Moving to remote Mac…"))
      .catch((e: any) => toast.error(e?.message || "Move failed"));
  };

  return (
    <>
      <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-gray-400">Run on device</DropdownMenuLabel>
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
            <span className="ml-2 flex items-center gap-1 text-[10px] text-gray-400">
              {isOwner ? "running here" : d.online ? "run here" : "offline"}
              <DeviceDot online={d.online} />
            </span>
          </DropdownMenuItem>
        );
      })}
      {remotes.length > 0 && <DropdownMenuSeparator />}
      {remotes.map((d) => {
        const isOwner = d.device_id === ownerDeviceId;
        return (
          <DropdownMenuItem
            key={d.device_id}
            disabled={isOwner || !d.online}
            onSelect={() => !isOwner && d.online && toRemote(d)}
          >
            <DeviceIcon d={d} className="w-3 h-3 mr-1.5" />
            <span className="flex-1 truncate">{isOwner ? "Remote Mac" : "Move to remote Mac"}</span>
            <span className="ml-2 flex items-center gap-1 text-[10px] text-gray-400">
              {isOwner ? "running here" : d.online ? "" : "offline"}
              <DeviceDot online={d.online} />
            </span>
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
