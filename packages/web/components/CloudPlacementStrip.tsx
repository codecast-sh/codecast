"use client";

/**
 * Where a cloud placement stands, above the conversation while the laptop
 * prepares the host and after it fails: which host, why it was chosen, each
 * step with its time, and the preparing child's own log. The record is
 * written by `cast cloud start` (cloud.reportPlacementProgress); this only
 * renders it, so every surface that mounts the error banner mounts this too.
 */

import { useState } from "react";
import { Check, Cloud, Loader2, X } from "lucide-react";
import { CLOUD_PLACEMENT_OCCASIONAL_STEPS, CLOUD_PLACEMENT_STEP_LABEL, CLOUD_PLACEMENT_STEPS, type CloudPlacementProgress, type CloudPlacementStep } from "@codecast/shared/contracts";
import { useInboxStore } from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useHostLoads } from "../hooks/useHostLoads";
import { deviceDisplayName, useDevices } from "./DeviceBadge";
import { formatHostLoad } from "../lib/hostLoad";

function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

type StepState = "done" | "current" | "failed" | "todo";

/** Each step's state and duration, from the record's step timestamps. */
export function placementSteps(p: CloudPlacementProgress, now: number): Array<{ step: CloudPlacementStep; state: StepState; ms?: number }> {
  const reached = new Map<CloudPlacementStep, number>();
  for (const s of p.steps) reached.set(s.step, s.at);
  const current = p.steps.at(-1)?.step;
  const end = p.failed_at ?? now;
  const seen = CLOUD_PLACEMENT_STEPS.filter((s) => reached.has(s));
  return CLOUD_PLACEMENT_STEPS
    // A shared checkout never seeds: a step skipped before the current one is not shown.
    .filter((s) => reached.has(s) || (!CLOUD_PLACEMENT_OCCASIONAL_STEPS.has(s) && CLOUD_PLACEMENT_STEPS.indexOf(s) > CLOUD_PLACEMENT_STEPS.indexOf(current ?? "host")))
    .map((step) => {
      const at = reached.get(step);
      if (at === undefined) return { step, state: "todo" as const };
      const next = seen[seen.indexOf(step) + 1];
      const until = next ? reached.get(next)! : end;
      const state: StepState = step !== current ? "done" : p.failed_at ? "failed" : "current";
      return { step, state, ms: until - at };
    });
}

export function CloudPlacementStrip({ sessionId }: { sessionId?: string }) {
  // Wake only on the fields shown: the row itself churns with every heartbeat.
  useInboxStore((s) => {
    const row = sessionId ? s.sessions[sessionId] : undefined;
    return `${row?.cloud_placement ?? ""}|${row?.cloud_placement_progress?.at ?? ""}|${row?.cloud_placement_progress?.failed_at ?? ""}`;
  });
  const row = sessionId ? useInboxStore.getState().sessions[sessionId] : undefined;
  const p = row?.cloud_placement_progress ?? null;
  const pending = row?.cloud_placement === "pending";
  const live = pending && !p?.failed_at;
  const now = useCoarseNow(live ? 1_000 : 60_000);
  const { byId } = useDevices();
  const loads = useHostLoads();
  const [open, setOpen] = useState(false);
  if (!p || (!pending && !p.failed_at)) return null;

  const hostName = (deviceId?: string, hostId?: string) => {
    const d = deviceId ? byId.get(deviceId) : undefined;
    return d ? deviceDisplayName(d) : hostId ?? "cloud host";
  };
  const load = p.host_device_id ? loads.get(p.host_device_id) : undefined;
  const steps = placementSteps(p, now);
  const total = (p.failed_at ?? now) - p.started_at;

  return (
    <div className={`shrink-0 border-b px-4 py-2 text-xs ${p.failed_at ? "border-sol-red/30 bg-sol-red/[0.06]" : "border-sol-violet/25 bg-sol-violet/[0.05]"}`} data-testid="cloud-placement-strip" data-placement={p.failed_at ? "failed" : "live"}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Cloud className="h-3.5 w-3.5 shrink-0 text-sol-violet" aria-hidden />
        <span className="font-medium text-sol-text">{hostName(p.host_device_id, p.host_id)}</span>
        {load && <span className={`font-mono text-[11px] ${load.tight ? "text-sol-yellow" : "text-sol-text-dim"}`}>{formatHostLoad(load)}</span>}
        {p.moved_from && (
          <span className="text-[11px] text-sol-text-muted" title={p.moved_from.host_id}>
            instead of {hostName(p.moved_from.host_device_id, p.moved_from.host_id)} · <span className="text-sol-yellow">{p.moved_from.why}</span>
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-sol-text-dim">{span(total)}</span>
      </div>
      <ol className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        {steps.map(({ step, state, ms }) => (
          <li key={step} className={`inline-flex items-center gap-1 ${state === "todo" ? "text-sol-text-dim opacity-60" : state === "failed" ? "text-sol-red" : state === "current" ? "text-sol-text" : "text-sol-text-muted"}`} data-step={step} data-state={state}>
            {state === "done" ? <Check className="h-3 w-3 text-sol-green" aria-hidden />
              : state === "current" ? <Loader2 className="h-3 w-3 animate-spin text-sol-violet" aria-hidden />
              : state === "failed" ? <X className="h-3 w-3" aria-hidden />
              : <span className="mx-[3px] h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
            <span>{CLOUD_PLACEMENT_STEP_LABEL[step]}</span>
            {ms !== undefined && <span className="font-mono text-[10px] opacity-70">{span(ms)}</span>}
          </li>
        ))}
        {p.lines.length > 0 && (
          <li className="ml-auto">
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-[11px] text-sol-text-muted underline decoration-dotted underline-offset-2 hover:text-sol-text">
              {open ? "Hide log" : `Log · ${p.lines.length}`}
            </button>
          </li>
        )}
      </ol>
      {open && (
        <pre className="mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-sol-bg-alt px-2 py-1.5 font-mono text-[10.5px] leading-relaxed text-sol-text-secondary">
          {p.lines.join("\n")}
        </pre>
      )}
    </div>
  );
}
