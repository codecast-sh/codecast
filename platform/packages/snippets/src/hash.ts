// The content fingerprint of one snippet body: the key rewrite decisions are
// made on. FNV-1a over a fixed JSON envelope. The envelope is historical: the
// first installer hashed the body through a manifest hasher in the slot named
// `scripts`, and configs across a fleet already hold those values. Keeping the
// same bytes under the hash means adoption changes no stored hash and so
// triggers no rewrite pass. Not a security hash.

export function snippetContentHash(body: string): string {
  const canonical = `{"scripts":[${JSON.stringify(body)}]}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    // The FNV prime, as shifts: `hash * 16777619` overflows 32 bits in JS.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
