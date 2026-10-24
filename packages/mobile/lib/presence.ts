// Touch ID for a Vault action on the phone: the web's /confirm page in the
// in-app browser (Safari View Controller runs the passkey ceremony), watched
// over this app's Convex client (web/lib/presenceHandoff).
import * as WebBrowser from 'expo-web-browser';
import { api } from '@codecast/convex/convex/_generated/api';
import { PRESENCE_TTL_MS, type PresenceAction, type PresenceGrant } from '@codecast/shared/contracts/secrets';
import { confirmPresenceViaWeb, type OpenedChallenge, type PresenceHandoffDeps } from '@codecast/web/lib/presenceHandoff';
import { convex } from '@/lib/convex';
import { openInAppBrowser } from '@/lib/links';

const phone: PresenceHandoffDeps = {
  webBase: 'https://codecast.sh',
  begin: (action, target) => convex.action(api.passkeys.presenceBegin, { action, target }) as Promise<OpenedChallenge>,
  enroll: () => convex.action(api.passkeys.registrationBegin, {}) as Promise<OpenedChallenge>,
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
export function confirmPresence(action: PresenceAction, target: string): Promise<PresenceGrant | null> {
  return confirmPresenceViaWeb(action, target, phone);
}
