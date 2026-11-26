// Finish an OAuth connection on the page the connector redirected back to.
//
// The connectors land the browser on an in-app page with the callback in the
// URL (lib/connectorReturn.ts names the shapes). A confirm token rides the
// FRAGMENT, because the redirect lands in whatever browser the provider chose
// and only the signed-in session that started the flow may complete it. This
// hook reads the callback once on mount, clears it from the address bar, and
// spends the token in this session. Every page a connector may return to
// mounts it: /settings/integrations for all of them, and the pages Google's
// connector accepts as a return_to (googleOAuth.ts GOOGLE_RETURN_PATHS), and
// /welcome and the main shell for the mail connect through Whisk
// (ConnectNotice, ConnectToast).

import { useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { APP_DESCRIPTORS, type AppId } from "@codecast/shared/contracts";
import { parseConnectorReturn, strippedUrl, type ConnectorReturn } from "../lib/connectorReturn";
import { useWatchEffect } from "./useWatchEffect";

const api = _api as any;

/** One toast per return, so a remount on the same landing cannot stack two. */
const CONNECT_TOAST_ID = "connector-return";

/** The callback's outcome, once known: an error to show (in the connector's
 *  words, for describeConnectorError), or a success. Null when the page was
 *  opened without a callback, or while a confirmation is still in flight.
 *  `extra` names providers besides the apps (parseConnectorReturn), and
 *  `names` their display names for the success toast. `quiet` skips the
 *  success toast, for a page that says it in place; `toastErrors` toasts a
 *  refusal too, for a page with no place to say it. */
export function useConnectorReturn<X extends string = never>(
  { extra = [], names = {}, quiet = false, toastErrors = false }: {
    extra?: readonly X[];
    names?: Partial<Record<X, string>>;
    quiet?: boolean;
    toastErrors?: boolean;
  } = {},
): ConnectorReturn<AppId | X> | null {
  const confirmConnector = useAction(api.oauthConnectors.confirmConnection);
  const confirmGoogle = useAction(api.googleOAuth.confirmConnection);
  const [notice, setNotice] = useState<ConnectorReturn<AppId | X> | null>(null);

  // ONE read of the landing URL. Re-reading it would let a back-navigation
  // replay a confirmation the user already spent.
  useWatchEffect(() => {
    const hit = parseConnectorReturn(window.location.hash, window.location.search, extra);
    if (!hit) return;
    window.history.replaceState(
      null,
      "",
      strippedUrl(window.location.pathname, window.location.search, window.location.hash),
    );
    if (hit.kind !== "confirm") {
      setNotice(hit);
      if (hit.kind === "error") {
        if (toastErrors) toast.error(hit.reason, { id: CONNECT_TOAST_ID });
        return;
      }
      const name = (names as Partial<Record<string, string>>)[hit.provider]
        ?? (APP_DESCRIPTORS as Partial<Record<string, { name: string }>>)[hit.provider]?.name;
      if (!quiet && name) {
        toast.success(hit.provider === "github" ? "GitHub App installed" : `${name} connected`, { id: CONNECT_TOAST_ID });
      }
      return;
    }
    // Google's connector and the generic one take the same two arguments and
    // differ only in which module owns the installation row.
    const confirm = hit.provider === "gmail" ? confirmGoogle : confirmConnector;
    const name = APP_DESCRIPTORS[hit.provider].name;
    void (async () => {
      try {
        const res = await confirm({ installation_id: hit.installationId, confirm_token: hit.confirmToken });
        if (res?.ok) {
          toast.success(`${name} connected`);
          setNotice({ kind: "success", provider: hit.provider });
        } else {
          setNotice({ kind: "error", provider: hit.provider, reason: res?.error ?? "The confirmation failed" });
        }
      } catch (e: any) {
        setNotice({ kind: "error", provider: hit.provider, reason: e?.message ?? `Couldn't confirm ${name}` });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read of the landing URL
  }, []);

  return notice;
}
