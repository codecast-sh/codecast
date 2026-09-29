"use client";

// pl-207 (Phase 3): the single place the web seals a provider API key and enqueues
// the device command that sets or removes it. Both surfaces — the Settings
// "Provider keys" section and the inline auth-card key entry — go through this hook,
// so the encrypt + mutation logic (and the codegen casts) live exactly once. The key
// only ever leaves the browser as ciphertext, via encryptProviderKey.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { captureException } from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { getProviderKeySpec } from "@codecast/shared/contracts";
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
      /** Seal `apiKey` to the device's public key and enqueue a "set" command.
       *  Resolves to the command's id, so a caller can watch the daemon's verdict
       *  (devices.providerKeyCommandOutcome). */
      async setKey(deviceId: string, pubkey: string, provider: string, apiKey: string): Promise<string | undefined> {
        const payload = await encryptProviderKey(pubkey, provider, apiKey);
        const res = await enqueue({ device_id: deviceId, op: "set", provider, payload });
        return (res as { command_id?: string } | undefined)?.command_id;
      },
      /** Remove a managed key — no encryption, just the provider id. */
      async removeKey(deviceId: string, provider: string) {
        await enqueue({ device_id: deviceId, op: "remove", provider });
      },
    }),
    [enqueue],
  );
}

/**
 * A key typed into a guided setup, sent to one machine, and that machine's
 * verdict on it: it checks the key with the provider before storing it, so a
 * refused key is never kept. `looksRight` gates the submit on the provider's
 * key prefix; `sent` is true once a key went out (the field then clears).
 */
export function useVerifiedKeySubmit(keyProvider: string, device: Device | null, pubkey: string | undefined) {
  const { setKey } = useProviderKeyCommand();
  const [key, setKeyText] = useState("");
  const [commandId, setCommandId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const outcome = useQuery(api.devices.providerKeyCommandOutcome, commandId ? { command_id: commandId as Id<"daemon_commands"> } : "skip");

  const trimmed = key.trim();
  const looksRight = trimmed.startsWith(getProviderKeySpec(keyProvider)?.keyPrefix ?? "") && trimmed.length > 20;

  const submit = async () => {
    if (!device || !pubkey || !looksRight) return;
    setSending(true);
    setSendError(null);
    setCommandId(null);
    try {
      const id = await setKey(device.device_id, pubkey, keyProvider, trimmed);
      setCommandId(id ?? null);
      setKeyText("");
    } catch (err) {
      captureException(err);
      setSendError(err instanceof Error ? err.message : "Couldn't send the key");
    } finally {
      setSending(false);
    }
  };

  return {
    key,
    setKey: setKeyText,
    looksRight,
    submit,
    sent: !!commandId,
    checking: sending || (!!commandId && (outcome === undefined || outcome?.state === "pending")),
    done: outcome?.state === "done",
    account: outcome?.state === "done" ? outcome.account : undefined,
    failed: outcome?.state === "failed" ? outcome.error : sendError,
  };
}
