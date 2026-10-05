// The person's Google connection as the lane describes it: the account the
// assistant works in, what its grant lets the assistant do, and the connect
// and disconnect gestures. Connections and /welcome both read it, so the two
// never disagree about whether Google is connected or what it allows.
import { APP_DESCRIPTORS, type AppConnectionsResult } from "@codecast/shared/contracts";
import type { GoogleGrant, GoogleReturnPath } from "@codecast/convex/convex/googleOAuth";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { useAppConnection } from "../../lib/integrations";
import type { GoogleAbilities } from "./lane";

// Everything the assistant's mail and calendar tools need beyond read access:
// modify (sort, label, archive, draft) also covers sending.
const GRANTS: GoogleGrant[] = ["gmail.modify", "calendar.events"];

export type GoogleRow = { _id: string; email?: string; pending: boolean; assistant?: boolean; can?: GoogleAbilities };

/** `returnTo` is the lane page Google's callback lands on (GOOGLE_RETURN_PATHS),
 *  which must mount ConnectNotice to finish the connection. */
export function useLaneGoogle(returnTo: GoogleReturnPath) {
  const { data } = useSettingsData("connections");
  const { data: googleRows } = useSettingsData("googleConnections");
  const gmail = (data as AppConnectionsResult | undefined)?.apps.find((a) => a.id === "gmail");
  // The account the assistant works in, as the server ranks it (googleAccount).
  // appConnections' gmail entry names the same account, so Disconnect
  // (its disconnect_id) revokes the mailbox the screen describes.
  const rows = (googleRows as GoogleRow[] | undefined) ?? [];
  const google = rows.find((r) => r.assistant) ?? null;
  // Ranked, so the first is the account the assistant would use after a disconnect.
  const others = rows.filter((r) => !r.pending && !r.assistant);
  const actions = useAppConnection(APP_DESCRIPTORS.gmail, gmail, "personal", { grants: GRANTS, returnTo });

  const connected = gmail?.status === "connected";
  const can: GoogleAbilities | null = google?.can ?? (connected ? { read_mail: true, modify_mail: false, send_mail: false, calendar: false } : null);
  const email = google?.email ?? (connected ? gmail?.detail : undefined);
  return {
    gmail,
    google,
    others,
    actions,
    connected,
    can,
    email,
    /** False until the connections list has answered, so a screen can wait
     *  rather than show "not connected" to someone who is. */
    known: data !== undefined,
  };
}
