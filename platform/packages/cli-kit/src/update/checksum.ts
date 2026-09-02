// Checksum helpers shared by the self updater and anything that verifies a
// downloaded artifact. Uses WebCrypto, which bun and node both provide.

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const hash = await crypto.subtle.digest("SHA-256", view);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface ChecksumResult {
  ok: boolean;
  expected: string;
  actual: string;
}

/** Case insensitive comparison of a SHA-256 hex digest against the bytes. */
export async function verifySha256(bytes: Uint8Array, expectedHex: string): Promise<ChecksumResult> {
  const actual = await sha256Hex(bytes);
  const expected = expectedHex.trim().toLowerCase();
  return { ok: actual === expected, expected, actual };
}
