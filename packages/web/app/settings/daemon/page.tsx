"use client";

import { autoUpdateLock, useDevicePolicy } from "../../../lib/managedPolicy";
import { Cpu, RefreshCw } from "lucide-react";
import { selfUpdateBlocked } from "@codecast/convex/convex/lib/deviceUpdate";
import { useInboxStore } from "../../../store/inboxStore";
import { Switch } from "../../../components/ui/switch";
import { Button } from "../../../components/ui/button";
import { SettingsCallout, SettingsRow, SettingsSection } from "../../../components/settings/ui";
import { DeviceSettingsFrame } from "../../../components/settings/DeviceSettingsFrame";
import { useDeviceSettingsPanel } from "../../../components/settings/useDeviceSettingsPanel";
import { relativeSeen, type Device } from "../../../components/DeviceBadge";
import { useDaemonHealth } from "../../../hooks/useDaemonHealth";
import { describeDaemonHealth } from "../../../lib/daemonHealthCopy";

/**
 * Daemon: the codecast daemon on one machine. What version it runs, whether it
 * is healthy, and whether it may update itself. With automatic update off, a
 * machine takes a new release only when you press Update here or run
 * `cast update` there, so nothing about it changes between those moments.
 */
export default function DaemonPage() {
  const panel = useDeviceSettingsPanel();
  return (
    <DeviceSettingsFrame panel={panel} title="Daemon" icon={Cpu} reports={(d) => !!d.settings || !!d.cli_version}>
      {(d) => (
        <>
          <StatusSection d={d} />
          <UpdatesSection d={d} panel={panel} />
        </>
      )}
    </DeviceSettingsFrame>
  );
}

function StatusSection({ d }: { d: Device }) {
  const health = useDaemonHealth(d.device_id);
  const problem = describeDaemonHealth(health);
  return (
    <SettingsSection title="Daemon" icon={Cpu} description="The background process that syncs this machine's sessions and runs what you ask of it.">
      <SettingsRow
        label="Status"
        description={
          !d.online
            ? `Offline. Last seen ${relativeSeen(d.last_seen)}.`
            : d.daemon_started_at
              ? `Running since ${new Date(d.daemon_started_at).toLocaleString()} (${relativeSeen(d.daemon_started_at).replace(" ago", "")}).`
              : "Running."
        }
      >
        <StatePill tone={!d.online ? "muted" : problem ? "warn" : "ok"}>
          {!d.online ? "Offline" : problem ? problem.short : "Healthy"}
        </StatePill>
      </SettingsRow>
      {problem && d.online && (
        <div className="px-4 pb-3 sm:px-5">
          <SettingsCallout tone="warning">
            {problem.detail} <code className="font-mono">{problem.command}</code>
          </SettingsCallout>
        </div>
      )}
      <SettingsRow label="Version" description={versionLine(d)}>
        <StatePill tone={d.update_required ? "warn" : d.update_available ? "info" : "ok"}>
          {d.cli_version ? `v${d.cli_version}` : "unknown"}
        </StatePill>
      </SettingsRow>
    </SettingsSection>
  );
}

function versionLine(d: Device): string {
  if (!d.cli_version) return "This machine's CLI does not report its version. Run cast update there.";
  if (d.update_required) return `Below the minimum version codecast supports. Update it so every feature keeps working${d.update_available ? `; v${d.update_available} is out` : ""}.`;
  if (d.update_available) return `v${d.update_available} is available.`;
  return "Up to date.";
}

// A request the daemon has not picked up in this long no longer holds the
// button: an older daemon reports no run, and pressing again is the retry.
const REQUEST_HOLD_MS = 10 * 60 * 1000;

function UpdatesSection({ d, panel }: { d: Device; panel: ReturnType<typeof useDeviceSettingsPanel> }) {
  const { pending, run, setSnippet } = panel;
  const requestUpdate = useInboxStore((s) => s.requestDeviceUpdate);
  // Older daemons report no value; they always update themselves and cannot
  // take the command, so the switch waits for an update.
  const known = d.settings?.auto_update !== undefined;
  // The device's team may force it (Managed devices); the switch then shows the forced value, locked.
  const forced = autoUpdateLock(useDevicePolicy(d));
  const auto = forced ? forced.on : d.settings?.auto_update !== false;
  const blocked = selfUpdateBlocked(d);
  const target = d.update_available ? `v${d.update_available}` : "the latest release";
  const held =
    d.update_state === "installing" ||
    (d.update_state === "requested" && Date.now() - (d.update_requested_at ?? 0) < REQUEST_HOLD_MS);

  return (
    <SettingsSection title="Updates" icon={RefreshCw}>
      <SettingsRow
        label="Update automatically"
        description={
          forced
            ? forced.message
            : !known
            ? "This machine's CLI always updates itself. Update it once with cast update to get this switch."
            : auto
              ? "On. New releases install on their own, and codecast refreshes its hooks and CLAUDE.md sections to match."
              : "Off. A new release installs only when you press Update here or run cast update on the machine. Each change it makes still shows in Harness."
        }
      >
        <Switch
          checked={auto}
          disabled={!!forced || !known || !d.online || pending.has("auto_update")}
          onCheckedChange={(next) =>
            run("auto_update", () => setSnippet({ device_id: d.device_id, snippet: "auto_update", enabled: next }))
          }
          aria-label="Update automatically"
        />
      </SettingsRow>
      {(d.update_available || d.update_required || d.update_state) && (
        <SettingsRow
          label="Update now"
          description={
            blocked
              ? `${blocked}. Update it on the machine.`
              : d.update_state === "installing"
                ? `Installing ${target}.`
                : d.update_state === "failed"
                  ? <span className="text-sol-red">Failed: <code className="font-mono">{d.update_error ?? "no error reported"}</code></span>
                  : d.update_state === "requested"
                    ? d.online ? `Requested ${relativeSeen(d.update_requested_at ?? Date.now())}.` : "Requested. Installs when this machine reconnects."
                    : `Install ${target} and restart the daemon. Running agents keep running.`
          }
        >
          {d.update_state && !blocked && <StatePill tone={d.update_state === "failed" ? "warn" : "info"}>{d.update_state}</StatePill>}
          <Button
            size="sm"
            variant="cyan"
            disabled={!!blocked || held || pending.has("update")}
            onClick={() => run("update", () => requestUpdate(d.device_id))}
          >
            {d.update_state === "failed" ? "Retry" : "Update"}
          </Button>
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

function StatePill({ tone, children }: { tone: "ok" | "warn" | "info" | "muted"; children: React.ReactNode }) {
  const cls =
    tone === "ok"
      ? "bg-sol-green/10 text-sol-green border-sol-green/30"
      : tone === "warn"
        ? "bg-sol-yellow/10 text-sol-yellow border-sol-yellow/30"
        : tone === "info"
          ? "bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30"
          : "bg-sol-bg-alt text-sol-text-muted border-sol-border";
  return <span className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border tabular-nums ${cls}`}>{children}</span>;
}
