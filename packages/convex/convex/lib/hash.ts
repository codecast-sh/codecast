/** SHA-256 as lowercase hex. The one spelling for every secret this backend
 *  stores by hash rather than by value (install nonces, confirm tokens), and
 *  for content addressed bytes (replay chunks): a string hashes as UTF-8. */
export async function sha256Hex(s: string | Uint8Array): Promise<string> {
  const input = (typeof s === "string" ? new TextEncoder().encode(s) : s) as Uint8Array<ArrayBuffer>;
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
