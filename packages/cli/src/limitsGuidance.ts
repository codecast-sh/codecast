// The "Usage limits" agent snippet turns itself on the moment a machine has
// more than one saved Claude account. That is when it becomes unambiguously
// right: with a second account saved, a limit on the active one is a short
// pause (auto-switch hops, or resume-at-reset continues), so an agent that
// winds down early is wasting the window it still has. Single-account machines
// can still `cast install limits` by hand.
//
// Auto-on happens once, and only from the never-decided state: an explicit
// `limits_enabled: false` (the user turned it off in Settings or with
// --disable) is respected forever. Idempotent and cheap — safe to call from
// every profile-save path and from daemon boot.

import { snippetSection } from "@codecast/shared/contracts";
import { listProfiles } from "./ccAccounts.js";
import { installSectionToTargets, stampSnippet } from "./snippets.js";
import { getLimitsVersion } from "./update.js";

export const LIMITS_AUTO_ENABLE_MIN_PROFILES = 2;

/** Decide from the profile count and the config alone (pure; tested). */
export function shouldAutoEnableLimitsGuidance(
  config: { limits_enabled?: boolean } | null | undefined,
  profileCount: number,
): boolean {
  return (config?.limits_enabled ?? undefined) === undefined && profileCount >= LIMITS_AUTO_ENABLE_MIN_PROFILES;
}

/** Install + flag the snippet when the machine just became multi-account.
 * Mutates `config` and returns whether it changed (caller persists). Never
 * throws — guidance is an enhancement, not a reason to fail a save. */
export function ensureLimitsGuidanceForMultiAccount(config: Record<string, any>): boolean {
  try {
    if (!shouldAutoEnableLimitsGuidance(config, listProfiles().length)) return false;
    const section = snippetSection("limits");
    installSectionToTargets(section.spec, section.body, true);
    config.limits_enabled = true;
    stampSnippet(config, "limits", getLimitsVersion());
    return true;
  } catch {
    return false;
  }
}
