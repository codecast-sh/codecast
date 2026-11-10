// The decisions behind Biometric Unlock (Settings > Security), with no React
// Native in them. components/BiometricGate.tsx is the half that draws the lock
// and asks the system for the check.

/** How long the app may sit in the background and come back unlocked. */
export const BIOMETRIC_GRACE_MS = 60_000;

/** Does a return to the foreground need a fresh check? */
export function shouldLockOnReturn(opts: {
  enabled: boolean;
  backgroundedAt: number | null;
  now: number;
  graceMs?: number;
}): boolean {
  if (!opts.enabled || opts.backgroundedAt === null) return false;
  return opts.now - opts.backgroundedAt >= (opts.graceMs ?? BIOMETRIC_GRACE_MS);
}

/** What the system's answer means for the lock. The check falls back to the
 *  device passcode by itself; "bypass" is the phone that has nothing left to
 *  check against (biometrics and passcode both removed since the setting was
 *  turned on), which must open rather than lock its owner out. */
export type UnlockVerdict = 'unlock' | 'bypass' | 'stay';

const NOTHING_TO_CHECK = new Set(['not_enrolled', 'not_available', 'passcode_not_set']);

export function unlockVerdict(result: { success: boolean; error?: string }): UnlockVerdict {
  if (result.success) return 'unlock';
  return result.error && NOTHING_TO_CHECK.has(result.error) ? 'bypass' : 'stay';
}
