// Touch ID for a Vault action on the phone: the platform passkey sheet, run by
// the app (lib/passkeyCeremony). A binary built before that sheet, or one the
// OS cannot vouch for codecast.sh, hands off to the web's /confirm page in the
// in-app browser instead, watched over this app's Convex client
// (web/lib/presenceHandoff).
import * as WebBrowser from 'expo-web-browser';
import { api } from '@codecast/convex/convex/_generated/api';
import { PRESENCE_TTL_MS, type PresenceAction, type PresenceGrant } from '@codecast/shared/contracts/secrets';
import { addPasskeyViaWeb, confirmPresenceViaWeb, type OpenedChallenge, type PresenceHandoffDeps } from '@codecast/web/lib/presenceHandoff';
import { convex } from '@/lib/convex';
import { nativePasskeyDeps } from '@/lib/nativePasskey';
import { UNCONFIGURED, addPasskeyNative, confirmPresenceNative } from '@/lib/passkeyCeremony';
import { openInAppBrowser, WEB_ORIGIN } from '@/lib/links';

const phone: PresenceHandoffDeps = {
  webBase: WEB_ORIGIN,
  begin: (action, target) => convex.action(api.passkeys.presenceBegin, { action, target }) as Promise<OpenedChallenge>,
  enroll: (grant) => convex.action(api.passkeys.registrationBegin, { grant }) as Promise<OpenedChallenge>,
  open: async (url) => ((await openInAppBrowser(url)).type === WebBrowser.WebBrowserResultType.OPENED ? 'opened' : 'closed'),
  close: () => void WebBrowser.dismissBrowser().catch(() => {}),
  watch: (challengeId, onStatus) => {
    const watch = convex.watchQuery(api.passkeys.challenge, { challenge_id: challengeId });
    const read = () => {
      try {
        const row = watch.localQueryResult();
        if (row !== undefined) onStatus(row?.status ?? null);
      } catch {
        onStatus(null);
      }
    };
    const stop = watch.onUpdate(read);
    read();
    return stop;
  },
  read: async (challengeId) => (await convex.query(api.passkeys.challenge, { challenge_id: challengeId }))?.status ?? null,
  ttlMs: PRESENCE_TTL_MS,
};

/** The grant string the gated call spends once the person confirmed `action` on `target` with Touch ID, else null. Throws with the server's words when it cannot start. */
export async function confirmPresence(action: PresenceAction, target: string): Promise<PresenceGrant | null> {
  const native = nativePasskeyDeps(phone);
  const got = native ? await confirmPresenceNative(action, target, native) : UNCONFIGURED;
  return got !== UNCONFIGURED ? got : confirmPresenceViaWeb(action, target, phone);
}

/** Add a passkey: true once stored. Throws with the server's words when it cannot start. */
export async function addPasskey(hasPasskeys: boolean): Promise<boolean> {
  const native = nativePasskeyDeps(phone);
  const added = native ? await addPasskeyNative(hasPasskeys, native) : UNCONFIGURED;
  return added !== UNCONFIGURED ? added : addPasskeyViaWeb(hasPasskeys, phone);
}
