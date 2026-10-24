// Touch ID on the web (docs/architecture/vault.md "Touch ID"). The presses
// that open an Ask first secret to whoever holds this tab (reveal, approve,
// Ask first off) and the passkeys themselves take a presence grant, earned by
// a passkey assertion no script can produce (convex/passkeys.ts). A gated
// press runs `confirmPresence` first: begin a challenge for that action on
// that target, let the platform prompt for Touch ID, finish it, and the
// press goes on to the gated call with the grant string the begin handed
// this tab, which the server lets through once. Nobody else holding the
// person's sign-in can spend that grant: the string lives only here.
//
// With no passkey yet, the same flow offers to set one up and continues. The
// desktop app has no platform passkeys, so it opens the web origin's
// /confirm page in the system browser and waits on the challenge instead.
// An agent's tab may not set one up (lib/agentTabGuard).

import { useCallback, useMemo } from "react";
import { useConvex } from "convex/react";
import type { ConvexReactClient } from "convex/react";
import { toast } from "sonner";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { api } from "@codecast/convex/convex/_generated/api";
import { NOT_CONFIRMED, approvesSecretRead, isPresenceRequired, type PresenceAction, type PresenceGrant } from "@codecast/shared/contracts/secrets";
import { isAgentDrivenTab } from "./desktopHandoff";
import { isDesktopShell, openExternalUrl } from "./desktop";
import { PERSON_ONLY } from "./agentTabGuard";

type Client = Pick<ConvexReactClient, "action" | "watchQuery">;

/** The page a desktop or phone opens to finish a challenge in a real browser. */
export const confirmPath = (challengeId: string) => `/confirm?c=${encodeURIComponent(challengeId)}`;

/** What a new passkey is called until its owner renames it: the device it was made on. */
export function deviceName(ua = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [browser, device].filter(Boolean).join(" on ") || "Passkey";
}

const fail = (error: string) => {
  toast.error(error);
  return false;
};

/** Run a WebAuthn ceremony; the person cancelling it answers null quietly, anything else says why. */
export async function runCeremony<T>(start: () => Promise<T>): Promise<T | null> {
  try {
    return await start();
  } catch (e) {
    const err = e as { name?: string; code?: string; message?: string };
    if (err?.name === "NotAllowedError" || err?.name === "AbortError" || err?.code === "ERROR_CEREMONY_ABORTED") return null;
    toast.error(err?.message || "Touch ID did not finish");
    return null;
  }
}

/** A short system prompt with one button, which is also the user gesture the next ceremony needs. */
function ask(title: string, label: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    toast(title, {
      duration: 60_000,
      action: { label, onClick: () => settle(true) },
      cancel: { label: "Cancel", onClick: () => settle(false) },
      onDismiss: () => settle(false),
      onAutoClose: () => settle(false),
    });
  });
}

/** Open /confirm in the system browser and wait until the challenge reaches `want`, the person cancels, or it expires. */
function handOff(client: Client, challengeId: string, want: "granted" | "used", expiresAt: number): Promise<boolean> {
  const url = `${window.location.origin}${confirmPath(challengeId)}`;
  openExternalUrl(url);
  return new Promise((resolve) => {
    const id = `presence:${challengeId}`;
    const watch = client.watchQuery(api.passkeys.challenge, { challenge_id: challengeId });
    let stop = () => {};
    let settled = false;
    const settle = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      stop();
      clearTimeout(timer);
      toast.dismiss(id);
      if (error) toast.error(error);
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false, "The confirmation expired"), Math.max(0, expiresAt - Date.now()));
    const check = () => {
      let state;
      try {
        state = watch.localQueryResult();
      } catch {
        return;
      }
      if (!state) return;
      if (state.status === want) settle(true);
      else if (state.status !== "pending") settle(false, "The confirmation expired");
    };
    stop = watch.onUpdate(check);
    toast("Confirm in your browser", {
      id,
      duration: Infinity,
      // Opening again keeps the toast; Cancel or swiping it away stops waiting.
      action: {
        label: "Open again",
        onClick: (e) => {
          e.preventDefault();
          openExternalUrl(url);
        },
      },
      cancel: { label: "Cancel", onClick: () => settle(false) },
      onDismiss: () => settle(false),
    });
    check();
  });
}

/** Create a passkey for a pending enrollment challenge and store it: true once stored. The /confirm page runs it too. */
export async function finishRegistration(client: Pick<Client, "action">, challengeId: string, options: any): Promise<boolean> {
  const response = await runCeremony(() => startRegistration({ optionsJSON: options }));
  if (!response) return false;
  const done = await client.action(api.passkeys.registrationFinish, { challenge_id: challengeId, response, name: deviceName() });
  return "error" in done ? fail(done.error) : true;
}

/** Assert a passkey for a pending presence challenge: true once the server granted it. The /confirm page runs it too. */
export async function finishPresence(client: Pick<Client, "action">, challengeId: string, options: any): Promise<boolean> {
  const response = await runCeremony(() => startAuthentication({ optionsJSON: options }));
  if (!response) return false;
  const done = await client.action(api.passkeys.presenceFinish, { challenge_id: challengeId, response });
  return "error" in done ? fail(done.error) : true;
}

/** Set up a passkey, inline or through the browser; `prompt` first asks with one button, which is the gesture the ceremony needs. A second passkey spends `grant`, an add_passkey grant. */
async function enroll(client: Client, handoff: boolean, prompt?: [title: string, label: string], grant?: PresenceGrant): Promise<boolean> {
  if (isAgentDrivenTab()) return fail(PERSON_ONLY.enroll);
  if (prompt && !(await ask(...prompt))) return false;
  const begun: any = await client.action(api.passkeys.registrationBegin, { origin: window.location.origin, grant });
  if (begun?.error) return fail(begun.error);
  if (handoff) return await handOff(client, begun.challenge_id, "used", begun.expires_at);
  return await finishRegistration(client, begun.challenge_id, begun.options);
}

async function confirmOnce(client: Client, action: PresenceAction, target: string): Promise<PresenceGrant | null> {
  const handoff = isDesktopShell();
  const begin = () => client.action(api.passkeys.presenceBegin, { action, target, origin: window.location.origin });
  let begun: any = await begin();
  if (begun?.needs_passkey) {
    if (!(await enroll(client, handoff, ["Set up Touch ID to confirm this", "Set up Touch ID"]))) return null;
    begun = await begin();
    // Setting up spent the press's gesture; the assertion takes a press of its own.
    if (!begun?.error && !handoff && !(await ask("Touch ID is set up", "Confirm"))) return null;
  }
  if (begun?.error) {
    fail(begun.error);
    return null;
  }
  const granted = handoff ? await handOff(client, begun.challenge_id, "granted", begun.expires_at) : await finishPresence(client, begun.challenge_id, begun.options);
  return granted ? begun.grant : null;
}

/**
 * Settings' Add: the first passkey sets up at once; another takes Touch ID
 * with one already there (an add_passkey grant), then a press to create it.
 */
export async function addPasskey(client: Client, hasPasskeys: boolean): Promise<boolean> {
  const handoff = isDesktopShell();
  if (!hasPasskeys) return await enroll(client, handoff);
  const grant = await confirmPresence(client, "add_passkey", "self");
  if (!grant) return false;
  return await enroll(client, handoff, handoff ? undefined : ["Confirmed: now create the new passkey", "Create passkey"], grant);
}

// One ceremony per action and target at a time: a second press while the
// prompt is up joins it rather than starting a second, which WebAuthn refuses.
const inflight = new Map<string, Promise<PresenceGrant | null>>();

/** Earn a presence grant for `action` on `target`: the grant string that spends it once the server holds it, null when cancelled or refused (said in a toast). */
export function confirmPresence(client: Client, action: PresenceAction, target: string): Promise<PresenceGrant | null> {
  const key = `${action}:${target}`;
  const running = inflight.get(key);
  if (running) return running;
  const run = confirmOnce(client, action, target)
    .catch((e: unknown) => {
      fail((e as Error)?.message || "Touch ID did not finish");
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

/**
 * Run a gated call: confirm first when the press is known to need it
 * (`upfront`) and call with the grant string, and if the server still
 * refuses with the presence code, answered or thrown (a grant that expired on
 * its way, an Ask first switched on meanwhile), confirm once more and call
 * again.
 */
export async function withPresence<T>(confirm: () => Promise<PresenceGrant | null>, call: (grant?: PresenceGrant) => T | Promise<T>, upfront: boolean): Promise<T | typeof NOT_CONFIRMED> {
  const confirmed = async () => {
    const grant = await confirm();
    return grant ? await call(grant) : NOT_CONFIRMED;
  };
  let first: T | typeof NOT_CONFIRMED;
  try {
    first = upfront ? await confirmed() : await call();
  } catch (e) {
    if (isPresenceRequired(e)) return await confirmed();
    throw e;
  }
  return first !== NOT_CONFIRMED && isPresenceRequired(first) ? await confirmed() : first;
}

/** confirmPresence bound to this tree's Convex client. */
export function usePresence(): (action: PresenceAction, target: string) => Promise<PresenceGrant | null> {
  const client = useConvex();
  return useCallback((action: PresenceAction, target: string) => confirmPresence(client, action, target), [client]);
}

type Answerable = { _id: string; category?: string; options: readonly { label: string }[] };

/**
 * Answering a decision where its Approve opens an Ask first secret: that
 * option confirms with Touch ID before `send` dispatches it with the grant
 * string; every other option, Deny included, answers at once. `gated(i)`
 * marks the option that asks. The answer is `send`'s own, or NOT_CONFIRMED.
 */
export function useApproveGate(decision: Answerable | undefined) {
  const confirm = usePresence();
  const gated = useCallback((index: number) => !!decision && approvesSecretRead(decision, index), [decision]);
  const answer = useCallback(
    <T,>(index: number, send: (presence?: PresenceGrant) => T): T | Promise<T | typeof NOT_CONFIRMED> =>
      decision && gated(index) ? withPresence(() => confirm("approve", decision._id), send, true) : send(),
    [decision, gated, confirm],
  );
  return useMemo(() => ({ gated, answer }), [gated, answer]);
}
