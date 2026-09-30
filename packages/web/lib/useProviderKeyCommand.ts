"use client";

// pl-207 (Phase 3): the single place the web seals a provider API key and enqueues
// the device command that sets or removes it. Both surfaces — the Settings
// "Provider keys" section and the inline auth-card key entry — go through this hook,
// so the encrypt + mutation logic (and the codegen casts) live exactly once. The key
// only ever leaves the browser as ciphertext, via encryptProviderKey.

import { useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useMutation, useQuery } from "convex/react";
import { captureException } from "@sentry/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { CLOUD_AGENT_ACTIONS, getProviderKeySpec, type CloudAgentActionName, type CloudAgentLoginStateName } from "@codecast/shared/contracts";
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
 * One daemon command the page waits on (devices.watchedCommandOutcome):
 * `watch` hands it the command's id (null lets go), `outcome` is the daemon's
 * verdict, and `unanswered` says the machine left it past `timeoutMs`, so the
 * page can say so instead of waiting forever. A new id replaces the old one.
 */
export function useWatchedCommand(timeoutMs?: number) {
  const [commandId, watch] = useState<string | null>(null);
  const [unansweredId, setUnansweredId] = useState<string | null>(null);
  const outcome = useQuery(api.devices.watchedCommandOutcome, commandId ? { command_id: commandId as Id<"daemon_commands"> } : "skip");
  const settled = outcome?.state === "done" || outcome?.state === "failed";
  useWatchEffect(() => {
    if (!commandId || settled || timeoutMs === undefined) return;
    const t = setTimeout(() => setUnansweredId(commandId), timeoutMs);
    return () => clearTimeout(t);
  }, [commandId, settled, timeoutMs]);
  return {
    commandId,
    watch,
    outcome: commandId ? outcome : undefined,
    settled,
    unanswered: !!commandId && unansweredId === commandId && !settled,
  };
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
  const { commandId, watch, outcome } = useWatchedCommand();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const trimmed = key.trim();
  const looksRight = trimmed.startsWith(getProviderKeySpec(keyProvider)?.keyPrefix ?? "") && trimmed.length > 20;

  const submit = async () => {
    if (!device || !pubkey || !looksRight) return;
    setSending(true);
    setSendError(null);
    watch(null);
    try {
      const id = await setKey(device.device_id, pubkey, keyProvider, trimmed);
      watch(id ?? null);
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
  | { state: CloudAgentLoginStateName; account?: string; plan?: string; detail?: string }
  | { state: "failed"; error: string };

/** How long a started sign-in is waited on before the dialog offers it again. */
const LOGIN_WAIT_MS = 5 * 60_000;
const LOGIN_RECHECK_MS = 3_000;
/** A check the machine has not answered in this long: it is not reading its commands. */
const LOGIN_CHECK_TIMEOUT_MS = 30_000;

/**
 * A sign-in based cloud agent provider (Codex Cloud) on one machine: its
 * daemon checks the login when the dialog opens, and `signIn` has it run the
 * provider's own sign-in (which opens the browser there), then checks again
 * every few seconds until the login lands or the wait runs out. The login
 * never leaves the machine; only its state and account come back.
 */
export function useCloudAgentLogin(provider: string, device: Device | null) {
  const enqueue = useMutation(api.devices.enqueueCloudAgentLoginCommand);
  // An offline machine reads no commands: nothing is asked of it (the dialog says it is offline).
  const deviceId = device?.online ? device.device_id : undefined;
  // The check the machine never answers is said, not waited on forever.
  const checkCmd = useWatchedCommand(LOGIN_CHECK_TIMEOUT_MS);
  const startCmd = useWatchedCommand();
  const check = checkCmd.outcome;
  const start = startCmd.outcome;
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // A started sign-in the wait ran out on, so the dialog says so rather than quietly offering it again.
  const [timedOut, setTimedOut] = useState(false);

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
    if (id) checkCmd.watch(id);
  }, [send, checkCmd.watch]);

  // One check per machine the dialog opens on (and again after it comes back online), not one per effect run.
  const checkedFor = useRef<string | undefined>(undefined);
  useWatchEffect(() => {
    if (checkedFor.current === deviceId) return;
    checkedFor.current = deviceId;
    if (deviceId) void recheck();
  }, [deviceId, recheck]);

  // "Check again": a new question, so a sign-in that failed to start (the CLI
  // missing, say) no longer stands for the answer, and signing in is offered again.
  const checkAgain = useCallback(async () => {
    startCmd.watch(null);
    setTimedOut(false);
    await recheck();
  }, [recheck, startCmd.watch]);

  const settled = checkCmd.settled;

  // Waiting on a started sign-in: each settled check that is not yet signed in asks again.
  const signedIn = check?.state === "done" && check.login === "signed_in";
  useWatchEffect(() => {
    if (waitingSince === null || !settled) return;
    if (signedIn || start?.state === "failed") { setWaitingSince(null); return; }
    if (Date.now() - waitingSince > LOGIN_WAIT_MS) { setWaitingSince(null); setTimedOut(true); return; }
    const t = setTimeout(() => void recheck(), LOGIN_RECHECK_MS);
    return () => clearTimeout(t);
  }, [waitingSince, checkCmd.commandId, settled, signedIn, start?.state, recheck]);

  const signIn = useCallback(async () => {
    setTimedOut(false);
    const id = await send("start");
    if (!id) return;
    startCmd.watch(id);
    setWaitingSince(Date.now());
  }, [send, startCmd.watch]);

  let view: CloudAgentLoginView;
  if (sendError) view = { state: "failed", error: sendError };
  else if (start?.state === "failed") view = { state: "failed", error: start.error };
  else if (checkCmd.unanswered) view = { state: "failed", error: `${device?.label ?? "Your computer"} didn't answer. Check that codecast is running there, then check again.` };
  else if (!check || check.state === "pending") view = { state: "checking" };
  else if (check.state === "failed") view = { state: "failed", error: check.error };
  else view = { state: check.login ?? "unreachable", account: check.account, plan: check.plan, detail: check.detail };

  return { view, waiting: waitingSince !== null, timedOut: timedOut && !signedIn, signIn, recheck: checkAgain };
}

/** How long an action waits for the hosting machine's answer (Create PR waits on Codex, Apply on the CLI). */
const ACTION_WAIT_MS = 4 * 60_000;

/** How an action went, for the page that asked: its result in words, and the page it made (a pull request). */
export interface CloudAgentActionOutcome { action: CloudAgentActionName; ok: boolean; text: string; url?: string }

/**
 * A session header's action on its cloud agent (CLOUD_AGENT_ACTIONS), sent to
 * the machine that hosts the session. The daemon says the result in the
 * session's thread; `onResult` hears it here too, or that the machine never
 * answered.
 */
export function useCloudAgentAction(conversationId: string, onResult: (outcome: CloudAgentActionOutcome) => void) {
  const enqueue = useMutation(api.devices.enqueueCloudAgentActionCommand);
  const [action, setAction] = useState<CloudAgentActionName | null>(null);
  const { watch, outcome, unanswered } = useWatchedCommand(ACTION_WAIT_MS);
  const report = useRef(onResult);
  report.current = onResult;

  const run = useCallback(async (next: CloudAgentActionName) => {
    try {
      const res = await enqueue({ conversation_id: conversationId as Id<"conversations">, action: next });
      setAction(next);
      watch(res.command_id);
    } catch (err) {
      captureException(err);
      report.current({ action: next, ok: false, text: err instanceof Error ? err.message : `${CLOUD_AGENT_ACTIONS[next].label} could not be sent` });
    }
  }, [conversationId, enqueue, watch]);

  useWatchEffect(() => {
    if (!action) return;
    if (unanswered) report.current({ action, ok: false, text: "The machine that hosts this session did not answer: it may be offline, or its codecast too old for this" });
    else if (outcome?.state === "done") report.current({ action, ok: true, text: outcome.detail ?? `${CLOUD_AGENT_ACTIONS[action].label} done`, url: outcome.url });
    else if (outcome?.state === "failed") report.current({ action, ok: false, text: outcome.error });
    else return;
    setAction(null);
    watch(null);
  }, [action, outcome, unanswered, watch]);

  return { run, pending: action };
}

