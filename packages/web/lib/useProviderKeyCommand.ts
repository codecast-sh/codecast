"use client";

// pl-207 (Phase 3): the single place the web seals a provider API key and enqueues
// the device command that sets or removes it. Both surfaces — the Settings
// "Provider keys" section and the inline auth-card key entry — go through this hook,
// so the encrypt + mutation logic (and the codegen casts) live exactly once. The key
// only ever leaves the browser as ciphertext, via encryptProviderKey.

import { useMemo } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { encryptProviderKey } from "./providerKeyCrypto";
import type { Device } from "../components/DeviceBadge";

// The two managed-key fields listDevices now returns per device. They aren't in the
// committed convex codegen yet (regenerating requires a prod push), so we read them
// through this localized cast — the one device-side boundary.
// pl-207: resolves on next convex codegen.
type ManagedKeyDevice = Device & {
  provider_key_pubkey?: string;
  managed_provider_ids?: string[];
};

/**
 * The device's ECDH public key (what a key is encrypted to) and the provider ids it
 * already manages a key for. Ids only — the keys themselves never leave the device.
 * A device whose daemon predates provider keys has no `pubkey`; callers gate on that.
 */
export function deviceManagedKeys(device: Device): { pubkey?: string; managedIds: string[] } {
  const d = device as ManagedKeyDevice; // pl-207: resolves on next convex codegen
  return { pubkey: d.provider_key_pubkey, managedIds: d.managed_provider_ids ?? [] };
}

/** Encrypt-and-enqueue actions for a device, shared by both key-entry surfaces. */
export function useProviderKeyCommand() {
  // pl-207: resolves on next convex codegen
  const enqueue = useMutation((api.devices as any).enqueueProviderKeyCommand);

  return useMemo(
    () => ({
      /** Seal `apiKey` to the device's public key and enqueue a "set" command. */
      async setKey(deviceId: string, pubkey: string, provider: string, apiKey: string) {
        const payload = await encryptProviderKey(pubkey, provider, apiKey);
        await enqueue({ device_id: deviceId, op: "set", provider, payload });
      },
      /** Remove a managed key — no encryption, just the provider id. */
      async removeKey(deviceId: string, provider: string) {
        await enqueue({ device_id: deviceId, op: "remove", provider });
      },
    }),
    [enqueue],
  );
}
