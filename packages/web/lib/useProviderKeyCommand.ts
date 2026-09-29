"use client";

// pl-207 (Phase 3): the single place the web seals a provider API key and enqueues
// the device command that sets or removes it. Both surfaces — the Settings
// "Provider keys" section and the inline auth-card key entry — go through this hook,
// so the encrypt + mutation logic (and the codegen casts) live exactly once. The key
// only ever leaves the browser as ciphertext, via encryptProviderKey.

import { useCallback, useEffect, useMemo, useState } from "react";
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
       *  (devices.watchedCommandOutcome). */
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
  const outcome = useQuery(api.devices.watchedCommandOutcome, commandId ? { command_id: commandId as Id<"daemon_commands"> } : "skip");

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

/** A machine's sign-in to a sign-in based cloud agent provider, as its daemon last checked it. */
export type CloudAgentLoginView =
  | { state: "checking" }
  | { state: "signed_in" | "signed_out" | "expired" | "disabled" | "unreachable"; account?: string; plan?: string; detail?: string }
  | { state: "failed"; error: string };

/** How long a started sign-in is waited on before the dialog offers it again. */
const LOGIN_WAIT_MS = 5 * 60_000;
const LOGIN_RECHECK_MS = 3_000;

/**
 * A sign-in based cloud agent provider (Codex Cloud) on one machine: its
 * daemon checks the login when the dialog opens, and `signIn` has it run the
 * provider's own sign-in (which opens the browser there), then checks again
 * every few seconds until the login lands or the wait runs out. The login
 * never leaves the machine; only its state and account come back.
 */
export function useCloudAgentLogin(provider: string, device: Device | null) {
  const enqueue = useMutation(api.devices.enqueueCloudAgentLoginCommand);
  const deviceId = device?.device_id;
  const [checkId, setCheckId] = useState<string | null>(null);
  const [startId, setStartId] = useState<string | null>(null);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // A started sign-in the wait ran out on, so the dialog says so rather than quietly offering it again.
  const [timedOut, setTimedOut] = useState(false);
  const check = useQuery(api.devices.watchedCommandOutcome, checkId ? { command_id: checkId as Id<"daemon_commands"> } : "skip");
  const start = useQuery(api.devices.watchedCommandOutcome, startId ? { command_id: startId as Id<"daemon_commands"> } : "skip");

  const send = useCallback(async (op: "check" | "start"): Promise<string | null> => {
    if (!deviceId) return null;
    try {
      const res = await enqueue({ device_id: deviceId, provider, op });
      setSendError(null);
      return (res as { command_id?: string } | undefined)?.command_id ?? null;
    } catch (err) {
      captureException(err);
      setSendError(err instanceof Error ? err.message : "Couldn't reach codecast");
      return null;
    }
  }, [deviceId, enqueue, provider]);

  const recheck = useCallback(async () => {
    const id = await send("check");
    if (id) setCheckId(id);
  }, [send]);

  useEffect(() => {
    if (deviceId) void recheck();
  }, [deviceId, recheck]);

  // Waiting on a started sign-in: each settled check that is not yet signed in asks again.
  const settled = check?.state === "done" || check?.state === "failed";
  const signedIn = check?.state === "done" && check.login === "signed_in";
  useEffect(() => {
    if (waitingSince === null || !settled) return;
    if (signedIn || start?.state === "failed") { setWaitingSince(null); return; }
    if (Date.now() - waitingSince > LOGIN_WAIT_MS) { setWaitingSince(null); setTimedOut(true); return; }
    const t = setTimeout(() => void recheck(), LOGIN_RECHECK_MS);
    return () => clearTimeout(t);
  }, [waitingSince, checkId, settled, signedIn, start?.state, recheck]);

  const signIn = useCallback(async () => {
    setTimedOut(false);
    const id = await send("start");
    if (!id) return;
    setStartId(id);
    setWaitingSince(Date.now());
  }, [send]);

  let view: CloudAgentLoginView;
  if (sendError) view = { state: "failed", error: sendError };
  else if (start?.state === "failed") view = { state: "failed", error: start.error };
  else if (!check || check.state === "pending") view = { state: "checking" };
  else if (check.state === "failed") view = { state: "failed", error: check.error };
  else view = { state: (check.login ?? "unreachable") as Exclude<CloudAgentLoginView["state"], "checking" | "failed">, account: check.account, plan: check.plan, detail: check.detail };

  return { view, waiting: waitingSince !== null, timedOut: timedOut && !signedIn, signIn, recheck };
}
