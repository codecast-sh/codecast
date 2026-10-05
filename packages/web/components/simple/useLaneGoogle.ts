// The person's Google connection as the lane describes it: the account the
// assistant works in, what its grant lets the assistant do, and the connect
// and disconnect gestures. Connections, /welcome and home all read it, so they
// never disagree about whether Google is connected or what it allows.
import { APP_DESCRIPTORS, type AppConnectionsResult } from "@codecast/shared/contracts";
import type { GoogleGrant, GoogleReturnPath } from "@codecast/convex/convex/googleOAuth";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useAppConnection } from "../../lib/integrations";
import { useConnectAvailable } from "./assistantPromise";
import type { GoogleAbilities } from "./lane";

// Everything the assistant's mail and calendar tools need beyond read access:
// modify (sort, label, archive, draft) also covers sending.
const GRANTS: GoogleGrant[] = ["gmail.modify", "calendar.events"];

export type GoogleRow = { _id: string; email?: string; pending: boolean; assistant?: boolean; can?: GoogleAbilities };

/** What the person's Google grant lets the assistant do, with no connect or
 *  disconnect gestures: home reads it to suggest only what works. */
export function useLaneGoogleAbilities() {
  const { data, error } = useSettingsData("connections");
  const { data: googleRows, error: rowsError } = useSettingsData("googleConnections");
  const reach = useConnectAvailable();
  // A backend that cannot answer is treated as able, so Connect shows and any
  // refusal is said where it happens rather than the screen waiting for good.
  const available = reach.failed ? true : reach.available;
  const gmail = (data as AppConnectionsResult | undefined)?.apps.find((a) => a.id === "gmail");
  // The account the assistant works in, as the server ranks it (googleAccount).
  // appConnections' gmail entry names the same account, so Disconnect
  // (its disconnect_id) revokes the mailbox the screen describes.
  const rows = (googleRows as GoogleRow[] | undefined) ?? [];
  const google = rows.find((r) => r.assistant) ?? null;
  const connected = gmail?.status === "connected";
  const can: GoogleAbilities | null = google?.can ?? (connected ? { read_mail: true, modify_mail: false, send_mail: false, calendar: false } : null);
  return {
    gmail,
    google,
    rows,
    connected,
    can,
    email: google?.email ?? (connected ? gmail?.detail : undefined),
    /** Whether this deployment can connect Google at all; undefined until it
     *  answers, true when the question failed. */
    available,
    /** A connected account the server can revoke (its disconnect_id). */
    canDisconnect: connected && !!gmail?.disconnect_id,
    /** False until the connections list has answered and, for someone
     *  connected, what their grant allows, so a screen can wait rather than
     *  show "not connected" or a weaker ability, and, for someone not
     *  connected, until the deployment has said whether Connect can work. A
     *  read that failed counts as answered (not connected, or read access
     *  only), so no screen waits on it for good. */
    known:
      (data !== undefined || !!error) &&
      (connected ? googleRows !== undefined || !!rowsError : available !== undefined),
  };
}

/** `returnTo` is the lane page Google's callback lands on (GOOGLE_RETURN_PATHS),
 *  which must mount ConnectNotice to finish the connection. */
export function useLaneGoogle(returnTo: GoogleReturnPath) {
  const { gmail, google, rows, connected, can, email, canDisconnect, known, available } = useLaneGoogleAbilities();
  // Ranked, so the first is the account the assistant would use after a disconnect.
  const others = rows.filter((r) => !r.pending && !r.assistant);
  // Google's consent screen opens in this tab and its callback returns here:
  // a tab opened after the URL is minted lands outside the tap that asked for
  // it, and phone browsers block it without a word.
  const actions = useAppConnection(APP_DESCRIPTORS.gmail, gmail, "personal", { grants: GRANTS, returnTo, sameTab: true });
  return {
    gmail,
    google,
    others,
    actions,
    connected,
    can,
    email,
    canDisconnect,
    known,
    available,
  };
}
