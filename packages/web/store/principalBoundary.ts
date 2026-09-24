// What the store does at an account boundary. The tracker fires synchronously
// at the token write (this window's own) or the storage event (a sibling's),
// before React renders anything for the next account, and everything here
// that must beat that render is synchronous too.
import { parseAccessIdentity, type AuthPrincipalChange } from "@platform/auth/web";
import { authPrincipal } from "../lib/authPrincipal";
import { readDurableAuthValue } from "../lib/durableAuthStorage";
import { AUTH_JWT_STORAGE_KEY } from "../lib/localAuth";
import { purgeLocalCache } from "./idbCache";
import { clearProtectedInboxMemory, rebootPersistence } from "./inboxStore";
import { stopSyncReplication } from "./syncReplication";

export function onAuthPrincipalChange({ previous, next }: AuthPrincipalChange): void {
  // The old account's channel and lock go first: a follower must not accept
  // one more update, and a host must not answer a snapshot request.
  stopSyncReplication();
  // Drops every row and unbinds dispatch, the outbox and write-through, so no
  // late callback of the old account can land or leave this window. Also on
  // the way in from no account: whatever a signed-out window held is not the
  // next account's.
  clearProtectedInboxMemory();
  if (previous !== null) void purgeAfterLeaving(previous);
  // The next account's persistence: write-through and outbox rebound, then
  // hydration, which serves the disk cache only if that account owns it.
  if (next !== null) rebootPersistence();
}

// The disk copy of the account we left. Every window purges, not only the one
// that signed out: a sibling mid-write could have re-persisted rows after the
// signing-out window deleted the database. One exception: localStorage alone
// was wiped while the durable tier still names the same account and nobody
// else signed in; the wrapper restores the token on its next read, and the
// cache (with its queued writes) stays theirs.
async function purgeAfterLeaving(previous: string): Promise<void> {
  if (authPrincipal.current() === null) {
    let durable: string | null = null;
    try { durable = parseAccessIdentity(await readDurableAuthValue(AUTH_JWT_STORAGE_KEY))?.principalId ?? null; } catch { durable = null; }
    if (durable === previous && authPrincipal.current() === null) return;
  }
  try {
    await purgeLocalCache();
  } catch (error) {
    console.error("[auth] failed to purge the local cache after leaving an account", error);
  }
}

let installed: (() => void) | null = null;
/** Subscribe the store to the window's principal tracker. Idempotent. */
export function installAuthPrincipalBoundary(): () => void {
  if (installed) return installed;
  const unsubscribe = authPrincipal.subscribe(onAuthPrincipalChange);
  installed = () => { unsubscribe(); installed = null; };
  return installed;
}
