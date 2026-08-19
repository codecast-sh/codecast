// The words for each daemon health state, shared by the header chip and the
// per-message delivery note so both surfaces tell the same story. `label` is
// the short chip text; `detail` is a full sentence for a tooltip or a bubble
// note; `command` is what the user can run (click to copy).
import { formatDuration, type DaemonHealth } from "../hooks/useDaemonHealth";

export interface DaemonHealthCopy {
  colorVar: string;
  label: string;
  detail: string;
  command: string;
}

const secs = (ms: number) => `${Math.max(1, Math.round(ms / 1000))}s`;

export function describeDaemonHealth(health: DaemonHealth): DaemonHealthCopy | null {
  switch (health.kind) {
    case "offline": {
      const stale = formatDuration(health.offlineMs);
      if (health.tier === "warn") {
        return {
          colorVar: "--sol-yellow",
          label: `daemon stale ${stale}`,
          detail: `The CLI daemon hasn't synced in ${stale}. Messages can't reach agents until it does.`,
          command: "cast status",
        };
      }
      return {
        colorVar: health.tier === "severe" ? "--sol-red" : "--sol-orange",
        label: `daemon offline ${stale}`,
        detail: `The CLI daemon has been offline for ${stale}. Messages can't reach agents until it is back.`,
        command: "cast restart",
      };
    }
    case "quiet": {
      const quiet = formatDuration(health.quietMs);
      return {
        colorVar: "--sol-yellow",
        label: `daemon quiet ${quiet}`,
        detail: `The CLI daemon hasn't checked in for ${quiet} — it may be frozen, restarting, or the machine may be asleep. Deliveries and echoes are delayed until it checks in.`,
        command: "cast status",
      };
    }
    case "restarting":
      return {
        colorVar: "--sol-cyan",
        label: `daemon restarted ${secs(health.sinceMs)} ago`,
        detail: `The CLI daemon restarted ${secs(health.sinceMs)} ago and is recovering sessions and watchers. Deliveries and echoes catch up once it settles.`,
        command: "cast status",
      };
    case "overloaded":
      return {
        colorVar: "--sol-orange",
        label: `daemon under load`,
        detail: `The CLI daemon was frozen for ${secs(health.freezeMs)} of the last minute (the machine is busy). Deliveries and echoes are delayed, not lost.`,
        command: "cast status",
      };
    case "sync_stalled": {
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
        detail: `The CLI daemon is online but ${count} ${unit}${count === 1 ? "" : "s"}${convoNote} have been waiting to sync for ${stalled}.`,
        command: "cast status",
      };
    }
    default:
      return null;
  }
}
