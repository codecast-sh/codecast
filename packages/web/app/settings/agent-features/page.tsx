"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Blocks } from "lucide-react";
import {
  SNIPPET_CATALOG,
  STABLE_MODES,
  type StableMode,
} from "@codecast/shared/contracts";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { Switch } from "../../../components/ui/switch";
import {
  useDevices,
  deviceDisplayName,
  deviceKindLabel,
  relativeSeen,
  DeviceDot,
  type Device,
} from "../../../components/DeviceBadge";

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
    <div className="max-w-2xl mx-auto space-y-5">
      <header className="flex items-start gap-3">
        <div className="mt-0.5 text-sol-cyan">
          <Blocks className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-sol-text">Agent Features</h1>
          <p className="text-sm text-sol-base1 mt-1">
            Capabilities you install into your agents — the same things{" "}
            <code className="font-mono text-sol-text">cast install</code> writes into a machine&apos;s
            CLAUDE.md. Each machine has its own setup, so changes apply to the selected device.
          </p>
        </div>
      </header>

      {sorted.length === 0 ? (
        <Card className="p-6 text-center text-sm text-sol-base1">
          No devices yet. Start the daemon with{" "}
          <code className="font-mono text-sol-text">cast daemon</code> on a machine to manage its
          features here.
        </Card>
      ) : (
        <>
          {sorted.length > 1 && (
            <DevicePicker devices={sorted} selectedId={selected?.device_id ?? null} onSelect={setSelectedId} />
          )}

          {selected && <DeviceHeadline d={selected} single={sorted.length === 1} />}

          {selected && !selected.settings ? (
            <Card className="p-5 text-sm text-sol-base1">
              This machine&apos;s CLI predates feature sync. Update it with{" "}
              <code className="font-mono text-sol-text">cast update</code>, and its installed
              features will show up here.
            </Card>
          ) : (
            selected && (
              <div className="space-y-3">
                <StableCard d={selected} pending={pending} run={run} setSnippet={setSnippet} />
                {SNIPPET_CATALOG.map((s) => (
                  <FeatureCard
                    key={s.slug}
                    slug={s.slug}
                    name={s.name}
                    desc={s.desc}
                    detail={s.detail}
                    writesTo={s.writesTo}
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
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

/** Pills to choose which machine you're configuring. */
function DevicePicker({
  devices,
  selectedId,
  onSelect,
}: {
  devices: Device[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {devices.map((d) => {
        const active = d.device_id === selectedId;
        return (
          <button
            key={d.device_id}
            onClick={() => onSelect(d.device_id)}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              active
                ? "border-sol-cyan bg-sol-cyan/10 text-sol-text"
                : "border-sol-border bg-sol-bg-alt text-sol-base1 hover:border-sol-base1"
            }`}
          >
            <DeviceDot online={d.online} />
            <span className="font-medium">{deviceDisplayName(d)}</span>
            <span className="opacity-60">{deviceKindLabel(d)}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Which device these controls apply to, and whether changes will land now. */
function DeviceHeadline({ d, single }: { d: Device; single: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <div className="inline-flex items-center gap-2 text-sm">
        <DeviceDot online={d.online} />
        <span className="font-medium text-sol-text">{deviceDisplayName(d)}</span>
        {single && <span className="text-xs text-sol-base1">{deviceKindLabel(d)}</span>}
      </div>
      <span className="text-[11px] text-sol-base1">
        {d.online ? "Online — changes apply now" : `Offline — last seen ${relativeSeen(d.last_seen)}`}
      </span>
    </div>
  );
}

/** Stable context — a tri-state (Solo / Team / Off), not a boolean. */
function StableCard({
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
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-sol-text">Stable context</div>
          <div className="text-[13px] text-sol-base1 mt-0.5">
            Inject recent session history into every new conversation, so agents start with
            shared context.
          </div>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2">
        {STABLE_MODES.map((m) => {
          const active = mode === m.value;
          return (
            <button
              key={m.value}
              disabled={disabled || busy}
              onClick={() => apply(m.value, global)}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                active
                  ? "border-sol-cyan bg-sol-cyan/10 text-sol-text"
                  : "border-sol-border bg-sol-bg-alt text-sol-base1 hover:border-sol-base1"
              }`}
            >
              <div className="text-sm font-medium">{m.name}</div>
              <div className="text-[11px] mt-0.5 opacity-70 leading-snug">{m.desc}</div>
            </button>
          );
        })}
      </div>

      <div
        className={`mt-3 flex items-center justify-between rounded-lg border border-sol-border/60 px-3 py-2 transition-opacity ${
          mode === "off" ? "opacity-40" : ""
        }`}
      >
        <div className="text-[13px] text-sol-text">
          All projects
          <span className="text-[11px] text-sol-base1 ml-2">
            {global ? "Sessions from every project" : "Only the current project"}
          </span>
        </div>
        <Switch
          checked={global}
          disabled={disabled || busy || mode === "off"}
          onCheckedChange={(next) => apply(mode === "off" ? "solo" : mode, next)}
        />
      </div>

      {disabled && (
        <p className="mt-2 text-[11px] text-sol-base1">
          This device is offline — changes apply when it reconnects.
        </p>
      )}
    </Card>
  );
}

/** One installable snippet, with the same explanation the terminal wizard shows. */
function FeatureCard({
  slug,
  name,
  desc,
  detail,
  writesTo,
  on,
  disabled,
  busy,
  onToggle,
}: {
  slug: string;
  name: string;
  desc: string;
  detail: string;
  writesTo: string;
  on: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-sol-text">{name}</span>
            <span
              className={`text-[10px] px-1.5 py-px rounded-full border ${
                on
                  ? "bg-sol-green/10 text-sol-green border-sol-green/30"
                  : "bg-sol-bg-alt text-sol-base1 border-sol-border"
              }`}
            >
              {on ? "Installed" : "Off"}
            </span>
          </div>
          <div className="text-[13px] text-sol-base1 mt-0.5">{desc}</div>
        </div>
        <Switch checked={on} disabled={disabled || busy} onCheckedChange={onToggle} />
      </div>

      <p className="text-[13px] text-sol-base1 leading-relaxed mt-2.5">{detail}</p>
      <p className="text-[11px] text-sol-base01 font-mono mt-2">{writesTo}</p>
    </Card>
  );
}
