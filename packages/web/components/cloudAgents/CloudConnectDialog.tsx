"use client";

// The frame every cloud agent "connect" dialog shares. A cloud agent is driven
// from one of the person's computers (the browser cannot reach the provider's
// API), so the dialog names that machine and fixes it when it opens. It says
// so when no machine is online, when the one it names is offline, or when that
// one runs a codecast too old for this, and closes with Done once the
// provider's own steps finish. Each provider's dialog (ConnectCursorDialog,
// ConnectCodexDialog) supplies only its steps.

import { useState, type ReactNode } from "react";
import { useDevices, type Device } from "../DeviceBadge";
import { deviceManagedKeys } from "../../lib/useProviderKeyCommand";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

/**
 * The machine that drives a cloud agent session, and whether it is already
 * connected to the provider: the one named (the session's machine, the page's
 * machine), else your most recently seen online computer.
 */
export function useCloudAgentMachine(deviceId: string | null | undefined, isConnected: (device: Device) => boolean): { device: Device | null; connected: boolean } {
  const { byId, mostRecentOnlineLocal } = useDevices();
  const device = (deviceId ? byId.get(deviceId) : undefined) ?? mostRecentOnlineLocal;
  return { device, connected: !!device && isConnected(device) };
}

/**
 * The machine for a dialog, fixed when it opens: the roster reorders as
 * machines check in, and credentials must go where the label said.
 */
export function usePinnedCloudAgentMachine(deviceId: string | null | undefined, isConnected: (device: Device) => boolean) {
  const initial = useCloudAgentMachine(deviceId, isConnected);
  const [pinnedId] = useState(() => initial.device?.device_id ?? null);
  const { device, connected } = useCloudAgentMachine(pinnedId, isConnected);
  return { device, connected, machine: device?.label ?? "your computer", pubkey: device ? deviceManagedKeys(device).pubkey : undefined };
}

export function CloudConnectDialog({ title, description, device, machine, needsPubkey = true, pubkey, outdated = false, done, onClose, children }: {
  title: string;
  description: ReactNode;
  device: Device | null;
  machine: string;
  /** Credentials cross codecast sealed to the machine's key, which older daemons lack. */
  needsPubkey?: boolean;
  pubkey?: string;
  /** The machine's codecast answered that it cannot do this yet (too old). */
  outdated?: boolean;
  done: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {!device ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-500">
            None of your computers is online. Start codecast on one (<code className="font-mono">cast start</code>), then come back.
          </p>
        ) : !device.online ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-500">
            {machine} is offline. Start codecast there (<code className="font-mono">cast start</code>), then come back.
          </p>
        ) : outdated || (needsPubkey && !pubkey) ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs text-amber-500">
            Update codecast on {machine}, then connect from here.
          </p>
        ) : (
          <div className="space-y-3 text-xs leading-relaxed text-sol-text-muted">{children}</div>
        )}

        <DialogFooter>
          <Button size="sm" variant={done ? "default" : "ghost"} onClick={onClose} className="h-7 px-3 text-[11px]">
            {done ? "Done" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
