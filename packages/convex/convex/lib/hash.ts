/** SHA-256 as lowercase hex. The one spelling for every secret this backend
 *  stores by hash rather than by value (install nonces, confirm tokens). */
export async function sha256Hex(s: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
