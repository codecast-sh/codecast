// The web's side of HARNESS_HOOKS: is a hook installed on a device, and which
// Agent Features entry owns it. Reads the heartbeat-reported device settings
// through the same rule the CLI installer applies (harnessHookWanted), so the
// Harness page and Agent Features say what the machine actually has.
import { HARNESS_HOOKS, harnessHookWanted, snippetBySlug, type HarnessHook } from "@codecast/shared/contracts";
import type { Device } from "../components/DeviceBadge";

export function deviceFeatureOn(d: Device, feature: string): boolean {
  if (feature === "stable") return (d.settings?.stable_mode ?? "off") !== "off";
  const desc = snippetBySlug(feature);
  const snippets = d.settings?.snippets ?? {};
  return snippets[feature] === true || (!!desc?.wireSlug && snippets[desc.wireSlug] === true);
}

export function deviceHookInstalled(d: Device, hook: HarnessHook): boolean {
  return harnessHookWanted(hook, d.settings?.hooks_enabled !== false, (f) => deviceFeatureOn(d, f));
}

/** The Agent Features entry that owns a hook, by the name that page shows. */
export function hookFeatureName(hook: HarnessHook): string | null {
  if (!hook.feature) return null;
  if (hook.feature === "stable") return "Stable context";
  return snippetBySlug(hook.feature)?.name ?? hook.feature;
}

/** The hooks that belong to one Agent Features entry. */
export function hooksOfFeature(feature: string): HarnessHook[] {
  return HARNESS_HOOKS.filter((h) => h.feature === feature);
}

export const FUNCTIONAL_HOOKS = HARNESS_HOOKS.filter((h) => !h.feature);
export const AGENT_HOOKS = HARNESS_HOOKS.filter((h) => h.feature);
