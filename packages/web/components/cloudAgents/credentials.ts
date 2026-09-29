import { useCallback } from "react";
import type { CloudAgentProviderId, CloudAgentProviderSpec } from "@codecast/shared/contracts";
import type { Device } from "../DeviceBadge";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { deviceManagedKeys } from "../../lib/useProviderKeyCommand";

type ConnectedCheck = (device: Device) => boolean;

/** A machine is connected to a key-based provider when it manages that provider's key. */
function hasCloudAgentKey(keyProvider: string): ConnectedCheck {
  return (device) => deviceManagedKeys(device).managedIds.includes(keyProvider);
}

/** A machine is signed in to Codex when its daemon reports the Codex login's account (the accounts feed). */
function useCodexSignedIn(): ConnectedCheck {
  const devices = useSettingsData("accountProfiles").data?.devices;
  return useCallback((device) => !!devices?.find((d) => d.device_id === device.device_id)?.codex_accounts?.active_email, [devices]);
}

/**
 * Providers whose credential is a sign-in on the machine (a CLI's own login),
 * not a Provider Keys entry, name the hook that checks it here. Every one runs
 * on every render, in this order, so the hook rules hold.
 */
const LOGIN_CHECKS: ReadonlyArray<readonly [CloudAgentProviderId, () => ConnectedCheck]> = [["codex", useCodexSignedIn]];

const NEVER: ConnectedCheck = () => false;
const keyChecks = new Map<string, ConnectedCheck>();

/** Whether a machine can drive a provider's agents (never, without a provider). Stable while what it reads holds still. */
export function useCloudAgentConnected(spec: CloudAgentProviderSpec | undefined): ConnectedCheck {
  const logins = LOGIN_CHECKS.map(([id, useCheck]) => [id, useCheck()] as const);
  if (!spec) return NEVER;
  const login = logins.find(([id]) => id === spec.id)?.[1];
  if (login) return login;
  if (!spec.keyProvider) return NEVER;
  let check = keyChecks.get(spec.keyProvider);
  if (!check) keyChecks.set(spec.keyProvider, (check = hasCloudAgentKey(spec.keyProvider)));
  return check;
}
