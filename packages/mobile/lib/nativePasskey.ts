// The platform passkey sheet (react-native-passkey) for lib/passkeyCeremony.
// Binaries built before the library, or an OS without passkeys, answer null
// and lib/presence hands off to /confirm as before.
import { Platform } from 'react-native';
import * as Device from 'expo-device';
import { api } from '@codecast/convex/convex/_generated/api';
import type { PresenceAction, PresenceGrant } from '@codecast/shared/contracts/secrets';
import { convex } from '@/lib/convex';
import { optionalNative } from '@/lib/optionalNative';
import type { Begun, NativePasskeyDeps } from '@/lib/passkeyCeremony';

type Lib = typeof import('react-native-passkey');

/** The deps for one ceremony, or null when this binary has no passkey sheet. `begin`/`enroll` are lib/presence's, so its bookkeeping rides along. */
export function nativePasskeyDeps(calls: {
  begin: (action: PresenceAction, target: string) => Promise<unknown>;
  enroll: (grant?: PresenceGrant) => Promise<unknown>;
}): NativePasskeyDeps | null {
  const Passkey = optionalNative('Passkey', () => (require('react-native-passkey') as Lib).Passkey);
  if (!Passkey?.isSupported()) return null;
  return {
    begin: (action, target) => calls.begin(action, target) as Promise<Begun>,
    enroll: (grant) => calls.enroll(grant) as Promise<Begun>,
    get: (request) => Passkey.get(request as any) as Promise<any>,
    create: (request) => Passkey.create(request as any) as Promise<any>,
    finishPresence: (challenge_id, response) => convex.action(api.passkeys.presenceFinish, { challenge_id, response }),
    finishRegistration: (challenge_id, response, name) => convex.action(api.passkeys.registrationFinish, { challenge_id, response, name }),
    name: `Codecast on ${Device.modelName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Android')}`,
  };
}
