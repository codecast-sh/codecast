// Proven room on one model's week: the pure reading behind model-room pins
// (lib/modelLimitPins.ts) and the resume rule that keeps them
// (ccAccountsShared.resumePinFor). A leaf: shared contracts only.

import { isUsageExhausted, isWindowRolled, livePercent, type CcUsage } from "@codecast/shared/contracts";

/** What a model-room pin records on the conversation (`cc_account_model_pin`). */
export type ModelPin = { family: string; profile: string; at: number; tried?: Array<{ profile: string; at: number }> };

/** The worst live percent across an account's session, all-model week and
 *  `family`'s own week, or null when that is not proven: no meter for the
 *  family at all (most accounts never report a Fable week), or a window that
 *  rolled after the snapshot was taken (unmeasured, maybe already spent). */
export function modelRoomPercent(usage: CcUsage | undefined | null, family: string, now: number): number | null {
  if (!usage) return null;
  const scoped = [usage.weekly_scoped, ...(usage.scoped ?? [])].filter(
    (w): w is NonNullable<typeof w> => !!w?.label && w.label.toLowerCase().includes(family),
  );
  if (scoped.length === 0) return null;
  const windows = [usage.session, usage.weekly, ...scoped].filter((w): w is NonNullable<typeof w> => !!w);
  if (windows.some((w) => isWindowRolled(w, now) && usage.fetched_at <= (w.resets_at ?? 0))) return null;
  return Math.max(...windows.map((w) => livePercent(w, now)));
}

/** Proven room for a session on `family`: every window it runs under is
 *  measured and below its cap, and nothing else blocks the account. */
export function hasModelRoom(usage: CcUsage | undefined | null, family: string, now: number): boolean {
  const percent = modelRoomPercent(usage, family, now);
  return percent !== null && percent < 100 && !isUsageExhausted(usage, now, [family]);
}

