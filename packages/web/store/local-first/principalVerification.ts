import {
  credentialEvidenceMatchesServerIdentity,
  type CredentialEvidence,
} from "./credentialBinding";
import { asPrincipalId } from "./types";

export type PrincipalVerificationOutcome =
  | { kind: "stale" }
  | { kind: "ready"; principalId: string }
  | { kind: "unverified"; reason: "identity-mismatch" | "runtime-refused" };

export type ServerPrincipalResult = {
  _id?: { toString(): string } | string | null;
} | null;

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
