import { describe, expect, test } from 'bun:test';
import { BIOMETRIC_GRACE_MS, shouldLockOnReturn, unlockVerdict } from './biometricLock';

describe('shouldLockOnReturn', () => {
  const t0 = 1_000_000;

  test('a short trip to another app comes back unlocked', () => {
    expect(shouldLockOnReturn({ enabled: true, backgroundedAt: t0, now: t0 + BIOMETRIC_GRACE_MS - 1 })).toBe(false);
  });

  test('a return after the grace period locks', () => {
    expect(shouldLockOnReturn({ enabled: true, backgroundedAt: t0, now: t0 + BIOMETRIC_GRACE_MS })).toBe(true);
    expect(shouldLockOnReturn({ enabled: true, backgroundedAt: t0, now: t0 + 5, graceMs: 5 })).toBe(true);
  });

  test('the setting off, or an app that never left, never locks', () => {
    expect(shouldLockOnReturn({ enabled: false, backgroundedAt: t0, now: t0 + 10 * BIOMETRIC_GRACE_MS })).toBe(false);
    expect(shouldLockOnReturn({ enabled: true, backgroundedAt: null, now: t0 })).toBe(false);
  });
});

describe('unlockVerdict', () => {
  test('a passed check unlocks', () => {
    expect(unlockVerdict({ success: true })).toBe('unlock');
  });

  test('a cancelled or failed check stays locked', () => {
    for (const error of ['user_cancel', 'system_cancel', 'app_cancel', 'authentication_failed', 'lockout', 'timeout', 'unknown']) {
      expect(unlockVerdict({ success: false, error })).toBe('stay');
    }
    expect(unlockVerdict({ success: false })).toBe('stay');
  });

  test('a phone with nothing to check against is let in', () => {
    for (const error of ['not_enrolled', 'not_available', 'passcode_not_set']) {
      expect(unlockVerdict({ success: false, error })).toBe('bypass');
    }
  });
});
