import { useCallback, useMemo } from "react";
import { signInExpired, type CloudAgentProviderId, type CloudAgentProviderSpec, type CloudAgentSetupBlock } from "@codecast/shared/contracts";
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

const NEVER: ConnectedCheck = () => false;

/**
 * Whether a machine's block is about its connection to the provider: not a
 * lane the provider changed (codecast paused it) or holds to a limit, which
 * no sign-in or key fixes and which the machine says on its own.
 */
function blocksConnection(block: CloudAgentSetupBlock | undefined): boolean {
  return !!block && block.kind !== "changed" && block.kind !== "limit";
}

/** What the machine's daemon last found keeps it from reading the provider (turned off for the account, refused), if anything. */
export function cloudAgentBlockOf(spec: CloudAgentProviderSpec | undefined, device: Device): CloudAgentSetupBlock | undefined {
  return spec ? device.cloud_agent_blocks?.find((b) => b.provider === spec.id) : undefined;
}

/**
 * The provider's sign-in check, when its credential is a sign-in on the
 * machine (a CLI's own login) rather than a Provider Keys entry. Each
 * provider's check is called here on every render, so the hook rules hold.
 */
function useSignInCheck(spec: CloudAgentProviderSpec | undefined): SignInCheck | undefined {
  const checks: Partial<Record<string, SignInCheck>> = { codex: useCodexSignIn() } satisfies Partial<Record<CloudAgentProviderId, SignInCheck>>;
  return spec ? checks[spec.id] : undefined;
}

/**
 * Whether a machine can drive a provider's agents (never, without a
 * provider): it holds the credential, and its daemon found nothing in the
 * provider's way (blocksConnection). Stable while what it reads holds still.
 */
export function useCloudAgentConnected(spec: CloudAgentProviderSpec | undefined): ConnectedCheck {
  const signIn = useSignInCheck(spec);
  return useMemo<ConnectedCheck>(() => {
    if (!spec) return NEVER;
    const holds: ConnectedCheck = signIn ? (device) => signIn(device).connected : spec.keyProvider ? hasCloudAgentKey(spec.keyProvider) : NEVER;
    return (device) => holds(device) && !blocksConnection(cloudAgentBlockOf(spec, device));
  }, [spec, signIn]);
}

/** When a machine's sign-in to the provider ran out, if it did (a key never runs out here). */
export function useCloudAgentExpiry(spec: CloudAgentProviderSpec | undefined): (device: Device) => number | undefined {
  const signIn = useSignInCheck(spec);
  return useCallback((device) => signIn?.(device).expiredAt, [signIn]);
}
