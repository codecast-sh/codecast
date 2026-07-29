import {
  AUTH_REFRESH_TOKEN_STORAGE_KEY,
  CONVEX_URL,
} from "@/lib/localAuth";
import { readDurableAuthValue } from "@/lib/durableAuthStorage";
import type { CredentialBinding } from "./types";

/**
 * Version-pinned to @convex-dev/auth 0.0.79. In that version refresh tokens are
 * `<rotating refresh-token id>|<stable auth-session id>` and rotation preserves
 * the second component. Any format change fails closed until this adapter and
 * its contract tests are reviewed.
 */
export const CREDENTIAL_BINDING_ADAPTER = "convex-auth-refresh-v1" as const;
export const SUPPORTED_CONVEX_AUTH_VERSION = "0.0.79" as const;

const CONVEX_ID = /^[a-z0-9]{20,64}$/;

export type CredentialEvidence = {
  binding: CredentialBinding;
  /** Ephemeral correlation evidence. Never write this value to the launcher. */
  sessionId: string;
};

export function parseConvexRefreshToken(raw: string): { sessionId: string } | null {
  const pieces = raw.split("|");
  if (pieces.length !== 2) return null;
  const [refreshTokenId, sessionId] = pieces;
  if (!CONVEX_ID.test(refreshTokenId) || !CONVEX_ID.test(sessionId)) return null;
  return { sessionId };
}

function bytesToHex(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += byte.toString(16).padStart(2, "0");
  return value;
}

async function sha256(value: string): Promise<string | null> {
  if (typeof crypto === "undefined" || !crypto.subtle) return null;
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

export async function credentialEvidenceFromRefreshToken(
  raw: string,
  deployment = CONVEX_URL,
): Promise<CredentialEvidence | null> {
  const parsed = parseConvexRefreshToken(raw);
  if (!parsed) return null;
  const digest = await sha256(
    `${CREDENTIAL_BINDING_ADAPTER}\0${deployment}\0${parsed.sessionId}`,
  );
  if (!digest) return null;
  return {
    binding: `${CREDENTIAL_BINDING_ADAPTER}:${digest}` as CredentialBinding,
    sessionId: parsed.sessionId,
  };
}

export async function readDurableCredentialEvidence(): Promise<CredentialEvidence | null> {
  const raw = await readDurableAuthValue(AUTH_REFRESH_TOKEN_STORAGE_KEY);
  return raw ? await credentialEvidenceFromRefreshToken(raw) : null;
}

function decodeBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    if (typeof atob !== "function") return null;
    const decoded = atob(padded);
    const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Correlate the server-accepted access token with the durable refresh session. */
export function parseConvexAccessTokenIdentity(
  token: string,
): { principalId: string; sessionId: string } | null {
  const pieces = token.split(".");
  if (pieces.length !== 3) return null;
  const header = decodeBase64UrlJson(pieces[0]);
  const payload = decodeBase64UrlJson(pieces[1]);
  if (!header || !payload || header.alg !== "RS256" || payload.aud !== "convex") return null;
  if (typeof payload.iss !== "string" || typeof payload.sub !== "string") return null;
  const subject = payload.sub.split("|");
  if (subject.length !== 2) return null;
  const [principalId, sessionId] = subject;
  if (!CONVEX_ID.test(principalId) || !CONVEX_ID.test(sessionId)) return null;
  return { principalId, sessionId };
}

export function credentialEvidenceMatchesServerIdentity(
  evidence: CredentialEvidence,
  accessToken: string | null,
  serverPrincipalId: string,
): boolean {
  if (!accessToken) return false;
  const identity = parseConvexAccessTokenIdentity(accessToken);
  return !!identity &&
    identity.sessionId === evidence.sessionId &&
    identity.principalId === serverPrincipalId;
}
