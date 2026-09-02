// Local first boot trust. The store hydrates its SQLite cache at module eval,
// long before the Convex WebSocket authenticates — so what may RENDER cannot
// wait on the server. The rule (same as the web localAuth signal): rendering gates
// on the LOCAL token; server confirmation only revokes, upgrades to a verified
// session, and decides authed side effects.
//
// The anchor is the last principal this device VERIFIED with the server,
// persisted at verification time. The disk cache belongs to that principal.
// When the locally parsed JWT names the same principal, the cache may render
// and writes may park in that principal's outbox before any network round
// trip. A token naming anyone else earns nothing until the server confirms it.

export type AccessIdentity = { principalId: string; subject: string };

// The subject this launch may act as before (or without) server verification.
// Null until the persisted anchor is read, whenever the token names a
// different principal than the anchor, and from the moment the server resolves
// the token to a different user (or no user) than the token claims.
export function localBootTrust(opts: {
  accessIdentity: AccessIdentity | null;
  bootPrincipal: string | null | undefined;
  isAuthenticated: boolean;
  currentUserLoaded: boolean;
  currentUserId: string | null;
}): string | null {
  const { accessIdentity, bootPrincipal, isAuthenticated, currentUserLoaded, currentUserId } = opts;
  if (!accessIdentity || bootPrincipal == null) return null;
  if (bootPrincipal !== accessIdentity.principalId) return null;
  if (isAuthenticated && currentUserLoaded && currentUserId !== accessIdentity.principalId) return null;
  return accessIdentity.subject;
}

// The shared store holds ONE principal's data (disk hydration or live sync).
// Clear it only when a DIFFERENT principal becomes trusted — never on the boot
// transition "unknown → same principal". Clearing on every subject change was
// the bug that wiped the just-hydrated cache on every launch the moment
// verification landed. `memoryPrincipal` undefined means the cache owner
// hasn't been read yet; callers gate rendering on that read, so deferring the
// decision is safe.
export function shouldClearMemoryFor(
  memoryPrincipal: string | null | undefined,
  trustedPrincipalId: string | null,
): boolean {
  if (!trustedPrincipalId) return false;
  if (memoryPrincipal === undefined) return false;
  return memoryPrincipal !== trustedPrincipalId;
}

export type AuthRenderDecision = "children" | "blank" | "storage-failure";

// What the provider renders. "blank" covers: the ms-long read of the trust
// anchor, and an authenticated-or-resolving token that earned no local trust
// (first login on this device, or a token for another principal — the cache
// must not flash while verification is pending). A signed-out resolution
// renders children so the login flow inside the Stack can appear.
export function authRenderDecision(opts: {
  bootPrincipalLoaded: boolean;
  trustedSubject: string | null;
  outboxFailureSubject: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
}): AuthRenderDecision {
  if (!opts.bootPrincipalLoaded) return "blank";
  if (opts.trustedSubject) {
    return opts.outboxFailureSubject === opts.trustedSubject ? "storage-failure" : "children";
  }
  return opts.isLoading || opts.isAuthenticated ? "blank" : "children";
}
