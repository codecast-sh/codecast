import { useCallback, useMemo } from "react";
import { signInExpired, type CloudAgentProviderId, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import type { Device } from "../DeviceBadge";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { deviceManagedKeys } from "../../lib/useProviderKeyCommand";

type ConnectedCheck = (device: Device) => boolean;
/** Where a machine's sign-in stands: connected, or when the sign-in it had ran out. */
type SignInCheck = (device: Device) => { connected: boolean; expiredAt?: number };

/** A machine is connected to a key-based provider when it manages that provider's key. */
function hasCloudAgentKey(keyProvider: string): ConnectedCheck {
  return (device) => deviceManagedKeys(device).managedIds.includes(keyProvider);
}

/**
 * A machine is signed in to Codex when its daemon reports the Codex login's
 * account (the accounts feed) and that login has not run out: codecast never
 * refreshes it, so past its expiry the daemon stops reading Codex Cloud.
 */
function useCodexSignIn(): SignInCheck {
  const devices = useSettingsData("accountProfiles").data?.devices;
  const now = useCoarseNow(60_000);
  return useCallback((device) => {
    const login = devices?.find((d) => d.device_id === device.device_id)?.codex_accounts;
    if (!login?.active_email) return { connected: false };
    return signInExpired(login.active_expires_at, now) ? { connected: false, expiredAt: login.active_expires_at } : { connected: true };
  }, [devices, now]);
}

/**
 * Providers whose credential is a sign-in on the machine (a CLI's own login),
 * not a Provider Keys entry, name the hook that checks it here. Every one runs
 * on every render, in this order, so the hook rules hold.
 */
const SIGN_IN_CHECKS: ReadonlyArray<readonly [CloudAgentProviderId, () => SignInCheck]> = [["codex", useCodexSignIn]];

const NEVER: ConnectedCheck = () => false;
const keyChecks = new Map<string, ConnectedCheck>();

/** The provider's sign-in check, when its credential is a sign-in. */
function useSignInCheck(spec: CloudAgentProviderSpec | undefined): SignInCheck | undefined {
  const checks = SIGN_IN_CHECKS.map(([id, useCheck]) => [id, useCheck()] as const);
  return spec ? checks.find(([id]) => id === spec.id)?.[1] : undefined;
}

/** Whether a machine can drive a provider's agents (never, without a provider). Stable while what it reads holds still. */
export function useCloudAgentConnected(spec: CloudAgentProviderSpec | undefined): ConnectedCheck {
  const signIn = useSignInCheck(spec);
  const fromSignIn = useMemo<ConnectedCheck | undefined>(() => signIn && ((device) => signIn(device).connected), [signIn]);
  if (!spec) return NEVER;
  if (fromSignIn) return fromSignIn;
  if (!spec.keyProvider) return NEVER;
  let check = keyChecks.get(spec.keyProvider);
  if (!check) keyChecks.set(spec.keyProvider, (check = hasCloudAgentKey(spec.keyProvider)));
  return check;
}

/** When a machine's sign-in to the provider ran out, if it did (a key never runs out here). */
export function useCloudAgentExpiry(spec: CloudAgentProviderSpec | undefined): (device: Device) => number | undefined {
  const signIn = useSignInCheck(spec);
  return useCallback((device) => signIn?.(device).expiredAt, [signIn]);
}
