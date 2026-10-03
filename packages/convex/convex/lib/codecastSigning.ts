// Codecast's signing key, on codecast's side only (external-data.md X8,
// "Signed requests"). `CODECAST_SIGNING_KEY` is a Convex deployment env var
// holding one private Ed25519 JWK, or a JSON array of them: the first signs,
// every one is published at /.well-known/codecast-keys.json. Generate one with
// `bun packages/convex/scripts/codecast-signing-key.ts`. The scheme itself is
// @codecast/shared/contracts/codecastSignature. A leaf with no Convex imports.
import {
  CODECAST_SIGNING_KEY_ENV,
  parseSigningKeys,
  publicJwks,
  signCodecastRequest,
  type CodecastJwk,
  type CodecastJwks,
  type SignInput,
} from "@codecast/shared/contracts/codecastSignature";

export const SIGNING_NOT_CONFIGURED = `Request signing not configured (${CODECAST_SIGNING_KEY_ENV})`;

let cache: { raw: string; keys: CodecastJwk[] | null; error?: string } | null = null;

/** The configured keys, null when the env var is unset, or why it does not parse. */
export function signingKeys(): { keys: CodecastJwk[] | null; error?: string } {
  const raw = process.env[CODECAST_SIGNING_KEY_ENV]?.trim() ?? "";
  if (cache?.raw === raw) return cache;
  try {
    cache = { raw, keys: raw ? parseSigningKeys(raw) : null };
  } catch (e: any) {
    cache = { raw, keys: null, error: String(e?.message ?? e) };
  }
  return cache;
}

/** The public key set codecast publishes (empty when signing is not configured). */
export function publishedKeys(): CodecastJwks {
  return publicJwks(signingKeys().keys ?? []);
}

/** The signature headers for one connector request, or why it cannot be signed. */
export async function signatureHeaders(req: SignInput): Promise<{ ok: true; headers: Record<string, string> } | { ok: false; error: string }> {
  const { keys, error } = signingKeys();
  if (!keys) return { ok: false, error: error ?? SIGNING_NOT_CONFIGURED };
  return { ok: true, headers: await signCodecastRequest(req, keys[0]) };
}
