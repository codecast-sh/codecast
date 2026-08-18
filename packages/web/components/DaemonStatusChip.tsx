import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { copyToClipboard } from "../lib/utils";
import { useDaemonHealth } from "../hooks/useDaemonHealth";
import { useSyncDevices } from "../hooks/useSyncDevices";
import { describeDaemonHealth } from "../lib/daemonHealthCopy";
import { useAppOffline } from "../hooks/useAppOffline";

export function DaemonStatusChip() {
  // Keep the device roster fed: health is per machine (devices.listDevices),
  // and this chip is the one always-mounted reader.
  useSyncDevices();
  const health = useDaemonHealth();
  // When this client itself is disconnected, daemon_last_seen is stale because
  // WE can't sync — the ConnectionBanner owns that story; a "daemon stale"
  // chip would misattribute it.
  const { offline: appOffline } = useAppOffline();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  useMountEffect(() => {
    setMounted(true);
  });

  if (!mounted || appOffline) return null;

  const view = describeDaemonHealth(health);
  if (!view) return null;

  const color = `var(${view.colorVar})`;

  const handleClick = async () => {
    await copyToClipboard(view.command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleClick}
      className="hidden md:flex items-center gap-1.5 px-2 py-0.5 rounded-full cursor-pointer select-none transition-all duration-300"
      style={{
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
        boxShadow: `0 0 10px color-mix(in srgb, ${color} 12%, transparent)`,
      }}
      title={`${view.detail} Run ${view.command} to inspect (click to copy).`}
    >
      <span className="relative flex h-2 w-2">
        <span
          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
          style={{ background: color, animationDuration: "2s" }}
        />
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: color }} />
      </span>
      <span className="text-[11px] font-mono font-bold whitespace-nowrap" style={{ color }}>
        {copied ? "copied!" : health.device ? `${health.device}: ${view.label}` : view.label}
      </span>
    </button>
  );
}
