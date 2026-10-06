// The person's mail and calendar as the lane describes them: connected
// through Whisk (convex/whisk.ts), what the grant lets the assistant do, the
// mailboxes it reaches, and the connect and disconnect gestures. Connections,
// /welcome and home all read it, so they never disagree about whether mail is
// connected or what it allows. Codecast holds no Google token for mail: the
// connect goes to Whisk and comes back through /connect/whisk.
import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { WhiskConnectionView, WhiskReturnPath } from "@codecast/convex/convex/whisk";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useConnectGesture } from "../../lib/integrations";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { GATE_DEADLINE_MS, useConnectAvailable } from "./assistantPromise";
import type { MailAbilities } from "./lane";

/** Whisk's web home, where "Open Whisk" goes before the server has said. */
export const WHISK_HOME = "https://whisk.email";

/** What the person's grant lets the assistant do, with no connect or
 *  disconnect gestures: home reads it to suggest only what works. */
export function useLaneMailAbilities() {
  const { data, error } = useSettingsData("whiskConnection");
  const reach = useConnectAvailable();
  // A connection read with no answer by the gate's deadline counts as "not
  // connected" for now, so no screen waits on it forever; a late answer
  // still lands.
  const [readLate, setReadLate] = useState(false);
  const reading = data === undefined && !error;
  useWatchEffect(() => {
    if (!reading) return;
    const timer = setTimeout(() => setReadLate(true), GATE_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [reading]);
  // Connect is offered only on a yes. Until one arrives, a deployment that is
  // late to answer offers nothing, so no screen leads a newcomer to a connect
  // that can only fail; a late yes still offers it.
  const available = reach.available ?? (reach.failed ? false : undefined);
  const view = (data ?? null) as WhiskConnectionView | null;
  const linked = view?.connected ? view : null;
  const connected = !!linked;
  const can: MailAbilities | null = linked?.can ?? null;
  return {
    connected,
    /** Whisk refused the connection (revoked there) or it can no longer be
     *  opened: it stays listed, and every surface offers Reconnect. */
    needsReconnect: !!linked?.needs_reconnect,
    can,
    email: linked?.email,
    /** Every mailbox the connection reaches, the main one first. */
    mailboxes: linked?.mailboxes ?? [],
    /** Where Whisk itself opens. */
    whiskUrl: view?.whisk_url ?? WHISK_HOME,
    /** Whether this deployment can connect mail through Whisk at all;
     *  undefined until it answers, false when the question failed. Offer
     *  Connect only on `available === true`. */
    available,
    canDisconnect: connected,
    /** False until the connection has answered and, for someone not
     *  connected, until the deployment has said whether Connect can work, so
     *  a screen can wait rather than show "not connected" or offer a button
     *  it may withdraw. A read that failed counts as answered. */
    known: (!reading || readLate) && (connected || available !== undefined),
  };
}

/** The connect and disconnect gestures, on the shared connect machinery
 *  (lib/integrations.ts useConnectGesture). `returnTo` is the lane page the
 *  connect comes back to (convex/whisk.ts WHISK_RETURN_PATHS). The connect
 *  opens in place on the web, in the system browser from the desktop app. */
function useWhiskActions(returnTo: WhiskReturnPath) {
  const getConnectUrl = useAction(api.whisk.getConnectUrl);
  const disconnectWhisk = useAction(api.whisk.disconnect);
  const { busy, error, attempt, settle, openMinted } = useConnectGesture();
  return {
    busy,
    error,
    connect: () =>
      attempt(() => openMinted(() => getConnectUrl({ return_to: returnTo, origin: window.location.origin }), "Couldn't start connecting your mail", { sameTab: true }), "Couldn't reach Whisk"),
    disconnect: () =>
      attempt(async () => {
        settle(await disconnectWhisk({}), "Couldn't disconnect your mail");
      }, "Couldn't disconnect your mail"),
  };
}

export function useLaneMail(returnTo: WhiskReturnPath) {
  const abilities = useLaneMailAbilities();
  return { ...abilities, actions: useWhiskActions(returnTo) };
}
