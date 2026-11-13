// Who the on-disk store cache may be served to. The store reads its SQLite
// cache synchronously while its module evaluates, before React or the auth
// provider exists, so this reader is installed from the app entry (index.ts)
// and reads the stored Convex Auth token straight from the keychain.
import * as SecureStore from 'expo-secure-store';
import { setCachePrincipalSource } from '@codecast/web/store/idbCache';
import { CONVEX_URL } from './convex';

export type AccessIdentity = { principalId: string; subject: string };

/** The principal a Convex Auth JWT names, unverified. Decides only what this
 *  device may render from its own cache; the server authorizes everything. */
export function parseAccessIdentity(token: string | null): AccessIdentity | null {
  if (!token || typeof atob !== 'function') return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const decode = (value: string) => JSON.parse(atob(
      value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='),
    ));
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    if (header.alg !== 'RS256' || payload.aud !== 'convex' ||
      typeof payload.iss !== 'string' || typeof payload.sub !== 'string') return null;
    const [principalId, sessionId, ...extra] = payload.sub.split('|');
    if (!principalId || !sessionId || extra.length > 0) return null;
    return { principalId, subject: payload.sub };
  } catch {
    return null;
  }
}

/** The keychain key @convex-dev/auth stores `key` under for this deployment
 *  (`<key>_<namespace without punctuation>`, the namespace being the URL). */
export function convexAuthStorageKey(key: string): string {
  return `${key}_${CONVEX_URL.replace(/[^a-zA-Z0-9]/g, '')}`;
}

export function installCachePrincipal(): void {
  setCachePrincipalSource(() => {
    // A throw (keychain locked before first unlock, on a background launch)
    // is caught by the cache as "unreadable": it serves nothing and purges nothing.
    const token = SecureStore.getItem(convexAuthStorageKey('__convexAuthJWT'));
    if (token == null) return { principal: null, tokenState: 'absent' };
    const identity = parseAccessIdentity(token);
    return identity
      ? { principal: identity.principalId, tokenState: 'named' }
      : { principal: null, tokenState: 'unparsable' };
  });
}
