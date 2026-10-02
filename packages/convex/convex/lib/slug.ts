// Unguessable strings for URLs and secrets: published page slugs and keys,
// guest call links and the secrets guests hold. A leaf module (no imports) so
// any function module can mint one without pulling another's graph.

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SLUG_LENGTH = 12; // ~71 bits of entropy: the slug IS the access gate.

export function newSlug(length = SLUG_LENGTH): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let slug = "";
  for (const b of bytes) slug += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return slug;
}

/** owner_key / edit_key: same shape as slugs, longer. */
export function newSecret(): string {
  return newSlug(20);
}
