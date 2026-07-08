import { useState } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { copyToClipboard } from "../lib/utils";
import { useDaemonHealth, formatDuration } from "../hooks/useDaemonHealth";

interface ChipView {
  colorVar: string;
  label: string;
  title: string;
  command: string;
}

function viewFor(health: ReturnType<typeof useDaemonHealth>): ChipView | null {
  if (health.kind === "offline") {
    const stale = formatDuration(health.offlineMs);
    if (health.tier === "warn") {
      return {
        colorVar: "--sol-yellow",
        label: `daemon stale ${stale}`,
        title: `CLI hasn't synced in ${stale}. Run cast status to inspect (click to copy).`,
        command: "cast status",
      };
    }
    return {
      colorVar: health.tier === "severe" ? "--sol-red" : "--sol-orange",
      label: `daemon offline ${stale}`,
      title: `CLI offline for ${stale}. Run cast restart to recover (click to copy).`,
      command: "cast restart",
    };
  }
  if (health.kind === "sync_stalled") {
    const stalled = formatDuration(health.stalledMs);
    // Prefer the honest message count; fall back to logical ops for older
    // daemons that don't report it yet.
    const count = health.messages > 0 ? health.messages : health.pending;
    const unit = health.messages > 0 ? "message" : "operation";
    const convoNote =
      health.conversations > 0
        ? ` across ${health.conversations} conversation${health.conversations === 1 ? "" : "s"}`
        : "";
    return {
      colorVar: "--sol-yellow",
      label: `syncing ${count}, oldest ${stalled} behind`,
      title: `Daemon is online but ${count} ${unit}${count === 1 ? "" : "s"}${convoNote} have been waiting to sync for ${stalled}. Run cast status to inspect (click to copy).`,
      command: "cast status",
    };
  }
  return null;
}

export function DaemonStatusChip() {
  const health = useDaemonHealth();
  const [mounted, setMounted] = useState(false);
  const [copied, setCopied] = useState(false);

  useMountEffect(() => {
    setMounted(true);
  });

  if (!mounted) return null;

  const view = viewFor(health);
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
      title={view.title}
    >
      <span className="relative flex h-2 w-2">
        <span
          className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40"
          style={{ background: color, animationDuration: "2s" }}
        />
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: color }} />
      </span>
      <span className="text-[11px] font-mono font-bold whitespace-nowrap" style={{ color }}>
        {copied ? "copied!" : view.label}
      </span>
    </button>
  );
}
