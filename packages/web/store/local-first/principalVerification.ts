import {
  credentialEvidenceMatchesServerIdentity,
  type CredentialEvidence,
} from "./credentialBinding";
import { asPrincipalId } from "./types";

export type PrincipalVerificationOutcome =
  | { kind: "stale" }
  | { kind: "ready"; principalId: string }
  | { kind: "unverified"; reason: "identity-mismatch" | "runtime-refused" };

export type PrincipalBootOutcome = PrincipalVerificationOutcome
  | { kind: "offline-ready"; verification: "not-requested" | "unavailable" }
  | { kind: "unverified"; reason: "offline-store-unavailable" };

export type ServerPrincipalResult = {
  _id?: { toString(): string } | string | null;
} | null;

/**
 * React auth state settles across several renders on a fresh tab. Coalesce the
 * local-store open across those captures so a token/auth transition cannot
 * supersede the very IndexedDB hydration that should unblock rendering.
 */
export class PrincipalOfflineResolutionCoordinator {
  private pending: {
    binding: CredentialEvidence["binding"];
    promise: Promise<boolean>;
  } | null = null;

  constructor(
    private readonly resolveOffline: (
      binding: CredentialEvidence["binding"],
    ) => Promise<boolean>,
  ) {}

  resolve(binding: CredentialEvidence["binding"]): Promise<boolean> {
    if (this.pending?.binding === binding) return this.pending.promise;
    const promise = this.resolveOffline(binding).then(
      (opened) => {
        if (this.pending?.promise === promise) this.pending = null;
        return opened;
      },
      (error: unknown) => {
        if (this.pending?.promise === promise) this.pending = null;
        throw error;
      },
    );
    this.pending = { binding, promise };
    return promise;
  }
}

/**
 * Correlate one post-capture server round trip with the exact access token that
 * initiated it. `isCurrent` is checked before any irreversible runtime action,
 * so an A response arriving after an A→B token switch is observation only: it
 * cannot fail, open, or authorize either principal.
 */
export async function verifyPostCapturePrincipal(input: {
  token: string;
  evidence: CredentialEvidence;
  queryCurrentPrincipal(): Promise<ServerPrincipalResult>;
  isCurrent(): boolean;
  verify(binding: CredentialEvidence["binding"], principalId: string): Promise<boolean>;
  failClosed(reason: "auth-session-correlation-failed"): Promise<void>;
}): Promise<PrincipalVerificationOutcome> {
  const currentUser = await input.queryCurrentPrincipal();
  if (!input.isCurrent()) return { kind: "stale" };

  const principalId = currentUser?._id?.toString() ?? null;
  if (!principalId || !credentialEvidenceMatchesServerIdentity(
    input.evidence,
    input.token,
    principalId,
  )) {
    await input.failClosed("auth-session-correlation-failed");
    return input.isCurrent()
      ? { kind: "unverified", reason: "identity-mismatch" }
      : { kind: "stale" };
  }

  const verified = await input.verify(input.evidence.binding, principalId);
  if (!input.isCurrent()) return { kind: "stale" };
  return verified
    ? { kind: "ready", principalId: asPrincipalId(principalId) }
    : { kind: "unverified", reason: "runtime-refused" };
}

/**
 * Warm boot is deliberately cache-first even when Convex auth has already
 * settled. The durable credential binding is the authorization to open a
 * previously server-verified namespace; the fresh server probe upgrades that
 * same open store for authoritative apply/dispatch, but never sits in front of
 * cached rendering.
 *
 * Start the probe before the local open so reconnect work overlaps IndexedDB,
 * then wait to apply its result until `resolveOffline` has finished. Runtime
 * transitions therefore remain sequential and retain their existing fencing.
 */
export async function resolvePrincipalBoot(input: {
  token: string | null;
  evidence: CredentialEvidence;
  serverAuthenticated: boolean;
  isCurrent(): boolean;
  resolveOffline(binding: CredentialEvidence["binding"]): Promise<boolean>;
  onOfflineReady(): void;
  queryCurrentPrincipal(): Promise<ServerPrincipalResult>;
  verify(binding: CredentialEvidence["binding"], principalId: string): Promise<boolean>;
  failClosed(reason: "auth-session-correlation-failed"): Promise<void>;
  onVerificationUnavailable?(error: unknown): void;
}): Promise<PrincipalBootOutcome> {
  const queryPromise = input.serverAuthenticated && input.token
    ? input.queryCurrentPrincipal().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    : null;

  const opened = await input.resolveOffline(input.evidence.binding);
  if (!input.isCurrent()) return { kind: "stale" };
  if (opened) input.onOfflineReady();

  if (!queryPromise || !input.token) {
    return opened
      ? { kind: "offline-ready", verification: "not-requested" }
      : { kind: "unverified", reason: "offline-store-unavailable" };
  }

  const queryResult = await queryPromise;
  if (!queryResult.ok) {
    if (!input.isCurrent()) return { kind: "stale" };
    if (!opened) throw queryResult.error;
    input.onVerificationUnavailable?.(queryResult.error);
    return { kind: "offline-ready", verification: "unavailable" };
  }

  return await verifyPostCapturePrincipal({
    token: input.token,
    evidence: input.evidence,
    queryCurrentPrincipal: async () => queryResult.value,
    isCurrent: input.isCurrent,
    verify: input.verify,
    failClosed: input.failClosed,
  });
}
