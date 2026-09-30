"use client";

// The frame every cloud agent "connect" dialog shares. A cloud agent is driven
// from one of the person's computers (the browser cannot reach the provider's
// API), so the dialog names that machine and fixes it when it opens. It says
// so when no machine is online, when the one it names is offline, or when that
// one runs a codecast too old for this, and closes with Done once the
// provider's own steps finish. Each provider's dialog (ConnectCursorDialog,
// ConnectCodexDialog) supplies only its steps, and pins its machine with
// usePinnedCloudAgentMachine (machine.ts).

import type { ReactNode } from "react";
import type { Device } from "../DeviceBadge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

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
