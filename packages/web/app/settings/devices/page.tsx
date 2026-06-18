"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { SNIPPET_CATALOG } from "@codecast/shared/contracts";
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

function PlatformGlyph({ d }: { d: Device }) {
  const cls = "w-5 h-5";
  if (d.is_remote)
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h11a3 3 0 000-6 5 5 0 00-9.584-1.5A3.5 3.5 0 003 15z" />
      </svg>
    );
  if (/linux/i.test(d.platform))
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    );
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

/**
 * Per-device agent-feature toggles. Source of truth lives on the device (its
 * ~/.codecast/config.json), heartbeat-reported into `d.settings`. Flipping a
 * switch enqueues a device-targeted command that runs `cast install <slug>` on
 * that machine; the server optimistically mirrors the new value so the toggle
 * moves instantly, and the next heartbeat reconciles to the device's real state.
 *
 * A toggle only "lands" on an online device (the command carries a 5-min TTL),
 * so for an offline device we render the switches read-only.
 */
function DeviceFeatures({ d }: { d: Device }) {
  const setSnippet = useMutation(api.devices.setDeviceSnippet);
  const [pending, setPending] = useState<Set<string>>(new Set());

  // An older CLI predates snippet reporting — nudge to update rather than show
  // a wall of "off" switches that don't reflect reality.
  if (!d.settings) {
    return (
      <div className="mt-3 pt-3 border-t border-sol-border/60 text-[11px] text-gray-500">
        Agent features aren&apos;t reported by this machine yet. Update its CLI
        (<code className="font-mono text-gray-300">cast update</code>) to manage them here.
      </div>
    );
  }

  const snippets = d.settings.snippets ?? {};
  const stableMode = d.settings.stable_mode ?? "off";

  const toggle = async (slug: string, enabled: boolean) => {
    setPending((p) => new Set(p).add(slug));
    try {
      await setSnippet({ device_id: d.device_id, snippet: slug, enabled });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't change that setting");
    } finally {
      setPending((p) => {
        const n = new Set(p);
        n.delete(slug);
        return n;
      });
    }
  };

  const rows: { slug: string; name: string; desc: string; on: boolean; state?: string }[] = [
    ...SNIPPET_CATALOG.map((s) => ({
      slug: s.slug,
      name: s.name,
      desc: s.desc,
      on: snippets[s.slug] === true,
    })),
    {
      slug: "stable",
      name: "Stable context",
      desc: "Inject recent session history into every new conversation",
      on: stableMode !== "off",
      state: stableMode,
    },
  ];

  return (
    <div className="mt-3 pt-3 border-t border-sol-border/60">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-medium uppercase tracking-wider text-sol-text-dim">
          Agent features
        </span>
        {!d.online && (
          <span className="text-[10px] text-gray-500">offline — changes apply when it reconnects</span>
        )}
      </div>
      <div className="rounded-lg border border-sol-border/60 divide-y divide-sol-border/40 overflow-hidden">
        {rows.map((r) => {
          const busy = pending.has(r.slug);
          return (
            <div key={r.slug} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] text-sol-text">{r.name}</span>
                  {r.state && r.state !== "off" && (
                    <span className="px-1 py-px rounded text-[9px] uppercase tracking-wide bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/25">
                      {r.state}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-gray-500 truncate">{r.desc}</div>
              </div>
              <Switch
                checked={r.on}
                disabled={!d.online || busy}
                onCheckedChange={(next) => toggle(r.slug, next)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DeviceRow({ d }: { d: Device }) {
  const accent = d.is_remote ? "text-sol-violet" : /linux/i.test(d.platform) ? "text-sol-orange" : "text-sol-blue";
  return (
    <Card className="p-4">
      <div className="flex items-start gap-4">
        <div className={`mt-0.5 ${accent}`}>
          <PlatformGlyph d={d} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm truncate">{deviceDisplayName(d)}</span>
            <span
              className={`px-1.5 py-0.5 rounded text-[10px] border ${
                d.is_remote
                  ? "bg-sol-violet/10 text-sol-violet border-sol-violet/30"
                  : "bg-gray-500/10 text-gray-400 border-gray-500/25"
              }`}
            >
              {deviceKindLabel(d)}
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-gray-400">
              <DeviceDot online={d.online} />
              {d.online ? "Online" : `Last seen ${relativeSeen(d.last_seen)}`}
            </span>
          </div>
          <div className="mt-1 text-[11px] text-gray-500 font-mono truncate">{d.label}</div>
          <div className="mt-2 flex items-center gap-4 text-[11px] text-gray-500">
            <span>{d.platform}</span>
            <span>
              {d.local_project_roots.length} project root{d.local_project_roots.length === 1 ? "" : "s"}
            </span>
            <span className="font-mono opacity-60">{d.device_id.slice(0, 12)}</span>
          </div>
          {d.local_project_roots.length > 0 && (
            <details className="mt-2 group">
              <summary className="cursor-pointer text-[11px] text-gray-400 hover:text-gray-200 select-none">
                Show checkouts
              </summary>
              <ul className="mt-1 space-y-0.5">
                {d.local_project_roots.slice(0, 30).map((r) => (
                  <li key={r} className="text-[11px] text-gray-400 font-mono truncate">
                    {r}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <DeviceFeatures d={d} />
        </div>
      </div>
    </Card>
  );
}

export default function DevicesSettingsPage() {
  const { devices } = useDevices();
  const sorted = useMemo(
    () =>
      [...devices].sort(
        (a, b) => Number(b.online) - Number(a.online) || Number(a.is_remote) - Number(b.is_remote) || b.last_seen - a.last_seen,
      ),
    [devices],
  );
  const onlineCount = sorted.filter((d) => d.online).length;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Devices</h1>
        <p className="text-sm text-gray-400 mt-1">
          Machines running the codecast daemon. A session runs on exactly one device. New sessions and
          messages from your phone route to your most-recently-active laptop or desktop — the{" "}
          <span className="text-sol-violet">remote Mac</span> only runs a session you explicitly move there.
        </p>
        <p className="text-sm text-gray-400 mt-1">
          Each machine has its own agent features (the snippets <code className="font-mono text-gray-300">cast install</code>{" "}
          writes into its CLAUDE.md), so toggles below are per device.
        </p>
        <p className="text-[11px] text-gray-500 mt-2">
          {onlineCount} of {sorted.length} online
        </p>
      </div>

      {sorted.length === 0 ? (
        <Card className="p-6 text-center text-sm text-gray-400">
          No devices yet. Start the daemon with <code className="font-mono text-gray-300">cast daemon</code> on a machine
          to see it here.
        </Card>
      ) : (
        <div className="space-y-3">
          {sorted.map((d) => (
            <DeviceRow key={d.device_id} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}
