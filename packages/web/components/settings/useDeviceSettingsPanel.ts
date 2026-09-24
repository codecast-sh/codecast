"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@codecast/convex/convex/_generated/api";
import { useDevices } from "../DeviceBadge";
import { useLocalDeviceId } from "../../hooks/useLocalDeviceId";

/**
 * The state every device-scoped settings panel shares (Agent Features,
 * Harness, Daemon): which machine is on screen, and a `run` that marks one
 * control busy while its command is queued and toasts a failure.
 *
 * The machine starts as the one this browser runs on: that is the harness a
 * person looking at their settings usually means. Until the local daemon
 * answers, and on a device with no daemon of its own, it falls back to the
 * most recently seen online machine.
 */
export function useDeviceSettingsPanel() {
  const { devices, mostRecentOnlineLocal } = useDevices();
  const localDeviceId = useLocalDeviceId(true);
  const setSnippet = useMutation(api.devices.setDeviceSnippet);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...devices].sort(
        (a, b) =>
          Number(b.device_id === localDeviceId) - Number(a.device_id === localDeviceId) ||
          Number(b.online) - Number(a.online) ||
          Number(a.is_remote) - Number(b.is_remote) ||
          b.last_seen - a.last_seen,
      ),
    [devices, localDeviceId],
  );

  const selected =
    sorted.find((d) => d.device_id === selectedId) ??
    sorted.find((d) => d.device_id === localDeviceId) ??
    mostRecentOnlineLocal ??
    sorted[0] ??
    null;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setPending((p) => new Set(p).add(key));
    try {
      await fn();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't apply that change");
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(key);
        return n;
      });
    }
  };

  return { devices: sorted, selected, select: setSelectedId, localDeviceId, pending, run, setSnippet };
}
