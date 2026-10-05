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
import { isDesktopShell, openExternalUrl } from "../../lib/desktop";
import { useConnectAvailable } from "./assistantPromise";
import type { MailAbilities } from "./lane";

/** Whisk's web home, where "Open Whisk" goes before the server has said. */
export const WHISK_HOME = "https://whisk.email";

/** What the person's grant lets the assistant do, with no connect or
 *  disconnect gestures: home reads it to suggest only what works. */
export function useLaneMailAbilities() {
  const { data, error } = useSettingsData("whiskConnection");
  const reach = useConnectAvailable();
  // A backend that cannot answer is treated as able, so Connect shows and any
  // refusal is said where it happens rather than the screen waiting for good.
  const available = reach.failed ? true : reach.available;
  const view = (data ?? null) as WhiskConnectionView | null;
  const linked = view?.connected ? view : null;
  const connected = !!linked;
  const can: MailAbilities | null = linked?.can ?? null;
  return {
    connected,
    can,
    email: linked?.email,
    /** Every mailbox the connection reaches, the main one first. */
    mailboxes: linked?.mailboxes ?? [],
    /** Where Whisk itself opens. */
    whiskUrl: view?.whisk_url ?? WHISK_HOME,
    /** Whether this deployment can connect mail through Whisk at all;
     *  undefined until it answers, true when the question failed. */
    available,
    canDisconnect: connected,
    /** False until the connection has answered and, for someone not
     *  connected, until the deployment has said whether Connect can work, so
     *  a screen can wait rather than show "not connected" or offer a button
     *  it may withdraw. A read that failed counts as answered. */
    known: (data !== undefined || !!error) && (connected || available !== undefined),
  };
}

/** The connect and disconnect gestures. `returnTo` is the lane page the
 *  connect comes back to (convex/whisk.ts WHISK_RETURN_PATHS). */
function useWhiskActions(returnTo: WhiskReturnPath) {
  const getConnectUrl = useAction(api.whisk.getConnectUrl);
  const disconnectWhisk = useAction(api.whisk.disconnect);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (fn: () => Promise<{ ok: boolean; error?: string }>, fallback: string) => {
    setError(null);
    setBusy(true);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? fallback);
    } catch (e: any) {
      setError(e?.message ?? fallback);
    } finally {
      setBusy(false);
    }
  };

  return {
    busy,
    error,
    connect: () =>
      attempt(async () => {
        const res = await getConnectUrl({ return_to: returnTo });
        // In place on the web: a tab opened once the URL arrives is outside
        // the tap's user activation, and phone browsers block it silently.
        // The desktop app hands it to the system browser.
        if (res.ok && res.url) {
          if (isDesktopShell()) openExternalUrl(res.url);
          else window.location.assign(res.url);
        }
        return res;
      }, "Couldn't start connecting your mail"),
    disconnect: () => attempt(() => disconnectWhisk({}), "Couldn't disconnect your mail"),
  };
}

export function useLaneMail(returnTo: WhiskReturnPath) {
  const abilities = useLaneMailAbilities();
  return { ...abilities, actions: useWhiskActions(returnTo) };
}
