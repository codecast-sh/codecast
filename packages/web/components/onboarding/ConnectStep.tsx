"use client";
// The setup flow's machine step: connect the computer the agents run on, and
// turn every agent feature on there. The features are what teach an agent to
// use codecast (search past sessions, file tasks, post in chat, publish a
// page), so a machine connected without them syncs sessions and little else.
//
// All of them start checked. Each machine that is online and has reported its
// setup gets the checked ones it lacks, through the same store action the
// Agent features page uses: on Continue, and the moment a machine connects
// while this step is open.
import { useRef, useState } from "react";
import { Check, Laptop } from "lucide-react";
import { SNIPPET_CATEGORIES, type SnippetDescriptor } from "@codecast/shared/contracts";
import { useDevices, type Device } from "../DeviceBadge";
import { SetupThisMachine } from "../EmptyState";
import { snippetEnabledOn } from "../../lib/newSnippets";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { cn } from "../../lib/utils";
import { BrowserPermissions } from "./BrowserPermissions";
import { applyAgentFeatures } from "./agentFeatures";
import { useAvailableAgentFeatures, type AgentFeatureChoice } from "../../hooks/useAgentFeatureChoice";

export function ConnectStep({ choice: { chosen, onToggle, onToggleAll } }: { choice: AgentFeatureChoice }) {
  const features = useAvailableAgentFeatures();
  const { devices } = useDevices();
  const mine = devices.filter((d) => !d.is_remote);
  const online = mine.filter((d) => d.online);
  const picked = features.filter((f) => chosen.has(f.slug));
  // A machine re-linked keeps its old rows, so one computer can list twice.
  const offlineNames = [...new Set(mine.filter((d) => !d.online).map((d) => d.label))];

  // A machine that comes online (or first reports its setup) while the step is
  // open gets the chosen features at once, so Continue never waits on it.
  const applied = useRef(new Set<string>());
  useWatchEffect(() => {
    const fresh = online.filter((d) => d.settings && !applied.current.has(d.device_id));
    if (fresh.length === 0) return;
    for (const d of fresh) applied.current.add(d.device_id);
    applyAgentFeatures(fresh, picked);
  }, [online.map((d) => `${d.device_id}:${d.settings ? 1 : 0}`).join(" ")]);

  const allOn = picked.length === features.length;
  // Set once the desktop app finished its setup: the machine's first
  // heartbeat is seconds away, and the card says it is on its way.
  const [linking, setLinking] = useState(false);

  return (
    <div className="space-y-6">
      <section aria-label="Machines" className="space-y-2">
        {online.length > 0 && (
          <ul className="space-y-2">
            {online.map((d) => (
              <MachineRow key={d.device_id} device={d} features={features} />
            ))}
          </ul>
        )}
        {online.length === 0 && (
          <div className="rounded-xl border border-sol-border bg-sol-bg-alt/40 p-4">
            <div className="mb-3 flex items-center gap-2 text-sm font-medium text-sol-text">
              <Laptop className="h-4 w-4 text-sol-text-muted" />
              {linking ? "Waiting for this computer" : "Connect this computer"}
            </div>
            <SetupThisMachine onConnected={() => setLinking(true)} accent auto />
            <p className="mt-2 text-xs text-sol-text-dim">Claude Code, Codex, Cursor and Gemini</p>
          </div>
        )}
        {offlineNames.length > 0 && (
          <p className="px-1 text-xs text-sol-text-dim">Offline: {offlineNames.join(", ")}</p>
        )}
        <BrowserPermissions />
      </section>

      <section aria-label="Agent features" className="space-y-3">
        <div className="flex items-center gap-3">
          <span className="flex-1 text-[15px] font-semibold text-sol-text">What your agents learn</span>
          <span className="text-sm tabular-nums text-sol-text" data-agent-features-on={picked.length}>
            {picked.length} of {features.length} on
          </span>
          <button type="button" onClick={() => onToggleAll(!allOn)} className={cn("h-7 rounded-md px-2.5 text-xs font-medium", allOn ? "text-sol-text-dim hover:text-sol-text" : "ob-all-on")}>
            {allOn ? "Clear all" : "Turn all on"}
          </button>
        </div>
        <ul className="grid gap-3 sm:grid-cols-2">
          {SNIPPET_CATEGORIES.map((cat) => {
            const inCat = features.filter((f) => f.category === cat.id);
            if (inCat.length === 0) return null;
            return (
              <li key={cat.id} className="rounded-xl border border-sol-border/70 p-4" data-agent-category={cat.id}>
                <div className="text-sm font-semibold text-sol-text">{cat.name}</div>
                <p className="mt-1 text-[13px] leading-relaxed text-sol-text-muted">{cat.blurb}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {inCat.map((f) => {
                    const on = chosen.has(f.slug);
                    return (
                      <button
                        key={f.slug}
                        type="button"
                        role="switch"
                        aria-checked={on}
                        onClick={() => onToggle(f.slug)}
                        title={f.desc}
                        data-agent-feature={f.slug}
                        className={cn(
                          "ob-chip tf-ghost inline-flex h-7 items-center gap-1 rounded-md border px-2 text-xs",
                          on ? "ob-chip-on" : "border-sol-border/60 text-sol-text-dim hover:text-sol-text-muted",
                        )}
                      >
                        {on && <Check className="h-3 w-3" />}
                        {f.name}
                      </button>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function MachineRow({ device, features }: { device: Device; features: SnippetDescriptor[] }) {
  const on = features.filter((f) => snippetEnabledOn(device.settings, f)).length;
  return (
    <li className="flex items-center gap-3 rounded-xl border border-sol-green/40 bg-sol-green/5 px-4 py-3" data-machine={device.device_id}>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sol-green/15 text-sol-green">
        <Check className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-sol-text">{device.label}</span>
      <span className="shrink-0 text-xs text-sol-text-dim">
        {device.settings ? <><span className="tabular-nums text-sol-text">{on}/{features.length}</span> agent features</> : "Reading its setup…"}
      </span>
    </li>
  );
}
