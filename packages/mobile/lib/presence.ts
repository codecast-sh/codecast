// Touch ID for a Vault action on the phone: the platform passkey sheet, run by
// the app (lib/passkeyCeremony). A binary built before that sheet, or one the
// OS cannot vouch for codecast.sh, hands off to the web's /confirm page in the
// in-app browser instead, watched over this app's Convex client
// (web/lib/presenceHandoff).
//
// The phone also answers what another of the person's devices asked for (a
// laptop with no passkey of its own): components/PresenceRequests shows it,
// and confirmForOtherDevice asserts that same challenge here.
import * as WebBrowser from 'expo-web-browser';
import { api } from '@codecast/convex/convex/_generated/api';
import { PRESENCE_TTL_MS, type PresenceAction, type PresenceGrant } from '@codecast/shared/contracts/secrets';
import { addPasskeyViaWeb, confirmPageUrl, confirmPresenceViaWeb, type OpenedChallenge, type PresenceHandoffDeps } from '@codecast/web/lib/presenceHandoff';
import { convex } from '@/lib/convex';
import { nativePasskeyDeps } from '@/lib/nativePasskey';
import { UNCONFIGURED, addPasskeyNative, classifyCeremonyError, confirmPresenceNative, toGetRequest, toResponseJSON } from '@/lib/passkeyCeremony';
import { ownChallenges } from '@/lib/presenceRequests';
import { openInAppBrowser, WEB_ORIGIN } from '@/lib/links';

/** Note a challenge this phone opened, so its waiting list (lib/presenceRequests) never offers it back. */
async function own(begun: Promise<OpenedChallenge>): Promise<OpenedChallenge> {
  const got = await begun;
  if ('challenge_id' in got) ownChallenges.add(got.challenge_id);
  return got;
}

const phone: PresenceHandoffDeps = {
  webBase: WEB_ORIGIN,
  begin: (action, target) => own(convex.action(api.passkeys.presenceBegin, { action, target }) as Promise<OpenedChallenge>),
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

/**
 * Answer a challenge another of the person's devices opened, with this
 * phone's passkey: true once granted, false when cancelled, expired or
 * refused (thrown with the server's words). A binary without the native sheet
 * answers it on /confirm in the in-app browser.
 */
export async function confirmForOtherDevice(challengeId: string): Promise<boolean> {
  const state = await convex.query(api.passkeys.challenge, { challenge_id: challengeId });
  if (state?.status !== 'pending' || !state.options) return false;
  const native = nativePasskeyDeps(phone);
  if (native) {
    let response;
    try {
      response = toResponseJSON(await native.get(toGetRequest(state.options)));
    } catch (e) {
      const meaning = classifyCeremonyError(e);
      if (meaning === 'cancel') return false;
      if (meaning !== UNCONFIGURED) throw new Error(meaning);
    }
    if (response) {
      const done = await native.finishPresence(challengeId, response);
      if ('error' in done) throw new Error(done.error);
      return true;
    }
  }
  await phone.open(confirmPageUrl(WEB_ORIGIN, challengeId));
  return (await phone.read(challengeId)) === 'granted';
}
