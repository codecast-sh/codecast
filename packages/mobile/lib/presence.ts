// Touch ID for a Vault action on the phone. With this phone's own key
// (lib/deviceKey, web/lib/deviceKeyPresence) it is the Face ID prompt and
// nothing else. Without one (a binary too old for it, no biometry, or the
// person chose not to set it up) it is the web's /confirm page in the in-app
// browser (Safari View Controller runs the passkey ceremony), watched over
// this app's Convex client (web/lib/presenceHandoff); setting the key up
// spends one such confirmation, once.
import { Alert } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { api } from '@codecast/convex/convex/_generated/api';
import { PRESENCE_PHRASE, PRESENCE_TTL_MS, type PresenceAction, type PresenceGrant } from '@codecast/shared/contracts/secrets';
import { confirmPresenceViaWeb, type OpenedChallenge, type PresenceHandoffDeps } from '@codecast/web/lib/presenceHandoff';
import { UNAVAILABLE, confirmWithDeviceKey, ensureDeviceKey, type DeviceKeyDeps } from '@codecast/web/lib/deviceKeyPresence';
import { phoneSigner } from '@/lib/deviceKey';
import { ownChallenges } from '@/lib/presenceRequests';
import { convex } from '@/lib/convex';
import { openInAppBrowser, WEB_ORIGIN } from '@/lib/links';

/** Note a challenge this phone opened, so its waiting list (lib/presenceRequests) never offers it back. */
async function own<T extends { challenge_id?: string } | { error: string }>(begun: Promise<T>): Promise<T> {
  const got = await begun;
  if ('challenge_id' in got && got.challenge_id) ownChallenges.add(got.challenge_id);
  return got;
}

const phone: PresenceHandoffDeps = {
<<<<<<< Updated upstream
  webBase: WEB_ORIGIN,
  begin: (action, target) => convex.action(api.passkeys.presenceBegin, { action, target }) as Promise<OpenedChallenge>,
=======
  webBase: 'https://codecast.sh',
  begin: (action, target) => own(convex.action(api.passkeys.presenceBegin, { action, target }) as Promise<OpenedChallenge>),
>>>>>>> Stashed changes
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

const keyDeps: DeviceKeyDeps = {
  signer: phoneSigner,
  appName: 'Codecast',
  list: () => convex.query(api.passkeys.list, {}),
  begin: (action, target, from) => own(convex.action(api.passkeys.presenceBegin, { action, target, from }) as any),
  registrationBegin: (grant, from) => convex.action(api.passkeys.registrationBegin, { grant, from }) as any,
  register: (challenge_id, public_key, signature, name) => convex.action(api.deviceKeys.register, { challenge_id, public_key, signature, name }),
  confirm: (challenge_id, credential_id, signature) => convex.action(api.deviceKeys.confirm, { challenge_id, credential_id, signature }),
  confirmElsewhere: (action, target) => confirmPresenceViaWeb(action, target, phone),
  offerSetUp: () =>
    new Promise((resolve) =>
      Alert.alert('Set up Face ID in this app', undefined, [
        { text: 'Not now', style: 'cancel', onPress: () => resolve('elsewhere') },
        { text: 'Set up', onPress: () => resolve('setup') },
      ], { cancelable: true, onDismiss: () => resolve('cancel') }),
    ),
  fail: (message) => Alert.alert(message),
};

/** The grant string the gated call spends once the person confirmed `action` on `target` with Face ID or Touch ID, else null. Throws with the server's words when it cannot start. */
export async function confirmPresence(action: PresenceAction, target: string): Promise<PresenceGrant | null> {
  const viaKey: PresenceGrant | null | typeof UNAVAILABLE = await confirmWithDeviceKey(action, target, keyDeps).catch(() => UNAVAILABLE);
  return viaKey !== UNAVAILABLE ? viaKey : confirmPresenceViaWeb(action, target, phone);
}

/** Answer a challenge another of the person's devices opened (lib/presence waiting list) with this phone's key: true once granted. */
export async function confirmForOtherDevice(challengeId: string, action: PresenceAction, label?: string): Promise<boolean> {
  const key = await ensureDeviceKey(keyDeps);
  if (!key || key === UNAVAILABLE) return false;
  const reason = label ? `${PRESENCE_PHRASE[action]}: ${label}` : PRESENCE_PHRASE[action];
  const signed = await phoneSigner.sign({ challenge: (await convex.query(api.passkeys.challenge, { challenge_id: challengeId }))?.options?.challenge ?? '', reason });
  if ('cancelled' in signed) return false;
  if ('error' in signed) return (keyDeps.fail(signed.error), false);
  const done = await convex.action(api.deviceKeys.confirm, { challenge_id: challengeId, credential_id: signed.credential_id, signature: signed.signature });
  if ('error' in done) return (keyDeps.fail(done.error), false);
  return true;
}
