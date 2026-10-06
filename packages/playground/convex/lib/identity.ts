// Visitors are anonymous: an id plus a secret the browser keeps in
// localStorage. Only the secret's hash is stored, and every public function
// proves the caller with it, so a visitor id alone (which appears on every
// message and presence row) grants nothing.

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export const SECRET_LENGTH = 32; // ~190 bits

/** A uniformly random string over `alphabet`. Rejection sampling keeps every
 *  character equally likely whatever the alphabet's length. */
export function randomToken(length: number, alphabet = TOKEN_ALPHABET): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

export function newSecret(): string {
  return randomToken(SECRET_LENGTH);
}

/** SHA-256 as lowercase hex; strings hash as UTF-8. */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Shape first, so junk never reaches the hash. */
export function isSecretShaped(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length === SECRET_LENGTH && /^[A-Za-z0-9]+$/.test(secret);
}

export async function secretMatches(secretHash: string, secret: unknown): Promise<boolean> {
  return isSecretShaped(secret) && (await sha256Hex(secret)) === secretHash;
}
