"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Blocks, Layers } from "lucide-react";
import {
  SNIPPET_CATALOG,
  STABLE_MODES,
  snippetAvailableForTeams,
  type StableMode,
} from "@codecast/shared/contracts";
import { useInboxStore } from "../../../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { Switch } from "../../../components/ui/switch";
import { SettingsOptionGroup, SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";
import { DevicePanelHeader } from "../../../components/settings/DevicePanelHeader";
import { useDevices, type Device } from "../../../components/DeviceBadge";
import { isRecentlyShipped } from "../../../lib/newSnippets";

/**
 * "Agent Features" — the web twin of `cast install`. Each machine keeps its own
 * config (its ~/.codecast/config.json), heartbeat-reported into `device.settings`,
 * so this page is scoped to ONE device at a time. Flipping a control enqueues a
 * device-targeted command that runs the same CLI command a human would; the
 * server optimistically mirrors the change so it moves instantly, and the next
 * heartbeat reconciles to the device's real state. Offline devices are read-only
 * (the command would expire before the daemon could run it).
 */
export default function AgentFeaturesPage() {
  const { devices, mostRecentOnlineLocal } = useDevices();
  // Team-gated snippets (chat, calls) only appear while some team has the
  // feature on; the daemon keeps a device's copy in step with the flag.
  const teams = useInboxStore((s) => s.teams);
  const setSnippet = useMutation(api.devices.setDeviceSnippet);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const sorted = useMemo(
    () =>
      [...devices].sort(
        (a, b) =>
          Number(b.online) - Number(a.online) ||
          Number(a.is_remote) - Number(b.is_remote) ||
          b.last_seen - a.last_seen,
      ),
    [devices],
  );

  const selected =
    sorted.find((d) => d.device_id === selectedId) ??
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

  return (
    <SettingsPanel>
      {sorted.length === 0 ? (
        <SettingsSection title="Agent features" icon={Blocks} padded>
          <p className="text-center text-sm text-sol-text-muted">
            No devices yet. Start the daemon with{" "}
            <code className="font-mono text-sol-text">cast daemon</code> on a machine to manage its
            features here.
          </p>
        </SettingsSection>
      ) : (
        <>
          {selected && (
            <DevicePanelHeader devices={sorted} selected={selected} onSelect={setSelectedId} />
          )}

          {selected && !selected.settings ? (
            <SettingsSection title="Agent features" icon={Blocks} padded>
              <p className="text-sm text-sol-text-muted">
                This machine&apos;s CLI predates feature sync. Update it with{" "}
                <code className="font-mono text-sol-text">cast update</code>, and its installed
                features will show up here.
              </p>
            </SettingsSection>
          ) : (
            selected && (
              <>
                <StableSection d={selected} pending={pending} run={run} setSnippet={setSnippet} />
                <SettingsSection
                  title="Features"
                  icon={Blocks}
                  description={
                    <>
                      Capabilities you install into your agents — the same things{" "}
                      <code className="font-mono text-sol-text-muted">cast install</code> writes into a
                      machine&apos;s CLAUDE.md. Each machine has its own setup, so changes apply to the
                      selected device.
                    </>
                  }
                >
                  {SNIPPET_CATALOG.filter((s) => snippetAvailableForTeams(s.slug, teams)).map((s) => (
                    <FeatureRow
                      key={s.slug}
                      name={s.name}
                      desc={s.desc}
                      detail={s.detail}
                      writesTo={s.writesTo}
                      isNew={isRecentlyShipped(s)}
                      on={(selected.settings?.snippets?.[s.slug] ?? (s.wireSlug ? selected.settings?.snippets?.[s.wireSlug] : undefined)) === true}
                      disabled={!selected.online}
                      busy={pending.has(s.slug)}
                      onToggle={(next) =>
                        run(s.slug, () =>
                          // Send the pre-rename slug when one exists: old daemons only
                          // match their exact slug, new daemons resolve it as an alias.
                          setSnippet({ device_id: selected.device_id, snippet: s.wireSlug ?? s.slug, enabled: next }),
                        )
                      }
                    />
                  ))}
                </SettingsSection>
              </>
            )
          )}
        </>
      )}
    </SettingsPanel>
  );
}

/** Stable context — a tri-state (Solo / Team / Off), not a boolean. */
function StableSection({
  d,
  pending,
  run,
  setSnippet,
}: {
  d: Device;
  pending: Set<string>;
  run: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  setSnippet: (args: {
    device_id: string;
    snippet: string;
    enabled: boolean;
    mode?: StableMode;
    global?: boolean;
  }) => Promise<unknown>;
}) {
  const mode: StableMode = d.settings?.stable_mode ?? "off";
  const global = d.settings?.stable_global === true;
  const disabled = !d.online;
  const busy = pending.has("stable");

  const apply = (nextMode: StableMode, nextGlobal: boolean) =>
    run("stable", () =>
      setSnippet({
        device_id: d.device_id,
        snippet: "stable",
        enabled: nextMode !== "off",
        mode: nextMode,
        global: nextGlobal,
      }),
    );

  return (
    <SettingsSection
      title="Stable context"
      icon={Layers}
      description="Inject recent session history into every new conversation, so agents start with shared context."
    >
      <div className="px-4 py-3.5 sm:px-5">
        <SettingsOptionGroup
          label="Stable context mode"
          value={mode}
          onChange={(v) => apply(v as StableMode, global)}
          disabled={disabled || busy}
          options={STABLE_MODES.map((m) => ({ value: m.value, label: m.name, description: m.desc }))}
        />
        {disabled && (
          <p className="mt-2 text-[11px] text-sol-text-muted">
            This device is offline — changes apply when it reconnects.
          </p>
        )}
      </div>
      <SettingsRow
        label="All projects"
        description={global ? "Sessions from every project" : "Only the current project"}
        disabled={mode === "off"}
      >
        <Switch
          checked={global}
          disabled={disabled || busy || mode === "off"}
          onCheckedChange={(next) => apply(mode === "off" ? "solo" : mode, next)}
          aria-label="Stable context across all projects"
        />
      </SettingsRow>
    </SettingsSection>
  );
}

/** One installable snippet, with the same explanation the terminal wizard shows. */
function FeatureRow({
  name,
  desc,
  detail,
  writesTo,
  isNew,
  on,
  disabled,
  busy,
  onToggle,
}: {
  name: string;
  desc: string;
  detail: string;
  writesTo: string;
  isNew: boolean;
  on: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <SettingsRow
      alignTop
      label={
        <span className="flex flex-wrap items-center gap-2">
          {name}
          {isNew && (
            <span className="text-[10px] px-1.5 py-px rounded-full border bg-sol-cyan/10 text-sol-cyan border-sol-cyan/30">
              New
            </span>
          )}
          <span
            className={`text-[10px] px-1.5 py-px rounded-full border ${
              on
                ? "bg-sol-green/10 text-sol-green border-sol-green/30"
                : "bg-sol-bg-alt text-sol-text-muted border-sol-border"
            }`}
          >
            {on ? "Installed" : "Off"}
          </span>
        </span>
      }
      description={
        <>
          {desc}
          <span className="mt-1.5 block leading-relaxed">{detail}</span>
          <span className="mt-1.5 block font-mono text-[11px] text-sol-text-dim">{writesTo}</span>
        </>
      }
    >
      <Switch checked={on} disabled={disabled || busy} onCheckedChange={onToggle} aria-label={name} />
    </SettingsRow>
  );
}
