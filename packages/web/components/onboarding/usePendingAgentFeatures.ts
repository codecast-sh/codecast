"use client";
// The agent features chosen in the setup flow outlive the flow. A person who
// leaves the Agents step before their machine connects (they paste the install
// command and move on) still gets every feature they chose: the choice is kept
// in clientState.ui.agent_features_pending, and the first machine that comes
// online and reports its setup receives the ones it lacks. Mounted with the
// global feeders (sync host only), so one window sends them.
import { snippetBySlug, type SnippetDescriptor } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { useDevices } from "../DeviceBadge";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { applyAgentFeatures } from "./agentFeatures";

/** A choice nobody's machine picked up in a week has gone stale. */
const PENDING_FOR_MS = 7 * 24 * 60 * 60 * 1000;

export function usePendingAgentFeatures() {
  const pending = useInboxStore((s) => s.clientState.ui?.agent_features_pending);
  const { devices } = useDevices();
  const ready = devices.filter((d) => !d.is_remote && d.online && d.settings);
  const readyKey = ready.map((d) => d.device_id).join(" ");

  useWatchEffect(() => {
    if (!pending) return;
    const clear = () => useInboxStore.getState().updateClientUI({ agent_features_pending: null });
    if (Date.now() - pending.at > PENDING_FOR_MS) return clear();
    if (ready.length === 0) return;
    const features = pending.slugs.map((s) => snippetBySlug(s)).filter((s): s is SnippetDescriptor => !!s);
    applyAgentFeatures(ready, features);
    clear();
  }, [pending?.at, readyKey]);
}

/** A leaf, so a machine's heartbeat re-renders only this. */
export function PendingAgentFeatures() {
  usePendingAgentFeatures();
  return null;
}
