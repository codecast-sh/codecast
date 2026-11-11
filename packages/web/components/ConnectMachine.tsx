"use client";
// The one way to connect a machine, new or returning. The install command
// with a setup token installs or updates cast, signs the machine in and starts
// its daemon, and a machine that ran it before keeps its device id, so the same
// command connects a new machine and brings back one that went offline or was
// signed out. The panel mints the token when it opens and says when the
// machine shows up.
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Check, Copy } from "lucide-react";
import { copyToClipboard, cn } from "../lib/utils";
import { track } from "../lib/analytics";
import { detectInstallOs, type InstallOs } from "../lib/visitorPlatform";
import { useCurrentUser } from "../hooks/useCurrentUser";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore } from "../store/inboxStore";
import { SegmentedToggle } from "./SegmentedToggle";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { deviceDisplayName, useDevices, type Device } from "./DeviceBadge";

// curl|sh can't run on Windows and irm|iex can't run on a POSIX shell. The
// Windows form passes the token through an env var because `irm | iex`
// evaluates script text and can't forward arguments.
export function installCommand(os: InstallOs, token: string): string {
  return os === "windows"
    ? `$env:CODECAST_SETUP_TOKEN="${token}"; irm codecast.sh/install.ps1 | iex`
    : `curl -fsSL codecast.sh/install | sh -s -- ${token}`;
}

const osFor = (target?: Device): InstallOs => (target ? (/win/i.test(target.platform) ? "windows" : "unix") : detectInstallOs());

/** The machine that came online since the panel opened: `target` when given, else any machine that was new or offline then. */
function useArrival(target?: Device): Device | null {
  const { devices } = useDevices();
  const live = useInboxStore((s) => s.machineRosterLive);
  // Taken from the first live roster, so a machine already online before the panel opened never reads as just arrived.
  const [wasOnline, setWasOnline] = useState<Map<string, boolean> | null>(null);
  if (live && !wasOnline) setWasOnline(new Map(devices.map((d) => [d.device_id, !!d.online])));
  if (target) return devices.find((d) => d.device_id === target.device_id && d.online) ?? null;
  if (!wasOnline) return null;
  return devices.find((d) => d.online && wasOnline.get(d.device_id) !== true) ?? null;
}

export function ConnectMachine({
  target,
  location,
  onCopy,
}: {
  /** Reconnecting a known machine: the panel waits for that one. */
  target?: Device;
  location: string;
  onCopy?: () => void;
}) {
  const createSetupToken = useMutation(api.apiTokens.createSetupToken);
  const [os, setOs] = useState<InstallOs>(() => osFor(target));
  const [minted, setMinted] = useState<{ token: string; expiresAt: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const arrived = useArrival(target);

  const { user } = useCurrentUser();
  const mint = () => void createSetupToken({}).then(setMinted).catch(() => setMinted(null));
  useWatchEffect(() => {
    if (user && !minted) mint();
  }, [user?._id]);
  // A panel left open past the token's hour gets a fresh one rather than a dead command.
  useWatchEffect(() => {
    if (!minted) return;
    const timer = setTimeout(mint, Math.max(0, minted.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [minted?.expiresAt]);

  const command = minted ? installCommand(os, minted.token) : null;
  const copy = async () => {
    if (!command) return;
    await copyToClipboard(command);
    track("install_command_copied", { location, platform: os, with_token: true });
    onCopy?.();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const name = target ? deviceDisplayName(target) : "the machine";

  return (
    <div className="space-y-3" data-connect-machine={arrived ? "connected" : "waiting"}>
      <SegmentedToggle
        value={os}
        onChange={(key) => setOs(key as InstallOs)}
        items={[
          { key: "unix", label: "macOS / Linux" },
          { key: "windows", label: "Windows", title: "PowerShell. Installs into WSL, setting it up first if needed." },
        ]}
      />
      <div className="flex items-start gap-2 rounded-lg border border-sol-border/70 bg-sol-bg-inset p-3">
        <code className="min-h-[1.25rem] min-w-0 flex-1 break-all font-mono text-xs leading-5 text-sol-text">
          {command ?? <span className="text-sol-text-dim">Preparing a command…</span>}
        </code>
        <Button size="sm" variant="secondary" onClick={copy} disabled={!command} className="h-7 shrink-0 gap-1.5 px-2.5 text-xs">
          {copied ? <Check className="h-3.5 w-3.5 text-sol-green" /> : <Copy className="h-3.5 w-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <div
        role="status"
        className={cn(
          "flex items-center gap-2 rounded-lg px-3 py-2 text-sm",
          arrived ? "bg-sol-green/10 text-sol-green" : "bg-sol-bg-alt/60 text-sol-text-muted",
        )}
      >
        {arrived ? <Check className="h-4 w-4 shrink-0" /> : <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-sol-yellow" />}
        <span className="min-w-0 truncate">
          {arrived ? `${deviceDisplayName(arrived)} is connected` : `Waiting for ${name}`}
        </span>
      </div>
    </div>
  );
}

/** The Machines page's connect and reconnect: the panel in a dialog that closes on Done once the machine is in. */
export function ConnectMachineDialog({ target, open, onOpenChange }: { target?: Device; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-sol-border bg-sol-card sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{target ? `Reconnect ${deviceDisplayName(target)}` : "Connect a machine"}</DialogTitle>
          <DialogDescription>Paste this into a terminal on {target ? deviceDisplayName(target) : "the machine"}.</DialogDescription>
        </DialogHeader>
        {open && <ConnectMachine target={target} location={target ? "settings_machines_reconnect" : "settings_machines"} />}
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" onClick={() => onOpenChange(false)}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
